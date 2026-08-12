import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { EventType } from "@ag-ui/core";
import type { AGUIEvent } from "@ag-ui/core";
import {
  BoomerBuddyRuntime,
  contentDigest,
  DeterministicModelProvider,
  RandomIds,
  RuntimeBoundaryError,
  ScriptedModelProvider,
  SequentialIds
} from "../runtime/index.js";
import type { Clock, IdSource, ModelProvider, PendingAction } from "../runtime/types.js";
import {
  ApprovalAuthorizationService,
  authorizationDigest,
  DeterministicTestIdentityAdapter,
  PatronTransportHttpAdapter,
  SqliteRuntimeStore,
  validateOutboundEvents,
  validateStoredEvents
} from "../transport/index.js";
import type {
  ApprovalAuthorizationSet,
  TransportAuditRecord,
  TransportAuditSink,
  PatronIdentityVerifier,
  VerifiedPatronIdentity
} from "../transport/types.js";

const tempDirectories: string[] = [];
const approvalKey = Buffer.from("approval-test-key-32-bytes-minimum!!", "utf8");
const identityKey = Buffer.from("identity-test-key-32-bytes-minimum!!", "utf8");
const audience = "boomer-buddy-patron-transport-v1";
const issuer = "boomer-buddy-reference-server";
const baseScope = { tenantId: "tenant-family", patronId: "patron-alice", threadId: "thread-care" };

