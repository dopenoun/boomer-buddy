import { EventType, RunAgentInputSchema } from "@ag-ui/core";
import type { AGUIEvent } from "@ag-ui/core";
import { z } from "zod";
import { checkedEvent, uiEvent } from "../runtime/ag-ui.js";
import { RuntimeBoundaryError, safeError } from "../runtime/errors.js";
import { contentDigest } from "../runtime/store.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { BoomerBuddyRuntime } from "../runtime/runtime.js";
import type { Clock, PatronScope, PendingAction } from "../runtime/types.js";
import { assertIdentityMatchesAction, authorizationDigest, validateVerifiedPatronIdentity } from "./auth.js";
import type { ApprovalAuthorizationService } from "./auth.js";
import type {
  ApprovalDecision,
  PatronIdentityVerifier,
  TransportAuditSink,
  TransportStateStore,
  VerifiedPatronIdentity
} from "./types.js";
import { validateOutboundEvents, validateTransportEvent } from "./events.js";

const MAX_REQUEST_BYTES = 65_536;
const REQUEST_LEASE_MS = 30_000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 5_000;
const MAX_SSE_RESPONSE_BYTES = 262_144;
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const emptyObject = z.object({}).strict();
const userMessageSchema = z.object({
  id: identifier,
  role: z.literal("user"),
  content: z.string().min(1).max(8_192)
}).strict();
const startBodySchema = z.object({
  threadId: identifier,
  runId: identifier,
  state: emptyObject,
  messages: z.tuple([userMessageSchema]),
  tools: z.tuple([]),
  context: z.tuple([]),
  forwardedProps: z.object({ timeZone: z.string().min(1).max(80) }).strict()
}).strict();
const resolvedResumeSchema = z.object({
  interruptId: identifier,
  status: z.literal("resolved"),
  payload: z.object({ approved: z.boolean() }).strict()
}).strict();
const cancelledResumeSchema = z.object({
  interruptId: identifier,
  status: z.literal("cancelled")
}).strict();
const resumeBodySchema = z.object({
  threadId: identifier,
  runId: identifier,
  parentRunId: identifier,
  state: emptyObject,
  messages: z.tuple([]),
  tools: z.tuple([]),
  context: z.tuple([]),
  forwardedProps: z.object({ approvalAuthorization: z.string().min(1).max(4_096) }).strict(),
  resume: z.tuple([z.union([resolvedResumeSchema, cancelledResumeSchema])])
}).strict();

type StartBody = z.infer<typeof startBodySchema>;
type ResumeBody = z.infer<typeof resumeBodySchema>;

function routeFor(request: Request):
  | { kind: "start"; threadId: string }
  | { kind: "reconnect"; threadId: string; interruptId: string }
  | { kind: "unknown" } {
  const url = new URL(request.url);
  if (url.search || url.hash || url.username || url.password) return { kind: "unknown" };
  const pathname = url.pathname;
  const start = /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/runs$/.exec(pathname);
  if (start?.[1]) return { kind: "start", threadId: start[1] };
  const reconnect = /^\/v1\/threads\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/interrupts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/events$/.exec(pathname);
  if (reconnect?.[1] && reconnect[2]) return { kind: "reconnect", threadId: reconnect[1], interruptId: reconnect[2] };
  return { kind: "unknown" };
}

function assertSseAccepted(request: Request): void {
  const accept = request.headers.get("accept");
  if (!accept || !accept.split(",").some((value) => value.trim().split(";")[0] === "text/event-stream")) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
}

async function readJsonBody(request: Request): Promise<{ raw: string; value: unknown }> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    throw new RuntimeBoundaryError("PAYLOAD_TOO_LARGE", "The request was too large.");
  }
  const raw = await request.text();
  const actualBytes = Buffer.byteLength(raw, "utf8");
  if (!raw || actualBytes > MAX_REQUEST_BYTES) {
    throw new RuntimeBoundaryError("PAYLOAD_TOO_LARGE", "The request was too large.");
  }
  if (contentLength && Number(contentLength) !== actualBytes) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
}

function assertOfficialRunInput(value: unknown): void {
  if (!RunAgentInputSchema.safeParse(value).success) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
}

function requestId(request: Request, bodyRunId: string): string {
  const value = request.headers.get("idempotency-key");
  if (!value || value !== bodyRunId || !identifier.safeParse(value).success) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
  return value;
}

function scopeFor(identity: VerifiedPatronIdentity, threadId: string): PatronScope {
  return { tenantId: identity.tenantId, patronId: identity.patronId, threadId };
}

function decisionFrom(body: ResumeBody): ApprovalDecision {
  const entry = body.resume[0];
  if (entry.status === "cancelled") return "cancel";
  return entry.payload.approved ? "approve" : "reject";
}

