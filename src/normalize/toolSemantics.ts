import path from "node:path";
import type { CommandResult, NormalizedToolCall, VerificationClosure } from "./types.js";

const viewToolNames = new Set(["view", "read_file", "read_text_file", "get_file", "view_image"]);
const globToolNames = new Set(["glob", "list_files", "list_directory", "list_dir", "file_search", "rg_files"]);
const searchToolNames = new Set(["search", "grep", "grep_search", "ripgrep", "rg", "find", "find_text", "search_files"]);
const editToolNames = new Set([
  "apply_patch",
  "edit",
  "edit_file",
  "write",
  "write_file",
  "create_file",
  "replace",
  "replace_in_file",
  "replace_string_in_file",
  "insert_edit_into_file",
  "str_replace"
]);
const commandToolNames = new Set([
  "command",
  "shell_command",
  "exec",
  "exec_command",
  "run_command",
  "run_in_terminal",
  "terminal",
  "powershell",
  "bash"
]);

function baseToolName(name: string): string {
  return name.toLowerCase().split(/__|[.:/]/).filter(Boolean).at(-1) ?? name.toLowerCase();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function parseQuotedString(value: string): string | undefined {
  try {
    return JSON.parse(value) as string;
  } catch {
    return undefined;
  }
}

/** Decode static JS string literals without evaluating trace code. */
function literalValue(literal: string): string | undefined {
  if (literal.startsWith('"')) return parseQuotedString(literal);
  if (literal.startsWith("`") && literal.includes("${")) return undefined;
  let value = "";
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  for (let index = 1; index < literal.length - 1; index++) {
    const char = literal[index];
    if (char !== "\\") { value += char; continue; }
    const escaped = literal[++index];
    if (escaped === "x" || escaped === "u") {
      const length = escaped === "x" ? 2 : 4;
      const hex = literal.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(hex)) return undefined;
      value += String.fromCharCode(parseInt(hex, 16)); index += length;
    } else if (escaped === "\n") continue;
    else value += escapes[escaped] ?? escaped;
  }
  return value;
}

function literalEnd(value: string, start: number): number {
  const quote = value[start];
  let end = start + 1;
  for (; end < value.length; end++) {
    if (value[end] === "\\") end++;
    else if (value[end] === quote) return end + 1;
  }
  return value.length;
}

function embeddedProperty(value: string, property: string): string | undefined {
  const key = new RegExp(`^(?:${property}|"${property}"|'${property}')\\s*:\\s*`, "i");
  let depth = 0;
  for (let index = 0; index < value.length;) {
    const preceding = value.slice(0, index).trimEnd().at(-1);
    if (depth <= 1 && (preceding === "{" || preceding === "," || index === 0)) {
      const match = key.exec(value.slice(index));
      if (match) {
        const start = index + match[0].length;
        if (property === "session_id") {
          const number = /^\d+(?=\s*[,}])/.exec(value.slice(start));
          if (number) return number[0];
        }
        if (!'"\'`'.includes(value[start] ?? " ")) return undefined;
        const end = literalEnd(value, start);
        // A literal followed by concatenation or interpolation is not static.
        if (!/^[,}]/.test(value.slice(end).trimStart())) return undefined;
        return literalValue(value.slice(start, end));
      }
    }
    if ('"\'`'.includes(value[index])) { index = literalEnd(value, index); continue; }
    if (value.startsWith("//", index)) { const end = value.indexOf("\n", index); index = end < 0 ? value.length : end + 1; continue; }
    if (value.startsWith("/*", index)) { const end = value.indexOf("*/", index + 2); index = end < 0 ? value.length : end + 2; continue; }
    if (value[index] === "{") depth++;
    if (value[index] === "}") depth--;
    index++;
  }
  return undefined;
}

/** Locate bounded call arguments; strings/comments never introduce tool calls. */
type ScriptCall = { name: string; source: string; start: number; end: number };

