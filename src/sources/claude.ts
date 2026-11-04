import fs from "node:fs";
import { commandResults, orchestrationScript } from "../normalize/toolSemantics.js";
import { createHash } from "node:crypto";
import { calculateMetrics, reported, unavailable } from "../normalize/metrics.js";
import type { EvidenceRef, NormalizedAssistantMessage, NormalizedSession, NormalizedToolCall, NormalizedTurn, RawLogEvent } from "../normalize/types.js";
import { stableId } from "../utils/stableId.js";
import { durationMs } from "../utils/time.js";

type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const metric = (value: unknown) => count(value) === undefined ? unavailable() : reported(count(value)!);
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => str(obj(part).text) ?? "").filter(Boolean).join("\n") : "";

export function isClaudeRecord(value: unknown): boolean {
  const row = obj(value);
  return typeof row.sessionId === "string" && ["user", "assistant", "system", "progress", "summary"].includes(String(row.type));
}

export function isClaudeEventsFile(events: RawLogEvent[]): boolean {
  return events.some(event => isClaudeRecord(event.data));
}

type NativeRow = { data: RecordValue; line: number; sourceFile: string };
const requestKey = (row: RecordValue): string | undefined => {
  const messageId = str(obj(row.message).id);
  const requestId = str(row.requestId);
  return messageId && requestId ? `request:${JSON.stringify([messageId, requestId])}` : str(row.uuid) ? `event:${row.uuid}` : undefined;
};
const eventKey = (row: RecordValue): string | undefined => {
  if (str(row.uuid)) return `event:${row.uuid}`;
  return row.type !== "assistant" && str(obj(row.message).id) ? `message:${JSON.stringify([row.type, obj(row.message).id, str(row.requestId) ?? null])}` : undefined;
};

export function readClaudeTranscript(file: string) {
  const bytes = fs.readFileSync(file);
  const raw = bytes.toString("utf8");
  let parseErrors = 0;
  const rows: NativeRow[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const row = obj(JSON.parse(line));
      if (typeof row.type !== "string") throw new Error("Missing type");
      rows.push({ data: row, line: index + 1, sourceFile: file });
    } catch { parseErrors += 1; }
  });
  return { rows, parseErrors, digest: createHash("sha256").update(bytes).digest("hex") };
}

type Transcript = ReturnType<typeof readClaudeTranscript>;

function transcriptScope(file: string, input: NativeRow[]) {
  const last = input.filter(({ data }) => data.type === "user" || data.type === "assistant").at(-1)?.data;
  const nativeSessionId = str(last?.sessionId) ?? stableId(file);
  const scope = input.filter(({ data }) => data.sessionId === nativeSessionId);
  const child = scope.filter(({ data }) => typeof data.isSidechain === "boolean").at(-1)?.data.isSidechain === true;
  const childAgentId = str(scope.filter(({ data }) => data.isSidechain === child && str(data.agentId)).at(-1)?.data.agentId);
  const sessionId = child && childAgentId ? `${nativeSessionId}:agent:${childAgentId}` : nativeSessionId;
  return { childAgentId, child, sessionId, nativeSessionId: str(last?.sessionId) ?? null, sessionIdMissing: !str(last?.sessionId) };
}

const snapshotKey = (row: RecordValue): string | undefined => {
  const request = row.type === "assistant" ? requestKey(row) : undefined;
  return eventKey(row) ?? (request ? `${request}:${JSON.stringify(row.message)}` : undefined);
};

