import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RuntimeBoundaryError } from "../runtime/errors.js";
import type { Clock, IdSource, PendingAction } from "../runtime/types.js";
import type {
  ApprovalAuthorizationClaims,
  ApprovalAuthorizationSet,
  ApprovalDecision,
  ApprovalVerificationInput,
  PatronIdentityVerifier,
  VerifiedPatronIdentity
} from "./types.js";

const MAX_TOKEN_BYTES = 4_096;
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const identityIdentifier = identifier.refine(
  (value) => !new Set(["0", "anonymous", "default", "null", "undefined", "unknown"]).has(value.toLowerCase())
);
const serviceIdentifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const tokenHeaderSchema = z.object({ algorithm: z.literal("HS256"), type: z.string().min(1).max(80) }).strict();
const approvalClaimsSchema = z.object({
  version: z.literal("1"),
  purpose: z.literal("boomer-buddy.approval-resume"),
  issuer: serviceIdentifier,
  audience: serviceIdentifier,
  tenantId: identifier,
  patronId: identifier,
  sessionId: identifier,
  threadId: identifier,
  runId: identifier,
  actionId: identifier,
  interruptId: identifier,
  capabilityId: z.literal("create_reminder"),
  decision: z.enum(["approve", "reject", "cancel"]),
  nonce: identifier,
  notBefore: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive()
}).strict();
const testIdentityClaimsSchema = z.object({
  version: z.literal("1"),
  purpose: z.literal("boomer-buddy.test-identity"),
  issuer: serviceIdentifier,
  audience: serviceIdentifier,
  tenantId: identifier,
  patronId: identifier,
  sessionId: identifier,
  nonce: identifier,
  notBefore: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive()
}).strict();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
}

function encodeJson(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
  }
  return decoded;
}

function decodeJson(value: string): unknown {
  try {
    const decoded = JSON.parse(decodeBase64Url(value).toString("utf8"));
    if (encodeJson(decoded) !== value) throw new Error("non-canonical JSON");
    return decoded;
  } catch {
    throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
  }
}

class HmacTokenCodec {
  readonly #key: Buffer;
  readonly #type: string;

