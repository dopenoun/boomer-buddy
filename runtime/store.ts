import { createHash } from "node:crypto";
import { RuntimeBoundaryError } from "./errors.js";
import type {
  ExecutionReceipt,
  IdSource,
  PatronScope,
  PendingAction,
  Reminder
} from "./types.js";

const SENSITIVE_KEY = /(?:secret|password|passcode|token|biometric|face.?id|raw.?content|message.?content)/i;
const SENSITIVE_VALUE = /(?:BEGIN (?:RSA |EC )?PRIVATE KEY|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{8,})/i;

function tupleKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function samePendingIdentity(left: PendingAction, right: PendingAction): boolean {
  return left.tenantId === right.tenantId &&
    left.patronId === right.patronId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.actionId === right.actionId &&
    left.interruptId === right.interruptId &&
    left.toolCallId === right.toolCallId &&
    left.capabilityId === right.capabilityId &&
    left.capabilityVersion === right.capabilityVersion &&
    left.prompt === right.prompt &&
    left.expiresAt === right.expiresAt &&
    JSON.stringify(left.arguments) === JSON.stringify(right.arguments);
}

export function contentDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function assertReceiptIsSafe(receipt: ExecutionReceipt): void {
  const inspect = (value: unknown): void => {
    if (typeof value === "string" && SENSITIVE_VALUE.test(value)) {
      throw new RuntimeBoundaryError("SENSITIVE_RECEIPT_VALUE", "Sensitive information cannot be stored in a receipt.");
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new RuntimeBoundaryError("SENSITIVE_RECEIPT_FIELD", "Sensitive information cannot be stored in a receipt.");
      }
      inspect(child);
    }
  };
  inspect(receipt);
}

export class InMemoryRuntimeStore {
  readonly #ids: IdSource;
  readonly #threadOwners = new Map<string, string>();
  readonly #pendingActions = new Map<string, PendingAction>();
  readonly #remindersByAction = new Map<string, Reminder>();
  readonly #receipts: ExecutionReceipt[] = [];

  constructor(ids: IdSource) {
    this.#ids = ids;
  }

  assertScope(scope: PatronScope): void {
    const threadKey = tupleKey(scope.tenantId, scope.threadId);
    const owner = this.#threadOwners.get(threadKey);
    if (owner && owner !== scope.patronId) {
      throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That conversation belongs to a different patron.");
    }
    this.#threadOwners.set(threadKey, scope.patronId);
  }

  savePendingAction(action: PendingAction): void {
    this.assertScope(action);
    const existing = this.#pendingActions.get(action.interruptId);
    if (existing && !samePendingIdentity(existing, action)) {
      throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
    }
    this.#pendingActions.set(action.interruptId, structuredClone(action));
  }

  getPendingAction(scope: PatronScope, interruptId: string): PendingAction {
    this.assertScope(scope);
    const action = this.#pendingActions.get(interruptId);
    if (!action) {
      throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
    }
    if (
      action.tenantId !== scope.tenantId ||
      action.patronId !== scope.patronId ||
      action.threadId !== scope.threadId
    ) {
      throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That approval request belongs to a different patron.");
    }
    return structuredClone(action);
  }

  updatePendingAction(action: PendingAction): void {
    const current = this.#pendingActions.get(action.interruptId);
    if (!current) throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
    if (!samePendingIdentity(current, action)) {
      throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That approval request belongs to a different patron.");
    }
    this.#pendingActions.set(action.interruptId, structuredClone(action));
  }

  createReminderOnce(action: PendingAction, createdAt: string): Reminder {
    const actionKey = tupleKey(action.tenantId, action.patronId, action.actionId);
    const existing = this.#remindersByAction.get(actionKey);
    if (existing) {
      if (
        existing.title !== action.arguments.title ||
        existing.dueAt !== action.arguments.dueAt ||
        existing.timeZone !== action.arguments.timeZone
      ) {
        throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
      }
      return structuredClone(existing);
    }
    const reminder: Reminder = {
      reminderId: this.#ids.next("reminder"),
      tenantId: action.tenantId,
      patronId: action.patronId,
      title: action.arguments.title,
      dueAt: action.arguments.dueAt,
      timeZone: action.arguments.timeZone,
      createdAt,
      actionId: action.actionId
    };
    this.#remindersByAction.set(actionKey, reminder);
    return structuredClone(reminder);
  }

  listReminders(scope: Pick<PatronScope, "tenantId" | "patronId">): Reminder[] {
    return [...this.#remindersByAction.values()]
      .filter((item) => item.tenantId === scope.tenantId && item.patronId === scope.patronId)
      .map((item) => structuredClone(item));
  }

  appendReceipt(receipt: ExecutionReceipt): void {
    assertReceiptIsSafe(receipt);
    this.#receipts.push(structuredClone(receipt));
  }

  listReceipts(scope: Pick<PatronScope, "tenantId" | "patronId">): ExecutionReceipt[] {
    return this.#receipts
      .filter((item) => item.tenantId === scope.tenantId && item.patronId === scope.patronId)
      .map((item) => structuredClone(item));
  }
}
