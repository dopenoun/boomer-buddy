import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventSchemas, EventType } from "@ag-ui/core";
import {
  assertReceiptIsSafe,
  BoomerBuddyRuntime,
  componentRegistry,
  createReminderManifest,
  DeterministicModelProvider,
  executableCapabilityRegistry,
  InMemoryRuntimeStore,
  RuntimeBoundaryError,
  ScriptedModelProvider,
  SequentialIds,
  validateAgUiEvent,
  validateStructuredComponent,
  VaultAuthorizationService
} from "../runtime/index.js";
import type { Clock, ExecutionReceipt, IdSource, ModelProposal, ModelProvider } from "../runtime/index.js";

class MutableClock implements Clock {
  #date: Date;

  constructor(value = "2026-08-11T14:00:00.000Z") {
    this.#date = new Date(value);
  }

  now(): Date {
    return new Date(this.#date);
  }

  advance(milliseconds: number): void {
    this.#date = new Date(this.#date.getTime() + milliseconds);
  }
}

class CollidingActionIds implements IdSource {
  readonly #counts = new Map<string, number>();

  next(prefix: string): string {
    if (prefix === "action") return "action_collision";
    const value = (this.#counts.get(prefix) ?? 0) + 1;
    this.#counts.set(prefix, value);
    return `${prefix}_${value.toString().padStart(6, "0")}`;
  }
}

class EchoReminderProvider implements ModelProvider {
  readonly identifier = "echo-reminder-provider/test";

  async propose(input: Parameters<ModelProvider["propose"]>[0]): Promise<ModelProposal> {
    return {
      capabilityId: "create_reminder",
      arguments: {
        title: input.patronMessage,
        dueAt: "2026-08-12T10:00:00-04:00",
        timeZone: "America/New_York"
      },
      inputProvenance: { source: "patron_message", messageId: input.messageId }
    };
  }
}

function harness(provider: ModelProvider = new DeterministicModelProvider()) {
  const clock = new MutableClock();
  const ids = new SequentialIds();
  const store = new InMemoryRuntimeStore(ids);
  const runtime = new BoomerBuddyRuntime({ clock, ids, provider, store });
  return { clock, ids, runtime, store };
}

const scope = { tenantId: "home-1", patronId: "patron-alice", threadId: "thread-1" } as const;

function customComponent(events: readonly { type: string; name?: string | undefined; value?: unknown }[], key: string) {
  return events.find((event) =>
    event.type === EventType.CUSTOM &&
    event.name === "boomer_buddy.ui" &&
    typeof event.value === "object" &&
    event.value !== null &&
    "component" in event.value &&
    (event.value.component as { key?: string }).key === key
  );
}

async function proposeReminder(runtime: BoomerBuddyRuntime) {
  return runtime.startRun({
    ...scope,
    messageId: "user-message-1",
    content: "Remind me to call Monte tomorrow at 10.",
    timeZone: "America/New_York"
  });
}

describe("golden journeys", () => {
  test("read-only help emits official AG-UI lifecycle, GuideCard, state, and safe receipts", async () => {
    const { runtime, store } = harness();
    const result = await runtime.startRun({
      ...scope,
      messageId: "user-message-help",
      content: "How do I make the text larger on my iPhone?",
      timeZone: "America/New_York"
    });

    assert.equal(result.status, "completed");
    assert.equal(result.events[0]?.type, EventType.RUN_STARTED);
    assert.equal(result.events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.ok(result.events.every((event) => EventSchemas.safeParse(event).success));
    assert.ok(result.events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).length >= 2);
    assert.ok(customComponent(result.events, "GuideCard"));
    assert.ok(result.events.some((event) => event.type === EventType.STATE_SNAPSHOT));
    assert.ok(result.events.some((event) => event.type === EventType.STATE_DELTA));
    assert.deepEqual(store.listReminders(scope), []);
    const receipts = store.listReceipts(scope);
    assert.deepEqual(receipts.map((receipt) => receipt.receiptType).sort(), ["action", "run"]);
    assert.ok(receipts.every((receipt) => receipt.outcome === "succeeded"));
    assert.ok(receipts.every((receipt) => receipt.inputProvenance.contentDigest?.startsWith("sha256:") ?? true));
  });

  test("[SEC-APPROVAL-002] reminder pauses for semantic approval and approval executes exactly once", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);

    assert.equal(proposed.status, "paused");
    assert.ok(proposed.interruptId);
    const card = customComponent(proposed.events, "ReminderConfirmationCard");
    assert.ok(card);
    assert.match(JSON.stringify(card.value), /Set a reminder to call Monte on Wednesday, August 12 at 10:00 AM\?/);
    const finished = proposed.events.at(-1);
    assert.equal(finished?.type, EventType.RUN_FINISHED);
    if (finished?.type === EventType.RUN_FINISHED) assert.equal(finished.outcome?.type, "interrupt");
    assert.deepEqual(store.listReminders(scope), []);

    const resumed = await runtime.resumeFromAgUi({
      ...scope,
      resume: { interruptId: proposed.interruptId, status: "resolved", payload: { approved: true } }
    });
    assert.equal(resumed.status, "completed");
    assert.ok(customComponent(resumed.events, "ActionReceiptCard"));
    assert.equal(store.listReminders(scope).length, 1);
    assert.equal(store.listReminders(scope)[0]?.title, "Call Monte");
  });

