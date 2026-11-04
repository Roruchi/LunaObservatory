import type { NormalizedToolCall, VerificationClosure } from "./types.js";

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
function scriptCalls(script: string): { name: string; source: string }[] {
  const calls: { name: string; source: string }[] = [];
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
    calls.push({ name: match[1], source: script.slice(start, index) });
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

export function commandResults(value: unknown): NonNullable<NormalizedToolCall["commandResults"]> {
  if (Array.isArray(value)) return value.flatMap(commandResults);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("exit_code" in record || "session_id" in record) {
      if (typeof record.exit_code === "number") return [record.exit_code === 0 ? "completed" : "failed"];
      return ["requested"];
    }
    return ["text", "value", "result", "content"].flatMap(key => commandResults(record[key]));
  }
  if (typeof value !== "string") return [];
  try { return commandResults(JSON.parse(value)); } catch {}
  const header = value.split(/^(?:Final output|Output):[^\S\r\n]*$/im)[0];
  return header.split(/\r?\n/).flatMap(line => {
    try { return commandResults(JSON.parse(line)); } catch {}
    const exit = /^(?:Exit code:|Process exited with code)\s*(-?\d+)\s*$/i.exec(line);
    if (exit) return [Number(exit[1]) === 0 ? "completed" as const : "failed" as const];
    return /^(?:Script running with cell ID|Process running with session ID)\b/i.test(line) ? ["requested" as const] : [];
  });
}

export function commandResultStatus(results: NonNullable<NormalizedToolCall["commandResults"]>): NormalizedToolCall["status"] {
  if (results.includes("failed")) return "failed";
  if (!results.length || results.includes("requested")) return "requested";
  return "completed";
}

function nestedOperations(tool: NormalizedToolCall): NormalizedToolCall[] {
  const script = orchestrationScript(tool);
  if (!script) return [tool];
  const matches = scriptCalls(script);
  const nestedCommandCount = matches.filter((match) => isDirectCommand(match.name)).length;
  const results = tool.commandResults ?? commandResults(tool.outputText);
  const wrapperFailed = tool.status === "failed" || results.includes("failed");
  // A wrapper finishing does not prove that every nested command finished.
  const partial = results.includes("requested") || results.length < nestedCommandCount;
  const operations: NormalizedToolCall[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index].name;
    if (!isSemanticOperationName(name)) continue;
    const callSource = matches[index].source;
    let args: unknown = callSource;
    if (isDirectCommand(name)) {
      args = {
        command: embeddedProperty(callSource, "command") ?? embeddedProperty(callSource, "cmd"),
        workdir: embeddedProperty(callSource, "workdir")
      };
    } else if (isDirectEdit(name)) {
      args = embeddedPatch(callSource) ?? embeddedPatch(script) ?? callSource;
    } else {
      const path = embeddedProperty(callSource, "path") ?? embeddedProperty(callSource, "file") ?? embeddedProperty(callSource, "uri");
      args = path ? { path } : callSource;
    }
    operations.push({
      ...tool,
      toolCallId: `${tool.toolCallId}:nested:${index + 1}`,
      name,
      arguments: args,
      status: isDirectCommand(name) && partial ? "requested" : isDirectCommand(name) && wrapperFailed ? (nestedCommandCount === 1 ? "failed" : "requested") : tool.status
    });
  }
  return operations.length ? operations : [tool];
}

export function expandToolCalls(tools: NormalizedToolCall[]): NormalizedToolCall[] {
  return tools.flatMap(nestedOperations);
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
  if (typeof args === "string") return embeddedProperty(args, "workdir");
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.workdir === "string") return record.workdir;
  const nested = record.arguments;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).workdir === "string") {
    return (nested as Record<string, unknown>).workdir as string;
  }
  return undefined;
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
  const explicitWorkdir = toolWorkdir(tool)?.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const commandWorkdir = /(?:^|[;&|]\s*)(?:cd|set-location)\s+["']?([^"';|]+)["']?/i.exec(command)?.[1]?.trim();
  const workdir = explicitWorkdir ?? commandWorkdir ?? "unknown-workdir";
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
  return `${baseToolName(tool.name)}:${JSON.stringify(stableValue(tool.arguments))}`;
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