  constructor(key: Uint8Array, type: string) {
    this.#key = Buffer.from(key);
    this.#type = type;
    if (this.#key.byteLength < 32) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
  }

  sign(payload: unknown): string {
    const header = encodeJson({ algorithm: "HS256", type: this.#type });
    const body = encodeJson(payload);
    const signature = createHmac("sha256", this.#key).update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${signature}`;
  }

  verify(token: string): unknown {
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    const [header, body, suppliedSignature] = parts as [string, string, string];
    const parsedHeader = tokenHeaderSchema.safeParse(decodeJson(header));
    if (!parsedHeader.success || parsedHeader.data.type !== this.#type) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    const expected = createHmac("sha256", this.#key).update(`${header}.${body}`).digest();
    let supplied: Buffer;
    try {
      supplied = decodeBase64Url(suppliedSignature);
    } catch {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    return decodeJson(body);
  }
}

const verifiedIdentitySchema = z.object({
  tenantId: identityIdentifier,
  patronId: identityIdentifier,
  sessionId: identityIdentifier,
  audience: serviceIdentifier,
  authenticationMethod: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
}).strict();

export function validateVerifiedPatronIdentity(value: unknown): VerifiedPatronIdentity {
  const parsed = verifiedIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
  }
  return parsed.data;
}

export function authorizationDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export class ApprovalAuthorizationService {
  readonly #audience: string;
  readonly #clock: Clock;
  readonly #codec: HmacTokenCodec;
  readonly #ids: IdSource;
  readonly #issuer: string;

  constructor(input: { key: Uint8Array; audience: string; issuer: string; clock: Clock; ids: IdSource }) {
    if (!serviceIdentifier.safeParse(input.audience).success || !serviceIdentifier.safeParse(input.issuer).success) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    this.#audience = input.audience;
    this.#issuer = input.issuer;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#codec = new HmacTokenCodec(input.key, "BB-APPROVAL-V1");
  }

  get audience(): string {
    return this.#audience;
  }

  issue(identity: VerifiedPatronIdentity, action: PendingAction): ApprovalAuthorizationSet {
    const now = Math.floor(this.#clock.now().getTime() / 1_000);
    const actionExpiry = Math.floor(new Date(action.expiresAt).getTime() / 1_000);
    const expiresAt = Math.min(now + 300, actionExpiry);
    const issueOne = (decision: ApprovalDecision): string => this.#codec.sign({
      version: "1",
      purpose: "boomer-buddy.approval-resume",
      issuer: this.#issuer,
      audience: this.#audience,
      tenantId: identity.tenantId,
      patronId: identity.patronId,
      sessionId: identity.sessionId,
      threadId: action.threadId,
      runId: action.runId,
      actionId: action.actionId,
      interruptId: action.interruptId,
      capabilityId: action.capabilityId,
      decision,
      nonce: this.#ids.next("approval_nonce"),
      notBefore: now,
      expiresAt
    } satisfies ApprovalAuthorizationClaims);
    return { approve: issueOne("approve"), reject: issueOne("reject"), cancel: issueOne("cancel") };
  }

  verify(token: string, expected: ApprovalVerificationInput): ApprovalAuthorizationClaims {
    const parsed = approvalClaimsSchema.safeParse(this.#codec.verify(token));
    if (!parsed.success) {
      throw new RuntimeBoundaryError("AUTHORIZATION_INVALID", "That approval authorization was invalid.");
    }
    const claims = parsed.data;
    const now = Math.floor(this.#clock.now().getTime() / 1_000);
    if (claims.audience !== this.#audience) {
      throw new RuntimeBoundaryError("AUTHORIZATION_AUDIENCE", "That approval authorization was not intended for this service.");
    }
    if (claims.notBefore > now) {
      throw new RuntimeBoundaryError("AUTHORIZATION_NOT_YET_VALID", "That approval authorization is not valid yet.");
    }
    if (claims.expiresAt <= now || claims.expiresAt <= claims.notBefore) {
      throw new RuntimeBoundaryError("AUTHORIZATION_EXPIRED", "That approval authorization has expired.");
    }
    const { identity, action, decision } = expected;
    if (
      claims.issuer !== this.#issuer ||
      claims.tenantId !== identity.tenantId ||
      claims.patronId !== identity.patronId ||
      claims.sessionId !== identity.sessionId ||
      claims.audience !== identity.audience ||
      claims.threadId !== action.threadId ||
      claims.runId !== action.runId ||
      claims.actionId !== action.actionId ||
      claims.interruptId !== action.interruptId ||
      claims.capabilityId !== action.capabilityId ||
      claims.decision !== decision
    ) {
      throw new RuntimeBoundaryError("AUTHORIZATION_BINDING", "That approval authorization does not match this request.");
    }
    return claims;
  }
}

export class DeterministicTestIdentityAdapter implements PatronIdentityVerifier {
  readonly #audience: string;
  readonly #clock: Clock;
  readonly #codec: HmacTokenCodec;
  readonly #ids: IdSource;
  readonly #issuer: string;

  constructor(input: { key: Uint8Array; audience: string; issuer: string; clock: Clock; ids: IdSource }) {
    this.#audience = input.audience;
    this.#issuer = input.issuer;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#codec = new HmacTokenCodec(input.key, "BB-TEST-IDENTITY-V1");
  }

  issue(input: { tenantId: string; patronId: string; sessionId: string; lifetimeSeconds?: number }): string {
    const now = Math.floor(this.#clock.now().getTime() / 1_000);
    return this.#codec.sign({
      version: "1",
      purpose: "boomer-buddy.test-identity",
      issuer: this.#issuer,
      audience: this.#audience,
      tenantId: input.tenantId,
      patronId: input.patronId,
      sessionId: input.sessionId,
      nonce: this.#ids.next("identity_nonce"),
      notBefore: now,
      expiresAt: now + (input.lifetimeSeconds ?? 300)
    });
  }

  async verify(request: Request): Promise<VerifiedPatronIdentity> {
    const authorization = request.headers.get("authorization");
    if (!authorization || authorization.length > MAX_TOKEN_BYTES + 7 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) {
      throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
    }
    let claims: z.infer<typeof testIdentityClaimsSchema>;
    try {
      const parsed = testIdentityClaimsSchema.safeParse(this.#codec.verify(authorization.slice(7)));
      if (!parsed.success) throw new Error("invalid identity claims");
      claims = parsed.data;
    } catch {
      throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
    }
    const now = Math.floor(this.#clock.now().getTime() / 1_000);
    if (
      claims.issuer !== this.#issuer ||
      claims.audience !== this.#audience ||
      claims.notBefore > now ||
      claims.expiresAt <= now
    ) {
      throw new RuntimeBoundaryError("AUTHENTICATION_FAILED", "The patron identity could not be verified.");
    }
    return validateVerifiedPatronIdentity({
      tenantId: claims.tenantId,
      patronId: claims.patronId,
      sessionId: claims.sessionId,
      audience: claims.audience,
      authenticationMethod: "deterministic-hmac-test-only"
    });
  }
}

export function assertIdentityMatchesAction(identity: VerifiedPatronIdentity, action: PendingAction): void {
  if (identity.tenantId !== action.tenantId || identity.patronId !== action.patronId) {
    throw new RuntimeBoundaryError("AUTHORIZATION_BINDING", "That approval authorization does not match this request.");
  }
}
