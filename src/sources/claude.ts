import fs from "node:fs";
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

type NativeRow = { data: RecordValue; line: number };
const eventKey = (row: RecordValue): string | undefined => {
  if (str(row.uuid)) return `event:${row.uuid}`;
  const message = obj(row.message);
  return str(message.id) ? `message:${row.type}:${message.id}:${str(row.requestId) ?? ""}` : undefined;
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
      rows.push({ data: row, line: index + 1 });
    } catch { parseErrors += 1; }
  });
  return { rows, parseErrors, digest: createHash("sha256").update(bytes).digest("hex") };
}

type Transcript = ReturnType<typeof readClaudeTranscript>;
const eventTime = (row: RecordValue) => Number.isFinite(Date.parse(str(row.timestamp) ?? "")) ? Date.parse(String(row.timestamp)) : Infinity;

function transcriptScope(file: string, input: NativeRow[]) {
  const last = input.filter(({ data }) => data.type === "user" || data.type === "assistant").at(-1)?.data;
  const nativeSessionId = str(last?.sessionId) ?? stableId(file);
  const scope = input.filter(({ data }) => data.sessionId === nativeSessionId);
  const child = scope.filter(({ data }) => typeof data.isSidechain === "boolean").at(-1)?.data.isSidechain === true;
  const childAgentId = str(scope.filter(({ data }) => data.isSidechain === child && str(data.agentId)).at(-1)?.data.agentId);
  const sessionId = child && childAgentId ? `${nativeSessionId}:agent:${childAgentId}` : nativeSessionId;
  const inScope = (row: RecordValue) => (!str(row.sessionId) || row.sessionId === nativeSessionId) &&
    (typeof row.isSidechain !== "boolean" || row.isSidechain === child) &&
    (!str(row.agentId) || row.agentId === childAgentId);
  return { nativeSessionId, childAgentId, child, sessionId, inScope, sessionIdMissing: !str(last?.sessionId) };
}

export function createClaudeCorpus(inputs: Map<string, Transcript>) {
  const scopes = new Map([...inputs].map(([file, input]) => [file, transcriptScope(file, input.rows)]));
  const firstTimes = new Map([...inputs].map(([file, input]) => [file, input.rows.reduce((first, { data }) => Math.min(first, eventTime(data)), Infinity)]));
  const tails = new Map<string, string[]>();
  const sessions = new Map<string, string[]>();
  const terminalKeys = new Map<string, string>();
  for (const [file, input] of inputs) {
    const scope = scopes.get(file)!;
    sessions.set(scope.sessionId, [...(sessions.get(scope.sessionId) ?? []), file]);
    const tail = input.rows.filter(({ data }) => scope.inScope(data) && eventKey(data)).at(-1)?.data;
    const key = tail && eventKey(tail);
    if (key) { tails.set(key, [...(tails.get(key) ?? []), file]); terminalKeys.set(file, key); }
  }
  const ancestors = new Map<string, Set<string>>();
  for (const [file, input] of inputs) {
    const parents = new Set<string>();
    for (const { data } of input.rows) {
      for (const parent of tails.get(`event:${data.parentUuid}`) ?? []) {
        if (parent !== file && terminalKeys.get(parent) !== terminalKeys.get(file)) parents.add(parent);
      }
      const parentId = str(data.parentSessionId);
      const parentAgent = str(data.parentAgentId);
      const key = parentAgent ? `${parentId ?? scopes.get(file)!.nativeSessionId}:agent:${parentAgent}` : parentId;
      if (key) for (const parent of sessions.get(key) ?? []) if (parent !== file) parents.add(parent);
    }
    ancestors.set(file, parents);
  }
  const isAncestor = (parent: string, file: string, seen = new Set<string>()): boolean => {
    if (seen.has(file)) return false;
    seen.add(file);
    return [...(ancestors.get(file) ?? [])].some(candidate => candidate === parent || isAncestor(parent, candidate, seen));
  };
  const occurrences = new Map<string, Map<string, number>>();
  for (const [file, input] of inputs) for (const { data } of input.rows) {
    const key = eventKey(data);
    if (!key || !scopes.get(file)!.inScope(data)) continue;
    let files = occurrences.get(key);
    if (!files) { files = new Map(); occurrences.set(key, files); }
    files.set(file, Math.min(files.get(file) ?? Infinity, eventTime(data)));
  }
  const compare = (a: string, b: string, files: Map<string, number>): number => {
    const timeA = files.get(a)!; const timeB = files.get(b)!;
    if (timeA !== timeB) return timeA < timeB ? -1 : 1;
    const aParent = isAncestor(a, b); const bParent = isAncestor(b, a);
    if (aParent !== bParent) return aParent ? -1 : 1;
    const firstA = firstTimes.get(a)!; const firstB = firstTimes.get(b)!;
    if (firstA !== firstB) return firstA < firstB ? -1 : 1;
    return scopes.get(a)!.sessionId === scopes.get(b)!.sessionId ? (a < b ? -1 : a > b ? 1 : 0) : 0;
  };
  const owners = new Map<string, string | undefined>();
  for (const [key, files] of occurrences) {
    const ordered = [...files.keys()].sort((a, b) => compare(a, b, files));
    owners.set(key, ordered.length > 1 && compare(ordered[0], ordered[1], files) === 0 ? undefined : ordered[0]);
  }
  const corpus = new Map<string, { input: Transcript; history: ReturnType<typeof normalizeHistory> }>();
  for (const [file, input] of inputs) {
    corpus.set(file, { input, history: normalizeHistory(file, input.rows, scopes, owners) });
  }
  return corpus;
}

