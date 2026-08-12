import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { capabilitySchemas } from "../runtime/capabilities.js";
import { RuntimeBoundaryError } from "../runtime/errors.js";
import {
  assertReceiptIsSafe,
  resolvePendingDecision
} from "../runtime/store.js";
import type { ResolvePendingActionInput, RuntimeStore } from "../runtime/store.js";
import type {
  ExecutionReceipt,
  IdSource,
  PatronScope,
  PendingAction,
  PendingResolution,
  Reminder
} from "../runtime/types.js";
import type {
  BeginTransportRequestResult,
  TransportReplayRecord,
  TransportStateStore
} from "./types.js";
import { validateStoredEvents } from "./events.js";

const MAX_STORED_RECORD_BYTES = 262_144;
const SCHEMA_VERSION = 1;
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const pendingActionSchema = z.object({
  tenantId: identifier,
  patronId: identifier,
  threadId: identifier,
  runId: identifier,
  actionId: identifier,
  interruptId: identifier,
  toolCallId: identifier,
  capabilityId: z.literal("create_reminder"),
  capabilityVersion: z.string().min(1).max(40),
  arguments: capabilitySchemas.reminderInput,
  prompt: z.string().min(1).max(500),
  status: z.enum(["pending", "executed", "rejected", "cancelled", "timed-out"]),
  expiresAt: z.iso.datetime({ offset: true }),
  result: z.union([z.null(), capabilitySchemas.reminderOutput])
}).strict();
const receiptSchema = z.object({
  receiptId: identifier,
  receiptType: z.enum(["run", "action"]),
  tenantId: identifier,
  patronId: identifier,
  threadId: identifier,
  runId: identifier,
  actionId: z.union([identifier, z.null()]),
  capabilityId: z.union([z.string().min(1).max(100), z.null()]),
  capabilityVersion: z.union([z.string().min(1).max(40), z.null()]),
  modelProvider: z.string().min(1).max(120),
  inputProvenance: z.object({
    source: z.enum(["patron_message", "approval_resume"]),
    messageId: z.union([identifier, z.null()]),
    contentDigest: z.union([z.string().regex(/^sha256:[a-f0-9]{64}$/), z.null()])
  }).strict(),
  approvalState: z.enum(["not-required", "pending", "approved", "rejected", "cancelled", "timed-out"]),
  outcome: z.enum(["succeeded", "interrupted", "rejected", "cancelled", "timed-out", "failed"]),
  safeErrorCode: z.union([z.string().min(1).max(100), z.null()]),
  createdAt: z.iso.datetime({ offset: true })
}).strict();

type SqlRow = Record<string, unknown>;

const expectedColumns = Object.freeze({
  patron_threads: ["tenant_id", "patron_id", "thread_id"],
  pending_actions: ["interrupt_id", "tenant_id", "patron_id", "thread_id", "action_id", "record_json"],
  reminders: ["tenant_id", "patron_id", "action_id", "record_json"],
  receipts: ["tenant_id", "patron_id", "receipt_id", "record_json"],
  authorization_nonces: ["tenant_id", "patron_id", "nonce", "purpose", "token_digest", "expires_at", "request_id", "request_digest", "kind"],
  transport_requests: ["tenant_id", "patron_id", "request_id", "request_digest", "kind", "state", "response_json", "started_at", "lease_expires_at"]
});
const expectedPrimaryKeys: Readonly<Record<keyof typeof expectedColumns, readonly string[]>> = Object.freeze({
  patron_threads: ["tenant_id", "thread_id"],
  pending_actions: ["interrupt_id"],
  reminders: ["tenant_id", "patron_id", "action_id"],
  receipts: ["tenant_id", "patron_id", "receipt_id"],
  authorization_nonces: ["tenant_id", "patron_id", "nonce"],
  transport_requests: ["tenant_id", "patron_id", "request_id"]
});

function encodeStored(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORED_RECORD_BYTES) {
    throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  }
  return encoded;
}

function decodeStored(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_STORED_RECORD_BYTES) {
    throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  }
}

