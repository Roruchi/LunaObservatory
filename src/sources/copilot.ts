import type { RawLogEvent } from "../normalize/types.js";

export function isCopilotEventsFile(events: RawLogEvent[]): boolean {
  return events.some((event) => event.type.startsWith("assistant.") || event.type.startsWith("hook."));
}