function normalizeHistory(file: string, input: NativeRow[], scopes: Map<string, ReturnType<typeof transcriptScope>>, owners: Map<string, string | undefined>) {
  const scope = scopes.get(file)!;
  const unknowns = new Set<string>();
  if (scope.sessionIdMissing) unknowns.add("session_id_missing");
  const parentSessionIds = new Set<string>();
  const linkedParents = new Set<string>();
  const inherited = new Set<string>();
  const unresolved = new Set<string>();
  const seen = new Set<string>();
  const rows = input.filter(({ data, line }) => {
    const key = eventKey(data);
    const identity = str(data.uuid) ? key : key && `${key}:${JSON.stringify(data.message)}:${JSON.stringify(data.toolUseResult)}`;
    if (identity && seen.has(identity)) return false;
    if (identity) seen.add(identity);
    const owner = key && owners.get(key);
    if (!scope.inScope(data) || key && (!owner || owner !== file)) {
      if (owner && owner !== file) { inherited.add(key!); parentSessionIds.add(scopes.get(owner)!.sessionId); }
      else { unresolved.add(key ?? `line:${line}`); unknowns.add("history_lineage_unknown"); }
      return false;
    }
    const parentId = str(data.parentSessionId);
    const parentAgent = str(data.parentAgentId);
    const nativeParent = parentAgent ? `${parentId ?? scope.nativeSessionId}:agent:${parentAgent}` : parentId;
    if (nativeParent) {
      if ([...scopes.values()].some(candidate => candidate.sessionId === nativeParent)) linkedParents.add(nativeParent);
      else unknowns.add("history_lineage_unknown");
    }
    if (!key) unknowns.add("history_event_identity_missing");
    const parentKey = str(data.parentUuid) && `event:${data.parentUuid}`;
    if (parentKey) {
      const parent = owners.get(parentKey);
      if (!parent) unknowns.add("history_lineage_unknown");
      else if (parent !== file) linkedParents.add(scopes.get(parent)!.sessionId);
    }
    return true;
  });
  if (scope.child && !parentSessionIds.size && !linkedParents.size) unknowns.add("history_lineage_unknown");
  if (unknowns.has("history_lineage_unknown") || unknowns.has("history_event_identity_missing")) unknowns.add("usage_missing_or_partial");
  const parentIds = linkedParents.size ? linkedParents : parentSessionIds;
  const candidateParent = parentIds.size === 1 ? [...parentIds][0] : scope.child ? scope.nativeSessionId : undefined;
  const parentSessionId = candidateParent === scope.sessionId ? undefined : candidateParent;
  return { ...scope, rows, parentSessionId, unknowns, inheritedEvents: inherited.size,
    unresolvedInheritedEvents: unknowns.has("history_lineage_unknown") ? unresolved.size || null : 0 };
}

