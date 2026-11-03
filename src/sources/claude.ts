import fs from "node:fs";
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

/** Reads native top-level Claude records without changing the Codex/Copilot reader. */
export function parseClaudeSessionFile(file: string) {
  let parseErrors = 0;
  const rows: { data: RecordValue; line: number }[] = [];
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      const row = obj(value);
      if (typeof row.type !== "string") throw new Error("Missing type");
      rows.push({ data: row, line: index + 1 });
    } catch { parseErrors += 1; }
  });
  const sessionIds = new Set(rows.map(({ data }) => str(data.sessionId)).filter(Boolean));
  if (sessionIds.size > 1) throw new Error("Claude transcript contains multiple native session IDs");
  const nativeSessionId = [...sessionIds][0] ?? stableId(file);
  const nativeAgentIds = new Set(rows.map(({ data }) => str(data.agentId)).filter(Boolean));
  if (nativeAgentIds.size > 1) throw new Error("Claude transcript contains multiple native agent IDs");
  const childAgentId = [...nativeAgentIds][0];
  const child = rows.some(({ data }) => data.isSidechain === true);
  const sessionId = child && childAgentId ? `${nativeSessionId}:agent:${childAgentId}` : nativeSessionId;
  const unknowns = new Set<string>();
  if (!sessionIds.size) unknowns.add("session_id_missing");
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
      const outputExit = /(?:^|\n)(?:Exit code:|Process exited with code)\s*(-?\d+)\b/i.exec(tool.outputText);
      const exitCode = typeof explicitExit === "number" && Number.isInteger(explicitExit) ? explicitExit : outputExit ? Number(outputExit[1]) : undefined;
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
    sessionId, ...(child && childAgentId ? { parentSessionId: nativeSessionId, agentPath: childAgentId } : {}), source: "claude", sourceFiles: [file], repoMatch: "unknown", repoRoot: worktreePaths.size === 1 ? [...worktreePaths][0] : undefined,
    startedAt: times[0], endedAt: times.at(-1), durationMs: durationMs(times[0], times.at(-1)), lifecycleStatus: "unknown", interactions: [], turns,
    userIntent: firstInstruction, finalAnswer,
    attribution: { branches: [...branches].sort(), worktreePaths: [...worktreePaths].sort(), firstInstruction,
      isSidechain: sidechains.size === 1 ? [...sidechains][0] : undefined, agentId, unknowns: [...unknowns].sort() }
  };
  const metrics = calculateMetrics(base, parseErrors);
  // The common model's input count is non-cache input; cache writes remain separate.
  metrics.modelRequests = messages.size;
  return { session: { ...base, metrics } as NormalizedSession, eventsParsed: rows.length, parseErrors };
}