function sseResponse(
  events: readonly AGUIEvent[],
  replayed = false,
  options: { idPrefix?: string; startingIndex?: number } = {}
): Response {
  const startingIndex = options.startingIndex ?? 0;
  const body = events.map((event, index) => {
    const validated = validateTransportEvent(event, { stored: false });
    const position = startingIndex + index + 1;
    const id = options.idPrefix ? `${options.idPrefix}:${position}` : String(position);
    return `id: ${id}\nevent: ag-ui\ndata: ${JSON.stringify(validated)}\n\n`;
  }).join("");
  if (events.length > 200 || Buffer.byteLength(body, "utf8") > MAX_SSE_RESPONSE_BYTES) {
    throw new RuntimeBoundaryError("PAYLOAD_TOO_LARGE", "The request was too large.");
  }
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-accel-buffering": "no",
      "x-boomer-buddy-replayed": replayed ? "true" : "false",
      "x-boomer-buddy-stream-mode": "buffered",
      "x-content-type-options": "nosniff"
    }
  });
}

function reconnectCursor(request: Request, runId: string, eventCount: number): number {
  const supplied = request.headers.get("last-event-id");
  if (supplied === null) return 0;
  const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,199}):(\d{1,3})$/.exec(supplied);
  if (!match || match[1] !== runId) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
  const position = Number(match[2]);
  if (!Number.isSafeInteger(position) || position < 1 || position > eventCount) {
    throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
  }
  return position;
}

function methodNotAllowed(allowed: "GET" | "POST"): Response {
  return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "The request method is not supported." } }, {
    status: 405,
    headers: {
      allow: allowed,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    }
  });
}

function errorStatus(code: string): number {
  if (code === "AUTHENTICATION_FAILED") return 401;
  if (code.startsWith("AUTHORIZATION_") || code === "CROSS_PATRON_ACCESS") return 403;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (code === "REQUEST_IN_PROGRESS") return 409;
  if (code === "STORAGE_UNAVAILABLE") return 503;
  if (code === "UNKNOWN_INTERRUPT") return 404;
  return 400;
}

function errorResponse(error: unknown): Response {
  const safe = safeError(error);
  return Response.json({ error: safe }, { status: errorStatus(safe.code), headers: {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  } });
}

async function verifiedIdentity(
  verifier: PatronIdentityVerifier,
  request: Request,
  timeoutMs: number,
  expectedAudience: string
): Promise<VerifiedPatronIdentity> {
  if (request.signal.aborted) {
    throw new RuntimeBoundaryError("CLIENT_DISCONNECTED", "The connection ended before anything was changed.");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.")), timeoutMs);
    abortHandler = () => reject(new RuntimeBoundaryError("CLIENT_DISCONNECTED", "The connection ended before anything was changed."));
    request.signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    const identityRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal
    });
    const value = validateVerifiedPatronIdentity(await Promise.race([verifier.verify(identityRequest), timeoutFailure]));
    if (value.audience !== expectedAudience) {
      throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
    }
    return value;
  } catch (error) {
    if (error instanceof RuntimeBoundaryError && error.code === "CLIENT_DISCONNECTED") throw error;
    throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
  }
}

function decorateInterruptAuthorization(
  events: readonly AGUIEvent[],
  action: PendingAction | null,
  identity: VerifiedPatronIdentity,
  authorizations: ApprovalAuthorizationService
): AGUIEvent[] {
  if (!action) return validateOutboundEvents(events);
  const tokens = authorizations.issue(identity, action);
  return events.map((event) => {
    const candidate = structuredClone(event) as unknown;
    if (candidate && typeof candidate === "object" && "type" in candidate && candidate.type === EventType.RUN_FINISHED) {
      const outcome = "outcome" in candidate ? candidate.outcome : null;
      if (outcome && typeof outcome === "object" && "type" in outcome && outcome.type === "interrupt" && "interrupts" in outcome && Array.isArray(outcome.interrupts)) {
        outcome.interrupts = outcome.interrupts.map((interrupt: unknown) => {
          if (!interrupt || typeof interrupt !== "object") return interrupt;
          return {
            ...interrupt,
            metadata: {
              schemaVersion: "boomer-buddy.approval-authorization.v1",
              authorizations: tokens
            }
          };
        });
      }
    }
    return validateTransportEvent(candidate, { stored: false });
  });
}