afterEach(() => {
  while (tempDirectories.length) {
    const directory = tempDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

class MutableClock implements Clock {
  #value: Date;

  constructor(value = "2026-08-11T14:00:00.000Z") {
    this.#value = new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }

  advance(milliseconds: number): void {
    this.#value = new Date(this.#value.getTime() + milliseconds);
  }
}

class RecordingAudit implements TransportAuditSink {
  readonly entries: TransportAuditRecord[] = [];

  record(entry: TransportAuditRecord): void {
    this.entries.push(structuredClone(entry));
  }
}

type Harness = {
  adapter: PatronTransportHttpAdapter;
  approvals: ApprovalAuthorizationService;
  clock: MutableClock;
  identity: DeterministicTestIdentityAdapter;
  identityToken: string;
  identityValue: VerifiedPatronIdentity;
  ids: IdSource;
  path: string;
  runtime: BoomerBuddyRuntime;
  store: SqliteRuntimeStore;
};

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "boomer-buddy-transport-"));
  tempDirectories.push(directory);
  return join(directory, "transport.sqlite");
}

function harness(input: {
  path?: string;
  clock?: MutableClock;
  ids?: IdSource;
    provider?: ModelProvider;
    audit?: TransportAuditSink;
    identityVerifier?: PatronIdentityVerifier;
    identityTimeoutMs?: number;
    busyTimeoutMs?: number;
  } = {}): Harness {
  const clock = input.clock ?? new MutableClock();
  const ids = input.ids ?? new SequentialIds();
  const path = input.path ?? databasePath();
  const store = new SqliteRuntimeStore({ path, ids, ...(input.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: input.busyTimeoutMs }) });
  const identity = new DeterministicTestIdentityAdapter({ key: identityKey, audience, issuer, clock, ids });
  const approvals = new ApprovalAuthorizationService({ key: approvalKey, audience, issuer, clock, ids });
  const runtime = new BoomerBuddyRuntime({
    clock,
    ids,
    provider: input.provider ?? new DeterministicModelProvider(),
    store
  });
  const adapter = new PatronTransportHttpAdapter({
    runtime,
    runtimeStore: store,
    transportStore: store,
    identityVerifier: input.identityVerifier ?? identity,
    approvalAuthorizations: approvals,
    clock,
    ...(input.audit ? { audit: input.audit } : {}),
    ...(input.identityTimeoutMs === undefined ? {} : { identityTimeoutMs: input.identityTimeoutMs })
  });
  const identityToken = identity.issue({ ...baseScope, sessionId: "session-alice" });
  return {
    adapter,
    approvals,
    clock,
    identity,
    identityToken,
    identityValue: {
      tenantId: baseScope.tenantId,
      patronId: baseScope.patronId,
      sessionId: "session-alice",
      audience,
      authenticationMethod: "deterministic-hmac-test-only"
    },
    ids,
    path,
    runtime,
    store
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function signedApproval(payload: unknown, input: { key?: Buffer; header?: unknown; rawPayload?: string } = {}): string {
  const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
  const header = encode(canonicalJson(input.header ?? { algorithm: "HS256", type: "BB-APPROVAL-V1" }));
  const body = encode(input.rawPayload ?? canonicalJson(payload));
  const signature = createHmac("sha256", input.key ?? approvalKey).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function decodedApproval(token: string): Record<string, unknown> {
  const body = token.split(".")[1];
  assert.ok(body);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

function adapterWithIdentity(value: Harness, verifier: PatronIdentityVerifier, identityTimeoutMs = 25): PatronTransportHttpAdapter {
  return new PatronTransportHttpAdapter({
    runtime: value.runtime,
    runtimeStore: value.store,
    transportStore: value.store,
    identityVerifier: verifier,
    approvalAuthorizations: value.approvals,
    clock: value.clock,
    identityTimeoutMs
  });
}

function startBody(runId = "client-run-1", content = "Remind me to call Monte tomorrow at 10 AM", threadId = baseScope.threadId): object {
  return {
    threadId,
    runId,
    state: {},
    messages: [{ id: `message-${runId}`, role: "user", content }],
    tools: [],
    context: [],
    forwardedProps: { timeZone: "America/New_York" }
  };
}

function startRequest(token: string, body: object, runId: string, overrides: { accept?: string; contentType?: string } = {}): Request {
  const threadId = typeof body === "object" && body && "threadId" in body ? String(body.threadId) : baseScope.threadId;
  return new Request(`https://transport.invalid/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: {
      accept: overrides.accept ?? "text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": overrides.contentType ?? "application/json",
      "idempotency-key": runId
    },
    body: JSON.stringify(body)
  });
}

function resumeBody(input: {
  interruptId: string;
  parentRunId: string;
  token: string;
  runId?: string;
  decision?: "approve" | "reject" | "cancel";
  threadId?: string;
}): object {
  const decision = input.decision ?? "approve";
  return {
    threadId: input.threadId ?? baseScope.threadId,
    runId: input.runId ?? "client-resume-1",
    parentRunId: input.parentRunId,
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { approvalAuthorization: input.token },
    resume: [decision === "cancel" ? {
      interruptId: input.interruptId,
      status: "cancelled"
    } : {
      interruptId: input.interruptId,
      status: "resolved",
      payload: { approved: decision === "approve" }
    }]
  };
}

function resumeRequest(identityToken: string, body: object, runId: string): Request {
  const threadId = typeof body === "object" && body && "threadId" in body ? String(body.threadId) : baseScope.threadId;
  return new Request(`https://transport.invalid/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${identityToken}`,
      "content-type": "application/json",
      "idempotency-key": runId
    },
    body: JSON.stringify(body)
  });
}

async function eventsFrom(response: Response): Promise<AGUIEvent[]> {
  const body = await response.text();
  return body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as unknown)
    .map((event) => {
      const validated = validateOutboundEvents([event as AGUIEvent])[0];
      if (!validated) throw new Error("missing SSE event");
      return validated;
    });
}

function interrupted(events: readonly AGUIEvent[]): {
  action: { interruptId: string; parentRunId: string };
  tokens: ApprovalAuthorizationSet;
} {
  const finished = events.find((event) => event.type === EventType.RUN_FINISHED && event.outcome?.type === "interrupt");
  assert.ok(finished && finished.type === EventType.RUN_FINISHED && finished.outcome?.type === "interrupt");
  const interrupt = finished.outcome.interrupts[0];
  assert.ok(interrupt);
  const metadata = interrupt.metadata as { authorizations?: ApprovalAuthorizationSet } | undefined;
  assert.ok(metadata?.authorizations);
  return {
    action: { interruptId: interrupt.id, parentRunId: finished.runId },
    tokens: metadata.authorizations
  };
}

async function proposeReminder(value: Harness, runId = "client-run-1"): Promise<ReturnType<typeof interrupted>> {
  const response = await value.adapter.handle(startRequest(value.identityToken, startBody(runId), runId));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  return interrupted(await eventsFrom(response));
}

function actionFor(value: Harness, interruptId: string): PendingAction {
  return value.store.getPendingAction(baseScope, interruptId);
}

describe("authenticated HTTP/SSE patron transport", () => {
  test("[TR-AUTH-001] forged identity is rejected before runtime scope is accepted", async () => {
    const value = harness();
    const forged = `${value.identityToken.slice(0, -1)}${value.identityToken.endsWith("A") ? "B" : "A"}`;
    const response = await value.adapter.handle(startRequest(forged, startBody(), "client-run-1"));
    assert.equal(response.status, 401);
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-AUTH-002] verifier output, failures, timeouts, and cancellation fail closed", async () => {
    const value = harness();
    const invalidIdentities: unknown[] = [
      { ...value.identityValue, patronId: "" },
      { ...value.identityValue, patronId: "patron-Ａlice" },
      { ...value.identityValue, patronId: "default" },
      { ...value.identityValue, extra: "scope" },
      { ...value.identityValue, tenantId: "tenant-family", sessionId: "session\u0301" },
      { ...value.identityValue, audience: "another-service" }
    ];
    for (const [index, identityValue] of invalidIdentities.entries()) {
      const verifier: PatronIdentityVerifier = { verify: async () => identityValue as VerifiedPatronIdentity };
      const response = await adapterWithIdentity(value, verifier).handle(
        startRequest(value.identityToken, startBody(`invalid-identity-${index}`), `invalid-identity-${index}`)
      );
      assert.equal(response.status, 401);
    }

    const thrown = await adapterWithIdentity(value, { verify: async () => { throw new Error("identity-secret"); } }).handle(
      startRequest(value.identityToken, startBody("identity-error"), "identity-error")
    );
    assert.equal(thrown.status, 401);
    assert.equal((await thrown.text()).includes("identity-secret"), false);

    const never: PatronIdentityVerifier = { verify: () => new Promise<VerifiedPatronIdentity>(() => undefined) };
    const timedOut = await adapterWithIdentity(value, never, 5).handle(
      startRequest(value.identityToken, startBody("identity-timeout"), "identity-timeout")
    );
    assert.equal(timedOut.status, 401);

    const controller = new AbortController();
    const cancelledRequest = new Request("https://transport.invalid/v1/threads/thread-care/runs", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}`, "content-type": "application/json", "idempotency-key": "identity-cancel" },
      body: JSON.stringify(startBody("identity-cancel")),
      signal: controller.signal
    });
    const pending = adapterWithIdentity(value, never, 1_000).handle(cancelledRequest);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 400);
    assert.equal(value.store.listReminders(baseScope).length, 0);
    assert.equal(value.store.listReceipts(baseScope).length, 0);
  });

  test("[TR-AUTH-004] identity verification cannot consume the patron request body", async () => {
    const value = harness();
    let verifierBody = "not-read";
    const verifier: PatronIdentityVerifier = {
      async verify(request) {
        verifierBody = await request.text();
        return value.identityValue;
      }
    };
    const response = await adapterWithIdentity(value, verifier).handle(
      startRequest(value.identityToken, startBody("identity-body", "make text larger"), "identity-body")
    );
    assert.equal(verifierBody, "");
    assert.equal(response.status, 200);
    assert.equal(value.store.listReceipts(baseScope).length, 2);
  });

  test("[TR-AUTH-003] absent, malformed, duplicate, conflicting, and case-variant identity headers are rejected", async () => {
    const value = harness();
    const make = (authorizationHeaders: string[]): Request => {
      const headers = new Headers({ accept: "text/event-stream", "content-type": "application/json", "idempotency-key": "identity-header" });
      authorizationHeaders.forEach((header) => headers.append("Authorization", header));
      return new Request("https://transport.invalid/v1/threads/thread-care/runs", {
        method: "POST",
        headers,
        body: JSON.stringify(startBody("identity-header"))
      });
    };
    const cases = [
      make([]),
      make([`bearer ${value.identityToken}`]),
      make([`Bearer ${value.identityToken}`, `Bearer ${value.identityToken}`]),
      make([`Bearer ${value.identityToken}`, "Bearer forged"]),
      make([`Bearer  ${value.identityToken}`])
    ];
    for (const request of cases) assert.equal((await value.adapter.handle(request)).status, 401);
    assert.equal(value.store.listReceipts(baseScope).length, 0);
  });

  test("[TR-SIGN-001] missing and altered approval signatures are rejected", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const altered = `${pending.tokens.approve.slice(0, -1)}${pending.tokens.approve.endsWith("A") ? "B" : "A"}`;
    for (const [index, token] of ["unsigned", altered].entries()) {
      const runId = `bad-signature-${index}`;
      const body = resumeBody({ ...pending.action, token, runId });
      const response = await value.adapter.handle(resumeRequest(value.identityToken, body, runId));
      assert.equal(response.status, 403);
    }
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-SIGN-002] canonical encoding, strict signed fields, algorithms, keys, and signature lengths fail closed", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const claims = decodedApproval(pending.tokens.approve);
    const canonical = canonicalJson(claims);
    const duplicateDecision = canonical.replace('"decision":"approve"', '"decision":"approve","decision":"reject"');
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(claims).reverse()));
    const signatureParts = pending.tokens.approve.split(".");
    const canonicalSignature = signatureParts[2];
    assert.ok(canonicalSignature);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = canonicalSignature.at(-1);
    assert.ok(last);
    const nonCanonicalLast = [...alphabet].find((candidate) =>
      candidate !== last && Buffer.from(`${canonicalSignature.slice(0, -1)}${candidate}`, "base64url").equals(Buffer.from(canonicalSignature, "base64url"))
    );
    assert.ok(nonCanonicalLast);
    const nonCanonicalSignature = `${signatureParts[0]}.${signatureParts[1]}.${canonicalSignature.slice(0, -1)}${nonCanonicalLast}`;
    assert.deepEqual(Buffer.from(nonCanonicalSignature.split(".")[2]!, "base64url"), Buffer.from(canonicalSignature, "base64url"));

    const variants = [
      signedApproval(claims, { rawPayload: reordered }),
      signedApproval(claims, { rawPayload: duplicateDecision }),
      signedApproval({ ...claims, extra: "unsigned-semantics" }),
      signedApproval(Object.fromEntries(Object.entries(claims).filter(([key]) => key !== "purpose"))),
      signedApproval({ ...claims, purpose: "boomer-buddy.other" }),
      signedApproval({ ...claims, capabilityId: "search_help_catalog" }),
      signedApproval({ ...claims, tenantId: "tenant-other" }),
      signedApproval({ ...claims, patronId: "patron-other" }),
      signedApproval({ ...claims, sessionId: "session-other" }),
      signedApproval({ ...claims, threadId: "thread-other" }),
      signedApproval({ ...claims, runId: "run-other" }),
      signedApproval({ ...claims, actionId: "action-other" }),
      signedApproval({ ...claims, interruptId: "interrupt-other" }),
      signedApproval({ ...claims, decision: "reject" }),
      signedApproval({ ...claims, issuer: "issuer-other" }),
      signedApproval(claims, { header: { algorithm: "none", type: "BB-APPROVAL-V1" } }),
      signedApproval(claims, { header: { algorithm: "HS256", type: "BB-APPROVAL-V1", kid: "confused" } }),
      signedApproval(claims, { header: { algorithm: "HS256", type: "BB-OTHER" } }),
      signedApproval(claims, { key: Buffer.from("wrong-approval-key-32-bytes-minimum!", "utf8") }),
      `${signatureParts[0]}.${signatureParts[1]}.deadbeef`,
      nonCanonicalSignature
    ];
    for (const [index, token] of variants.entries()) {
      const runId = `strict-signature-${index}`;
      const response = await value.adapter.handle(resumeRequest(value.identityToken, resumeBody({ ...pending.action, token, runId }), runId));
      assert.equal(response.status, 403, `variant ${index}`);
    }
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-BIND-001] wrong patron, action, run, thread, audience, and decision bindings fail closed", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const action = actionFor(value, pending.action.interruptId);
    const cases: Array<{ name: string; body: object; identityToken?: string; status?: number }> = [];

    const wrongPatronIdentity = { ...value.identityValue, patronId: "patron-bob" };
    cases.push({
      name: "patron",
      body: resumeBody({ ...pending.action, token: value.approvals.issue(wrongPatronIdentity, action).approve, runId: "wrong-patron" })
    });
    cases.push({
      name: "action",
      body: resumeBody({ ...pending.action, token: value.approvals.issue(value.identityValue, { ...action, actionId: "action-substituted" }).approve, runId: "wrong-action" })
    });
    cases.push({
      name: "run",
      body: resumeBody({ ...pending.action, parentRunId: "run-substituted", token: pending.tokens.approve, runId: "wrong-run" })
    });
    cases.push({
      name: "thread",
      body: resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "wrong-thread", threadId: "thread-other" }),
      status: 404
    });
    const otherAudience = new ApprovalAuthorizationService({
      key: approvalKey,
      audience: "another-service",
      issuer,
      clock: value.clock,
      ids: value.ids
    });
    cases.push({
      name: "audience",
      body: resumeBody({ ...pending.action, token: otherAudience.issue(value.identityValue, action).approve, runId: "wrong-audience" })
    });
    cases.push({
      name: "decision",
      body: resumeBody({ ...pending.action, token: pending.tokens.reject, runId: "wrong-decision" })
    });

    for (const item of cases) {
      const runId = (item.body as { runId: string }).runId;
      const response = await value.adapter.handle(resumeRequest(item.identityToken ?? value.identityToken, item.body, runId));
      assert.equal(response.status, item.status ?? 403, item.name);
    }
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-TIME-001] expired and not-yet-valid approval authorizations are rejected", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const action = actionFor(value, pending.action.interruptId);
    const expiredClock = new MutableClock("2026-08-11T13:50:00.000Z");
    const futureClock = new MutableClock("2026-08-11T14:01:00.000Z");
    const expiredService = new ApprovalAuthorizationService({ key: approvalKey, audience, issuer, clock: expiredClock, ids: value.ids });
    const futureService = new ApprovalAuthorizationService({ key: approvalKey, audience, issuer, clock: futureClock, ids: value.ids });
    const tokens = [expiredService.issue(value.identityValue, action).approve, futureService.issue(value.identityValue, action).approve];
    for (const [index, token] of tokens.entries()) {
      const runId = `time-invalid-${index}`;
      const response = await value.adapter.handle(resumeRequest(
        value.identityToken,
        resumeBody({ ...pending.action, token, runId }),
        runId
      ));
      assert.equal(response.status, 403);
    }
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-TIME-002] exact not-before and expiry boundaries allow no implicit clock skew", async () => {
    const value = harness();
    const pending = await proposeReminder(value, "clock-boundary-start");
    const action = actionFor(value, pending.action.interruptId);
    const issued = value.approvals.issue(value.identityValue, action);
    const claimSet = [issued.approve, issued.reject, issued.cancel].map(decodedApproval);
    assert.equal(new Set(claimSet.map((claims) => claims.nonce)).size, 3);
    assert.ok(claimSet.every((claims) => Number(claims.expiresAt) - Number(claims.notBefore) <= 300));
    assert.doesNotThrow(() => value.approvals.verify(issued.approve, { identity: value.identityValue, action, decision: "approve" }));
    value.clock.advance(299_000);
    assert.doesNotThrow(() => value.approvals.verify(issued.approve, { identity: value.identityValue, action, decision: "approve" }));
    value.clock.advance(1_000);
    assert.throws(
      () => value.approvals.verify(issued.approve, { identity: value.identityValue, action, decision: "approve" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "AUTHORIZATION_EXPIRED"
    );
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-NONCE-001] a signed approval nonce cannot be replayed under a new request id", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const firstBody = resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "resume-first" });
    const first = await value.adapter.handle(resumeRequest(value.identityToken, firstBody, "resume-first"));
    assert.equal(first.status, 200);
    const replayBody = resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "resume-replay" });
    const replay = await value.adapter.handle(resumeRequest(value.identityToken, replayBody, "resume-replay"));
    assert.equal(replay.status, 403);
    assert.equal(value.store.listReminders(baseScope).length, 1);
  });

  test("[TR-RESTART-001] duplicate resume across adapter and storage restart replays one durable result", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const body = resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "resume-durable" });
    const first = await value.adapter.handle(resumeRequest(value.identityToken, body, "resume-durable"));
    assert.equal(first.status, 200);
    await eventsFrom(first);
    value.store.close();

    const restarted = harness({ path: value.path, clock: value.clock, ids: value.ids });
    const replay = await restarted.adapter.handle(resumeRequest(value.identityToken, body, "resume-durable"));
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("x-boomer-buddy-replayed"), "true");
    assert.equal(restarted.store.listReminders(baseScope).length, 1);
    restarted.store.close();
  });

  test("[TR-CRASH-001] exact retry recovers after nonce commit and before action execution", async () => {
    const value = harness({ ids: new RandomIds() });
    const pending = await proposeReminder(value, "crash-before-action-start");
    const runId = "crash-before-action-resume";
    const body = resumeBody({ ...pending.action, token: pending.tokens.approve, runId });
    const raw = JSON.stringify(body);
    const digest = contentDigest(raw);
    const action = actionFor(value, pending.action.interruptId);
    const claims = value.approvals.verify(pending.tokens.approve, { identity: value.identityValue, action, decision: "approve" });
    value.store.beginTransportRequest({
      scope: baseScope,
      requestId: runId,
      requestDigest: digest,
      kind: "resume",
      now: value.clock.now().toISOString(),
      leaseExpiresAt: new Date(value.clock.now().getTime() + 30_000).toISOString()
    });
    value.store.consumeAuthorizationNonce({
      scope: baseScope,
      nonce: claims.nonce,
      purpose: claims.purpose,
      tokenDigest: authorizationDigest(pending.tokens.approve),
      expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
      requestId: runId,
      requestDigest: digest,
      kind: "resume"
    });
    value.store.close();
    value.clock.advance(31_000);

    const restarted = harness({ path: value.path, clock: value.clock, ids: new RandomIds() });
    const response = await restarted.adapter.handle(resumeRequest(value.identityToken, body, runId));
    assert.equal(response.status, 200);
    assert.equal(restarted.store.listReminders(baseScope).length, 1);
    restarted.store.close();
  });

  test("[TR-CRASH-002] exact retry recovers after action execution and before response persistence", async () => {
    const value = harness({ ids: new RandomIds() });
    const pending = await proposeReminder(value, "crash-after-action-start");
    const runId = "crash-after-action-resume";
    const body = resumeBody({ ...pending.action, token: pending.tokens.approve, runId });
    const raw = JSON.stringify(body);
    const digest = contentDigest(raw);
    const action = actionFor(value, pending.action.interruptId);
    const claims = value.approvals.verify(pending.tokens.approve, { identity: value.identityValue, action, decision: "approve" });
    value.store.beginTransportRequest({ scope: baseScope, requestId: runId, requestDigest: digest, kind: "resume", now: value.clock.now().toISOString(), leaseExpiresAt: new Date(value.clock.now().getTime() + 30_000).toISOString() });
    const tokenDigest = authorizationDigest(pending.tokens.approve);
    value.store.consumeAuthorizationNonce({ scope: baseScope, nonce: claims.nonce, purpose: claims.purpose, tokenDigest, expiresAt: new Date(claims.expiresAt * 1_000).toISOString(), requestId: runId, requestDigest: digest, kind: "resume" });
    const receiptCountBeforeExecution = value.store.listReceipts(baseScope).length;
    const executed = value.store.resolvePendingAction({
      scope: baseScope,
      interruptId: pending.action.interruptId,
      decision: "approve",
      now: value.clock.now().toISOString(),
      reminderId: new RandomIds().next("reminder")
    });
    assert.equal(executed.status, "executed");
    assert.equal(value.store.listReceipts(baseScope).length, receiptCountBeforeExecution);
    assert.equal(value.store.listReminders(baseScope).length, 1);
    value.store.close();
    value.clock.advance(31_000);

    const restarted = harness({ path: value.path, clock: value.clock, ids: new RandomIds() });
    const response = await restarted.adapter.handle(resumeRequest(value.identityToken, body, runId));
    assert.equal(response.status, 200);
    const events = await eventsFrom(response);
    const text = events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta).join("");
    assert.match(text, /already created/);
    assert.equal(restarted.store.listReminders(baseScope).length, 1);
    assert.equal(restarted.store.listReceipts(baseScope).length, receiptCountBeforeExecution + 2);
    restarted.store.close();
  });

  test("[TR-SCOPE-001] cross-patron interrupt substitution cannot reconnect or resume", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const bobToken = value.identity.issue({ tenantId: baseScope.tenantId, patronId: "patron-bob", sessionId: "session-bob" });
    const reconnect = new Request(
      `https://transport.invalid/v1/threads/${baseScope.threadId}/interrupts/${pending.action.interruptId}/events`,
      { headers: { accept: "text/event-stream", authorization: `Bearer ${bobToken}` } }
    );
    const response = await value.adapter.handle(reconnect);
    assert.equal(response.status, 404);
    const resumeId = "cross-patron-resume";
    const resumed = await value.adapter.handle(resumeRequest(
      bobToken,
      resumeBody({ ...pending.action, token: pending.tokens.approve, runId: resumeId }),
      resumeId
    ));
    assert.equal(resumed.status, 404);
    assert.deepEqual((await response.clone().json()).error, (await resumed.clone().json()).error);
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-RECONNECT-001] reconnect during an interrupt restores the prompt and fresh scoped authorizations", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const reconnect = new Request(
      `https://transport.invalid/v1/threads/${baseScope.threadId}/interrupts/${pending.action.interruptId}/events`,
      { headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` } }
    );
    const response = await value.adapter.handle(reconnect);
    assert.equal(response.status, 200);
    const restored = interrupted(await eventsFrom(response));
    assert.equal(restored.action.interruptId, pending.action.interruptId);
    assert.notEqual(restored.tokens.approve, pending.tokens.approve);
    const resume = resumeBody({ ...restored.action, token: restored.tokens.approve, runId: "resume-after-reconnect" });
    const resumed = await value.adapter.handle(resumeRequest(value.identityToken, resume, "resume-after-reconnect"));
    assert.equal(resumed.status, 200);
    assert.equal(value.store.listReminders(baseScope).length, 1);
  });

  test("[TR-SSE-002] reconnect cursors bind to one run, reject duplicates, and never execute", async () => {
    const value = harness();
    const before = await value.adapter.handle(new Request(
      `https://transport.invalid/v1/threads/${baseScope.threadId}/interrupts/interrupt-missing/events`,
      { headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` } }
    ));
    assert.equal(before.status, 404);

    const pending = await proposeReminder(value, "cursor-start");
    const url = `https://transport.invalid/v1/threads/${baseScope.threadId}/interrupts/${pending.action.interruptId}/events`;
    const first = await value.adapter.handle(new Request(url, { headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` } }));
    assert.equal(first.headers.get("x-boomer-buddy-stream-mode"), "buffered");
    const firstText = await first.text();
    const ids = firstText.split("\n").filter((line) => line.startsWith("id: ")).map((line) => line.slice(4));
    assert.deepEqual(ids, [`${pending.action.parentRunId}:1`, `${pending.action.parentRunId}:2`, `${pending.action.parentRunId}:3`]);
    assert.equal(value.store.listReminders(baseScope).length, 0);

    const resumed = await value.adapter.handle(new Request(url, { headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${value.identityToken}`,
      "last-event-id": ids[0]!
    } }));
    const resumedIds = (await resumed.text()).split("\n").filter((line) => line.startsWith("id: ")).map((line) => line.slice(4));
    assert.deepEqual(resumedIds, ids.slice(1));

    for (const invalid of ["other-run:1", `${pending.action.parentRunId}:0`, `${pending.action.parentRunId}:999`, "1", "bad, duplicate"]) {
      const response = await value.adapter.handle(new Request(url, { headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${value.identityToken}`,
        "last-event-id": invalid
      } }));
      assert.equal(response.status, 400, invalid);
    }
    const duplicateHeaders = new Headers({ accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` });
    duplicateHeaders.append("Last-Event-ID", ids[0]!);
    duplicateHeaders.append("last-event-id", ids[1]!);
    assert.equal((await value.adapter.handle(new Request(url, { headers: duplicateHeaders }))).status, 400);
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-SSE-003] downstream non-consumption or cancellation cannot retrigger execution and terminal reconnect is observational", async () => {
    const value = harness();
    const pending = await proposeReminder(value, "downstream-start");
    const runId = "downstream-resume";
    const body = resumeBody({ ...pending.action, token: pending.tokens.approve, runId });
    const response = await value.adapter.handle(resumeRequest(value.identityToken, body, runId));
    assert.equal(response.status, 200);
    assert.equal(value.store.listReminders(baseScope).length, 1, "execution commits before any downstream body read");
    await response.body?.cancel();
    assert.equal(value.store.listReminders(baseScope).length, 1);

    const terminalReconnect = await value.adapter.handle(new Request(
      `https://transport.invalid/v1/threads/${baseScope.threadId}/interrupts/${pending.action.interruptId}/events`,
      { headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` } }
    ));
    assert.equal(terminalReconnect.status, 404);

    const replay = await value.adapter.handle(resumeRequest(value.identityToken, body, runId));
    assert.equal(replay.status, 200);
    const replayEvents = await eventsFrom(replay);
    const terminal = replayEvents.at(-1);
    assert.ok(terminal?.type === EventType.RUN_FINISHED || terminal?.type === EventType.RUN_ERROR);
    assert.equal(value.store.listReminders(baseScope).length, 1);
  });

  test("[TR-SSE-004] buffered replay records enforce an event-count memory bound before persistence", () => {
    const value = harness();
    const requestId = "oversized-replay";
    value.store.beginTransportRequest({ scope: baseScope, requestId, requestDigest: contentDigest("oversized"), kind: "start", now: value.clock.now().toISOString(), leaseExpiresAt: new Date(value.clock.now().getTime() + 30_000).toISOString() });
    const event = { type: EventType.RUN_ERROR, message: "Safe failure", code: "SAFE_FAILURE", timestamp: value.clock.now().getTime() } as AGUIEvent;
    assert.throws(
      () => value.store.completeTransportRequest({
        scope: baseScope,
        requestId,
        requestDigest: contentDigest("oversized"),
        kind: "start",
        response: { status: 200, events: Array.from({ length: 201 }, () => event) }
      }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "STORAGE_RECORD_INVALID"
    );
  });

  test("[TR-RACE-001] concurrent authenticated approval and rejection produce one final decision", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const approveBody = resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "race-approve" });
    const rejectBody = resumeBody({ ...pending.action, token: pending.tokens.reject, runId: "race-reject", decision: "reject" });
    const responses = await Promise.all([
      value.adapter.handle(resumeRequest(value.identityToken, approveBody, "race-approve")),
      value.adapter.handle(resumeRequest(value.identityToken, rejectBody, "race-reject"))
    ]);
    const eventSets = await Promise.all(responses.map(eventsFrom));
    const successful = eventSets.filter((events) => !events.some((event) => event.type === EventType.RUN_ERROR));
    assert.equal(successful.length, 1);
    const action = actionFor(value, pending.action.interruptId);
    assert.ok(action.status === "executed" || action.status === "rejected");
    assert.equal(value.store.listReminders(baseScope).length, action.status === "executed" ? 1 : 0);
  });

  test("[TR-RECOVERY-001] pending interrupt, receipts, and reminder recover after storage restart", async () => {
    const value = harness();
    const pending = await proposeReminder(value);
    const receiptCount = value.store.listReceipts(baseScope).length;
    value.store.close();
    const restarted = harness({ path: value.path, clock: value.clock, ids: value.ids });
    assert.equal(restarted.store.getPendingAction(baseScope, pending.action.interruptId).status, "pending");
    assert.equal(restarted.store.listReceipts(baseScope).length, receiptCount);
    const body = resumeBody({ ...pending.action, token: pending.tokens.approve, runId: "resume-after-restart" });
    const response = await restarted.adapter.handle(resumeRequest(value.identityToken, body, "resume-after-restart"));
    assert.equal(response.status, 200);
    assert.equal(restarted.store.listReminders(baseScope).length, 1);
    restarted.store.close();
  });

  test("[TR-SSE-001] malformed SSE requests and malformed stored events are rejected", async () => {
    const value = harness();
    const badAccept = await value.adapter.handle(startRequest(value.identityToken, startBody(), "client-run-1", { accept: "application/json" }));
    assert.equal(badAccept.status, 400);
    const badBody = await value.adapter.handle(startRequest(value.identityToken, { ...startBody(), tools: [{ name: "run_shell" }] }, "client-run-1"));
    assert.equal(badBody.status, 400);
    assert.throws(() => validateStoredEvents([{ type: "FORGED_EVENT", secret: "x" } as unknown as AGUIEvent]));
    const valid = await value.adapter.handle(startRequest(value.identityToken, startBody("stored-metadata"), "stored-metadata"));
    const outbound = await eventsFrom(valid);
    assert.throws(() => validateStoredEvents(outbound), "approval bearer metadata must never be accepted as a stored replay event");
  });

  test("[TR-SIZE-001] oversized request payloads are rejected before provider invocation", async () => {
    const value = harness();
    const body = startBody("oversized", `Remind me ${"x".repeat(70_000)}`);
    const response = await value.adapter.handle(startRequest(value.identityToken, body, "oversized"));
    assert.equal(response.status, 413);
    assert.equal(value.store.listReceipts(baseScope).length, 0);
  });

  test("[TR-HTTP-001] methods, queries, identifiers, headers, lengths, JSON, and body reuse are strict", async () => {
    const value = harness();
    const get = await value.adapter.handle(new Request("https://transport.invalid/v1/threads/thread-care/runs", { method: "GET" }));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");

    const query = await value.adapter.handle(new Request(
      "https://transport.invalid/v1/threads/thread-care/runs?patronId=patron-bob&patronId=patron-alice",
      { method: "POST", headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}` } }
    ));
    assert.equal(query.status, 400);

    const conflictingBody = startBody("conflict", "make text larger", "thread-other");
    const conflicting = await value.adapter.handle(new Request("https://transport.invalid/v1/threads/thread-care/runs", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}`, "content-type": "application/json", "idempotency-key": "conflict" },
      body: JSON.stringify(conflictingBody)
    }));
    assert.equal(conflicting.status, 400);

    const duplicateIdempotency = startRequest(value.identityToken, startBody("duplicate-idempotency", "make text larger"), "duplicate-idempotency");
    duplicateIdempotency.headers.append("Idempotency-Key", "duplicate-idempotency");
    assert.equal((await value.adapter.handle(duplicateIdempotency)).status, 400);

    const raw = JSON.stringify(startBody("length-mismatch", "make text larger"));
    const lengthMismatch = new Request("https://transport.invalid/v1/threads/thread-care/runs", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}`, "content-type": "application/json", "idempotency-key": "length-mismatch", "content-length": String(Buffer.byteLength(raw) + 1) },
      body: raw
    });
    assert.equal((await value.adapter.handle(lengthMismatch)).status, 400);

    let deeplyNested: unknown = "leaf";
    for (let depth = 0; depth < 1_000; depth += 1) deeplyNested = { value: deeplyNested };
    const malformedBodies = [
      "{",
      JSON.stringify({ ...startBody("extra-json", "make text larger"), extra: true }),
      JSON.stringify({ nested: deeplyNested })
    ];
    for (const [index, body] of malformedBodies.entries()) {
      const response = await value.adapter.handle(new Request("https://transport.invalid/v1/threads/thread-care/runs", {
        method: "POST",
        headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}`, "content-type": "application/json", "idempotency-key": `malformed-${index}` },
        body
      }));
      assert.equal(response.status, 400);
    }

    assert.equal((await value.adapter.handle(startRequest(value.identityToken, startBody("bad-type"), "bad-type", { contentType: "text/plain" }))).status, 400);
    const reusable = startRequest(value.identityToken, startBody("body-reuse", "make text larger"), "body-reuse");
    assert.equal((await value.adapter.handle(reusable)).status, 200);
    assert.equal((await value.adapter.handle(reusable)).status, 400);
  });

  test("[TR-HTTP-002] patron responses disable caching, sniffing, referrers, and cross-origin grants", async () => {
    const value = harness();
    const success = await value.adapter.handle(startRequest(value.identityToken, startBody("secure-headers", "make text larger"), "secure-headers"));
    assert.equal(success.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(success.headers.get("x-content-type-options"), "nosniff");
    assert.equal(success.headers.get("referrer-policy"), "no-referrer");
    assert.equal(success.headers.get("access-control-allow-origin"), null);
    const failure = await value.adapter.handle(startRequest("forged", startBody("secure-error"), "secure-error"));
    assert.equal(failure.headers.get("cache-control"), "no-store");
    assert.equal(failure.headers.get("x-content-type-options"), "nosniff");
    assert.match(failure.headers.get("content-type") ?? "", /^application\/json/);
  });

  test("[TR-STORE-001] stored JSON is rebound to partition columns and corrupt cross-patron values fail closed", async () => {
    const value = harness();
    const pending = await proposeReminder(value, "corrupt-row-start");
    const runId = "corrupt-row-resume";
    assert.equal((await value.adapter.handle(resumeRequest(value.identityToken, resumeBody({ ...pending.action, token: pending.tokens.approve, runId }), runId))).status, 200);
    value.store.close();

    const db = new DatabaseSync(value.path);
    const row = db.prepare("SELECT record_json FROM reminders WHERE tenant_id = ? AND patron_id = ?").get(baseScope.tenantId, baseScope.patronId) as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record.patronId = "patron-bob";
    db.prepare("UPDATE reminders SET record_json = ? WHERE tenant_id = ? AND patron_id = ?").run(JSON.stringify(record), baseScope.tenantId, baseScope.patronId);
    db.close();

    const restarted = harness({ path: value.path, clock: value.clock, ids: value.ids });
    assert.throws(
      () => restarted.store.listReminders(baseScope),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "STORAGE_RECORD_INVALID"
    );
    restarted.store.close();
  });

  test("[TR-STORE-002] schema mismatch, partial schema, path injection, and foreign-key violations fail closed", () => {
    const mismatchPath = databasePath();
    const mismatch = new DatabaseSync(mismatchPath);
    mismatch.exec("PRAGMA user_version = 999");
    mismatch.close();
    assert.throws(() => new SqliteRuntimeStore({ path: mismatchPath, ids: new RandomIds() }), /stored data schema/i);

    const partialPath = databasePath();
    const partial = new DatabaseSync(partialPath);
    partial.exec("CREATE TABLE partial_state (id TEXT PRIMARY KEY) STRICT");
    partial.close();
    assert.throws(() => new SqliteRuntimeStore({ path: partialPath, ids: new RandomIds() }), /stored data schema/i);

    const corruptPath = databasePath();
    writeFileSync(corruptPath, "not a sqlite database", "utf8");
    assert.throws(() => new SqliteRuntimeStore({ path: corruptPath, ids: new RandomIds() }), /stored data schema/i);
    for (const path of ["", "file:transport.sqlite?mode=memory&cache=shared", "bad\0path"]) {
      assert.throws(() => new SqliteRuntimeStore({ path, ids: new RandomIds() }), /stored data schema/i);
    }

    const path = databasePath();
    const store = new SqliteRuntimeStore({ path, ids: new RandomIds() });
    store.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => db.prepare("INSERT INTO reminders (tenant_id, patron_id, action_id, record_json) VALUES (?, ?, ?, ?)").run("tenant-x", "patron-x", "action-x", "{}"));
    db.close();
  });

  test("[TR-STORE-003] transaction rollback and locked-database failures preserve integrity", async () => {
    const value = harness({ busyTimeoutMs: 5 });
    const pending = await proposeReminder(value, "rollback-start");
    assert.throws(
      () => value.store.resolvePendingAction({ scope: baseScope, interruptId: pending.action.interruptId, decision: "approve", now: value.clock.now().toISOString(), reminderId: "" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "STORAGE_RECORD_INVALID"
    );
    assert.equal(actionFor(value, pending.action.interruptId).status, "pending");
    assert.equal(value.store.listReminders(baseScope).length, 0);

    const locker = new DatabaseSync(value.path);
    locker.exec("BEGIN EXCLUSIVE");
    assert.throws(
      () => value.store.assertScope({ tenantId: "tenant-locked", patronId: "patron-locked", threadId: "thread-locked" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "STORAGE_UNAVAILABLE"
    );
    locker.exec("ROLLBACK");
    locker.close();
    assert.equal(actionFor(value, pending.action.interruptId).status, "pending");
  });

  test("[TR-STORE-004] separate store instances serialize decisions and identifier collisions cannot cross patrons", async () => {
    const first = harness({ ids: new RandomIds() });
    const pending = await proposeReminder(first, "multi-store-start");
    const action = actionFor(first, pending.action.interruptId);
    assert.throws(
      () => first.store.savePendingAction({ ...action, tenantId: "tenant-other", patronId: "patron-other", threadId: "thread-other" }),
      (error: unknown) => error instanceof RuntimeBoundaryError && error.code === "ID_COLLISION"
    );
    const second = harness({ path: first.path, clock: first.clock, ids: new RandomIds() });
    const approveId = "multi-store-approve";
    const rejectId = "multi-store-reject";
    const [approved, rejected] = await Promise.all([
      first.adapter.handle(resumeRequest(first.identityToken, resumeBody({ ...pending.action, token: pending.tokens.approve, runId: approveId }), approveId)),
      second.adapter.handle(resumeRequest(second.identityToken, resumeBody({ ...pending.action, token: pending.tokens.reject, runId: rejectId, decision: "reject" }), rejectId))
    ]);
    await Promise.all([eventsFrom(approved), eventsFrom(rejected)]);
    const final = first.store.getPendingAction(baseScope, pending.action.interruptId);
    assert.ok(final.status === "executed" || final.status === "rejected");
    assert.equal(first.store.listReminders(baseScope).length, final.status === "executed" ? 1 : 0);
    second.store.close();
  });

  test("[TR-POLICY-001] provider output cannot bypass the existing executable capability registry", async () => {
    const provider = new ScriptedModelProvider({
      capabilityId: "run_shell",
      arguments: { command: "whoami" },
      inputProvenance: { source: "patron_message", messageId: "message-provider-bypass" }
    });
    const value = harness({ provider });
    const body = startBody("provider-bypass", "please do it");
    (body as { messages: Array<{ id: string }> }).messages[0]!.id = "message-provider-bypass";
    const response = await value.adapter.handle(startRequest(value.identityToken, body, "provider-bypass"));
    assert.equal(response.status, 200);
    const events = await eventsFrom(response);
    assert.ok(events.some((event) => event.type === EventType.RUN_ERROR && event.code === "UNREGISTERED_CAPABILITY"));
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-PROVIDER-001] malicious provider errors, UI fields, prototype keys, and internal-access requests stay non-authoritative", async () => {
    let observedKeys: string[] = [];
    const provider: ModelProvider = {
      identifier: "malicious-provider/test",
      async propose(input) {
        observedKeys = Object.keys(input).sort();
        return {
          capabilityId: "create_reminder",
          arguments: JSON.parse('{"title":"Call Monte","dueAt":"2026-08-12T10:00:00-04:00","timeZone":"America/New_York","__proto__":{"transportStore":"stolen"}}'),
          inputProvenance: { source: "patron_message", messageId: input.messageId },
          component: { key: "ArbitraryHtml", props: { html: "<script>steal()</script>" } }
        } as never;
      }
    };
    const value = harness({ provider });
    const response = await value.adapter.handle(startRequest(value.identityToken, startBody("malicious-provider"), "malicious-provider"));
    const serialized = JSON.stringify(await eventsFrom(response));
    assert.deepEqual(observedKeys, ["allowedCapabilityIds", "messageId", "now", "patronMessage", "timeZone"]);
    assert.equal(serialized.includes("ArbitraryHtml"), false);
    assert.equal(serialized.includes("steal"), false);
    assert.equal(value.store.listReminders(baseScope).length, 0);

    const throwing = harness({ provider: { identifier: "throwing-provider/test", propose: async () => { throw new Error("sk-provider-secret"); } } });
    const thrown = await throwing.adapter.handle(startRequest(throwing.identityToken, startBody("throwing-provider"), "throwing-provider"));
    const thrownText = await thrown.text();
    assert.equal(thrownText.includes("sk-provider-secret"), false);
    assert.equal(JSON.stringify(throwing.store.listReceipts(baseScope)).includes("sk-provider-secret"), false);
  });

  test("[TR-CANCEL-001] cancellation while a provider is pending terminates the request without mutation", async () => {
    const provider: ModelProvider = {
      identifier: "pending-provider/test",
      propose: () => new Promise(() => undefined)
    };
    const value = harness({ provider });
    const controller = new AbortController();
    const request = new Request("https://transport.invalid/v1/threads/thread-care/runs", {
      method: "POST",
      headers: { accept: "text/event-stream", authorization: `Bearer ${value.identityToken}`, "content-type": "application/json", "idempotency-key": "provider-cancel" },
      body: JSON.stringify(startBody("provider-cancel")),
      signal: controller.signal
    });
    const pending = value.adapter.handle(request);
    setTimeout(() => controller.abort(), 0);
    const response = await pending;
    assert.equal(response.status, 200);
    const events = await eventsFrom(response);
    assert.ok(events.some((event) => event.type === EventType.RUN_ERROR && event.code === "CLIENT_DISCONNECTED"));
    assert.equal(value.store.listReminders(baseScope).length, 0);
  });

  test("[TR-LEAK-001] receipts and transport audit records exclude messages, secrets, credentials, and approval tokens", async () => {
    const audit = new RecordingAudit();
    const value = harness({ audit });
    const secret = "sk-transportsecret123456";
    const runId = "secret-run";
    const response = await value.adapter.handle(startRequest(
      value.identityToken,
      startBody(runId, `Remind me to call Monte tomorrow at 10 AM ${secret}`),
      runId
    ));
    const pending = interrupted(await eventsFrom(response));
    const serialized = JSON.stringify({ receipts: value.store.listReceipts(baseScope), audit: audit.entries });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(value.identityToken), false);
    assert.equal(serialized.includes(pending.tokens.approve), false);
    assert.equal(serialized.includes("Remind me"), false);
  });
});
