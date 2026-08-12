import { EventType, ResumeEntrySchema } from "@ag-ui/core";
import type { AGUIEvent } from "@ag-ui/core";
import { z } from "zod";
import {
  createReminderManifest,
  executableCapabilityRegistry,
  searchHelpCatalog,
  searchHelpCatalogManifest
} from "./capabilities.js";
import { checkedEvent, uiEvent } from "./ag-ui.js";
import { RuntimeBoundaryError, safeError } from "./errors.js";
import { contentDigest, InMemoryRuntimeStore } from "./store.js";
import type { RuntimeStore } from "./store.js";
import type {
  ApprovalState,
  Clock,
  ExecutionOutcome,
  ExecutionReceipt,
  IdSource,
  ModelProvider,
  PatronScope,
  PendingAction
} from "./types.js";

export type RunResult = {
  status: "completed" | "paused" | "rejected" | "cancelled" | "timed-out" | "failed";
  runId: string;
  actionId: string | null;
  interruptId: string | null;
  events: AGUIEvent[];
};

type StartRunInput = PatronScope & {
  messageId: string;
  content: string;
  timeZone: string;
  signal?: AbortSignal;
};

type ResumeRunInput = PatronScope & {
  interruptId: string;
  decision: "approve" | "reject" | "cancel";
  signal?: AbortSignal;
};

const APPROVAL_TTL_MS = 5 * 60_000;
const opaqueIdentifier = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerIdentifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const abortSignalSchema = z.custom<AbortSignal>(
  (value) => typeof value === "object" && value !== null && "aborted" in value && typeof value.aborted === "boolean"
);
const startRunInputSchema = z.object({
  tenantId: opaqueIdentifier,
  patronId: opaqueIdentifier,
  threadId: opaqueIdentifier,
  messageId: opaqueIdentifier,
  content: z.string().min(1).max(8_192),
  timeZone: z.string().trim().min(1).max(80),
  signal: abortSignalSchema.optional()
}).strict();
const resumeRunInputSchema = z.object({
  tenantId: opaqueIdentifier,
  patronId: opaqueIdentifier,
  threadId: opaqueIdentifier,
  interruptId: opaqueIdentifier,
  decision: z.enum(["approve", "reject", "cancel"]),
  signal: abortSignalSchema.optional()
}).strict();
const providerProposalSchema = z.object({
  capabilityId: z.string().min(1).max(100),
  arguments: z.unknown(),
  inputProvenance: z.object({
    source: z.literal("patron_message"),
    messageId: opaqueIdentifier
  }).strict()
}).strict();
const strictResumeEntrySchema = z.discriminatedUnion("status", [
  z.object({
    interruptId: opaqueIdentifier,
    status: z.literal("resolved"),
    payload: z.object({ approved: z.boolean() }).strict()
  }).strict(),
  z.object({
    interruptId: opaqueIdentifier,
    status: z.literal("cancelled")
  }).strict()
]);

function lowerFirst(value: string): string {
  return value.length ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function semanticReminderQuestion(title: string, dueAt: string, timeZone: string): string {
  const due = new Date(dueAt);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(due);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(due);
  return `Set a reminder to ${lowerFirst(title)} on ${date} at ${time}?`;
}

async function awaitWhileConnected<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw new RuntimeBoundaryError("CLIENT_DISCONNECTED", "The connection ended before anything was changed.");
  }
  let abortHandler: (() => void) | undefined;
  const disconnected = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new RuntimeBoundaryError("CLIENT_DISCONNECTED", "The connection ended before anything was changed."));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, disconnected]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

export class BoomerBuddyRuntime {
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #provider: ModelProvider;
  readonly #store: RuntimeStore;

  constructor(input: { clock: Clock; ids: IdSource; provider: ModelProvider; store?: RuntimeStore }) {
    if (!providerIdentifier.safeParse(input.provider.identifier).success) {
      throw new RuntimeBoundaryError("PROVIDER_CONFIGURATION_INVALID", "The model provider configuration was invalid.");
    }
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#provider = input.provider;
    this.#store = input.store ?? new InMemoryRuntimeStore(input.ids);
  }