function reconnectEvents(action: PendingAction, identity: VerifiedPatronIdentity, authorizations: ApprovalAuthorizationService, timestamp: number): AGUIEvent[] {
  const base = [
    checkedEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        status: "awaiting-approval",
        currentRunId: action.runId,
        pendingAction: { actionId: action.actionId, capabilityId: action.capabilityId, expiresAt: action.expiresAt },
        nextAvailableMoves: ["Approve", "Not now"]
      },
      timestamp
    }),
    uiEvent({
      key: "ReminderConfirmationCard",
      props: {
        question: action.prompt,
        title: action.arguments.title,
        scheduledFor: action.arguments.dueAt,
        timeZone: action.arguments.timeZone,
        actionId: action.actionId,
        choices: ["Approve", "Not now"]
      }
    }, timestamp),
    checkedEvent({
      type: EventType.RUN_FINISHED,
      threadId: action.threadId,
      runId: action.runId,
      outcome: {
        type: "interrupt",
        interrupts: [{
          id: action.interruptId,
          reason: "approval-required",
          message: action.prompt,
          toolCallId: action.toolCallId,
          expiresAt: action.expiresAt,
          responseSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
            additionalProperties: false
          }
        }]
      },
      timestamp
    })
  ];
  return decorateInterruptAuthorization(base, action, identity, authorizations);
}

export class PatronTransportHttpAdapter {
  readonly #audit: TransportAuditSink | null;
  readonly #authorizations: ApprovalAuthorizationService;
  readonly #clock: Clock;
  readonly #identity: PatronIdentityVerifier;
  readonly #identityTimeoutMs: number;
  readonly #runtime: BoomerBuddyRuntime;
  readonly #runtimeStore: RuntimeStore;
  readonly #transportStore: TransportStateStore;

