import {
  expandToolCalls,
  executionDirectory,
  executionScope,
  resolveExecutionPath,
  isEditTool,
  isGlobTool,
  isViewTool,
  toolCommand,
  verificationLaneKey
} from "../normalize/toolSemantics.js";
import type {
  EvidenceRef,
  NormalizedAssistantMessage,
  NormalizedSession,
  NormalizedTextEvidence,
  NormalizedToolCall,
  NormalizedTurn
} from "../normalize/types.js";
import type {
  ClaimCheck,
  DreamChangeClassification,
  DreamChangeType,
  DreamConfidence,
  DreamEvidenceRef,
  DreamTaskWindow,
  DreamVerificationType,
  VerificationCheck
} from "./types.js";

export type DreamChangePolicy = {
  verificationRequired: boolean | null;
  acceptableVerificationTypes: DreamVerificationType[];
  repositoryTestsRelevant: boolean;
};

export const DREAM_CHANGE_POLICY: Record<DreamChangeType, DreamChangePolicy> = {
  product_code: {
    verificationRequired: true,
    acceptableVerificationTypes: ["test", "build", "lint", "typecheck", "diff_check"],
    repositoryTestsRelevant: true
  },
  tests: {
    verificationRequired: true,
    acceptableVerificationTypes: ["test", "build", "lint", "typecheck", "diff_check"],
    repositoryTestsRelevant: true
  },
  documentation: {
    verificationRequired: true,
    acceptableVerificationTypes: ["document_build", "read_back", "diff_check"],
    repositoryTestsRelevant: false
  },
  repository_metadata: {
    verificationRequired: true,
    acceptableVerificationTypes: ["build", "lint", "typecheck", "read_back", "diff_check"],
    repositoryTestsRelevant: false
  },
  automation_memory: {
    verificationRequired: true,
    acceptableVerificationTypes: ["persistence_check", "read_back"],
    repositoryTestsRelevant: false
  },
  external_system: {
    verificationRequired: true,
    acceptableVerificationTypes: ["external_confirmation", "read_back"],
    repositoryTestsRelevant: false
  },
  generated_asset: {
    verificationRequired: true,
    acceptableVerificationTypes: ["asset_inspection", "build", "read_back"],
    repositoryTestsRelevant: false
  },
  local_file_organization: {
    verificationRequired: true,
    acceptableVerificationTypes: ["filesystem_check", "read_back"],
    repositoryTestsRelevant: false
  },
  read_only: {
    verificationRequired: false,
    acceptableVerificationTypes: [],
    repositoryTestsRelevant: false
  },
  unknown: {
    verificationRequired: null,
    acceptableVerificationTypes: [],
    repositoryTestsRelevant: false
  }
};

type OrderedAction = {
  actionIndex: number;
  turn: NormalizedTurn;
  tool: NormalizedToolCall;
};

type TaskDraft = {
  turns: NormalizedTurn[];
  intentEvidence: NormalizedTextEvidence[];
  confidence: DreamConfidence;
};

type ShellMutation = {
  operation: "write" | "copy" | "move" | "remove" | "redirect";
  targets: string[];
};

type EffectiveOutcome = "passed" | "failed" | "unknown";

const directMutationNames = /(?:^|_)(?:send|post|create|update|delete|archive|publish|submit|upload|schedule|reschedule|cancel|label|react|click|type|fill|select)(?:_|$)/i;
const externalReadNames = /(?:^|_)(?:get|read|fetch|list|open|inspect|screenshot|snapshot|search)(?:_|$)/i;
const generatedToolNames = /(?:imagegen|image_gen|generate_image|create_image|suno|generate_audio|render_asset)/i;
const metadataNames = new Set([
  "agents.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "vite.config.ts",
  "vitest.config.ts",
  "wrangler.jsonc",
  "dockerfile"
]);