function parseAction(value: unknown): PendingAction {
  const parsed = pendingActionSchema.safeParse(decodeStored(value));
  if (!parsed.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  return parsed.data;
}

function parseReminder(value: unknown): Reminder {
  const parsed = capabilitySchemas.reminderOutput.safeParse(decodeStored(value));
  if (!parsed.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  return parsed.data;
}

function parseReceipt(value: unknown): ExecutionReceipt {
  const parsed = receiptSchema.safeParse(decodeStored(value));
  if (!parsed.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  assertReceiptIsSafe(parsed.data);
  return parsed.data;
}

function parseReplay(value: unknown): TransportReplayRecord {
  const decoded = decodeStored(value);
  const envelope = z.object({ status: z.literal(200), events: z.array(z.unknown()).max(200) }).strict().safeParse(decoded);
  if (!envelope.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
  return { status: 200, events: validateStoredEvents(envelope.data.events) };
}

export class SqliteRuntimeStore implements RuntimeStore, TransportStateStore {
  readonly #db: DatabaseSync;
  readonly #ids: IdSource;

  constructor(input: { path: string; ids: IdSource; busyTimeoutMs?: number }) {
    if (
      typeof input.path !== "string" || input.path.length < 1 || input.path.length > 4_096 ||
      input.path.includes("\0") || input.path.startsWith("file:")
    ) {
      throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
    }
    const busyTimeoutMs = input.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
    }
    this.#ids = input.ids;
    try {
      this.#db = new DatabaseSync(input.path);
    } catch {
      throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
    }
    try {
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      const versionRow = this.#db.prepare("PRAGMA user_version").get() as SqlRow;
      const version = versionRow.user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) {
        throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
      }
      if (version === 0) {
      const existing = this.#db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all() as SqlRow[];
      if (existing.length > 0) {
        throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
      }
      this.#db.exec(`
      CREATE TABLE IF NOT EXISTS patron_threads (
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, thread_id),
        UNIQUE (tenant_id, patron_id, thread_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pending_actions (
        interrupt_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (tenant_id, patron_id, action_id),
        FOREIGN KEY (tenant_id, patron_id, thread_id)
          REFERENCES patron_threads (tenant_id, patron_id, thread_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_actions_patron_partition
        ON pending_actions (tenant_id, patron_id, thread_id, interrupt_id);
      CREATE TABLE IF NOT EXISTS reminders (
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, patron_id, action_id),
        FOREIGN KEY (tenant_id, patron_id, action_id)
          REFERENCES pending_actions (tenant_id, patron_id, action_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipts (
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, patron_id, receipt_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS authorization_nonces (
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        purpose TEXT NOT NULL,
        token_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (tenant_id, patron_id, nonce)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transport_requests (
        tenant_id TEXT NOT NULL,
        patron_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json TEXT,
        started_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, patron_id, request_id)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
      }
      this.#validateSchema();
    } catch (error) {
      try {
        this.#db.close();
      } catch {
        // Initialization already failed; expose only the canonical storage error.
      }
      if (error instanceof RuntimeBoundaryError) throw error;
      throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
    }
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(operation: () => T): T {
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new RuntimeBoundaryError("STORAGE_UNAVAILABLE", "The stored data is temporarily unavailable.");
    }
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        throw new RuntimeBoundaryError("STORAGE_UNAVAILABLE", "The stored data is temporarily unavailable.");
      }
      if (error instanceof RuntimeBoundaryError) throw error;
      throw new RuntimeBoundaryError("STORAGE_UNAVAILABLE", "The stored data is temporarily unavailable.");
    }
  }

  #validateSchema(): void {
    try {
      for (const [table, columns] of Object.entries(expectedColumns)) {
        const rows = this.#db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
        if (rows.map((row) => row.name).join("\0") !== columns.join("\0")) {
          throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
        }
        if (rows.some((row) => row.type !== "TEXT" || (row.name !== "response_json" && row.notnull !== 1))) {
          throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
        }
        const primaryKey = rows.filter((row) => typeof row.pk === "number" && row.pk > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((row) => row.name);
        if (primaryKey.join("\0") !== expectedPrimaryKeys[table as keyof typeof expectedColumns].join("\0")) {
          throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
        }
        const createRow = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as SqlRow | undefined;
        if (typeof createRow?.sql !== "string" || !/\) STRICT$/i.test(createRow.sql.trim())) {
          throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
        }
      }
      const pendingForeignKeys = this.#db.prepare("PRAGMA foreign_key_list(pending_actions)").all() as SqlRow[];
      const reminderForeignKeys = this.#db.prepare("PRAGMA foreign_key_list(reminders)").all() as SqlRow[];
      if (pendingForeignKeys.length !== 3 || reminderForeignKeys.length !== 3) {
        throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
      }
      const foreignKeyProblems = this.#db.prepare("PRAGMA foreign_key_check").all() as SqlRow[];
      if (foreignKeyProblems.length > 0) {
        throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
      }
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) throw error;
      throw new RuntimeBoundaryError("STORAGE_SCHEMA_MISMATCH", "The stored data schema is not supported.");
    }
  }

  #parseActionRow(row: SqlRow): PendingAction {
    const action = parseAction(row.record_json);
    if (
      action.tenantId !== row.tenant_id || action.patronId !== row.patron_id ||
      action.threadId !== row.thread_id || action.interruptId !== row.interrupt_id ||
      action.actionId !== row.action_id ||
      (action.result !== null && (
        action.result.tenantId !== action.tenantId || action.result.patronId !== action.patronId ||
        action.result.actionId !== action.actionId
      ))
    ) {
      throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    }
    return action;
  }

  #parseReminderRow(row: SqlRow): Reminder {
    const reminder = parseReminder(row.record_json);
    if (reminder.tenantId !== row.tenant_id || reminder.patronId !== row.patron_id || reminder.actionId !== row.action_id) {
      throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    }
    return reminder;
  }

  #parseReceiptRow(row: SqlRow): ExecutionReceipt {
    const receipt = parseReceipt(row.record_json);
    if (receipt.tenantId !== row.tenant_id || receipt.patronId !== row.patron_id || receipt.receiptId !== row.receipt_id) {
      throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    }
    return receipt;
  }

  #assertScopeInside(scope: PatronScope): void {
    const row = this.#db.prepare(
      "SELECT patron_id FROM patron_threads WHERE tenant_id = ? AND thread_id = ?"
    ).get(scope.tenantId, scope.threadId) as SqlRow | undefined;
    if (row && row.patron_id !== scope.patronId) {
      throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That conversation belongs to a different patron.");
    }
    this.#db.prepare(
      "INSERT OR IGNORE INTO patron_threads (tenant_id, patron_id, thread_id) VALUES (?, ?, ?)"
    ).run(scope.tenantId, scope.patronId, scope.threadId);
  }

  assertScope(scope: PatronScope): void {
    this.#transaction(() => this.#assertScopeInside(scope));
  }

  savePendingAction(action: PendingAction): void {
    const validated = pendingActionSchema.safeParse(action);
    if (!validated.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    this.#transaction(() => {
      this.#assertScopeInside(action);
      const existing = this.#db.prepare("SELECT interrupt_id, tenant_id, patron_id, thread_id, action_id, record_json FROM pending_actions WHERE interrupt_id = ?")
        .get(action.interruptId) as SqlRow | undefined;
      if (existing && encodeStored(this.#parseActionRow(existing)) !== encodeStored(validated.data)) {
        throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
      }
      this.#db.prepare(`
        INSERT OR IGNORE INTO pending_actions
          (interrupt_id, tenant_id, patron_id, thread_id, action_id, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(action.interruptId, action.tenantId, action.patronId, action.threadId, action.actionId, encodeStored(validated.data));
    });
  }

  getPendingAction(scope: PatronScope, interruptId: string): PendingAction {
    this.assertScope(scope);
    const row = this.#db.prepare("SELECT interrupt_id, tenant_id, patron_id, thread_id, action_id, record_json FROM pending_actions WHERE interrupt_id = ?")
      .get(interruptId) as SqlRow | undefined;
    if (!row) throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
    if (row.tenant_id !== scope.tenantId || row.patron_id !== scope.patronId || row.thread_id !== scope.threadId) {
      throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That approval request belongs to a different patron.");
    }
    return structuredClone(this.#parseActionRow(row));
  }

  resolvePendingAction(input: ResolvePendingActionInput): PendingResolution {
    return this.#transaction(() => {
      this.#assertScopeInside(input.scope);
      const row = this.#db.prepare("SELECT interrupt_id, tenant_id, patron_id, thread_id, action_id, record_json FROM pending_actions WHERE interrupt_id = ?")
        .get(input.interruptId) as SqlRow | undefined;
      if (!row) throw new RuntimeBoundaryError("UNKNOWN_INTERRUPT", "That approval request is no longer available.");
      if (row.tenant_id !== input.scope.tenantId || row.patron_id !== input.scope.patronId || row.thread_id !== input.scope.threadId) {
        throw new RuntimeBoundaryError("CROSS_PATRON_ACCESS", "That approval request belongs to a different patron.");
      }
      const action = this.#parseActionRow(row);
      const reminderRow = this.#db.prepare(
        "SELECT tenant_id, patron_id, action_id, record_json FROM reminders WHERE tenant_id = ? AND patron_id = ? AND action_id = ?"
      ).get(action.tenantId, action.patronId, action.actionId) as SqlRow | undefined;
      const resolution = resolvePendingDecision(
        action,
        input.decision,
        input.now,
        input.reminderId,
        reminderRow ? this.#parseReminderRow(reminderRow) : null
      );
      const validatedAction = pendingActionSchema.safeParse(resolution.action);
      const validatedReminder = resolution.reminder ? capabilitySchemas.reminderOutput.safeParse(resolution.reminder) : null;
      if (!validatedAction.success || (validatedReminder && !validatedReminder.success)) {
        throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
      }
      if (resolution.reminder) {
        this.#db.prepare(`
          INSERT OR IGNORE INTO reminders (tenant_id, patron_id, action_id, record_json)
          VALUES (?, ?, ?, ?)
        `).run(action.tenantId, action.patronId, action.actionId, encodeStored(resolution.reminder));
      }
      this.#db.prepare("UPDATE pending_actions SET record_json = ? WHERE interrupt_id = ?")
        .run(encodeStored(resolution.action), action.interruptId);
      return structuredClone(resolution);
    });
  }

  createReminderOnce(action: PendingAction, createdAt: string): Reminder {
    const resolution = this.resolvePendingAction({
      scope: action,
      interruptId: action.interruptId,
      decision: "approve",
      now: createdAt,
      reminderId: this.#ids.next("reminder")
    });
    if (!resolution.reminder) throw new RuntimeBoundaryError("SAFE_FAILURE", "The request could not be completed safely.");
    return resolution.reminder;
  }

  listReminders(scope: Pick<PatronScope, "tenantId" | "patronId">): Reminder[] {
    const rows = this.#db.prepare(
      "SELECT tenant_id, patron_id, action_id, record_json FROM reminders WHERE tenant_id = ? AND patron_id = ? ORDER BY action_id"
    ).all(scope.tenantId, scope.patronId) as SqlRow[];
    return rows.map((row) => structuredClone(this.#parseReminderRow(row)));
  }

  appendReceipt(receipt: ExecutionReceipt): void {
    const parsed = receiptSchema.safeParse(receipt);
    if (!parsed.success) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    assertReceiptIsSafe(parsed.data);
    this.#transaction(() => {
      this.#assertScopeInside(receipt);
      const result = this.#db.prepare(`
        INSERT OR IGNORE INTO receipts (tenant_id, patron_id, receipt_id, record_json) VALUES (?, ?, ?, ?)
      `).run(receipt.tenantId, receipt.patronId, receipt.receiptId, encodeStored(parsed.data));
      if (result.changes !== 1) throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
    });
  }

  listReceipts(scope: Pick<PatronScope, "tenantId" | "patronId">): ExecutionReceipt[] {
    const rows = this.#db.prepare(
      "SELECT tenant_id, patron_id, receipt_id, record_json FROM receipts WHERE tenant_id = ? AND patron_id = ? ORDER BY rowid"
    ).all(scope.tenantId, scope.patronId) as SqlRow[];
    return rows.map((row) => structuredClone(this.#parseReceiptRow(row)));
  }

  beginTransportRequest(input: {
    scope: PatronScope;
    requestId: string;
    requestDigest: string;
    kind: "start" | "resume";
    now: string;
    leaseExpiresAt: string;
  }): BeginTransportRequestResult {
    return this.#transaction(() => {
      this.#assertScopeInside(input.scope);
      const row = this.#db.prepare(`
        SELECT request_digest, kind, state, response_json, lease_expires_at
        FROM transport_requests WHERE tenant_id = ? AND patron_id = ? AND request_id = ?
      `).get(input.scope.tenantId, input.scope.patronId, input.requestId) as SqlRow | undefined;
      if (row) {
        if (row.request_digest !== input.requestDigest || row.kind !== input.kind) {
          throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
        }
        if (row.state === "completed") return { state: "replay", response: parseReplay(row.response_json) };
        if (row.state !== "processing" || typeof row.lease_expires_at !== "string") {
          throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
        }
        if (new Date(row.lease_expires_at).getTime() > new Date(input.now).getTime()) {
          throw new RuntimeBoundaryError("REQUEST_IN_PROGRESS", "That request is already being processed.");
        }
        this.#db.prepare(`
          UPDATE transport_requests SET started_at = ?, lease_expires_at = ?
          WHERE tenant_id = ? AND patron_id = ? AND request_id = ?
        `).run(input.now, input.leaseExpiresAt, input.scope.tenantId, input.scope.patronId, input.requestId);
        return { state: "claimed" };
      }
      this.#db.prepare(`
        INSERT INTO transport_requests
          (tenant_id, patron_id, request_id, request_digest, kind, state, response_json, started_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?, ?)
      `).run(
        input.scope.tenantId,
        input.scope.patronId,
        input.requestId,
        input.requestDigest,
        input.kind,
        input.now,
        input.leaseExpiresAt
      );
      return { state: "claimed" };
    });
  }

  completeTransportRequest(input: {
    scope: PatronScope;
    requestId: string;
    requestDigest: string;
    kind: "start" | "resume";
    response: TransportReplayRecord;
  }): void {
    const response = parseReplay(encodeStored({
      status: 200 as const,
      events: validateStoredEvents(input.response.events)
    }));
    this.#transaction(() => {
      this.#assertScopeInside(input.scope);
      const result = this.#db.prepare(`
        UPDATE transport_requests SET state = 'completed', response_json = ?
        WHERE tenant_id = ? AND patron_id = ? AND request_id = ?
          AND request_digest = ? AND kind = ? AND state = 'processing'
      `).run(
        encodeStored(response),
        input.scope.tenantId,
        input.scope.patronId,
        input.requestId,
        input.requestDigest,
        input.kind
      );
      if (result.changes !== 1) throw new RuntimeBoundaryError("STORAGE_RECORD_INVALID", "Stored state could not be read safely.");
    });
  }

  consumeAuthorizationNonce(input: {
    scope: PatronScope;
    nonce: string;
    purpose: string;
    tokenDigest: string;
    expiresAt: string;
    requestId: string;
    requestDigest: string;
    kind: "resume";
  }): void {
    this.#transaction(() => {
      this.#assertScopeInside(input.scope);
      const existing = this.#db.prepare(`
        SELECT purpose, token_digest, expires_at, request_id, request_digest, kind
        FROM authorization_nonces WHERE tenant_id = ? AND patron_id = ? AND nonce = ?
      `).get(input.scope.tenantId, input.scope.patronId, input.nonce) as SqlRow | undefined;
      if (existing) {
        if (
          existing.purpose === input.purpose && existing.token_digest === input.tokenDigest &&
          existing.expires_at === input.expiresAt && existing.request_id === input.requestId &&
          existing.request_digest === input.requestDigest && existing.kind === input.kind
        ) return;
        throw new RuntimeBoundaryError("AUTHORIZATION_REPLAY", "That approval authorization has already been used.");
      }
      this.#db.prepare(`
        INSERT INTO authorization_nonces
          (tenant_id, patron_id, nonce, purpose, token_digest, expires_at, request_id, request_digest, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.scope.tenantId,
        input.scope.patronId,
        input.nonce,
        input.purpose,
        input.tokenDigest,
        input.expiresAt,
        input.requestId,
        input.requestDigest,
        input.kind
      );
    });
  }
}
