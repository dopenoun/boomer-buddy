import { z } from "zod";
import { RuntimeBoundaryError } from "./errors.js";

const shortText = z.string().trim().min(1).max(240);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const isoDateTime = z.iso.datetime({ offset: true });
function hasUnsafeDisplayControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}
const semanticText = z.string().trim().min(1).max(120).refine((value) => !hasUnsafeDisplayControl(value));

export const componentRegistry = Object.freeze({
  GuideCard: z.object({
    title: shortText,
    summary: z.string().trim().min(1).max(600),
    steps: z.array(shortText).min(1).max(8),
    source: z.object({
      kind: z.literal("local_help_catalog"),
      articleId: identifier,
      lastReviewedAt: z.iso.date()
    }).strict(),
    nextMove: shortText
  }).strict(),
  ReminderConfirmationCard: z.object({
    question: shortText,
    title: semanticText,
    scheduledFor: isoDateTime,
    timeZone: z.string().trim().min(1).max(80),
    actionId: identifier,
    choices: z.tuple([z.literal("Approve"), z.literal("Not now")])
  }).strict(),
  ActionReceiptCard: z.object({
    heading: shortText,
    status: z.enum(["completed", "not-created", "cancelled", "timed-out"]),
    summary: z.string().trim().min(1).max(400),
    actionId: identifier,
    capabilityId: identifier,
    occurredAt: isoDateTime,
    nextMove: shortText
  }).strict(),
  SafetyNoticeCard: z.object({
    title: shortText,
    message: z.string().trim().min(1).max(500),
    code: z.enum(["ACTION_EXPIRED", "ACTION_CANCELLED", "REQUEST_REJECTED", "SAFE_FAILURE"]),
    nextMove: shortText
  }).strict()
} as const);

export type ComponentKey = keyof typeof componentRegistry;

export type StructuredComponent = {
  [Key in ComponentKey]: { key: Key; props: z.infer<(typeof componentRegistry)[Key]> }
}[ComponentKey];

const blockedProperty = /^(?:dangerouslySetInnerHTML|innerHTML|srcDoc|script|jsx|html|on[A-Z].*)$/;
const executableText = /(?:<\/?script\b|javascript:|<\/?[A-Z][A-Za-z0-9]*\b|=>\s*[{(])/i;
const MAX_COMPONENT_BYTES = 16_384;

function rejectExecutableContent(value: unknown): void {
  if (typeof value === "string" && executableText.test(value)) {
    throw new RuntimeBoundaryError("UNSAFE_COMPONENT_PAYLOAD", "The requested display content was not safe.");
  }
  if (Array.isArray(value)) {
    value.forEach(rejectExecutableContent);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (blockedProperty.test(key)) {
        throw new RuntimeBoundaryError("UNSAFE_COMPONENT_PROPERTY", "The requested display content was not safe.");
      }
      rejectExecutableContent(child);
    }
  }
}

export function validateStructuredComponent(value: unknown): StructuredComponent {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RuntimeBoundaryError("INVALID_COMPONENT_PROPS", "The requested display content was malformed.");
  }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_COMPONENT_BYTES) {
    throw new RuntimeBoundaryError("COMPONENT_PAYLOAD_TOO_LARGE", "The requested display content was too large.");
  }
  rejectExecutableContent(value);
  const envelope = z.object({ key: z.string(), props: z.unknown() }).strict().safeParse(value);
  if (!envelope.success || !Object.hasOwn(componentRegistry, envelope.data.key)) {
    throw new RuntimeBoundaryError("UNKNOWN_COMPONENT", "The requested display component is not available.");
  }
  const key = envelope.data.key as ComponentKey;
  const props = componentRegistry[key].safeParse(envelope.data.props);
  if (!props.success) {
    throw new RuntimeBoundaryError("INVALID_COMPONENT_PROPS", "The requested display content was malformed.");
  }
  return { key, props: props.data } as StructuredComponent;
}