function scriptCalls(script: string): ScriptCall[] {
  const calls: ScriptCall[] = [];
  for (let index = 0; index < script.length;) {
    if ('"\'`'.includes(script[index])) { index = literalEnd(script, index); continue; }
    if (script.startsWith("//", index)) { const end = script.indexOf("\n", index); index = end < 0 ? script.length : end + 1; continue; }
    if (script.startsWith("/*", index)) { const end = script.indexOf("*/", index + 2); index = end < 0 ? script.length : end + 2; continue; }
    const match = /^(?:tools)\.([a-zA-Z0-9_]+)\s*\(/.exec(script.slice(index));
    if (!match || index > 0 && /[\w$.]/.test(script[index - 1])) { index++; continue; }
    const start = index;
    index += match[0].length;
    let depth = 1;
    while (index < script.length && depth) {
      if ('"\'`'.includes(script[index])) { index = literalEnd(script, index); continue; }
      if (script[index] === "(") depth++;
      if (script[index] === ")") depth--;
      index++;
    }
    calls.push({ name: match[1], source: script.slice(start, index), start, end: index });
  }
  return calls;
}

function embeddedPatch(value: string): string | undefined {
  for (const match of value.matchAll(/("(?:\\.|[^"\\])*")/g)) {
    const decoded = parseQuotedString(match[1]);
    if (decoded?.includes("*** Begin Patch")) return decoded;
  }
  const template = /`([\s\S]*?\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch[\s\S]*?)`/.exec(value);
  return template?.[1].replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

export function orchestrationScript(tool: NormalizedToolCall): string | undefined {
  const name = baseToolName(tool.name);
  return (name === "exec" || name === "exec_command") && typeof tool.arguments === "string" && /\btools\.[\w_]+\s*\(/.test(tool.arguments)
    ? tool.arguments
    : undefined;
}

function isDirectView(name: string): boolean {
  return viewToolNames.has(baseToolName(name));
}

function isDirectGlob(name: string): boolean {
  return globToolNames.has(baseToolName(name));
}

function isDirectSearch(name: string): boolean {
  return searchToolNames.has(baseToolName(name));
}

function isDirectEdit(name: string): boolean {
  return editToolNames.has(baseToolName(name));
}

function isDirectCommand(name: string): boolean {
  return commandToolNames.has(baseToolName(name));
}

function isSemanticOperationName(name: string): boolean {
  return isDirectView(name) || isDirectGlob(name) || isDirectSearch(name) || isDirectEdit(name) || isDirectCommand(name);
}

function scriptPrints(script: string, calls: ScriptCall[]) {
  let skeleton = "";
  for (let index = 0; index < script.length;) {
    const callIndex = calls.findIndex(call => call.start === index);
    if (callIndex >= 0) { skeleton += `CALL_${callIndex}`; index = calls[callIndex].end; continue; }
    if ('"\'`'.includes(script[index])) {
      const end = literalEnd(script, index);
      if (script[index] === "`" && script.slice(index, end).includes("${")) return undefined;
      skeleton += '""'; index = end; continue;
    }
    if (script.startsWith("//", index)) { const end = script.indexOf("\n", index); index = end < 0 ? script.length : end + 1; continue; }
    if (script.startsWith("/*", index)) { const end = script.indexOf("*/", index + 2); index = end < 0 ? script.length : end + 2; continue; }
    skeleton += script[index++];
  }
  const bindings = new Map<string, number[]>();
  const prints: number[] = [];
  while ((skeleton = skeleton.trim().replace(/^;+/, "").trim())) {
    let match: RegExpExecArray | null;
    if ((match = /^const\s+(\w+)\s*=\s*await\s+Promise\.all(?:Settled)?\(\[([\s\S]*?)\]\)\s*;?/.exec(skeleton))) {
      if (!/^(?:\s*CALL_\d+\s*,?)*$/.test(match[2]) || bindings.has(match[1])) return undefined;
      bindings.set(match[1], [...match[2].matchAll(/CALL_(\d+)/g)].map(item => Number(item[1])));
    } else if ((match = /^const\s+(\w+)\s*=\s*(?:await\s+)?CALL_(\d+)\s*;?/.exec(skeleton))) {
      if (bindings.has(match[1])) return undefined;
      bindings.set(match[1], [Number(match[2])]);
    } else if ((match = /^text\(\s*(?:await\s+)?CALL_(\d+)\s*\)\s*;?/.exec(skeleton))) {
      prints.push(Number(match[1]));
    } else if ((match = /^text\(\s*(\w+)\s*\)\s*;?/.exec(skeleton))) {
      const binding = bindings.get(match[1]);
      if (!binding) return undefined;
      prints.push(...binding);
    } else if ((match = /^for\s*\(const\s+(\w+)\s+of\s+(\w+)\)\s*(?:\{\s*)?text\(\1\)\s*;?\s*\}?/.exec(skeleton))) {
      const binding = bindings.get(match[2]);
      if (!binding) return undefined;
      prints.push(...binding);
    } else if (!(match = /^(?:(?:await\s+)?CALL_\d+|const\s+\w+\s*=\s*"")\s*;?/.exec(skeleton))) return undefined;
    skeleton = skeleton.slice(match[0].length);
  }
  return { prints, bindings };
}

function nativeCommandResult(value: unknown, allowText: boolean, decodeJson = true): CommandResult | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.status === "fulfilled") return nativeCommandResult(record.value, allowText);
    if (record.status === "rejected") return undefined;
    if ("exit_code" in record || "session_id" in record) {
      const sessionId = typeof record.session_id === "number" || typeof record.session_id === "string" ? String(record.session_id) : undefined;
      const status = typeof record.exit_code === "number" && Number.isInteger(record.exit_code)
        ? record.exit_code === 0 ? "completed" : "failed" : "requested";
      return { status, sessionId };
    }
    if (allowText && Array.isArray(record.content)) return nativeCommandResult(record.content, true, false);
  }
  if (!allowText) return undefined;
  if (Array.isArray(value)) {
    const texts = value.filter(item => item && typeof item === "object" && (item.type === "text" || item.type === "input_text"))
      .map(item => item.text).filter((text): text is string => typeof text === "string");
    return nativeCommandResult(texts.join("\n"), true, decodeJson);
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (decodeJson && typeof parsed !== "string") return nativeCommandResult(parsed, true);
  } catch {}
  const header = value.split(/^(?:Final output|Output):[^\S\r\n]*$/im)[0];
  const exit = /^(?:Exit code:|Process exited with code)\s*(-?\d+)\s*$/im.exec(header);
  const sessionId = /^Process running with session ID\s+(\d+)\s*$/im.exec(header)?.[1];
  return exit ? { status: Number(exit[1]) === 0 ? "completed" : "failed", sessionId }
    : sessionId ? { status: "requested", sessionId } : undefined;
}

function printedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(printedValues);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("exit_code" in record || "session_id" in record) return [record];
    if (record.type === "text" || record.type === "input_text") return printedValues(record.text ?? record.value);
    if (Array.isArray(record.content) || typeof record.content === "string") return printedValues(record.content);
    return [record];
  }
  if (typeof value !== "string" || /^Script completed\s*$/.test(value)) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : [parsed]; } catch {}
  const lines = value.replace(/^Script completed\s*\n/, "").trim().split(/\r?\n/);
  try { return lines.map(line => JSON.parse(line) as unknown); } catch { return [value]; }
}

export function commandResults(value: unknown, tool: NormalizedToolCall | undefined, allowText = false): CommandResult[] {
  const script = tool && orchestrationScript(tool);
  if (!script) {
    const result = nativeCommandResult(value, allowText);
    return result ? [result] : [];
  }
  const layout = scriptPrints(script, scriptCalls(script));
  if (!layout?.prints.length) return [];
  const values = printedValues(value);
  if (values.length !== layout.prints.length) return [];
  return values.map((item, index) => ({ ...(nativeCommandResult(item, true) ?? { status: "requested" as const }), operationIndex: layout.prints[index] }));
}

export function commandResultStatus(results: CommandResult[]): NormalizedToolCall["status"] {
  return results.at(-1)?.status ?? "requested";
}

