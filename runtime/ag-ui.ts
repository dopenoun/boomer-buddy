import { EventSchemas, EventType } from "@ag-ui/core";
import type { AGUIEvent } from "@ag-ui/core";
import { z } from "zod";
import { executableCapabilityRegistry } from "./capabilities.js";
import { validateStructuredComponent } from "./components.js";
import { RuntimeBoundaryError } from "./errors.js";

const MAX_EVENT_BYTES = 65_536;
const allowedEventTypes = new Set<string>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.CUSTOM
]);

const uiEventValueSchema = z.object({
  schemaVersion: z.literal("0.1"),
  component: z.unknown()
}).strict();

const runtimeStatusSchema = z.enum(["working", "resuming", "awaiting-approval", "completed", "rejected", "cancelled", "timed-out"]);
const pendingActionSchema = z.union([
  z.null(),
  z.object({
    actionId: z.string().min(1).max(200),
    capabilityId: z.literal("create_reminder"),
    expiresAt: z.iso.datetime({ offset: true })
  }).strict()
]);
const nextMovesSchema = z.array(z.string().min(1).max(240)).max(8);
const jsonPatchOperationSchema = z.discriminatedUnion("path", [
  z.object({ op: z.literal("replace"), path: z.literal("/status"), value: runtimeStatusSchema }).strict(),
  z.object({ op: z.literal("replace"), path: z.literal("/currentRunId"), value: z.string().min(1).max(200) }).strict(),
  z.object({ op: z.literal("replace"), path: z.literal("/pendingAction"), value: pendingActionSchema }).strict(),
  z.object({ op: z.literal("replace"), path: z.literal("/nextAvailableMoves"), value: nextMovesSchema }).strict()
]);

const runtimeStateSchema = z.object({
  status: runtimeStatusSchema,
  currentRunId: z.string().min(1).max(200),
  pendingAction: pendingActionSchema,
  nextAvailableMoves: nextMovesSchema
}).strict();

export function validateAgUiEvent(value: unknown): AGUIEvent {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RuntimeBoundaryError("MALFORMED_AG_UI_EVENT", "The protocol event was malformed.");
  }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) {
    throw new RuntimeBoundaryError("MALFORMED_AG_UI_EVENT", "The protocol event was malformed.");
  }
  const parsed = EventSchemas.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeBoundaryError("MALFORMED_AG_UI_EVENT", "The protocol event was malformed.");
  }
  if (!allowedEventTypes.has(parsed.data.type)) {
    throw new RuntimeBoundaryError("UNSUPPORTED_AG_UI_EVENT", "The protocol event type is not supported.");
  }
  if (parsed.data.type === EventType.CUSTOM) {
    if (parsed.data.name !== "boomer_buddy.ui") {
      throw new RuntimeBoundaryError("UNKNOWN_CUSTOM_EVENT", "The protocol event was not recognized.");
    }
    const uiValue = uiEventValueSchema.safeParse(parsed.data.value);
    if (!uiValue.success) {
      throw new RuntimeBoundaryError("MALFORMED_UI_EVENT", "The display event was malformed.");
    }
    validateStructuredComponent(uiValue.data.component);
  }
  if (parsed.data.type === EventType.STATE_DELTA) {
    const patch = z.array(jsonPatchOperationSchema).min(1).max(20).safeParse(parsed.data.delta);
    if (!patch.success) {
      throw new RuntimeBoundaryError("MALFORMED_STATE_DELTA", "The state update was malformed.");
    }
  }
  if (parsed.data.type === EventType.STATE_SNAPSHOT && !runtimeStateSchema.safeParse(parsed.data.snapshot).success) {
    throw new RuntimeBoundaryError("MALFORMED_AG_UI_EVENT", "The protocol event was malformed.");
  }
  if (
    parsed.data.type === EventType.TOOL_CALL_START &&
    !Object.hasOwn(executableCapabilityRegistry, parsed.data.toolCallName)
  ) {
    throw new RuntimeBoundaryError("UNREGISTERED_CAPABILITY", "The requested action is not available.");
  }
  return parsed.data;
}

export function checkedEvent(value: unknown): AGUIEvent {
  return validateAgUiEvent(value);
}

export function uiEvent(component: unknown, timestamp: number): AGUIEvent {
  const validated = validateStructuredComponent(component);
  return checkedEvent({
    type: EventType.CUSTOM,
    name: "boomer_buddy.ui",
    value: { schemaVersion: "0.1", component: validated },
    timestamp
  });
}