function baseToolName(name: string): string {
  return name.toLowerCase().split(/__|[.:/]/).filter(Boolean).at(-1) ?? name.toLowerCase();
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function evidenceId(sessionId: string, suffix: string): string {
  return `${sessionId}:analysis:${suffix.replace(/[^a-zA-Z0-9._:-]/g, "_")}`;
}

function toDreamRefs(sessionId: string, refs: EvidenceRef[] | undefined, suffix: string): DreamEvidenceRef[] {
  return (refs ?? []).map((ref, index) => ({
    id: evidenceId(sessionId, `${suffix}:${ref.eventId ?? ref.lineNumber}:${index}`),
    sessionId,
    sourceFile: ref.sourceFile,
    lineNumber: ref.lineNumber,
    eventId: ref.eventId,
    eventType: ref.eventType,
    fieldPath: ref.fieldPath,
    summary: ref.summary
  }));
}

function syntheticRef(sessionId: string, suffix: string, summary: string): DreamEvidenceRef {
  return { id: evidenceId(sessionId, suffix), sessionId, summary };
}

function uniqueRefs(refs: DreamEvidenceRef[]): DreamEvidenceRef[] {
  const byId = new Map<string, DreamEvidenceRef>();
  for (const ref of refs) byId.set(ref.id, ref);
  return [...byId.values()];
}

function metricNumber(session: NormalizedSession, key: keyof NormalizedSession["metrics"]): number {
  const value = session.metrics[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    const metric = (value as { value?: unknown }).value;
    if (typeof metric === "number" && Number.isFinite(metric)) return metric;
  }
  return 0;
}

function hasTurnActivity(turn: NormalizedTurn): boolean {
  return Boolean(turn.userMessages?.length || turn.assistantMessages.length || turn.toolCalls.length || turn.lifecycleStatus);
}

function segmentTasks(session: NormalizedSession): TaskDraft[] {
  const turns = session.turns.filter(hasTurnActivity);
  if (!turns.length) {
    return [
      {
        turns: [],
        intentEvidence: session.userIntent ? [session.userIntent] : [],
        confidence: session.userIntent ? "medium" : "low"
      }
    ];
  }

  const explicit = turns.some((turn) => Boolean(turn.userMessages?.length));
  if (explicit) {
    const drafts: TaskDraft[] = [];
    const prefix: NormalizedTurn[] = [];
    let current: TaskDraft | undefined;
    for (const turn of turns) {
      const messages = turn.userMessages ?? [];
      if (messages.length) {
        if (current) drafts.push(current);
        current = {
          turns: drafts.length === 0 ? [...prefix, turn] : [turn],
          intentEvidence: messages,
          confidence: "high"
        };
      } else if (current) {
        current.turns.push(turn);
      } else {
        prefix.push(turn);
      }
    }
    if (current) drafts.push(current);
    return drafts.length ? drafts : [{ turns, intentEvidence: session.userIntent ? [session.userIntent] : [], confidence: "low" }];
  }

  const lifecycleTurns = turns.filter((turn) => turn.lifecycleStatus && turn.lifecycleStatus !== "unknown");
  if (metricNumber(session, "taskStarts") > 1 && lifecycleTurns.length > 1) {
    return lifecycleTurns.map((turn, index) => ({
      turns: [turn],
      intentEvidence: index === 0 && session.userIntent ? [session.userIntent] : [],
      confidence: "low"
    }));
  }

  return [
    {
      turns,
      intentEvidence: session.userIntent ? [session.userIntent] : [],
      confidence: session.userIntent ? "medium" : "low"
    }
  ];
}

function orderedActions(session: NormalizedSession): Map<NormalizedTurn, OrderedAction[]> {
  const byTurn = new Map<NormalizedTurn, OrderedAction[]>();
  let actionIndex = 0;
  const expandedByCall = new Map<string, NormalizedToolCall[]>();
  for (const tool of expandToolCalls(session.turns.flatMap(turn => turn.toolCalls))) {
    const key = tool.originToolCallId ?? tool.toolCallId;
    expandedByCall.set(key, [...expandedByCall.get(key) ?? [], tool]);
  }
  for (const turn of session.turns) {
    const actions: OrderedAction[] = [];
    for (const original of turn.toolCalls) {
      for (const tool of expandedByCall.get(original.toolCallId) ?? []) {
        actions.push({ actionIndex: actionIndex++, turn, tool });
      }
    }
    byTurn.set(turn, actions);
  }
  return byTurn;
}

function argumentRecord(tool: NormalizedToolCall): Record<string, unknown> | undefined {
  return tool.arguments && typeof tool.arguments === "object" && !Array.isArray(tool.arguments)
    ? (tool.arguments as Record<string, unknown>)
    : undefined;
}

function pathValues(value: unknown, depth = 0): string[] {
  if (depth > 2 || !value || typeof value !== "object") return [];
  const paths: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      /^(?:path|file|filePath|filename|uri|url|target|destination|output|resourceId|resource_id|automationId|automation_id|threadId|thread_id|documentId|document_id|id)$/i.test(
        key
      )
    ) {
      paths.push(item);
    } else if (item && typeof item === "object") {
      paths.push(...pathValues(item, depth + 1));
    }
  }
  return paths;
}

