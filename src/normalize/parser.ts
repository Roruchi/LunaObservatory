import type { SourceName } from "../sources/types.js";
import { readJsonl } from "../fs/jsonl.js";
import { normalizeEventsToSession } from "./sessions.js";
import type { NormalizedSession } from "./types.js";

export type ParsedSessionFile = {
  session: NormalizedSession;
  eventsParsed: number;
  parseErrors: number;
};

export function parseSessionFile(file: string, source: SourceName): ParsedSessionFile {
  const result = readJsonl(file);
  return {
    session: normalizeEventsToSession(result.events, source, file, result.parseErrors),
    eventsParsed: result.events.length,
    parseErrors: result.parseErrors
  };
}
