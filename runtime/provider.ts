import { RuntimeBoundaryError } from "./errors.js";
import type { ModelProposal, ModelProvider } from "./types.js";

function tomorrowAtTen(now: Date, timeZone: string): string {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(dateParts.find((candidate) => candidate.type === type)?.value);
  const target = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + 1));
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(target).find((candidate) => candidate.type === "timeZoneName")?.value;
  const offset = timeZoneName?.replace("GMT", "") || "+00:00";
  return `${target.toISOString().slice(0, 10)}T10:00:00${offset}`;
}

export class DeterministicModelProvider implements ModelProvider {
  readonly identifier = "deterministic-provider/v0";

  async propose(input: Parameters<ModelProvider["propose"]>[0]): Promise<ModelProposal> {
    if (/remind\s+me/i.test(input.patronMessage)) {
      return {
        capabilityId: "create_reminder",
        arguments: {
          title: /call\s+monte/i.test(input.patronMessage) ? "Call Monte" : "Patron reminder",
          dueAt: tomorrowAtTen(input.now, input.timeZone),
          timeZone: input.timeZone
        },
        inputProvenance: { source: "patron_message", messageId: input.messageId }
      };
    }
    if (/(?:text|font).*(?:larger|bigger)|(?:larger|bigger).*(?:text|font)/i.test(input.patronMessage)) {
      return {
        capabilityId: "search_help_catalog",
        arguments: { query: input.patronMessage },
        inputProvenance: { source: "patron_message", messageId: input.messageId }
      };
    }
    throw new RuntimeBoundaryError("NO_ALLOWED_CAPABILITY", "I cannot safely do that yet.");
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly identifier: string;
  readonly #proposal: ModelProposal;

  constructor(proposal: ModelProposal, identifier = "scripted-provider/test") {
    this.#proposal = proposal;
    this.identifier = identifier;
  }

  async propose(): Promise<ModelProposal> {
    return structuredClone(this.#proposal);
  }
}