function patchTargets(tool: NormalizedToolCall): string[] {
  const text = valueText(tool.arguments);
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim());
}

function shellVariables(command: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const match of command.matchAll(/\$([a-zA-Z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    variables.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return variables;
}

function stripToken(value: string): string {
  return value.trim().replace(/^["']|["',)]+$/g, "");
}

function resolveShellToken(token: string, variables: Map<string, string>): string {
  const stripped = stripToken(token);
  const variable = /^\$([a-zA-Z_][\w]*)$/.exec(stripped);
  return variable ? variables.get(variable[1].toLowerCase()) ?? stripped : stripped;
}

function pathLikeTokens(segment: string, variables: Map<string, string>): string[] {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\$[\w:]+(?:[\\/][^\s;|]+)*|[^\s;|]+/g) ?? [];
  return tokens
    .map((token) => resolveShellToken(token, variables))
    .filter(
      (token) =>
        Boolean(token) &&
        !/^-/i.test(token) &&
        !/^\d+$/.test(token) &&
        !/^(?:add-content|set-content|out-file|copy-item|move-item|rename-item|remove-item|new-item|cp|mv|rm|mkdir|touch)$/i.test(token) &&
        (/[$%~.:\\/]/.test(token) || /\.[a-z0-9]{1,8}$/i.test(token))
    );
}

function namedShellTargets(command: string, variables: Map<string, string>): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/-(?:LiteralPath|FilePath|Path|Destination|Dest|TargetPath)\s+("[^"]*"|'[^']*'|[^\s;|]+)/gi)) {
    targets.push(resolveShellToken(match[1], variables));
  }
  return targets;
}

function shellMutation(command: string): ShellMutation | undefined {
  const variables = shellVariables(command);
  const namedTargets = namedShellTargets(command, variables);
  const powershell = /\b(Add-Content|Set-Content|Out-File|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item)\b/i.exec(command);
  if (powershell) {
    const operationName = powershell[1].toLowerCase();
    const operation: ShellMutation["operation"] = /copy/.test(operationName)
      ? "copy"
      : /move|rename/.test(operationName)
        ? "move"
        : /remove/.test(operationName)
          ? "remove"
          : "write";
    const segment = command.slice(powershell.index).split(/[;|\r\n]/, 1)[0];
    const positional = pathLikeTokens(segment, variables);
    const targets = namedTargets.length
      ? operation === "copy" || operation === "move"
        ? namedTargets.slice(-1)
        : namedTargets
      : positional.slice(-1);
    return { operation, targets };
  }

  const unix = /(?:^|[;&|]\s*|\s)(cp|mv|rm|mkdir|touch)\s+([^;&|\r\n]+)/i.exec(command);
  if (unix) {
    const operation: ShellMutation["operation"] = unix[1].toLowerCase() === "cp" ? "copy" : unix[1].toLowerCase() === "mv" ? "move" : "remove";
    return { operation, targets: pathLikeTokens(unix[2], variables).slice(-1) };
  }

  const redirected = [...command.matchAll(/(?:^|[\s;])(>>|>)\s*("[^"]*"|'[^']*'|[^\s;|]+)/g)].map((match) =>
    resolveShellToken(match[2], variables)
  );
  return redirected.length ? { operation: "redirect", targets: redirected } : undefined;
}

function shellReadTarget(command: string): string | undefined {
  const variables = shellVariables(command);
  const named = namedShellTargets(command, variables);
  if (named.length) return named.at(-1);
  const read = /\b(Get-Content|Select-String|Test-Path|Get-ChildItem|Get-Item|Resolve-Path|cat|type|ls)\b/i.exec(command);
  if (!read) return undefined;
  const segment = command.slice(read.index).split(/[;|\r\n]/, 1)[0];
  return pathLikeTokens(segment, variables).at(-1);
}

function canonicalTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  let normalized = stripToken(target)
    .replace(/\\/g, "/")
    .replace(/\$env:codex_home/gi, "%codex_home%")
    .replace(/\$env:userprofile/gi, "%userprofile%")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
  normalized = normalized.replace(/^.*\/\.codex\/(automations\/)/, "%codex_home%/$1");
  return normalized || undefined;
}

export function repositoryVerificationMatches(change: DreamChangeClassification, check: VerificationCheck): boolean {
  const scope = canonicalTarget(change.executionScope);
  const target = canonicalTarget(change.target);
  const checkScope = check.target?.startsWith("repo:") ? canonicalTarget(check.target.slice(5)) : undefined;
  if (!scope || !target || !checkScope) return false;
  if (!["product_code", "tests", "documentation", "repository_metadata"].includes(change.changeType)) return false;
  return (target === scope || target.startsWith(`${scope}/`)) &&
    checkScope === scope;
}

function isRepoPath(target: string, executionScope?: string): boolean {
  const normalized = canonicalTarget(target);
  if (!normalized) return false;
  const scope = canonicalTarget(executionScope);
  return Boolean(scope && (normalized === scope || normalized.startsWith(`${scope}/`)));
}

function fileName(target: string): string {
  return canonicalTarget(target)?.split("/").at(-1) ?? target.toLowerCase();
}

function generatedAssetPath(target: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico|svg|mp3|wav|flac|ogg|mp4|webm|pdf|docx|pptx|xlsx)$/i.test(target);
}

function classifyTarget(target: string | undefined, executionScope: string | undefined, operation?: ShellMutation["operation"]): {
  type: DreamChangeType;
  confidence: DreamConfidence;
  reason: string;
} {
  const normalized = canonicalTarget(target);
  if (normalized && /(?:^|\/)automations\/[^/]+\/memory\.md$|%codex_home%\/automations\//i.test(normalized)) {
    return { type: "automation_memory", confidence: "high", reason: "target is Codex automation memory" };
  }
  if (normalized && generatedAssetPath(normalized)) {
    return { type: "generated_asset", confidence: "high", reason: "target has a generated-asset file type" };
  }
  if (target && isRepoPath(target, executionScope)) {
    const name = fileName(target);
    if (/(?:^|\/)(?:tests?|specs?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(normalized ?? target)) {
      return { type: "tests", confidence: "high", reason: "target is a repository test or fixture" };
    }
    if (/(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|rst|adoc|txt)$/i.test(normalized ?? target)) {
      return { type: "documentation", confidence: "high", reason: "target is repository documentation" };
    }
    if (
      metadataNames.has(name) ||
      /(?:^|\/)(?:\.github|\.husky|config|policies|prompts|runbooks)(?:\/|$)|(?:^|\/)(?:readme|agents)\.md$/i.test(normalized ?? target) ||
      /\.(?:ya?ml|toml|ini|jsonc)$/i.test(normalized ?? target)
    ) {
      return { type: "repository_metadata", confidence: "high", reason: "target is repository metadata or guidance" };
    }
    return { type: "product_code", confidence: "high", reason: "target is a repository product file" };
  }
  if (normalized && /\.(?:md|mdx|rst|adoc|txt)$/i.test(normalized)) {
    return { type: "documentation", confidence: "medium", reason: "target is a documentation file outside the matched repository" };
  }
  if (normalized && operation && ["copy", "move", "remove"].includes(operation)) {
    return { type: "local_file_organization", confidence: "high", reason: `${operation} targets a local path outside the repository` };
  }
  return { type: "unknown", confidence: "low", reason: target ? "target type is ambiguous" : "mutation target was not captured" };
}

function effectiveOutcome(tool: NormalizedToolCall): EffectiveOutcome {
  if (tool.status === "failed") return "failed";
  if (tool.status === "completed") return "passed";
  return "unknown";
}

function mutationKind(action: OrderedAction): {
  mutation: boolean;
  targets: string[];
  shell?: ShellMutation;
  forcedType?: DreamChangeType;
  confidence?: DreamConfidence;
  reason?: string;
} {
  const { tool } = action;
  const name = baseToolName(tool.name);
  const command = toolCommand(tool);
  const shell = command ? shellMutation(command) : undefined;
  if (shell) return { mutation: true, targets: shell.targets, shell };

  if (isEditTool(tool)) {
    const targets = [...patchTargets(tool), ...pathValues(argumentRecord(tool))];
    return { mutation: true, targets };
  }

  if (generatedToolNames.test(`${tool.name} ${name}`) && !/view|inspect|read/i.test(tool.name)) {
    const outputPaths = [...(tool.outputText ?? "").matchAll(/(?:[a-z]:)?[^\s"']+\.(?:png|jpe?g|webp|gif|svg|mp3|wav|mp4|pdf|docx|pptx|xlsx)/gi)].map(
      (match) => match[0]
    );
    return {
      mutation: true,
      targets: [...pathValues(argumentRecord(tool)), ...outputPaths],
      forcedType: "generated_asset",
      confidence: "high",
      reason: "tool generates an asset"
    };
  }

  if (/automation.*(?:update|create)|(?:update|create).*automation/i.test(tool.name)) {
    return {
      mutation: true,
      targets: pathValues(argumentRecord(tool)),
      forcedType: "automation_memory",
      confidence: "high",
      reason: "tool mutates automation state"
    };
  }

  if (directMutationNames.test(tool.name) || /(?:browser|chrome|computer).*(?:click|type|fill|select)/i.test(tool.name)) {
    return {
      mutation: true,
      targets: pathValues(argumentRecord(tool)),
      forcedType: "external_system",
      confidence: "medium",
      reason: "tool name indicates an external-system mutation"
    };
  }
  return { mutation: false, targets: [] };
}

function classifyChanges(session: NormalizedSession, taskId: string, actions: OrderedAction[]): DreamChangeClassification[] {
  const changes: DreamChangeClassification[] = [];
  for (const action of actions) {
    const semantic = mutationKind(action);
    if (!semantic.mutation) continue;
    const outcome = effectiveOutcome(action.tool);
    const directory = executionDirectory(action.tool);
    const scope = executionScope(action.tool);
    const rawTargets = semantic.targets.length ? semantic.targets : [undefined];
    rawTargets.forEach((rawTarget, targetIndex) => {
      const target = rawTarget === undefined ? undefined : semantic.forcedType === "external_system"
        ? canonicalTarget(rawTarget) : filesystemTarget(rawTarget, directory);
      const classified = semantic.forcedType
        ? { type: semantic.forcedType, confidence: semantic.confidence ?? "medium", reason: semantic.reason ?? "tool semantics" }
        : classifyTarget(target ?? canonicalTarget(rawTarget), scope, semantic.shell?.operation);
      const policy = DREAM_CHANGE_POLICY[classified.type];
      const refs = toDreamRefs(session.sessionId, action.tool.evidence, `${taskId}:change:${action.actionIndex}:${targetIndex}`);
      changes.push({
        changeId: `${taskId}:change:${action.actionIndex}:${targetIndex + 1}`,
        actionIndex: action.actionIndex,
        changeType: classified.type,
        target: target ?? canonicalTarget(rawTarget),
        executionScope: scope,
        stateChanging: outcome === "passed",
        verificationRequired: policy.verificationRequired,
        acceptableVerificationTypes: [...policy.acceptableVerificationTypes],
        repositoryTestsRelevant: policy.repositoryTestsRelevant,
        confidence: classified.confidence,
        evidence: [
          `tool=${action.tool.name}`,
          `effectiveOutcome=${outcome}`,
          classified.reason,
          ...(rawTarget ? [`target=${rawTarget}`] : [])
        ],
        evidenceRefs: refs.length
          ? refs
          : [syntheticRef(session.sessionId, `${taskId}:change:${action.actionIndex}:${targetIndex}`, `${action.tool.name}: ${classified.reason}`)]
      });
    });
  }
  return changes;
}

function filesystemTarget(value: string | undefined, directory?: string): string | undefined {
  const target = canonicalTarget(value);
  if (!target) return undefined;
  return /^%(?:codex_home|userprofile)%\//.test(target) ? target : resolveExecutionPath(target, directory);
}

function verificationType(action: OrderedAction): { type: DreamVerificationType; target?: string } | undefined {
  const { tool } = action;
  const name = baseToolName(tool.name);
  const command = toolCommand(tool);
  const normalized = command?.replace(/\\/g, "/").toLowerCase() ?? "";
  const directTargets = pathValues(argumentRecord(tool));
  const directory = executionDirectory(tool);
  const scope = executionScope(tool);
  const repositoryTarget = scope ? `repo:${scope}` : undefined;

  if (/\bgit\b[^\r\n;|]*\b(?:diff|status)\b/.test(normalized) || /\bdiff\s+--check\b/.test(normalized)) {
    return { type: "diff_check", target: repositoryTarget };
  }

  // PowerShell's Test-Path is an observation, not a repository test suite.
  // Resolve read targets before applying the broad command-name matchers below.
  const readTarget = command ? shellReadTarget(command) : undefined;
  if (readTarget) {
    const canonical = filesystemTarget(readTarget, directory);
    if (canonical && /%codex_home%\/automations\//.test(canonical) && /\b(?:Test-Path|Select-String)\b/i.test(command ?? "")) {
      return { type: "persistence_check", target: canonical };
    }
    if (/\b(?:Get-ChildItem|Get-Item|Resolve-Path|Test-Path|ls)\b/i.test(command ?? "")) {
      return { type: "filesystem_check", target: canonical };
    }
    return { type: "read_back", target: canonical };
  }

  if (/\b(?:typecheck|type-check|tsc|mypy)\b/.test(normalized)) return { type: "typecheck", target: repositoryTarget };
  if (/\b(?:test|vitest|pytest|jest|cargo\s+test|go\s+test|dotnet\s+test|gut)\b/.test(normalized)) {
    return { type: "test", target: repositoryTarget };
  }
  if (/\b(?:lint|eslint|ruff|cspell)\b/.test(normalized)) return { type: "lint", target: repositoryTarget };
  if (
    /\b(?:pandoc|mkdocs|sphinx-build|render_docx|export_whitepaper|build[_:-]?(?:docs?|document|whitepaper)|docs?:build)\b/.test(normalized) ||
    (/\b(?:build|render|export)\b/.test(normalized) && /\b(?:docs?|document|docx|pdf|markdown|whitepaper)\b/.test(normalized))
  ) {
    return { type: "document_build", target: repositoryTarget };
  }
  if (/\b(?:build|validate|check)\b/.test(normalized)) return { type: "build", target: repositoryTarget };

  if (isViewTool(tool)) {
    const target = filesystemTarget(directTargets[0], directory);
    return { type: target && generatedAssetPath(target) ? "asset_inspection" : "read_back", target };
  }
  if (isGlobTool(tool)) return { type: "filesystem_check", target: filesystemTarget(directTargets[0], directory) };
  if (generatedToolNames.test(tool.name) && /view|inspect|read/i.test(tool.name)) {
    return { type: "asset_inspection", target: filesystemTarget(directTargets[0], directory) };
  }
  if (externalReadNames.test(tool.name) || /(?:browser|chrome|computer).*(?:screenshot|inspect|read|snapshot)/i.test(tool.name)) {
    return { type: "external_confirmation", target: canonicalTarget(directTargets[0]) };
  }
  return undefined;
}

function verificationStatus(action: OrderedAction, type: DreamVerificationType): VerificationCheck["status"] {
  const outcome = effectiveOutcome(action.tool);
  if (outcome === "failed") return "failed";
  if (outcome === "unknown") return "unknown";
  if (["read_back", "persistence_check", "external_confirmation", "asset_inspection", "filesystem_check"].includes(type)) {
    const command = toolCommand(action.tool);
    if (command && !action.tool.outputText?.trim()) return "unknown";
    if (command && /(?:Output:\s*|Script completed\s*)$/i.test(action.tool.outputText?.trim() ?? "")) return "unknown";
  }
  return "passed";
}

function repoChange(change: DreamChangeClassification): boolean {
  return ["product_code", "tests", "documentation", "repository_metadata"].includes(change.changeType) && Boolean(change.target);
}

function targetsMatch(change: DreamChangeClassification, check: VerificationCheck): boolean {
  if (repoChange(change) && check.target?.startsWith("repo:")) return repositoryVerificationMatches(change, check);
  if (!change.target || !check.target) return false;
  if (change.target === check.target) return true;
  if (change.changeType === "local_file_organization") {
    return change.target.startsWith(`${check.target}/`) || check.target.startsWith(`${change.target}/`);
  }
  return false;
}

function classifyVerificationChecks(
  session: NormalizedSession,
  taskId: string,
  actions: OrderedAction[],
  changes: DreamChangeClassification[]
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  for (const action of actions) {
    if (mutationKind(action).mutation) continue;
    const semantic = verificationType(action);
    if (!semantic) continue;
    const refs = toDreamRefs(session.sessionId, action.tool.evidence, `${taskId}:verification:${action.actionIndex}`);
    checks.push({
      command: toolCommand(action.tool) ?? action.tool.name,
      lane: toolCommand(action.tool)
        ? verificationLaneKey(action.tool)
        : `${semantic.target ?? "unknown-target"}|${semantic.type}`,
      verificationType: semantic.type,
      actionIndex: action.actionIndex,
      target: semantic.target,
      status: verificationStatus(action, semantic.type),
      fresh: false,
      evidenceRefs: refs.length
        ? refs
        : [syntheticRef(session.sessionId, `${taskId}:verification:${action.actionIndex}`, `${action.tool.name}: ${semantic.type}`)]
    });
  }

  for (const check of checks) {
    const relevant = changes.filter(
      (change) =>
        change.stateChanging &&
        change.verificationRequired === true &&
        Boolean(check.verificationType && change.acceptableVerificationTypes.includes(check.verificationType)) &&
        targetsMatch(change, check)
    );
    const lastChange = relevant.reduce((latest, change) => Math.max(latest, change.actionIndex), -1);
    check.fresh = lastChange >= 0 && (check.actionIndex ?? -1) > lastChange;
  }
  return checks;
}

function finalTextForTask(session: NormalizedSession, draft: TaskDraft, isLastTask: boolean): {
  text?: string;
  evidenceRefs: DreamEvidenceRef[];
} {
  if (isLastTask && session.finalAnswer?.text) {
    return {
      text: session.finalAnswer.text,
      evidenceRefs: toDreamRefs(session.sessionId, session.finalAnswer.evidence, "final-answer")
    };
  }
  const messages: NormalizedAssistantMessage[] = draft.turns.flatMap((turn) => turn.assistantMessages);
  const final = [...messages].reverse().find((message) => message.kind === "text" && message.text?.trim());
  return final
    ? { text: final.text, evidenceRefs: toDreamRefs(session.sessionId, final.evidence, `assistant:${final.messageId ?? "final"}`) }
    : { evidenceRefs: [] };
}

function claimTexts(answer: string): string[] {
  const withoutCode = answer.replace(/```[\s\S]*?```/g, " ");
  const claims: string[] = [];
  for (const block of withoutCode.split(/\r?\n+/)) {
    const normalized = block.replace(/^\s*(?:[-*+] |\d+[.)]\s*)/, "").trim();
    if (normalized.length < 12) continue;
    for (const sentence of normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9`])/)) {
      const text = sentence.trim();
      if (text.length >= 12) claims.push(text.slice(0, 800));
    }
  }
  return [...new Set(claims)].slice(0, 16);
}

function claimsForTask(
  session: NormalizedSession,
  answer: string | undefined,
  evidenceRefs: DreamEvidenceRef[],
  isLastTask: boolean
): ClaimCheck[] {
  if (!answer) return [];
  if (isLastTask && session.finalClaims?.length) {
    return session.finalClaims.map((claim, index) => ({
      text: claim.text,
      evidenceRefs: toDreamRefs(session.sessionId, claim.evidence, `claim:${index}`)
    }));
  }
  return claimTexts(answer).map((text) => ({ text, evidenceRefs }));
}

function readableDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${parsed.getUTCDate()} ${months[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

function taskLabel(intent: string | undefined, endedAt: string | undefined, index: number): string {
  const firstLine = intent
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^#+\s*(?:my request|environment|files mentioned)/i.test(line));
  const subject = firstLine?.replace(/^automation:\s*/i, "").replace(/[:.]+$/, "").slice(0, 90) || `Task ${index + 1}`;
  const date = readableDate(endedAt);
  return date ? `${subject}, ${date}` : subject;
}

function readOnlyClassification(session: NormalizedSession, taskId: string, actions: OrderedAction[]): DreamChangeClassification {
  const policy = DREAM_CHANGE_POLICY.read_only;
  return {
    changeId: `${taskId}:read-only`,
    actionIndex: actions.at(-1)?.actionIndex ?? 0,
    changeType: "read_only",
    stateChanging: false,
    verificationRequired: policy.verificationRequired,
    acceptableVerificationTypes: [],
    repositoryTestsRelevant: false,
    confidence: actions.length ? "high" : "medium",
    evidence: [actions.length ? "tool activity contained no detected state-changing action" : "task contained no tool activity"],
    evidenceRefs: [
      syntheticRef(
        session.sessionId,
        `${taskId}:read-only`,
        actions.length ? "tool activity contained no detected state-changing action" : "task contained no tool activity"
      )
    ]
  };
}

export function analyzeDreamTasks(session: NormalizedSession): DreamTaskWindow[] {
  const drafts = segmentTasks(session);
  const actionsByTurn = orderedActions(session);
  return drafts.map((draft, index) => {
    const taskId = `${session.sessionId}:task:${index + 1}`;
    const actions = draft.turns.flatMap((turn) => actionsByTurn.get(turn) ?? []);
    const classifiedChanges = classifyChanges(session, taskId, actions);
    const changes = classifiedChanges.length ? classifiedChanges : [readOnlyClassification(session, taskId, actions)];
    const verificationChecks = classifyVerificationChecks(session, taskId, actions, changes);
    const final = finalTextForTask(session, draft, index === drafts.length - 1);
    const finalClaims = claimsForTask(session, final.text, final.evidenceRefs, index === drafts.length - 1);
    const intent = draft.intentEvidence.map((item) => item.text.trim()).filter(Boolean).join("\n\n") || undefined;
    const intentRefs = draft.intentEvidence.flatMap((item, itemIndex) =>
      toDreamRefs(session.sessionId, item.evidence, `${taskId}:intent:${itemIndex}`)
    );
    const evidenceRefs = uniqueRefs([
      ...intentRefs,
      ...changes.flatMap((change) => change.evidenceRefs),
      ...verificationChecks.flatMap((check) => check.evidenceRefs ?? []),
      ...final.evidenceRefs,
      ...finalClaims.flatMap((claim) => claim.evidenceRefs ?? [])
    ]);
    return {
      taskId,
      label: taskLabel(intent, draft.turns.at(-1)?.endedAt ?? session.endedAt, index),
      intent,
      startedAt: draft.turns[0]?.startedAt ?? session.startedAt,
      endedAt: draft.turns.at(-1)?.endedAt ?? session.endedAt,
      segmentationConfidence: draft.confidence,
      turnIds: draft.turns.map((turn) => turn.turnId),
      changes,
      verificationChecks,
      finalAnswer: final.text,
      finalClaims,
      evidenceRefs
    };
  });
}