function nestedOperations(tool: NormalizedToolCall): NormalizedToolCall[] {
  const script = orchestrationScript(tool);
  if (!script) return [{ ...tool }];
  const matches = scriptCalls(script);
  const layout = scriptPrints(script, matches);
  const operations: NormalizedToolCall[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index].name;
    const polling = baseToolName(name) === "write_stdin";
    if (!isSemanticOperationName(name) && !polling) continue;
    const callSource = matches[index].source;
    let args: unknown = callSource;
    let pollForToolCallId: string | undefined;
    if (isDirectCommand(name)) {
      args = {
        command: embeddedProperty(callSource, "command") ?? embeddedProperty(callSource, "cmd"),
        workdir: embeddedProperty(callSource, "workdir")
      };
    } else if (polling) {
      args = { session_id: embeddedProperty(callSource, "session_id") };
      const variable = /[,{]\s*session_id\s*:\s*(\w+)\.session_id\s*[,}]/.exec(callSource)?.[1];
      const binding = variable ? layout?.bindings.get(variable) : undefined;
      if (binding?.length === 1 && binding[0] < index) pollForToolCallId = `${tool.toolCallId}:nested:${binding[0] + 1}`;
    } else if (isDirectEdit(name)) {
      args = embeddedPatch(callSource) ?? embeddedPatch(script) ?? callSource;
    } else {
      const path = embeddedProperty(callSource, "path") ?? embeddedProperty(callSource, "file") ?? embeddedProperty(callSource, "uri");
      args = path ? { path } : callSource;
    }
    const results = tool.commandResults?.filter(result => result.operationIndex === index) ?? [];
    operations.push({
      ...tool,
      toolCallId: `${tool.toolCallId}:nested:${index + 1}`,
      originToolCallId: tool.toolCallId,
      pollForToolCallId,
      name,
      arguments: args,
      commandResults: results,
      status: isDirectCommand(name) || polling ? commandResultStatus(results) : tool.status
    });
  }
  return operations.length ? operations : [{ ...tool }];
}

export function expandToolCalls(tools: NormalizedToolCall[]): NormalizedToolCall[] {
  const operations = tools.flatMap(nestedOperations);
  const commands = new Map<string, NormalizedToolCall>();
  const commandByCallId = new Map<string, NormalizedToolCall>();
  for (const tool of operations) {
    if (isDirectCommand(tool.name)) commandByCallId.set(tool.toolCallId, tool);
    const result = tool.commandResults?.at(-1);
    if (isDirectCommand(tool.name) && result?.sessionId) commands.set(result.sessionId, tool);
    if (baseToolName(tool.name) !== "write_stdin" || !result) continue;
    const args = commandArgumentRecord(tool.arguments);
    const sessionId = args?.session_id === undefined ? undefined : String(args.session_id);
    const target = tool.pollForToolCallId ? commandByCallId.get(tool.pollForToolCallId) : sessionId ? commands.get(sessionId) : undefined;
    const targetSession = target?.commandResults?.at(-1)?.sessionId;
    if (!target || !targetSession || result.sessionId && result.sessionId !== targetSession) continue;
    if (result.sessionId) commandByCallId.set(tool.toolCallId, target);
    target.status = result.status;
  }
  return operations;
}

function commandArgumentRecord(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") { try { return commandArgumentRecord(JSON.parse(args)); } catch { return undefined; } }
  return args && typeof args === "object" ? args as Record<string, unknown> : undefined;
}

export function toolCommand(tool: NormalizedToolCall): string | undefined {
  if (!isCommandTool(tool)) return undefined;
  const args = tool.arguments;
  if (typeof args === "string") {
    try { return commandArgument(JSON.parse(args)); } catch { /* Native shell strings are also valid. */ }
    return embeddedProperty(args, "command") ?? embeddedProperty(args, "cmd") ?? args;
  }
  return commandArgument(args);
}

function commandArgument(args: unknown): string | undefined {
  if (typeof args === "string") {
    try { return commandArgument(JSON.parse(args)); } catch { return undefined; }
  }
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.cmd === "string") return record.cmd;
  // Native wrappers can retain a second arguments envelope.
  if (record.arguments !== args) return commandArgument(record.arguments);
  return undefined;
}

function toolWorkdir(tool: NormalizedToolCall): string | undefined {
  const args = tool.arguments;
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.workdir === "string") return record.workdir;
  const nested = record.arguments;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).workdir === "string") {
    return (nested as Record<string, unknown>).workdir as string;
  }
  return undefined;
}

