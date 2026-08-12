import type { z } from "zod";
import { randomUUID } from "node:crypto";

export type PatronScope = {
  tenantId: string;
  patronId: string;
  threadId: string;
};

export type Clock = { now(): Date };

export type IdSource = { next(prefix: string): string };

export type CapabilityClassification = "read-only" | "mutating";
export type ApprovalPolicy = "none" | "semantic-confirmation" | "vault-authorization";

export type CapabilityManifest<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> = {
  id: string;
  version: string;
  purpose: string;
  inputSchema: Input;
  outputSchema: Output;
  classification: CapabilityClassification;
  approvalPolicy: ApprovalPolicy;
  requiredPatronScope: "patron";
  receiptRequirements: readonly string[];
  allowedComponents: readonly string[];
};

export type ModelProposal = {
  capabilityId: string;
  arguments: unknown;
  inputProvenance: {
    source: "patron_message";
    messageId: string;
  };
};

export type ModelProvider = {
  readonly identifier: string;
  propose(input: {
    patronMessage: string;
    messageId: string;
    now: Date;
    timeZone: string;
    allowedCapabilityIds: readonly string[];
  }): Promise<ModelProposal>;
};

export type ApprovalState = "not-required" | "pending" | "approved" | "rejected" | "cancelled" | "timed-out";
export type ExecutionOutcome = "succeeded" | "interrupted" | "rejected" | "cancelled" | "timed-out" | "failed";

export type ExecutionReceipt = {
  receiptId: string;
  receiptType: "run" | "action";
  tenantId: string;
  patronId: string;
  threadId: string;
  runId: string;
  actionId: string | null;
  capabilityId: string | null;
  capabilityVersion: string | null;
  modelProvider: string;
  inputProvenance: {
    source: "patron_message" | "approval_resume";
    messageId: string | null;
    contentDigest: string | null;
  };
  approvalState: ApprovalState;
  outcome: ExecutionOutcome;
  safeErrorCode: string | null;
  createdAt: string;
};

export type Reminder = {
  reminderId: string;
  tenantId: string;
  patronId: string;
  title: string;
  dueAt: string;
  timeZone: string;
  createdAt: string;
  actionId: string;
};

export type PendingAction = {
  tenantId: string;
  patronId: string;
  threadId: string;
  runId: string;
  actionId: string;
  interruptId: string;
  toolCallId: string;
  capabilityId: "create_reminder";
  capabilityVersion: string;
  arguments: { title: string; dueAt: string; timeZone: string };
  prompt: string;
  status: "pending" | "executed" | "rejected" | "cancelled" | "timed-out";
  expiresAt: string;
  result: Reminder | null;
};

export type PendingDecision = "approve" | "reject" | "cancel";

export type PendingResolution = {
  action: PendingAction;
  status: "executed" | "rejected" | "cancelled" | "timed-out";
  reminder: Reminder | null;
  duplicate: boolean;
};

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SequentialIds implements IdSource {
  #value = 0;

  next(prefix: string): string {
    this.#value += 1;
    return `${prefix}_${this.#value.toString().padStart(6, "0")}`;
  }
}

export class RandomIds implements IdSource {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}