function orderCopiedRows(rows: NativeRow[], copies: Transcript[]): NativeRow[] {
  const key = (row: NativeRow) => snapshotKey(row.data) ?? `line:${JSON.stringify([row.sourceFile, row.line])}`;
  const time = (row: NativeRow) => {
    const timestamp = Date.parse(str(row.data.timestamp) ?? "");
    return Number.isFinite(timestamp) ? timestamp : Infinity;
  };
  const successors = new Map(rows.map(row => [key(row), new Set<string>()]));
  const incoming = new Map(rows.map(row => [key(row), 0]));
  for (const copy of copies) {
    let previous: string | undefined;
    const seen = new Set<string>();
    for (const row of copy.rows) {
      const id = key(row);
      if (!incoming.has(id) || seen.has(id)) continue;
      seen.add(id);
      const before = previous;
      if (before && before !== id && !successors.get(before)!.has(id)) {
        successors.get(before)!.add(id);
        incoming.set(id, incoming.get(id)! + 1);
      }
      previous = id;
    }
  }
  const ranked = [...rows].sort((a, b) => time(a) - time(b));
  const ranks = new Map(ranked.map((row, index) => [key(row), index]));
  const emitted = new Set<number>();
  const ready: number[] = [];
  const enqueue = (rank: number) => {
    let index = ready.length;
    ready.push(rank);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (ready[parent] <= rank) break;
      ready[index] = ready[parent];
      index = parent;
    }
    ready[index] = rank;
  };
  for (const [id, rank] of ranks) if (incoming.get(id) === 0) enqueue(rank);
  const ordered: NativeRow[] = [];
  let fallback = 0;
  while (ordered.length < ranked.length) {
    let rank = ready[0];
    const last = ready.pop();
    if (ready.length && last !== undefined) {
      let index = 0;
      while (index * 2 + 1 < ready.length) {
        let child = index * 2 + 1;
        if (child + 1 < ready.length && ready[child + 1] < ready[child]) child += 1;
        if (last <= ready[child]) break;
        ready[index] = ready[child];
        index = child;
      }
      ready[index] = last;
    }
    if (rank === undefined) {
      while (emitted.has(fallback)) fallback += 1;
      rank = fallback;
    }
    emitted.add(rank);
    const row = ranked[rank];
    ordered.push(row);
    for (const next of successors.get(key(row))!) {
      const degree = incoming.get(next)! - 1;
      incoming.set(next, degree);
      const nextRank = ranks.get(next)!;
      if (degree === 0 && !emitted.has(nextRank)) enqueue(nextRank);
    }
  }
  return ordered;
}