export function resolveExecutionPath(value: unknown, base?: string): string | undefined {
  if (value === undefined) return base;
  if (typeof value !== "string") return undefined;
  const target = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
  if (!target || /^[$%~]/.test(target)) return undefined;
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return path.posix.normalize(target).replace(/\/$/, "");
  return base ? path.posix.normalize(`${base}/${target}`).replace(/\/$/, "") : undefined;
}

export function executionDirectory(tool: NormalizedToolCall): string | undefined {
  let context = resolveExecutionPath(toolWorkdir(tool), resolveExecutionPath(tool.executionCwd));
  let command = (toolCommand(tool) ?? "").trim().replace(/^rtk\s+(?:proxy\s+)?/i, "");
  const prefix = /^(?:cd|set-location)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))\s*(?:&&|;)\s*/i;
  let match: RegExpExecArray | null;
  while ((match = prefix.exec(command))) {
    context = resolveExecutionPath(match[1] ?? match[2] ?? match[3], context);
    command = command.slice(match[0].length).replace(/^rtk\s+(?:proxy\s+)?/i, "");
  }
  if (/(?:^|[;&]\s*)(?:cd|set-location)\s/i.test(command)) return undefined;
  match = /^git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/i.exec(command);
  if (match) context = resolveExecutionPath(match[1] ?? match[2] ?? match[3], context);
  return context;
}

export function executionScope(tool: NormalizedToolCall): string | undefined {
  const directory = executionDirectory(tool);
  const root = resolveExecutionPath(tool.executionRoot);
  return directory && root && (directory === root || directory.startsWith(`${root}/`)) ? root : directory;
}

export function isViewTool(tool: NormalizedToolCall): boolean {
  return isDirectView(tool.name) || nestedOperations(tool).some((operation) => operation !== tool && isDirectView(operation.name));
}

export function isGlobTool(tool: NormalizedToolCall): boolean {
  return isDirectGlob(tool.name) || nestedOperations(tool).some((operation) => operation !== tool && isDirectGlob(operation.name));
}

export function isSearchTool(tool: NormalizedToolCall): boolean {
  return isDirectSearch(tool.name) || nestedOperations(tool).some((operation) => operation !== tool && isDirectSearch(operation.name));
}

export function isEditTool(tool: NormalizedToolCall): boolean {
  return isDirectEdit(tool.name) || nestedOperations(tool).some((operation) => operation !== tool && isDirectEdit(operation.name));
}

export function isCommandTool(tool: NormalizedToolCall): boolean {
  if (orchestrationScript(tool)) return nestedOperations(tool).some((operation) => operation !== tool && isDirectCommand(operation.name));
  return isDirectCommand(tool.name);
}

export function looksLikeVerificationTool(tool: NormalizedToolCall): boolean {
  if (tool.name === "report_intent" || isEditTool(tool)) return false;
  const command = toolCommand(tool);
  if (!command) return false;
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return [
    /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|validate|typecheck)(?:[:_-][\w-]+)*\b/,
    /\b(?:vitest|pytest|jest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\w*\s+test|eslint|ruff|mypy)\b/,
    /(?:^|\s)tsc(?:\s|$)/,
    /\bnode\s+--check\b/,
    /\bgit\b[^\r\n;|]*\bdiff\s+--check\b/,
    /(?:^|\s)[^\s;|]*(?:test|validate|lint|check)(?:[-_][\w-]+)?\.(?:ps1|sh|js|mjs|cjs|ts|py)(?:\s|$)/,
    /\btools\/godot\.ps1\b[^\r\n;|]*\b(?:parse|boot|test|export|check-android-env)\b/,
    /\bgodot(?:\.exe)?\b[^\r\n;|]*\b--headless\b/
  ].some((pattern) => pattern.test(normalized));
}

