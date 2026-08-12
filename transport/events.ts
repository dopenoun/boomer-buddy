import { EventType } from "@ag-ui/core";
import type { AGUIEvent } from "@ag-ui/core";
import { z } from "zod";
import { validateAgUiEvent } from "../runtime/ag-ui.js";
import { RuntimeBoundaryError } from "../runtime/errors.js";

const token = z.string().min(1).max(4_096).regex(/^[A-Za-z0-9_.-]+$/);
const approvalMetadataSchema = z.object({
  schemaVersion: z.literal("boomer-buddy.approval-authorization.v1"),
  authorizations: z.object({ approve: token, reject: token, cancel: token }).strict()
}).strict();
const responseSchema = z.object({
  type: z.literal("object"),
  properties: z.object({ approved: z.object({ type: z.literal("boolean") }).strict() }).strict(),
  required: z.tuple([z.literal("approved")]),
  additionalProperties: z.literal(false)
}).strict();
const interruptSchema = z.object({
  id: z.string(),
  reason: z.literal("approval-required"),
  message: z.string(),
  toolCallId: z.string(),
  expiresAt: z.string(),
  responseSchema,
  metadata: approvalMetadataSchema.optional()
}).strict();
const outcomeSchema = z.union([
  z.object({ type: z.literal("success") }).strict(),
  z.object({ type: z.literal("interrupt"), interrupts: z.array(interruptSchema).min(1).max(1) }).strict()
]);

const eventKeys: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  [EventType.RUN_STARTED]: new Set(["type", "threadId", "runId", "parentRunId", "timestamp"]),
  [EventType.RUN_FINISHED]: new Set(["type", "threadId", "runId", "outcome", "timestamp"]),
  [EventType.RUN_ERROR]: new Set(["type", "message", "code", "timestamp"]),
  [EventType.TEXT_MESSAGE_START]: new Set(["type", "messageId", "role", "name", "timestamp"]),
  [EventType.TEXT_MESSAGE_CONTENT]: new Set(["type", "messageId", "delta", "timestamp"]),
  [EventType.TEXT_MESSAGE_END]: new Set(["type", "messageId", "timestamp"]),
  [EventType.TOOL_CALL_START]: new Set(["type", "toolCallId", "toolCallName", "parentMessageId", "timestamp"]),
  [EventType.TOOL_CALL_ARGS]: new Set(["type", "toolCallId", "delta", "timestamp"]),
  [EventType.TOOL_CALL_END]: new Set(["type", "toolCallId", "timestamp"]),
  [EventType.TOOL_CALL_RESULT]: new Set(["type", "messageId", "toolCallId", "content", "role", "timestamp"]),
  [EventType.STATE_SNAPSHOT]: new Set(["type", "snapshot", "timestamp"]),
  [EventType.STATE_DELTA]: new Set(["type", "delta", "timestamp"]),
  [EventType.CUSTOM]: new Set(["type", "name", "value", "timestamp"])
});

export function validateTransportEvent(value: unknown, input: { stored: boolean }): AGUIEvent {
  const event = validateAgUiEvent(value);
  const allowed = eventKeys[event.type];
  if (!allowed || Object.keys(event).some((key) => !allowed.has(key))) {
    throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  }
  if (event.type === EventType.RUN_FINISHED) {
    const outcome = outcomeSchema.safeParse(event.outcome);
    if (!outcome.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    if (
      input.stored &&
      outcome.data.type === "interrupt" &&
      outcome.data.interrupts.some((interrupt) => interrupt.metadata !== undefined)
    ) {
      throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    }
  }
  return event;
}

export function validateStoredEvents(events: readonly unknown[]): AGUIEvent[] {
  return events.map((event) => validateTransportEvent(event, { stored: true }));
}

export function validateOutboundEvents(events: readonly unknown[]): AGUIEvent[] {
  return events.map((event) => validateTransportEvent(event, { stored: false }));
}