export function createClaudeCorpus(inputs: Map<string, Transcript>) {
  const seenRequests = new Set<string>();
  const seenEvents = new Set<string>();
  const seenTools = new Set<string>();
  const transcripts = [...inputs].map(([file, input]) => ({ file, input, scope: transcriptScope(file, input.rows) }));
  transcripts.sort((a, b) => a.scope.sessionId < b.scope.sessionId ? -1 : a.scope.sessionId > b.scope.sessionId ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const corpus = new Map<string, { input: Transcript; history: ReturnType<typeof normalizeHistory>; sourceFiles: string[]; sessionParseErrors: number }>();
  const groups = new Map<string, typeof transcripts>();
  for (const transcript of transcripts) {
    const group = groups.get(transcript.scope.sessionId) ?? [];
    group.push(transcript);
    groups.set(transcript.scope.sessionId, group);
  }
  for (const group of groups.values()) {
    const digests = new Set<string>();
    const copies = group.filter(({ input }) => {
      if (digests.has(input.digest)) return false;
      digests.add(input.digest);
      return true;
    });
    const history = normalizeHistory(copies.flatMap(item => item.input.rows), group[0].scope, seenRequests, seenEvents, seenTools);
    if (copies.length > 1) {
      history.unknowns.add("conflicting_session_copies");
      history.rows = orderCopiedRows(history.rows, copies.map(copy => copy.input));
    }
    const sourceFiles = group.map(item => item.file);
    const sessionParseErrors = copies.reduce((sum, item) => sum + item.input.parseErrors, 0);
    for (const { file, input } of group) corpus.set(file, { input, history, sourceFiles, sessionParseErrors });
  }
  return corpus;
}

function normalizeHistory(input: NativeRow[], scope: ReturnType<typeof transcriptScope>, seenRequests: Set<string>, seenEvents: Set<string>, seenTools: Set<string>) {
  const unknowns = new Set<string>();
  if (scope.sessionIdMissing) unknowns.add("session_id_missing");
  const inherited = new Set<string>();
  const ownRequests = new Set<string>();
  const ownTools = new Set<string>();
  const skippedTools = new Set<string>();
  const snapshots = new Set<string>();
  const retained = input.filter(({ data }) => {
    const event = eventKey(data);
    const request = data.type === "assistant" ? requestKey(data) : undefined;
    const snapshot = snapshotKey(data);
    if (snapshot && snapshots.has(snapshot)) return false;
    if (snapshot) snapshots.add(snapshot);
    if (event && seenEvents.has(event)) { inherited.add(event); return false; }
    if (data.type === "assistant") {
      const blocks = Array.isArray(obj(data.message).content) ? obj(data.message).content as unknown[] : [];
      const tools = blocks.map(obj).filter(block => block.type === "tool_use" && str(block.id)).map(block => str(block.id)!);
      if (request && seenRequests.has(request) && !ownRequests.has(request)) {
        inherited.add(event ?? request);
        tools.forEach(id => skippedTools.add(id));
        return false;
      }
      if (request) { ownRequests.add(request); seenRequests.add(request); }
      else unknowns.add("history_event_identity_missing");
      if (!str(obj(data.message).id) || !str(data.requestId)) unknowns.add("request_identity_missing");
      tools.forEach(id => ownTools.add(id));
    }
    if (event) seenEvents.add(event);
    else if (data.type !== "assistant") unknowns.add("history_event_identity_missing");
    return true;
  });
  const rows: NativeRow[] = retained.flatMap(({ data, line, sourceFile }) => {
    if (data.type !== "user" || !Array.isArray(obj(data.message).content)) return [{ data, line, sourceFile }];
    const message = obj(data.message);
    const content = (message.content as unknown[]).filter(value => {
      const block = obj(value);
      const id = str(block.tool_use_id);
      if (block.type !== "tool_result" || !id || !skippedTools.has(id) && (!seenTools.has(id) || ownTools.has(id))) return true;
      inherited.add(eventKey(data) ?? `tool_result:${id}`);
      return false;
    });
    if (content.length === (message.content as unknown[]).length) return [{ data, line, sourceFile }];
    return content.length ? [{ data: { ...data, message: { ...message, content } }, line, sourceFile }] : [];
  });
  ownTools.forEach(id => seenTools.add(id));
  if (inherited.size) unknowns.add("history_inherited_events");
  if (scope.child && !inherited.size) unknowns.add("history_lineage_unknown");
  if (inherited.size || unknowns.has("history_lineage_unknown") || unknowns.has("history_event_identity_missing") || unknowns.has("request_identity_missing")) unknowns.add("usage_missing_or_partial");
  return { ...scope, rows, unknowns, inheritedEvents: inherited.size,
    unresolvedInheritedEvents: unknowns.has("history_lineage_unknown") ? null : 0 };
}

/** Reads native top-level Claude records without changing the Codex/Copilot reader. */
export function parseClaudeSessionFile(file: string, corpus = createClaudeCorpus(new Map([[file, readClaudeTranscript(file)]]))) {
  const { input, history, sourceFiles, sessionParseErrors } = corpus.get(file)!;
  const parseErrors = input.parseErrors;
  const { rows, sessionId, childAgentId, child, inheritedEvents, unresolvedInheritedEvents } = history;
  const unknowns = new Set(history.unknowns);
  const turns: NormalizedTurn[] = [];
  const tools = new Map<string, NormalizedToolCall>();
  const messages = new Map<string, { message: NormalizedAssistantMessage; blocks: Set<string>; usage: RecordValue }>();
  const branches = new Set<string>();
  const worktreePaths = new Set<string>();
  const sidechains = new Set<boolean>();
  let agentId: string | undefined;
  let executionRoot: string | undefined;
  let firstInstruction: NormalizedSession["userIntent"];
  let finalAnswer: NormalizedSession["finalAnswer"];
  let current: NormalizedTurn | undefined;
  const times: string[] = [];
  const turn = (): NormalizedTurn => {
    if (!current) { current = { turnId: `${sessionId}:turn:${turns.length + 1}`, assistantMessages: [], toolCalls: [], hooks: [] }; turns.push(current); }
    return current;
  };
  for (const { data: row, line, sourceFile } of rows) {
    const ref = (row: RecordValue, line: number, fieldPath: string): EvidenceRef => ({
      sourceFile, lineNumber: line, eventId: str(row.uuid), eventType: String(row.type), fieldPath, summary: "native Claude transcript field"
    });
    const stamp = str(row.timestamp);
    const time = stamp && Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString() : undefined;
    if (time) times.push(time); else unknowns.add("timestamp_missing_or_invalid");
    executionRoot ??= str(row.cwd);
    if (str(row.cwd)) worktreePaths.add(str(row.cwd)!);
    if (str(row.gitBranch)) branches.add(str(row.gitBranch)!);
    if (typeof row.isSidechain === "boolean") sidechains.add(row.isSidechain);
    agentId ??= str(row.agentId);
    const native = obj(row.message);
    const content = native.content;
    const blocks = Array.isArray(content) ? content.map(obj) : typeof content === "string" ? [{ type: "text", text: content }] : [];
    const userText = row.type === "user" ? text(content) : "";
    if (userText && !row.isMeta) {
      current = undefined;
      const evidence = { text: userText, evidence: [ref(row, line, "message.content")] };
      firstInstruction ??= evidence;
      turn().userMessages = [evidence];
    }
    if (row.type !== "assistant" && row.type !== "user") continue;
    const active = turn();
    if (time) {
      active.startedAt ??= time; active.endedAt = time;
      const cwd = str(row.cwd);
      if (cwd && !active.hooks.some(hook => hook.cwd === cwd)) active.hooks.push({
        hookInvocationId: `${active.turnId}:cwd:${active.hooks.length + 1}`, hookType: "context", startedAt: time,
        cwd, toolCallIds: [], evidence: [ref(row, line, "cwd")]
      });
    }
    if (row.type === "assistant") {
      const requestId = str(row.requestId);
      const messageId = str(native.id);
      const key = requestKey(row) ?? `line:${JSON.stringify([sourceFile, line])}`;
      let group = messages.get(key);
      if (!group) {
        const message: NormalizedAssistantMessage = { messageId, requestId, kind: "text", model: str(native.model), contentLength: 0, hasContent: false,
          hasEncryptedContent: false, hasOpaqueReasoning: false, outputTokens: unavailable(), toolRequestIds: [], evidence: [] };
        group = { message, blocks: new Set(), usage: {} };
        messages.set(key, group); active.assistantMessages.push(message);
      }
      const message = group.message;
      message.model ??= str(native.model);
      message.evidence!.push(ref(row, line, "message"));
      for (const [name, value] of Object.entries(obj(native.usage))) {
        if (count(value) !== undefined) group.usage[name] = Math.max(count(group.usage[name]) ?? 0, count(value)!);
      }
      message.inputTokens = metric(group.usage.input_tokens);
      message.outputTokens = metric(group.usage.output_tokens);
      message.cachedTokens = metric(group.usage.cache_read_input_tokens);
      message.cacheCreationTokens = metric(group.usage.cache_creation_input_tokens);
      for (const block of blocks) {
        const fingerprint = JSON.stringify(block);
        if (group.blocks.has(fingerprint)) continue;
        group.blocks.add(fingerprint);
        if (block.type === "text" || block.type === "thinking") {
          const value = str(block.text) ?? str(block.thinking) ?? "";
          message.contentLength += value.length;
          message.hasContent ||= Boolean(value);
          if (block.type === "thinking") message.hasOpaqueReasoning = true;
          else { message.text = [message.text, value].filter(Boolean).join("\n"); finalAnswer = { text: message.text, evidence: message.evidence }; }
        } else if (block.type === "tool_use" && str(block.id)) {
          const id = str(block.id)!;
          if (!message.toolRequestIds.includes(id)) message.toolRequestIds.push(id);
          if (!tools.has(id)) {
            const name = str(block.name) ?? "unknown";
            const args = obj(block.input);
            const aliases: Record<string, string> = { Read: "view", MultiEdit: "edit", NotebookEdit: "edit" };
            const tool: NormalizedToolCall = { toolCallId: id, name: aliases[name] ?? name, arguments: typeof block.input === "string" ? block.input : { ...args, ...(str(args.file_path) ? { path: args.file_path } : {}) },
              executionRoot, executionCwd: str(row.cwd), requestedAt: time, status: "requested", evidence: [ref(row, line, "message.content.tool_use")] };
            tools.set(id, tool); active.toolCalls.push(tool);
          }
        } else if (block.type !== "tool_use") unknowns.add(`unsupported_content:${String(block.type)}`);
      }
    }
    if (row.type === "user") for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      if (!id) { unknowns.add("tool_result_identity_missing"); continue; }
      let tool = tools.get(id);
      if (!tool) {
        tool = { toolCallId: id, name: "unknown", status: "unknown" };
        tools.set(id, tool); active.toolCalls.push(tool); unknowns.add("orphan_tool_result");
      }
      tool.outputText = text(block.content);
      if (orchestrationScript(tool)) tool.commandResults = commandResults(block.content, tool);
      tool.executionEndedAt = time;
      tool.evidence = [...(tool.evidence ?? []), ref(row, line, "message.content.tool_result")];
      const result = obj(row.toolUseResult);
      const explicitExit = result.exitCode ?? result.exit_code ?? block.exitCode;
      const exitCode = typeof explicitExit === "number" && Number.isInteger(explicitExit) ? explicitExit : undefined;
      tool.exitCode = exitCode;
      const bash = tool.name.toLowerCase() === "bash";
      if (block.is_error === true || (exitCode !== undefined && exitCode !== 0)) tool.status = "failed";
      else if (bash && (result.isBackground === true || (exitCode === undefined && typeof block.is_error !== "boolean"))) {
        tool.status = "unknown"; unknowns.add("command_exit_unknown");
      } else tool.status = "completed";
    }
  }
  for (const { message } of messages.values()) if (message.outputTokens.value === null || message.inputTokens?.value === null) unknowns.add("usage_missing_or_partial");
  if (sidechains.size > 1) unknowns.add("mixed_sidechain_markers");
  if (child && !childAgentId) unknowns.add("sidechain_agent_identity_missing");
  if (!branches.size) unknowns.add("branch_missing");
  if (!worktreePaths.size) unknowns.add("worktree_path_missing");
  for (const { message } of messages.values()) if (!message.model) unknowns.add("model_missing");
  times.sort();
  const base: Omit<NormalizedSession, "metrics"> = {
    sessionId, nativeSessionId: history.nativeSessionId, ...(child && childAgentId ? { agentPath: childAgentId } : {}), source: "claude", sourceFiles, repoMatch: "unknown", repoRoot: worktreePaths.size === 1 ? [...worktreePaths][0] : undefined,
    startedAt: times[0], endedAt: times.at(-1), durationMs: durationMs(times[0], times.at(-1)), lifecycleStatus: "unknown", interactions: [], turns,
    userIntent: firstInstruction, finalAnswer,
    attribution: { branches: [...branches].sort(), worktreePaths: [...worktreePaths].sort(), firstInstruction,
      isSidechain: sidechains.size === 1 ? [...sidechains][0] : undefined, agentId,
      inheritedEvents, unresolvedInheritedEvents,
      notes: [...(unknowns.has("conflicting_session_copies") ? ["Conflicting copies of this native session were combined before request deduplication; attribution remains unverified."] : []),
        "Assistant requests are counted once per scan by message ID plus request ID, falling back to event UUID. Transcripts are processed by native transcript ID, then source path; this does not reconstruct lineage. Reused identities and richer later copies can undercount usage or tool outcomes.",
        ...(unresolvedInheritedEvents === null ? ["Inherited history is unresolved without another transcript containing the same requests; observed totals may include replayed history."] : [])],
      historyCoverage: inheritedEvents > 0 || unknowns.has("history_lineage_unknown") || unknowns.has("history_event_identity_missing") || sessionParseErrors > 0 ? "partial" : "complete",
      usageCoverage: unknowns.has("usage_missing_or_partial") || sessionParseErrors > 0 ? "partial" : "complete", unknowns: [...unknowns].sort() }
  };
  const metrics = calculateMetrics(base, sessionParseErrors);
  // The common model's input count is non-cache input; cache writes remain separate.
  metrics.modelRequests = messages.size;
  return { session: { ...base, metrics } as NormalizedSession, eventsParsed: input.rows.length, parseErrors, traceDigest: input.digest };
}
