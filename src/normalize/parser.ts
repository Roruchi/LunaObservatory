import type { SourceName } from "../sources/types.js";
import { readJsonl } from "../fs/jsonl.js";
import { normalizeEventsToSession } from "./sessions.js";
import type { NormalizedSession } from "./types.js";
import { createClaudeCorpus, isClaudeRecord, parseClaudeSessionFile, readClaudeTranscript } from "../sources/claude.js";

export type ParsedSessionFile = {
  session: NormalizedSession;
  eventsParsed: number;
  parseErrors: number;
  traceDigest?: string;
};

export function createSessionParser(files: { file: string; source: SourceName }[]) {
  const transcripts = new Map<string, ReturnType<typeof readClaudeTranscript>>();
  for (const { file, source } of files) {
    if (transcripts.has(file) || source !== "claude" && source !== "unknown") continue;
    const transcript = readClaudeTranscript(file);
    if (source === "claude" || transcript.rows.some(({ data }) => isClaudeRecord(data))) transcripts.set(file, transcript);
  }
  const corpus = createClaudeCorpus(transcripts);
  return (file: string, source: SourceName): ParsedSessionFile => {
    if (corpus.has(file)) return parseClaudeSessionFile(file, corpus);
    const result = readJsonl(file);
    const inferredSource = source !== "unknown" ? source
      : result.events.some(event => event.type === "session_meta") ? "codex"
      : result.events.some(event => /^(?:assistant\.|user\.message$|hook\.|tool\.execution_|session\.)/.test(event.type)) ? "copilot" : "unknown";
    return {
      session: normalizeEventsToSession(result.events, inferredSource, file, result.parseErrors),
      eventsParsed: result.events.length,
      parseErrors: result.parseErrors
    };
  };
}

export function parseSessionFile(file: string, source: SourceName): ParsedSessionFile {
  return createSessionParser([{ file, source }])(file, source);
}
