import { EventType } from "@ag-ui/core";
import {
  BoomerBuddyRuntime,
  DeterministicModelProvider,
  InMemoryRuntimeStore,
  SequentialIds
} from "../runtime/index.js";
import type { Clock } from "../runtime/index.js";

class DemoClock implements Clock {
  now(): Date {
    return new Date("2026-08-11T14:00:00.000Z");
  }
}

const ids = new SequentialIds();
const store = new InMemoryRuntimeStore(ids);
const runtime = new BoomerBuddyRuntime({
  clock: new DemoClock(),
  ids,
  provider: new DeterministicModelProvider(),
  store
});
const scope = { tenantId: "demo-home", patronId: "demo-patron", threadId: "demo-thread" };

function summarize(label: string, result: Awaited<ReturnType<BoomerBuddyRuntime["startRun"]>>): void {
  const components = result.events
    .filter((event) => event.type === EventType.CUSTOM && event.name === "boomer_buddy.ui")
    .map((event) => {
      if (event.type !== EventType.CUSTOM || typeof event.value !== "object" || event.value === null || !("component" in event.value)) return "unknown";
      return (event.value.component as { key: string }).key;
    });
  console.log(JSON.stringify({
    journey: label,
    status: result.status,
    runId: result.runId,
    actionId: result.actionId,
    interruptId: result.interruptId,
    eventTypes: result.events.map((event) => event.type),
    components
  }, null, 2));
}

const help = await runtime.startRun({
  ...scope,
  messageId: "demo-help",
  content: "How do I make the text larger on my iPhone?",
  timeZone: "America/New_York"
});
summarize("A: read-only help", help);

const proposed = await runtime.startRun({
  ...scope,
  messageId: "demo-reminder",
  content: "Remind me to call Monte tomorrow at 10.",
  timeZone: "America/New_York"
});
summarize("B1: reminder approval pause", proposed);

if (!proposed.interruptId) throw new Error("Demo reminder did not pause for approval.");
const approved = await runtime.resumeFromAgUi({
  ...scope,
  resume: { interruptId: proposed.interruptId, status: "resolved", payload: { approved: true } }
});
summarize("B2: reminder approved", approved);

console.log(JSON.stringify({
  reminders: store.listReminders(scope),
  receiptCount: store.listReceipts(scope).length
}, null, 2));