  async startRun(input: StartRunInput): Promise<RunResult> {
    const runId = this.#ids.next("run");
    const events: AGUIEvent[] = [];
    const timestamp = this.#clock.now().getTime();
    const request = startRunInputSchema.safeParse(input);
    if (!request.success) {
      const safe = safeError(new RuntimeBoundaryError("MALFORMED_RUN_REQUEST", "The request was malformed."));
      events.push(checkedEvent({ type: EventType.RUN_STARTED, threadId: "invalid-thread", runId, timestamp }));
      events.push(checkedEvent({ type: EventType.RUN_ERROR, message: safe.message, code: safe.code, timestamp }));
      return { status: "failed", runId, actionId: null, interruptId: null, events };
    }
    const validatedInput = request.data;
    const scope: PatronScope = {
      tenantId: validatedInput.tenantId,
      patronId: validatedInput.patronId,
      threadId: validatedInput.threadId
    };
    let actionId: string | null = null;
    let actionCapabilityId: string | null = null;
    let actionCapabilityVersion: string | null = null;
    const emit = (event: unknown): void => { events.push(checkedEvent(event)); };

    try {
      this.#store.assertScope(scope);
      emit({ type: EventType.RUN_STARTED, threadId: validatedInput.threadId, runId, timestamp });
      emit({
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          status: "working",
          currentRunId: runId,
          pendingAction: null,
          nextAvailableMoves: ["Ask for a help guide", "Ask to set a reminder"]
        },
        timestamp
      });
      this.#assertConnected(validatedInput.signal);
      const rawProposal = await awaitWhileConnected(this.#provider.propose({
        patronMessage: validatedInput.content,
        messageId: validatedInput.messageId,
        now: this.#clock.now(),
        timeZone: validatedInput.timeZone,
        allowedCapabilityIds: Object.freeze(Object.keys(executableCapabilityRegistry))
      }), validatedInput.signal);
      this.#assertConnected(validatedInput.signal);
      const parsedProposal = providerProposalSchema.safeParse(rawProposal);
      if (!parsedProposal.success) {
        throw new RuntimeBoundaryError("PROVIDER_RESPONSE_MALFORMED", "The model response was malformed.");
      }
      const proposal = parsedProposal.data;
      if (proposal.inputProvenance.messageId !== validatedInput.messageId) {
        throw new RuntimeBoundaryError("PROVIDER_PROVENANCE_MISMATCH", "The model response did not match this request.");
      }
      if (!Object.hasOwn(executableCapabilityRegistry, proposal.capabilityId)) {
        throw new RuntimeBoundaryError("UNREGISTERED_CAPABILITY", "The requested action is not available.");
      }

      actionId = this.#ids.next("action");
      const toolCallId = this.#ids.next("tool_call");
      if (proposal.capabilityId === searchHelpCatalogManifest.id) {
        actionCapabilityId = searchHelpCatalogManifest.id;
        actionCapabilityVersion = searchHelpCatalogManifest.version;
        const args = searchHelpCatalogManifest.inputSchema.safeParse(proposal.arguments);
        if (!args.success) throw new RuntimeBoundaryError("INVALID_TOOL_ARGUMENTS", "The help search request was malformed.");
        this.#emitToolProposal(emit, toolCallId, proposal.capabilityId, args.data, timestamp);
        const output = searchHelpCatalog(args.data);
        searchHelpCatalogManifest.outputSchema.parse(output);
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: this.#ids.next("message"),
          toolCallId,
          content: JSON.stringify(output),
          role: "tool",
          timestamp
        });
        events.push(uiEvent({ key: "GuideCard", props: output }, timestamp));
        this.#emitText(emit, "Here is the reviewed iPhone guide. You can follow it one step at a time.", timestamp);
        emit({
          type: EventType.STATE_DELTA,
          delta: [
            { op: "replace", path: "/status", value: "completed" },
            { op: "replace", path: "/nextAvailableMoves", value: [output.nextMove, "Ask to set a reminder"] }
          ],
          timestamp
        });
        emit({ type: EventType.RUN_FINISHED, threadId: validatedInput.threadId, runId, outcome: { type: "success" }, timestamp });
        this.#appendReceipt(scope, runId, actionId, searchHelpCatalogManifest.id, searchHelpCatalogManifest.version, validatedInput.messageId, validatedInput.content, "not-required", "succeeded", "action");
        this.#appendReceipt(scope, runId, null, null, null, validatedInput.messageId, validatedInput.content, "not-required", "succeeded", "run");
        return { status: "completed", runId, actionId, interruptId: null, events };
      }

      actionCapabilityId = createReminderManifest.id;
      actionCapabilityVersion = createReminderManifest.version;
      const args = createReminderManifest.inputSchema.safeParse(proposal.arguments);
      if (!args.success) throw new RuntimeBoundaryError("INVALID_TOOL_ARGUMENTS", "The reminder request was malformed.");
      this.#emitToolProposal(emit, toolCallId, proposal.capabilityId, args.data, timestamp);
      const interruptId = this.#ids.next("interrupt");
      const prompt = semanticReminderQuestion(args.data.title, args.data.dueAt, args.data.timeZone);
      const expiresAt = new Date(this.#clock.now().getTime() + APPROVAL_TTL_MS).toISOString();
      const pending: PendingAction = {
        ...scope,
        runId,
        actionId,
        interruptId,
        toolCallId,
        capabilityId: "create_reminder",
        capabilityVersion: createReminderManifest.version,
        arguments: args.data,
        prompt,
        status: "pending",
        expiresAt,
        result: null
      };
      const confirmationEvent = uiEvent({
        key: "ReminderConfirmationCard",
        props: {
          question: prompt,
          title: args.data.title,
          scheduledFor: args.data.dueAt,
          timeZone: args.data.timeZone,
          actionId,
          choices: ["Approve", "Not now"]
        }
      }, timestamp);
      this.#store.savePendingAction(pending);
      events.push(confirmationEvent);
      this.#emitText(emit, prompt, timestamp);
      emit({
        type: EventType.STATE_DELTA,
        delta: [
          { op: "replace", path: "/status", value: "awaiting-approval" },
          { op: "replace", path: "/pendingAction", value: { actionId, capabilityId: proposal.capabilityId, expiresAt } },
          { op: "replace", path: "/nextAvailableMoves", value: ["Approve", "Not now"] }
        ],
        timestamp
      });
      emit({
        type: EventType.RUN_FINISHED,
        threadId: validatedInput.threadId,
        runId,
        outcome: {
          type: "interrupt",
          interrupts: [{
            id: interruptId,
            reason: "approval-required",
            message: prompt,
            toolCallId,
            expiresAt,
            responseSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
              required: ["approved"],
              additionalProperties: false
            }
          }]
        },
        timestamp
      });
      this.#appendReceipt(scope, runId, actionId, createReminderManifest.id, createReminderManifest.version, validatedInput.messageId, validatedInput.content, "pending", "interrupted", "action");
      this.#appendReceipt(scope, runId, null, null, null, validatedInput.messageId, validatedInput.content, "pending", "interrupted", "run");
      return { status: "paused", runId, actionId, interruptId, events };
    } catch (error) {
      const safe = safeError(error);
      if (!events.some((event) => event.type === EventType.RUN_STARTED)) {
        events.push(checkedEvent({ type: EventType.RUN_STARTED, threadId: validatedInput.threadId, runId, timestamp }));
      }
      events.push(checkedEvent({ type: EventType.RUN_ERROR, message: safe.message, code: safe.code, timestamp }));
      if (actionId && actionCapabilityId && actionCapabilityVersion) {
        this.#appendReceipt(scope, runId, actionId, actionCapabilityId, actionCapabilityVersion, validatedInput.messageId, validatedInput.content, "not-required", "failed", "action", safe.code);
      }
      this.#appendReceipt(scope, runId, null, null, null, validatedInput.messageId, validatedInput.content, "not-required", "failed", "run", safe.code);
      return { status: "failed", runId, actionId, interruptId: null, events };
    }
  }

  async resume(input: ResumeRunInput): Promise<RunResult> {
    const runId = this.#ids.next("run");
    const request = resumeRunInputSchema.safeParse(input);
    const timestamp = this.#clock.now().getTime();
    const events: AGUIEvent[] = [];
    if (!request.success) {
      const safe = safeError(new RuntimeBoundaryError("MALFORMED_RESUME_REQUEST", "The approval response was malformed."));
      events.push(checkedEvent({ type: EventType.RUN_STARTED, threadId: "invalid-thread", runId, timestamp }));
      events.push(checkedEvent({ type: EventType.RUN_ERROR, message: safe.message, code: safe.code, timestamp }));
      return { status: "failed", runId, actionId: null, interruptId: null, events };
    }
    const validatedInput = request.data;
    const scope: PatronScope = {
      tenantId: validatedInput.tenantId,
      patronId: validatedInput.patronId,
      threadId: validatedInput.threadId
    };
    const emit = (event: unknown): void => { events.push(checkedEvent(event)); };
    let action: PendingAction | null = null;
    try {
      this.#store.assertScope(scope);
      action = this.#store.getPendingAction(scope, validatedInput.interruptId);
      emit({ type: EventType.RUN_STARTED, threadId: validatedInput.threadId, runId, parentRunId: action.runId, timestamp });
      emit({
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          status: "resuming",
          currentRunId: runId,
          pendingAction: { actionId: action.actionId, capabilityId: action.capabilityId, expiresAt: action.expiresAt },
          nextAvailableMoves: ["Wait for the result"]
        },
        timestamp
      });
      this.#assertConnected(validatedInput.signal);

      this.#assertConnected(validatedInput.signal);
      const resolution = this.#store.resolvePendingAction({
        scope,
        interruptId: action.interruptId,
        decision: validatedInput.decision,
        now: this.#clock.now().toISOString(),
        reminderId: this.#ids.next("reminder")
      });
      action = resolution.action;
      if (resolution.status === "timed-out") {
        events.push(uiEvent({
          key: "SafetyNoticeCard",
          props: {
            title: "Approval expired",
            message: "No reminder was created. Please ask again if you still want it.",
            code: "ACTION_EXPIRED",
            nextMove: "Ask Boomer Buddy to set the reminder again."
          }
        }, timestamp));
        this.#finishWithoutMutation(emit, action, runId, timestamp, "timed-out");
        this.#appendReceipt(scope, runId, action.actionId, action.capabilityId, action.capabilityVersion, null, null, "timed-out", "timed-out", "action");
        this.#appendReceipt(scope, runId, null, null, null, null, null, "timed-out", "timed-out", "run");
        return { status: "timed-out", runId, actionId: action.actionId, interruptId: action.interruptId, events };
      }
      if (resolution.status === "cancelled" || resolution.status === "rejected") {
        const cancelled = resolution.status === "cancelled";
        events.push(uiEvent({
          key: cancelled ? "SafetyNoticeCard" : "ActionReceiptCard",
          props: cancelled ? {
            title: "Reminder cancelled",
            message: "No reminder was created.",
            code: "ACTION_CANCELLED",
            nextMove: "You can ask again at any time."
          } : {
            heading: "Reminder not created",
            status: "not-created",
            summary: "You chose not to create this reminder.",
            actionId: action.actionId,
            capabilityId: action.capabilityId,
            occurredAt: this.#clock.now().toISOString(),
            nextMove: "You can ask for a different reminder."
          }
        }, timestamp));
        this.#finishWithoutMutation(emit, action, runId, timestamp, cancelled ? "cancelled" : "rejected");
        const approval = cancelled ? "cancelled" : "rejected";
        const outcome = cancelled ? "cancelled" : "rejected";
        this.#appendReceipt(scope, runId, action.actionId, action.capabilityId, action.capabilityVersion, null, null, approval, outcome, "action");
        this.#appendReceipt(scope, runId, null, null, null, null, null, approval, outcome, "run");
        return { status: cancelled ? "cancelled" : "rejected", runId, actionId: action.actionId, interruptId: action.interruptId, events };
      }

      const reminder = resolution.reminder;
      if (!reminder) throw new RuntimeBoundaryError("SAFE_FAILURE", "The request could not be completed safely.");
      createReminderManifest.outputSchema.parse(reminder);
      this.#emitCompletedAction(emit, events, action, reminder, runId, timestamp, resolution.duplicate);
      this.#appendReceipt(scope, runId, action.actionId, action.capabilityId, action.capabilityVersion, null, null, "approved", "succeeded", "action");
      this.#appendReceipt(scope, runId, null, null, null, null, null, "approved", "succeeded", "run");
      return { status: "completed", runId, actionId: action.actionId, interruptId: action.interruptId, events };
    } catch (error) {
      const safe = safeError(error);
      if (!events.some((event) => event.type === EventType.RUN_STARTED)) {
        events.push(checkedEvent({ type: EventType.RUN_STARTED, threadId: validatedInput.threadId, runId, timestamp }));
      }
      events.push(checkedEvent({ type: EventType.RUN_ERROR, message: safe.message, code: safe.code, timestamp }));
      this.#appendReceipt(scope, runId, null, null, null, null, null, "not-required", "failed", "run", safe.code);
      return { status: "failed", runId, actionId: action?.actionId ?? null, interruptId: action?.interruptId ?? null, events };
    }
  }

  async resumeFromAgUi(input: PatronScope & { resume: unknown; signal?: AbortSignal }): Promise<RunResult> {
    const entry = ResumeEntrySchema.safeParse(input.resume);
    const strictEntry = strictResumeEntrySchema.safeParse(input.resume);
    if (!entry.success || !strictEntry.success) {
      throw new RuntimeBoundaryError("MALFORMED_AG_UI_RESUME", "The approval response was malformed.");
    }
    if (strictEntry.data.status === "cancelled") {
      return this.resume({
        tenantId: input.tenantId,
        patronId: input.patronId,
        threadId: input.threadId,
        interruptId: strictEntry.data.interruptId,
        decision: "cancel",
        ...(input.signal ? { signal: input.signal } : {})
      });
    }
    return this.resume({
      tenantId: input.tenantId,
      patronId: input.patronId,
      threadId: input.threadId,
      interruptId: strictEntry.data.interruptId,
      decision: strictEntry.data.payload.approved ? "approve" : "reject",
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  #assertConnected(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new RuntimeBoundaryError("CLIENT_DISCONNECTED", "The connection ended before anything was changed.");
    }
  }

  #emitToolProposal(emit: (event: unknown) => void, toolCallId: string, name: string, args: unknown, timestamp: number): void {
    emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, timestamp });
    emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args), timestamp });
    emit({ type: EventType.TOOL_CALL_END, toolCallId, timestamp });
  }

  #emitText(emit: (event: unknown) => void, content: string, timestamp: number): void {
    const messageId = this.#ids.next("message");
    const splitAt = Math.max(1, Math.floor(content.length / 2));
    emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", timestamp });
    emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content.slice(0, splitAt), timestamp });
    emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content.slice(splitAt), timestamp });
    emit({ type: EventType.TEXT_MESSAGE_END, messageId, timestamp });
  }

  #emitCompletedAction(
    emit: (event: unknown) => void,
    events: AGUIEvent[],
    action: PendingAction,
    reminder: NonNullable<PendingAction["result"]>,
    runId: string,
    timestamp: number,
    duplicate: boolean
  ): void {
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: this.#ids.next("message"),
      toolCallId: action.toolCallId,
      content: JSON.stringify(reminder),
      role: "tool",
      timestamp
    });
    events.push(uiEvent({
      key: "ActionReceiptCard",
      props: {
        heading: duplicate ? "Reminder already created" : "Reminder created",
        status: "completed",
        summary: `${reminder.title} is set for ${new Intl.DateTimeFormat("en-US", { timeZone: reminder.timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(reminder.dueAt))}.`,
        actionId: action.actionId,
        capabilityId: action.capabilityId,
        occurredAt: reminder.createdAt,
        nextMove: "You can ask for another help guide or reminder."
      }
    }, timestamp));
    this.#emitText(emit, duplicate ? "That reminder was already created. I did not create a second one." : "Your reminder is set.", timestamp);
    emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: "replace", path: "/status", value: "completed" },
        { op: "replace", path: "/pendingAction", value: null },
        { op: "replace", path: "/nextAvailableMoves", value: ["Ask for a help guide", "Set another reminder"] }
      ],
      timestamp
    });
    emit({ type: EventType.RUN_FINISHED, threadId: action.threadId, runId, outcome: { type: "success" }, timestamp });
  }

  #finishWithoutMutation(
    emit: (event: unknown) => void,
    action: PendingAction,
    runId: string,
    timestamp: number,
    status: "rejected" | "cancelled" | "timed-out"
  ): void {
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: this.#ids.next("message"),
      toolCallId: action.toolCallId,
      content: JSON.stringify({ status, mutated: false }),
      role: "tool",
      timestamp
    });
    emit({
      type: EventType.STATE_DELTA,
      delta: [
        { op: "replace", path: "/status", value: status },
        { op: "replace", path: "/pendingAction", value: null },
        { op: "replace", path: "/nextAvailableMoves", value: ["Ask again", "Ask for a help guide"] }
      ],
      timestamp
    });
    emit({ type: EventType.RUN_FINISHED, threadId: action.threadId, runId, outcome: { type: "success" }, timestamp });
  }

  #appendReceipt(
    scope: PatronScope,
    runId: string,
    actionId: string | null,
    capabilityId: string | null,
    capabilityVersion: string | null,
    messageId: string | null,
    content: string | null,
    approvalState: ApprovalState,
    outcome: ExecutionOutcome,
    receiptType: "run" | "action",
    safeErrorCode: string | null = null
  ): void {
    const receipt: ExecutionReceipt = {
      receiptId: this.#ids.next("receipt"),
      receiptType,
      ...scope,
      runId,
      actionId,
      capabilityId,
      capabilityVersion,
      modelProvider: this.#provider.identifier,
      inputProvenance: {
        source: messageId ? "patron_message" : "approval_resume",
        messageId,
        contentDigest: content === null ? null : contentDigest(content)
      },
      approvalState,
      outcome,
      safeErrorCode,
      createdAt: this.#clock.now().toISOString()
    };
    this.#store.appendReceipt(receipt);
  }
}
