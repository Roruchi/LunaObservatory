import type { SourceName } from "../sources/types.js";
import { readJsonl } from "../fs/jsonl.js";
import { normalizeEventsToSession } from "./sessions.js";
import type { NormalizedSession } from "./types.js";
import fs from "node:fs";
import { isClaudeRecord, parseClaudeSessionFile } from "../sources/claude.js";

export type ParsedSessionFile = {
  session: NormalizedSession;
  eventsParsed: number;
  parseErrors: number;
};

export function parseSessionFile(file: string, source: SourceName): ParsedSessionFile {
  if (source === "claude" || (source === "unknown" && fs.readFileSync(file, "utf8").split(/\r?\n/).some(line => {
    try { return isClaudeRecord(JSON.parse(line)); } catch { return false; }
  }))) return parseClaudeSessionFile(file);
  const result = readJsonl(file);
  return {
    session: normalizeEventsToSession(result.events, source, file, result.parseErrors),
    eventsParsed: result.events.length,
    parseErrors: result.parseErrors
  };
}