  constructor(input: {
    runtime: BoomerBuddyRuntime;
    runtimeStore: RuntimeStore;
    transportStore: TransportStateStore;
    identityVerifier: PatronIdentityVerifier;
    approvalAuthorizations: ApprovalAuthorizationService;
    clock: Clock;
    identityTimeoutMs?: number;
    audit?: TransportAuditSink;
  }) {
    this.#runtime = input.runtime;
    this.#runtimeStore = input.runtimeStore;
    this.#transportStore = input.transportStore;
    this.#identity = input.identityVerifier;
    this.#authorizations = input.approvalAuthorizations;
    this.#clock = input.clock;
    this.#identityTimeoutMs = input.identityTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
    if (!Number.isInteger(this.#identityTimeoutMs) || this.#identityTimeoutMs < 1 || this.#identityTimeoutMs > 60_000) {
      throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
    }
    this.#audit = input.audit ?? null;
  }

  async handle(request: Request): Promise<Response> {
    const route = routeFor(request);
    let requestDigest: string | null = null;
    let identity: VerifiedPatronIdentity | null = null;
    try {
      if (route.kind === "unknown") throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
      if (route.kind === "reconnect" && request.method !== "GET") return methodNotAllowed("GET");
      if (route.kind === "start" && request.method !== "POST") return methodNotAllowed("POST");
      assertSseAccepted(request);
      identity = await verifiedIdentity(this.#identity, request, this.#identityTimeoutMs, this.#authorizations.audience);
      if (route.kind === "reconnect") {
        const scope = scopeFor(identity, route.threadId);
        let action: PendingAction;
        try {
          action = this.#runtimeStore.getPendingAction(scope, route.interruptId);
        } catch (error) {
          if (error instanceof RuntimeBoundaryError && (error.code === "UNKNOWN_INTERRUPT" || error.code === "CROSS_PATRON_ACCESS")) {
            throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
          }
          throw error;
        }
        assertIdentityMatchesAction(identity, action);
        if (action.status !== "pending" || new Date(action.expiresAt).getTime() <= this.#clock.now().getTime()) {
          throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
        }
        const events = reconnectEvents(action, identity, this.#authorizations, this.#clock.now().getTime());
        const cursor = reconnectCursor(request, action.runId, events.length);
        this.#recordAudit("reconnect", "succeeded", null, null, identity);
        return sseResponse(events.slice(cursor), false, { idPrefix: action.runId, startingIndex: cursor });
      }
      const bodyEnvelope = await readJsonBody(request);
      requestDigest = contentDigest(bodyEnvelope.raw);
      assertOfficialRunInput(bodyEnvelope.value);
      const hasResume = Boolean(bodyEnvelope.value && typeof bodyEnvelope.value === "object" && "resume" in bodyEnvelope.value);
      if (hasResume) {
        const parsed = resumeBodySchema.safeParse(bodyEnvelope.value);
        if (!parsed.success || parsed.data.threadId !== route.threadId) {
          throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
        }
        return await this.#resume(request, identity, parsed.data, requestDigest);
      }
      const parsed = startBodySchema.safeParse(bodyEnvelope.value);
      if (!parsed.success || parsed.data.threadId !== route.threadId) {
        throw new RuntimeBoundaryError("TRANSPORT_REQUEST_INVALID", "The transport request was malformed.");
      }
      return await this.#start(request, identity, parsed.data, requestDigest);
    } catch (error) {
      const safe = safeError(error);
      this.#recordAudit(route.kind, "rejected", safe.code, requestDigest, identity);
      return errorResponse(error);
    }
  }

  async #start(request: Request, identity: VerifiedPatronIdentity, body: StartBody, digest: string): Promise<Response> {
    const scope = scopeFor(identity, body.threadId);
    const id = requestId(request, body.runId);
    const claim = this.#transportStore.beginTransportRequest({
      scope,
      requestId: id,
      requestDigest: digest,
      kind: "start",
      now: this.#clock.now().toISOString(),
      leaseExpiresAt: new Date(this.#clock.now().getTime() + REQUEST_LEASE_MS).toISOString()
    });
    if (claim.state === "replay") {
      const action = this.#pendingFromEvents(scope, claim.response.events);
      const events = decorateInterruptAuthorization(claim.response.events, action, identity, this.#authorizations);
      this.#recordAudit("start", "replayed", null, digest, identity);
      return sseResponse(events, true);
    }
    const message = body.messages[0];
    const result = await this.#runtime.startRun({
      ...scope,
      messageId: message.id,
      content: message.content,
      timeZone: body.forwardedProps.timeZone,
      signal: request.signal
    });
    this.#transportStore.completeTransportRequest({
      scope,
      requestId: id,
      requestDigest: digest,
      kind: "start",
      response: { status: 200, events: result.events }
    });
    const action = result.interruptId ? this.#runtimeStore.getPendingAction(scope, result.interruptId) : null;
    const events = decorateInterruptAuthorization(result.events, action, identity, this.#authorizations);
    this.#recordAudit("start", "succeeded", null, digest, identity);
    return sseResponse(events);
  }

  async #resume(request: Request, identity: VerifiedPatronIdentity, body: ResumeBody, digest: string): Promise<Response> {
    const scope = scopeFor(identity, body.threadId);
    const id = requestId(request, body.runId);
    const entry = body.resume[0];
    let action: PendingAction;
    try {
      action = this.#runtimeStore.getPendingAction(scope, entry.interruptId);
    } catch (error) {
      if (error instanceof RuntimeBoundaryError && (error.code === "UNKNOWN_INTERRUPT" || error.code === "CROSS_PATRON_ACCESS")) {
        throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
      }
      throw error;
    }
    assertIdentityMatchesAction(identity, action);
    if (body.parentRunId !== action.runId) {
      throw new RuntimeBoundaryError("AUTHORIZATION_BINDING", "That approval authorization does not match this request.");
    }
    const decision = decisionFrom(body);
    const claims = this.#authorizations.verify(body.forwardedProps.approvalAuthorization, { identity, action, decision });
    const claim = this.#transportStore.beginTransportRequest({
      scope,
      requestId: id,
      requestDigest: digest,
      kind: "resume",
      now: this.#clock.now().toISOString(),
      leaseExpiresAt: new Date(this.#clock.now().getTime() + REQUEST_LEASE_MS).toISOString()
    });
    if (claim.state === "replay") {
      this.#recordAudit("resume", "replayed", null, digest, identity);
      return sseResponse(claim.response.events, true);
    }
    this.#transportStore.consumeAuthorizationNonce({
      scope,
      nonce: claims.nonce,
      purpose: claims.purpose,
      tokenDigest: authorizationDigest(body.forwardedProps.approvalAuthorization),
      expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
      requestId: id,
      requestDigest: digest,
      kind: "resume"
    });
    const result = await this.#runtime.resume({
      ...scope,
      interruptId: entry.interruptId,
      decision,
      signal: request.signal
    });
    this.#transportStore.completeTransportRequest({
      scope,
      requestId: id,
      requestDigest: digest,
      kind: "resume",
      response: { status: 200, events: result.events }
    });
    this.#recordAudit("resume", "succeeded", null, digest, identity);
    return sseResponse(result.events);
  }

  #pendingFromEvents(scope: PatronScope, events: readonly AGUIEvent[]): PendingAction | null {
    for (const event of events) {
      if (event.type === EventType.RUN_FINISHED && event.outcome?.type === "interrupt") {
        const interrupt = event.outcome.interrupts[0];
        if (interrupt) return this.#runtimeStore.getPendingAction(scope, interrupt.id);
      }
    }
    return null;
  }

  #recordAudit(
    route: "start" | "resume" | "reconnect" | "unknown",
    outcome: "succeeded" | "replayed" | "rejected",
    safeErrorCode: string | null,
    requestDigest: string | null,
    identity: VerifiedPatronIdentity | null
  ): void {
    if (!this.#audit) return;
    this.#audit.record({
      occurredAt: this.#clock.now().toISOString(),
      route,
      outcome,
      safeErrorCode,
      requestDigest,
      principalDigest: identity ? contentDigest(`${identity.tenantId}\u0000${identity.patronId}`) : null
    });
  }
}
