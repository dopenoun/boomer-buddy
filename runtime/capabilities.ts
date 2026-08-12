import { z } from "zod";
import type { CapabilityManifest } from "./types.js";

function hasUnsafeDisplayControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}
const semanticTitle = z.string().trim().min(1).max(120).refine(
  (value) => !hasUnsafeDisplayControl(value),
  "Control characters are not allowed in semantic approval text."
);

const searchInput = z.object({
  query: z.string().trim().min(3).max(200)
}).strict();

const guideOutput = z.object({
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(600),
  steps: z.array(z.string().min(1).max(240)).min(1).max(8),
  source: z.object({
    kind: z.literal("local_help_catalog"),
    articleId: z.string(),
    lastReviewedAt: z.iso.date()
  }).strict(),
  nextMove: z.string().min(1).max(240)
}).strict();

const reminderInput = z.object({
  title: semanticTitle,
  dueAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().trim().min(1).max(80)
}).strict();

const reminderOutput = z.object({
  reminderId: z.string(),
  tenantId: z.string(),
  patronId: z.string(),
  title: z.string(),
  dueAt: z.iso.datetime({ offset: true }),
  timeZone: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  actionId: z.string()
}).strict();

export const searchHelpCatalogManifest = Object.freeze({
  id: "search_help_catalog",
  version: "0.1.0",
  purpose: "Find a reviewed, local plain-language help guide.",
  inputSchema: searchInput,
  outputSchema: guideOutput,
  classification: "read-only",
  approvalPolicy: "none",
  requiredPatronScope: "patron",
  receiptRequirements: ["scope", "provenance", "outcome", "timestamp"],
  allowedComponents: ["GuideCard"]
} as const satisfies CapabilityManifest<typeof searchInput, typeof guideOutput>);

export const createReminderManifest = Object.freeze({
  id: "create_reminder",
  version: "0.1.0",
  purpose: "Create one patron-scoped reminder after understandable approval.",
  inputSchema: reminderInput,
  outputSchema: reminderOutput,
  classification: "mutating",
  approvalPolicy: "semantic-confirmation",
  requiredPatronScope: "patron",
  receiptRequirements: ["scope", "provenance", "approval", "outcome", "timestamp"],
  allowedComponents: ["ReminderConfirmationCard", "ActionReceiptCard", "SafetyNoticeCard"]
} as const satisfies CapabilityManifest<typeof reminderInput, typeof reminderOutput>);

export const executableCapabilityRegistry = Object.freeze({
  [searchHelpCatalogManifest.id]: searchHelpCatalogManifest,
  [createReminderManifest.id]: createReminderManifest
});

export const intendedCapabilityCatalog = Object.freeze([
  { id: "search_help_catalog", status: "implemented", classification: "read-only", approvalPolicy: "none" },
  { id: "read_patron_note", status: "planned", classification: "read-only", approvalPolicy: "none" },
  { id: "create_reminder", status: "implemented", classification: "mutating", approvalPolicy: "semantic-confirmation" },
  { id: "list_reminders", status: "planned", classification: "read-only", approvalPolicy: "none" },
  { id: "request_vault_unlock", status: "planned", classification: "mutating", approvalPolicy: "semantic-confirmation" },
  { id: "read_unlocked_vault_item", status: "planned", classification: "read-only", approvalPolicy: "vault-authorization" },
  { id: "save_patron_preference", status: "planned", classification: "mutating", approvalPolicy: "semantic-confirmation" },
  { id: "contact_trusted_helper", status: "planned", classification: "mutating", approvalPolicy: "semantic-confirmation" }
] as const);

export type ExecutableCapabilityId = keyof typeof executableCapabilityRegistry;

const localHelpArticles = [
  {
    articleId: "iphone-larger-text",
    match: /(?:iphone|text|larger|bigger|font)/i,
    title: "Make text larger on an iPhone",
    summary: "Use the iPhone's built-in Text Size setting. You can change it back at any time.",
    steps: [
      "Open Settings.",
      "Tap Display & Brightness.",
      "Tap Text Size.",
      "Move the slider to the right until the text is comfortable to read."
    ],
    source: { kind: "local_help_catalog" as const, articleId: "iphone-larger-text", lastReviewedAt: "2026-08-11" },
    nextMove: "You can also ask how to make only one app easier to read."
  }
] as const;

export function searchHelpCatalog(input: z.infer<typeof searchInput>): z.infer<typeof guideOutput> {
  const article = localHelpArticles.find((candidate) => candidate.match.test(input.query)) ?? localHelpArticles[0];
  return guideOutput.parse({
    title: article.title,
    summary: article.summary,
    steps: article.steps,
    source: article.source,
    nextMove: article.nextMove
  });
}

export const capabilitySchemas = { searchInput, guideOutput, reminderInput, reminderOutput };
