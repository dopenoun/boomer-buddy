import type { AGUIEvent } from "@ag-ui/core";
import type { PatronScope, PendingAction } from "../runtime/types.js";

export type VerifiedPatronIdentity = {
  tenantId: string;
  patronId: string;
  sessionId: string;
  audience: string;
  authenticationMethod: string;
};

export interface PatronIdentityVerifier {
  verify(request: Request): Promise<VerifiedPatronIdentity>;
}

export type ApprovalDecision = "approve" | "reject" | "cancel";

export type ApprovalAuthorizationClaims = {
  version: "1";
  purpose: "boomer-buddy.approval-resume";
  issuer: string;
  audience: string;
  tenantId: string;
  patronId: string;
  sessionId: string;
  threadId: string;
  runId: string;
  actionId: string;
  interruptId: string;
  capabilityId: "create_reminder";
  decision: ApprovalDecision;
  nonce: string;
  notBefore: number;
  expiresAt: number;
};

export type ApprovalAuthorizationSet = Record<ApprovalDecision, string>;

export type ApprovalVerificationInput = {
  identity: VerifiedPatronIdentity;
  action: PendingAction;
  decision: ApprovalDecision;
};

export type TransportReplayRecord = {
  status: number;
  events: AGUIEvent[];
};

export type BeginTransportRequestResult =
  | { state: "claimed" }
  | { state: "replay"; response: TransportReplayRecord };

export interface TransportStateStore {
  beginTransportRequest(input: {
    scope: PatronScope;
    requestId: string;
    requestDigest: string;
    kind: "start" | "resume";
    now: string;
    leaseExpiresAt: string;
  }): BeginTransportRequestResult;
  completeTransportRequest(input: {
    scope: PatronScope;
    requestId: string;
    requestDigest: string;
    kind: "start" | "resume";
    response: TransportReplayRecord;
  }): void;
  consumeAuthorizationNonce(input: {
    scope: PatronScope;
    nonce: string;
    purpose: string;
    tokenDigest: string;
    expiresAt: string;
    requestId: string;
    requestDigest: string;
    kind: "resume";
  }): void;
}

export type TransportAuditRecord = {
  occurredAt: string;
  route: "start" | "resume" | "reconnect" | "unknown";
  outcome: "succeeded" | "replayed" | "rejected";
  safeErrorCode: string | null;
  requestDigest: string | null;
  principalDigest: string | null;
};

export interface TransportAuditSink {
  record(entry: TransportAuditRecord): void;
}