export function canonicalCommand(command: string): string {
  return command
    .replace(/\\/g, "/")
    .replace(/(?:^|\s)(?:\d?>|>>|\*>|2>&1)\s*[^\s;|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function verificationLaneKey(tool: NormalizedToolCall): string {
  const command = canonicalCommand(toolCommand(tool) ?? tool.name);
  const workdir = executionDirectory(tool) ?? "unknown-workdir";
  const packageScript = /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?((?:test|build|lint|check|validate|typecheck)(?:[:_-][\w-]+)*)\b/.exec(command);
  if (packageScript) return `${workdir}|${packageScript[1]}:${packageScript[2]}|${command}`;
  const godot = /\btools\/godot\.ps1\b.*?\b(parse|boot|test|export(?:-web)?|check-android-env)\b/.exec(command);
  if (godot) {
    const target = /(?:-test|-path)\s+([^\s;|]+)/.exec(command)?.[1];
    return `${workdir}|godot:${godot[1]}${target ? `:${target}` : ""}`;
  }
  const executable = /(?:^|\s)(vitest|pytest|jest|cargo\s+test|go\s+test|dotnet\s+test|eslint|ruff|mypy|tsc|node\s+--check)\b/.exec(
    command
  )?.[1];
  return `${workdir}|${executable ? `${executable}:${command}` : command}`;
}

export function canonicalToolSignature(tool: NormalizedToolCall): string {
  if (isCommandTool(tool)) {
    // Unknown commands are not evidence that two operations were redundant.
    if (!toolCommand(tool)) return `${baseToolName(tool.name)}:unknown:${tool.toolCallId}`;
    return `${baseToolName(tool.name)}:${verificationLaneKey(tool)}`;
  }
  return `${baseToolName(tool.name)}:${executionDirectory(tool) ?? "unknown-workdir"}:${JSON.stringify(stableValue(tool.arguments))}`;
}

export function verificationClosureForTools(tools: NormalizedToolCall[]): VerificationClosure {
  const semanticTools = expandToolCalls(tools);
  const lastEdit = semanticTools.reduce((last, tool, index) => (isDirectEdit(tool.name) && tool.status === "completed" ? index : last), -1);
  if (lastEdit < 0) return "not_applicable";
  const checks = semanticTools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool, index }) => index > lastEdit && looksLikeVerificationTool(tool));
  if (!checks.length) return "missing";

  const finalByLane = new Map<string, NormalizedToolCall["status"]>();
  for (const { tool } of checks) finalByLane.set(verificationLaneKey(tool), tool.status);
  const finalStatuses = [...finalByLane.values()];
  if (finalStatuses.some((status) => status === "failed")) return "failed";
  if (finalStatuses.every((status) => status === "completed")) return "passed";
  return "missing";
}

export function repeatedFailureStats(tools: NormalizedToolCall[]): { repeated: number; failed: number } {
  const activeFailures = new Map<string, number>();
  let repeated = 0;
  let failed = 0;
  for (const tool of expandToolCalls(tools)) {
    if (isDirectEdit(tool.name) && tool.status === "completed") {
      activeFailures.clear();
      continue;
    }
    if (!isCommandTool(tool)) continue;
    const key = canonicalToolSignature(tool);
    if (tool.status === "failed") {
      failed += 1;
      const attempts = activeFailures.get(key) ?? 0;
      if (attempts > 0) repeated += 1;
      activeFailures.set(key, attempts + 1);
    } else if (tool.status === "completed") {
      activeFailures.delete(key);
    }
  }
  return { repeated, failed };
}

export function redundantToolStats(tools: NormalizedToolCall[]): { duplicate: number; comparable: number } {
  let stateEpoch = 0;
  let duplicate = 0;
  let comparable = 0;
  const seen = new Map<string, number>();
  for (const tool of expandToolCalls(tools)) {
    if (isDirectEdit(tool.name)) {
      if (tool.status === "completed") stateEpoch += 1;
      continue;
    }
    if (!(isViewTool(tool) || isSearchTool(tool) || isGlobTool(tool) || isCommandTool(tool))) continue;
    if (tool.status === "failed") continue;
    comparable += 1;
    const signature = canonicalToolSignature(tool);
    if (seen.get(signature) === stateEpoch) duplicate += 1;
    seen.set(signature, stateEpoch);
  }
  return { duplicate, comparable };
}