  test("rejection creates no reminder", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const result = await runtime.resumeFromAgUi({
      ...scope,
      resume: { interruptId: proposed.interruptId, status: "resolved", payload: { approved: false } }
    });
    assert.equal(result.status, "rejected");
    assert.deepEqual(store.listReminders(scope), []);
    assert.ok(customComponent(result.events, "ActionReceiptCard"));
  });

  test("cancellation creates no reminder", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const result = await runtime.resumeFromAgUi({
      ...scope,
      resume: { interruptId: proposed.interruptId, status: "cancelled" }
    });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(store.listReminders(scope), []);
    assert.ok(customComponent(result.events, "SafetyNoticeCard"));
  });

  test("expired approval times out and creates no reminder", async () => {
    const { clock, runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    clock.advance(6 * 60_000);
    const result = await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" });
    assert.equal(result.status, "timed-out");
    assert.deepEqual(store.listReminders(scope), []);
    assert.ok(customComponent(result.events, "SafetyNoticeCard"));
  });
});

describe("authority and idempotency", () => {
  test("[SEC-IDEMP-001] duplicate approval/resume is idempotent", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const first = await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" });
    const second = await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" });
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(store.listReminders(scope).length, 1);
    assert.match(JSON.stringify(customComponent(second.events, "ActionReceiptCard")?.value), /already created/i);
  });

  test("[SEC-IDEMP-002] concurrent reconnect approvals execute one mutation", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const [first, second] = await Promise.all([
      runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" }),
      runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" })
    ]);
    assert.deepEqual([first.status, second.status], ["completed", "completed"]);
    assert.equal(store.listReminders(scope).length, 1);
  });

  test("a finalized rejection cannot later be turned into approval", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "reject" });
    const second = await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" });
    assert.equal(second.status, "failed");
    assert.equal(second.events.at(-1)?.type, EventType.RUN_ERROR);
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-APPROVAL-001] malformed direct decisions fail closed instead of defaulting to approval", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const result = await runtime.resume({
      ...scope,
      interruptId: proposed.interruptId,
      decision: "yes" as "approve"
    });
    assert.equal(result.status, "failed");
    const error = result.events.at(-1);
    if (error?.type === EventType.RUN_ERROR) assert.equal(error.code, "MALFORMED_RESUME_REQUEST");
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-SCOPE-001] cross-patron resume is denied", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const result = await runtime.resume({
      tenantId: scope.tenantId,
      patronId: "patron-bob",
      threadId: scope.threadId,
      interruptId: proposed.interruptId,
      decision: "approve"
    });
    assert.equal(result.status, "failed");
    const error = result.events.at(-1);
    assert.equal(error?.type, EventType.RUN_ERROR);
    if (error?.type === EventType.RUN_ERROR) assert.equal(error.code, "CROSS_PATRON_ACCESS");
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-SCOPE-002] tenant and thread mismatches cannot read or mutate a pending action", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const wrongTenant = await runtime.resume({
      tenantId: "home-2",
      patronId: scope.patronId,
      threadId: scope.threadId,
      interruptId: proposed.interruptId,
      decision: "approve"
    });
    const wrongThread = await runtime.resume({
      tenantId: scope.tenantId,
      patronId: scope.patronId,
      threadId: "thread-2",
      interruptId: proposed.interruptId,
      decision: "approve"
    });
    assert.deepEqual([wrongTenant.status, wrongThread.status], ["failed", "failed"]);
    assert.deepEqual(store.listReminders(scope), []);
    const wrongTenantReceipts = store.listReceipts({ tenantId: "home-2", patronId: scope.patronId });
    assert.equal(wrongTenantReceipts.length, 1);
    assert.equal(wrongTenantReceipts[0]?.safeErrorCode, "CROSS_PATRON_ACCESS");
    assert.equal(wrongTenantReceipts[0]?.actionId, null);
    assert.deepEqual(store.listReminders({ tenantId: scope.tenantId, patronId: "patron-bob" }), []);
  });

  test("[SEC-SCOPE-003] colliding action identifiers cannot disclose another patron's reminder", async () => {
    const clock = new MutableClock();
    const ids = new CollidingActionIds();
    const store = new InMemoryRuntimeStore(ids);
    const runtime = new BoomerBuddyRuntime({ clock, ids, provider: new EchoReminderProvider(), store });
    const aliceScope = { tenantId: "home-1", patronId: "patron-alice", threadId: "thread-alice" };
    const bobScope = { tenantId: "home-1", patronId: "patron-bob", threadId: "thread-bob" };

    const alice = await runtime.startRun({
      ...aliceScope,
      messageId: "message-alice",
      content: "Alice private reminder",
      timeZone: "America/New_York"
    });
    assert.ok(alice.interruptId);
    await runtime.resume({ ...aliceScope, interruptId: alice.interruptId, decision: "approve" });

    const bob = await runtime.startRun({
      ...bobScope,
      messageId: "message-bob",
      content: "Bob reminder",
      timeZone: "America/New_York"
    });
    assert.ok(bob.interruptId);
    const bobResult = await runtime.resume({ ...bobScope, interruptId: bob.interruptId, decision: "approve" });

    assert.equal(bobResult.status, "completed");
    assert.equal(JSON.stringify(bobResult.events).includes("Alice private reminder"), false);
    assert.equal(store.listReminders(bobScope)[0]?.title, "Bob reminder");
  });

  test("[SEC-CAP-001] model cannot request an unregistered capability", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "run_shell",
      arguments: { command: "whoami" },
      inputProvenance: { source: "patron_message", messageId: "malicious-1" }
    });
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "malicious-1", content: "do it", timeZone: "UTC" });
    assert.equal(result.status, "failed");
    const error = result.events.at(-1);
    if (error?.type === EventType.RUN_ERROR) assert.equal(error.code, "UNREGISTERED_CAPABILITY");
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-PROVIDER-001] provider cannot forge proposal provenance", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "search_help_catalog",
      arguments: { query: "make text larger" },
      inputProvenance: { source: "patron_message", messageId: "different-message" }
    });
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({
      ...scope,
      messageId: "trusted-message",
      content: "make text larger",
      timeZone: "UTC"
    });
    assert.equal(result.status, "failed");
    const error = result.events.at(-1);
    if (error?.type === EventType.RUN_ERROR) assert.equal(error.code, "PROVIDER_PROVENANCE_MISMATCH");
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-PROVIDER-002] provider-controlled RuntimeBoundaryError text is replaced with a canonical safe message", async () => {
    const privateText = "private patron detail that must not be emitted";
    const provider: ModelProvider = {
      identifier: "malicious-provider/test",
      async propose() {
        throw new RuntimeBoundaryError("NO_ALLOWED_CAPABILITY", privateText);
      }
    };
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "safe-message", content: "help", timeZone: "UTC" });
    assert.equal(result.status, "failed");
    assert.equal(JSON.stringify(result.events).includes(privateText), false);
    assert.equal(JSON.stringify(store.listReceipts(scope)).includes(privateText), false);
  });

  test("[SEC-PROVIDER-003] provider identifier is a bounded opaque label", () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "search_help_catalog",
      arguments: { query: "make text larger" },
      inputProvenance: { source: "patron_message", messageId: "message-1" }
    }, "provider secret with spaces");
    assert.throws(
      () => harness(provider),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "PROVIDER_CONFIGURATION_INVALID"
    );
  });

  test("[SEC-PROVIDER-004] provider receives an immutable exact capability allowlist", async () => {
    const provider: ModelProvider = {
      identifier: "allowlist-provider/test",
      async propose(input) {
        assert.deepEqual(input.allowedCapabilityIds.slice().sort(), ["create_reminder", "search_help_catalog"]);
        assert.throws(() => (input.allowedCapabilityIds as string[]).push("run_shell"));
        return {
          capabilityId: "search_help_catalog",
          arguments: { query: "make text larger" },
          inputProvenance: { source: "patron_message", messageId: input.messageId }
        };
      }
    };
    const { runtime } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "allowlist-message", content: "larger text", timeZone: "UTC" });
    assert.equal(result.status, "completed");
  });

  test("[SEC-POLICY-005] executable manifests and the component registry cannot be replaced at runtime", () => {
    assert.equal(Object.isFrozen(executableCapabilityRegistry), true);
    assert.equal(Object.isFrozen(createReminderManifest), true);
    assert.equal(Object.isFrozen(componentRegistry), true);
    assert.throws(() => {
      (componentRegistry as Record<string, unknown>).TerminalCard = { executable: true };
    });
  });

  test("[SEC-INPUT-001] malformed client run envelopes fail before provider invocation", async () => {
    let invoked = false;
    const provider: ModelProvider = {
      identifier: "counting-provider/test",
      async propose() {
        invoked = true;
        throw new Error("must not run");
      }
    };
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({
      ...scope,
      messageId: "../../raw-secret",
      content: "help",
      timeZone: "UTC"
    });
    assert.equal(result.status, "failed");
    assert.equal(invoked, false);
    assert.deepEqual(store.listReceipts(scope), []);
  });

  test("[SEC-APPROVAL-003] control-character approval text is rejected before an interrupt exists", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "create_reminder",
      arguments: {
        title: "Call Monte\u202EApprove hidden text",
        dueAt: "2026-08-12T10:00:00-04:00",
        timeZone: "America/New_York"
      },
      inputProvenance: { source: "patron_message", messageId: "bidi-message" }
    });
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "bidi-message", content: "remind me", timeZone: "UTC" });
    assert.equal(result.status, "failed");
    assert.equal(result.interruptId, null);
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-APPROVAL-004] an unsafe confirmation card cannot leave a resumable orphan action", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "create_reminder",
      arguments: {
        title: "<script>approve()</script>",
        dueAt: "2026-08-12T10:00:00-04:00",
        timeZone: "America/New_York"
      },
      inputProvenance: { source: "patron_message", messageId: "unsafe-card-message" }
    });
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({
      ...scope,
      messageId: "unsafe-card-message",
      content: "remind me",
      timeZone: "UTC"
    });
    assert.equal(result.status, "failed");
    assert.equal(result.interruptId, null);
    const guessedResume = await runtime.resume({ ...scope, interruptId: "interrupt_000004", decision: "approve" });
    assert.equal(guessedResume.status, "failed");
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-CAP-002] tool argument schema violation is rejected before execution", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "create_reminder",
      arguments: { title: "Call Monte", dueAt: "tomorrow", timeZone: "UTC", command: "rm -rf" },
      inputProvenance: { source: "patron_message", messageId: "bad-args" }
    });
    const { runtime, store } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "bad-args", content: "remind me", timeZone: "UTC" });
    assert.equal(result.status, "failed");
    const error = result.events.at(-1);
    if (error?.type === EventType.RUN_ERROR) assert.equal(error.code, "INVALID_TOOL_ARGUMENTS");
    assert.deepEqual(store.listReminders(scope), []);
    assert.ok(store.listReceipts(scope).some((receipt) =>
      receipt.receiptType === "action" &&
      receipt.capabilityId === "create_reminder" &&
      receipt.outcome === "failed"
    ));
  });

  test("[SEC-CAP-003] only the two narrow capabilities are executable", () => {
    assert.deepEqual(Object.keys(executableCapabilityRegistry).sort(), ["create_reminder", "search_help_catalog"]);
    const serialized = JSON.stringify(executableCapabilityRegistry).toLowerCase();
    for (const forbidden of ["shell", "terminal", "filesystem", "fetch_url", "arbitrary", "generic_mcp", "eval"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

describe("closed UI and AG-UI boundary", () => {
  test("[SEC-UI-001] arbitrary component code and dangerous properties are rejected", () => {
    assert.throws(
      () => validateStructuredComponent({
        key: "GuideCard",
        props: {
          title: "Unsafe",
          summary: "Hello",
          steps: ["One"],
          source: { kind: "local_help_catalog", articleId: "safe", lastReviewedAt: "2026-08-11" },
          nextMove: "Next",
          dangerouslySetInnerHTML: { __html: "<script>alert(1)</script>" }
        }
      }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNSAFE_COMPONENT_PROPERTY"
    );
  });

  test("[SEC-UI-002] executable text variants are rejected from every closed component", () => {
    for (const payload of ["<img src=x onerror=alert(1)>", "javascript:alert(1)", "value => ({run: true})"]) {
      assert.throws(
        () => validateStructuredComponent({
          key: "SafetyNoticeCard",
          props: { title: "Safe title", message: payload, code: "SAFE_FAILURE", nextMove: "Stop" }
        }),
        (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNSAFE_COMPONENT_PAYLOAD"
      );
    }
  });

  test("unknown component key is rejected", () => {
    assert.throws(
      () => validateStructuredComponent({ key: "TerminalCard", props: {} }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNKNOWN_COMPONENT"
    );
    assert.throws(
      () => validateStructuredComponent({ key: "toString", props: {} }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNKNOWN_COMPONENT"
    );
  });

  test("oversized and malformed component payloads are rejected", () => {
    assert.throws(() => validateStructuredComponent({ key: "SafetyNoticeCard", props: { title: "x".repeat(20_000) } }));
    assert.throws(() => validateStructuredComponent({ key: "GuideCard", props: { title: "Missing fields" } }));
  });

  test("[SEC-AGUI-001] malformed AG-UI event and malformed state delta are rejected", () => {
    assert.throws(
      () => validateAgUiEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message-1" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_AG_UI_EVENT"
    );
    assert.throws(
      () => validateAgUiEvent({ type: EventType.STATE_DELTA, delta: [{ op: "execute", path: "/status" }] }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_STATE_DELTA"
    );
    assert.throws(
      () => validateAgUiEvent({ type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/__proto__/polluted", value: true }] }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_STATE_DELTA"
    );
    assert.throws(
      () => validateAgUiEvent({ type: EventType.MESSAGES_SNAPSHOT, messages: [] }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNSUPPORTED_AG_UI_EVENT"
    );
    assert.throws(
      () => validateAgUiEvent({ type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/status", value: { forged: true } }] }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_STATE_DELTA"
    );
    assert.throws(
      () => validateAgUiEvent({ type: EventType.TOOL_CALL_START, toolCallId: "tool-1", toolCallName: "run_shell" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "UNREGISTERED_CAPABILITY"
    );
    assert.throws(
      () => validateAgUiEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "x".repeat(70_000)
      }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_AG_UI_EVENT"
    );
  });

  test("[SEC-AGUI-002] malformed official AG-UI resume payload is rejected", async () => {
    const { runtime } = harness();
    await assert.rejects(
      runtime.resumeFromAgUi({
        ...scope,
        resume: { interruptId: "interrupt-1", status: "resolved", payload: { approved: "yes" } }
      }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_AG_UI_RESUME"
    );
    await assert.rejects(
      runtime.resumeFromAgUi({
        ...scope,
        resume: { interruptId: "interrupt-1", status: "resolved", payload: { approved: true }, forged: true }
      }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "MALFORMED_AG_UI_RESUME"
    );
  });
});

describe("disconnect, vault, and receipt safety", () => {
  test("[SEC-RECONNECT-001] disconnected client cannot cause mutation and can reconnect to resume", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const controller = new AbortController();
    controller.abort();
    const disconnected = await runtime.resume({
      ...scope,
      interruptId: proposed.interruptId,
      decision: "approve",
      signal: controller.signal
    });
    assert.equal(disconnected.status, "failed");
    assert.deepEqual(store.listReminders(scope), []);
    const resumed = await runtime.resume({ ...scope, interruptId: proposed.interruptId, decision: "approve" });
    assert.equal(resumed.status, "completed");
    assert.equal(store.listReminders(scope).length, 1);
  });

  test("already disconnected initial client causes no action or mutation", async () => {
    const { runtime, store } = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.startRun({
      ...scope,
      messageId: "disconnected-start",
      content: "Remind me to call Monte tomorrow at 10.",
      timeZone: "America/New_York",
      signal: controller.signal
    });
    assert.equal(result.status, "failed");
    assert.equal(result.actionId, null);
    assert.deepEqual(store.listReminders(scope), []);
  });

  test("[SEC-TOKEN-001] vault authorization is short-lived, scoped, single-use, and rejects replay", () => {
    const clock = new MutableClock();
    const service = new VaultAuthorizationService(clock, new SequentialIds());
    const grant = {
      patronId: scope.patronId,
      capabilityId: "read_unlocked_vault_item",
      verifiedGrantId: "native-grant-0000000001",
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString()
    };
    const authorization = service.issue(grant);
    assert.deepEqual(Object.keys(authorization).sort(), ["authorizationId", "capabilityId", "expiresAt", "patronId"]);
    service.consume(authorization.authorizationId, scope.patronId, "read_unlocked_vault_item");
    assert.throws(
      () => service.consume(authorization.authorizationId, scope.patronId, "read_unlocked_vault_item"),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "VAULT_AUTH_REPLAY"
    );
    assert.throws(
      () => service.issue(grant),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "VAULT_GRANT_REPLAY"
    );
  });

  test("[SEC-TOKEN-002] stale and cross-scope vault grants are rejected", () => {
    const clock = new MutableClock();
    const service = new VaultAuthorizationService(clock, new SequentialIds());
    assert.throws(() => service.issue({
      patronId: scope.patronId,
      capabilityId: "read_unlocked_vault_item",
      verifiedGrantId: "native-grant-stale-0001",
      expiresAt: new Date(clock.now().getTime() - 1).toISOString()
    }));
    const authorization = service.issue({
      patronId: scope.patronId,
      capabilityId: "read_unlocked_vault_item",
      verifiedGrantId: "native-grant-scoped-0001",
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString()
    });
    assert.throws(
      () => service.consume(authorization.authorizationId, "patron-bob", "read_unlocked_vault_item"),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "VAULT_AUTH_SCOPE"
    );
  });

  test("[SEC-TOKEN-003] an issued authorization cannot be consumed after expiry", () => {
    const clock = new MutableClock();
    const service = new VaultAuthorizationService(clock, new SequentialIds());
    const authorization = service.issue({
      patronId: scope.patronId,
      capabilityId: "read_unlocked_vault_item",
      verifiedGrantId: "native-grant-expiring-0001",
      expiresAt: new Date(clock.now().getTime() + 1_000).toISOString()
    });
    clock.advance(1_001);
    assert.throws(
      () => service.consume(authorization.authorizationId, scope.patronId, "read_unlocked_vault_item"),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "VAULT_AUTH_STALE"
    );
  });

  test("[SEC-RECEIPT-001] raw patron content and secrets do not leak into receipts", async () => {
    const { runtime, store } = harness();
    const secret = "sk-supersecret123456789";
    await runtime.startRun({
      ...scope,
      messageId: "secret-message",
      content: `How do I make the text larger on my iPhone? ${secret}`,
      timeZone: "America/New_York"
    });
    const serialized = JSON.stringify(store.listReceipts(scope));
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("How do I make"), false);

    const unsafe = {
      ...store.listReceipts(scope)[0],
      safeErrorCode: secret
    } as ExecutionReceipt;
    assert.throws(
      () => assertReceiptIsSafe(unsafe),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "SENSITIVE_RECEIPT_VALUE"
    );
  });
});

describe("explicit v0 product-boundary limitations", () => {
  test("[LIMIT-AUTH-001] exact scope identifiers and interrupt possession are treated as approval authority", async () => {
    const { runtime, store } = harness();
    const proposed = await proposeReminder(runtime);
    assert.ok(proposed.interruptId);
    const forgedByCaller = await runtime.resume({
      ...scope,
      interruptId: proposed.interruptId,
      decision: "approve"
    });
    assert.equal(forgedByCaller.status, "completed");
    assert.equal(store.listReminders(scope).length, 1);
  });

  test("[LIMIT-PROVIDER-001] in-process provider code runs outside proposal policy", async () => {
    let externalSideEffect = false;
    const provider: ModelProvider = {
      identifier: "side-effect-provider/test",
      async propose(input) {
        externalSideEffect = true;
        return {
          capabilityId: "run_shell",
          arguments: {},
          inputProvenance: { source: "patron_message", messageId: input.messageId }
        };
      }
    };
    const { runtime } = harness(provider);
    const result = await runtime.startRun({ ...scope, messageId: "provider-side-effect", content: "help", timeZone: "UTC" });
    assert.equal(externalSideEffect, true);
    assert.equal(result.status, "failed");
  });

  test("[LIMIT-TOKEN-001] vault grant authenticity is a trusted-adapter precondition", () => {
    const clock = new MutableClock();
    const service = new VaultAuthorizationService(clock, new SequentialIds());
    const syntacticallyValidButUnsigned = service.issue({
      patronId: scope.patronId,
      capabilityId: "read_unlocked_vault_item",
      verifiedGrantId: "caller-chosen-grant-0001",
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString()
    });
    assert.equal(syntacticallyValidButUnsigned.patronId, scope.patronId);
  });

  test("[LIMIT-DURABILITY-001] pending approvals do not survive a process-local store replacement", async () => {
    const first = harness();
    const proposed = await proposeReminder(first.runtime);
    assert.ok(proposed.interruptId);
    const restarted = harness();
    const resumed = await restarted.runtime.resume({
      ...scope,
      interruptId: proposed.interruptId,
      decision: "approve"
    });
    assert.equal(resumed.status, "failed");
    assert.deepEqual(restarted.store.listReminders(scope), []);
  });
});