/** Reads native top-level Claude records without changing the Codex/Copilot reader. */
export function parseClaudeSessionFile(file: string, corpus = createClaudeCorpus(new Map([[file, readClaudeTranscript(file)]]))) {
  const { input, history } = corpus.get(file)!;
  const parseErrors = input.parseErrors;
  const { rows, nativeSessionId, childAgentId, child, parentSessionId, inheritedEvents, unresolvedInheritedEvents } = history;
  const unknowns = new Set(history.unknowns);
  const sessionId = child && childAgentId ? `${nativeSessionId}:agent:${childAgentId}` : nativeSessionId;
  const turns: NormalizedTurn[] = [];
  const tools = new Map<string, NormalizedToolCall>();
  const messages = new Map<string, { message: NormalizedAssistantMessage; blocks: Set<string>; usage: RecordValue }>();
  // Either native key can tie split records together (some records have only one).
  const aliases = new Map<string, string>();
  // Union both request and message identities before processing split streaming rows.
  const roots = new Map<string, string>();
  const rootKey = (key: string): string => {
    const parent = roots.get(key);
    if (!parent || parent === key) return key;
    const root = rootKey(parent); roots.set(key, root); return root;
  };
  for (const { data } of rows) {
    if (data.type !== "assistant") continue;
    const request = str(data.requestId); const message = str(obj(data.message).id);
    if (request && message) roots.set(rootKey(`message:${message}`), rootKey(`request:${request}`));
  }
  for (const { data } of rows) {
    const request = str(data.requestId); const message = str(obj(data.message).id);
    for (const key of [request && `request:${request}`, message && `message:${message}`]) if (key) aliases.set(key, rootKey(key));
  }
  const branches = new Set<string>();
  const worktreePaths = new Set<string>();
  const sidechains = new Set<boolean>();
  let agentId: string | undefined;
  let firstInstruction: NormalizedSession["userIntent"];
  let finalAnswer: NormalizedSession["finalAnswer"];
  let current: NormalizedTurn | undefined;
  const times: string[] = [];
  const ref = (row: RecordValue, line: number, fieldPath: string): EvidenceRef => ({
    sourceFile: file, lineNumber: line, eventId: str(row.uuid), eventType: String(row.type), fieldPath, summary: "native Claude transcript field"
  });
  const turn = (): NormalizedTurn => {
    if (!current) { current = { turnId: `${sessionId}:turn:${turns.length + 1}`, assistantMessages: [], toolCalls: [], hooks: [] }; turns.push(current); }
    return current;
  };
  for (const { data: row, line } of rows) {
    const stamp = str(row.timestamp);
    const time = stamp && Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString() : undefined;
    if (time) times.push(time); else unknowns.add("timestamp_missing_or_invalid");
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
      const keys = [requestId && `request:${requestId}`, messageId && `message:${messageId}`].filter((key): key is string => Boolean(key));
      const key = keys.map(alias => aliases.get(alias)).find(Boolean) ?? keys[0] ?? `line:${line}`;
      keys.forEach(alias => aliases.set(alias, key));
      if (!keys.length) unknowns.add("request_identity_missing");
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
            const tool: NormalizedToolCall = { toolCallId: id, name: aliases[name] ?? name, arguments: { ...args, ...(str(args.file_path) ? { path: args.file_path } : {}) },
              requestedAt: time, status: "requested", evidence: [ref(row, line, "message.content.tool_use")] };
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
    sessionId, ...(parentSessionId ? { parentSessionId } : {}), ...(child && childAgentId ? { agentPath: childAgentId } : {}), source: "claude", sourceFiles: [file], repoMatch: "unknown", repoRoot: worktreePaths.size === 1 ? [...worktreePaths][0] : undefined,
    startedAt: times[0], endedAt: times.at(-1), durationMs: durationMs(times[0], times.at(-1)), lifecycleStatus: "unknown", interactions: [], turns,
    userIntent: firstInstruction, finalAnswer,
    attribution: { branches: [...branches].sort(), worktreePaths: [...worktreePaths].sort(), firstInstruction,
      isSidechain: sidechains.size === 1 ? [...sidechains][0] : undefined, agentId,
      inheritedEvents, unresolvedInheritedEvents,
      historyCoverage: unknowns.has("history_lineage_unknown") || unknowns.has("history_event_identity_missing") || parseErrors > 0 ? "partial" : "complete",
      usageCoverage: unknowns.has("usage_missing_or_partial") || parseErrors > 0 ? "partial" : "complete", unknowns: [...unknowns].sort() }
  };
  const metrics = calculateMetrics(base, parseErrors);
  // The common model's input count is non-cache input; cache writes remain separate.
  metrics.modelRequests = messages.size;
  if (unknowns.has("history_lineage_unknown")) {
    metrics.inputTokens = unavailable(); metrics.outputTokens = unavailable(); metrics.cachedTokens = unavailable();
    metrics.outputTokensPerTask = unavailable();
  }
  return { session: { ...base, metrics } as NormalizedSession, eventsParsed: input.rows.length, parseErrors, traceDigest: input.digest };
}
