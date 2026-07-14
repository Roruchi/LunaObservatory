import type { MetricValue, NormalizedSession, NormalizedToolCall, SessionMetrics } from "./types.js";
import {
  isCommandTool,
  isEditTool,
  expandToolCalls,
  isGlobTool,
  isSearchTool,
  isViewTool,
  looksLikeVerificationTool,
  redundantToolStats,
  repeatedFailureStats,
  toolCommand,
  verificationClosureForTools
} from "./toolSemantics.js";

export const unavailable = (): MetricValue => ({ value: null, source: "unavailable" });
export const reported = (value: number): MetricValue => ({ value, source: "reported" });
export const derived = (value: number): MetricValue => ({ value, source: "derived" });

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function firstPathArg(tool: NormalizedToolCall): string | undefined {
  const args = tool.arguments;
  if (!args || typeof args !== "object") return undefined;
  for (const key of ["path", "file", "filePath", "uri"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function shellReadPaths(command: string): string[] {
  const paths: string[] = [];
  const normalized = command.replace(/\\/g, "/");
  const getContent = /\b(?:get-content|cat|type)\b(?:\s+-[\w-]+)*\s+["']?([^"'\s;|]+)/gi;
  for (const match of normalized.matchAll(getContent)) paths.push(match[1]);
  return paths;
}

function patchStats(tool: NormalizedToolCall): { paths: string[]; lines: number } {
  if (!isEditTool(tool) || typeof tool.arguments !== "string") return { paths: [], lines: 0 };
  const paths = [...tool.arguments.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim());
  const lines = tool.arguments
    .split(/\r?\n/)
    .filter((line) => (/^[+-]/.test(line) && !/^\+\+\+|^---/.test(line))).length;
  return { paths, lines };
}

export function calculateMetrics(session: Omit<NormalizedSession, "metrics">, parseErrors = 0): SessionMetrics {
  const models: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const viewedFiles: string[] = [];
  const declaredIntents: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let summaryInputTokens = 0;
  let summaryOutputTokens = 0;
  let summaryCachedTokens = 0;
  let hasReportedInputTokens = false;
  let hasReportedOutputTokens = false;
  let hasReportedCachedTokens = false;
  let hasSummaryInputTokens = false;
  let hasSummaryOutputTokens = false;
  let hasSummaryCachedTokens = false;
  let assistantMessages = 0;
  let reasoningItems = 0;
  let tokenSamples = 0;
  let modelRequests = 0;
  let toolRequests = 0;
  let toolExecutionsStarted = 0;
  let toolExecutionsCompleted = 0;
  let toolExecutionsFailed = 0;
  let hookInvocations = 0;
  let hookFailures = 0;
  let totalHookLatencyMs = 0;
  let globCalls = 0;
  let searchCalls = 0;
  let editAttempts = 0;
  let editCalls = 0;
  let commandCalls = 0;
  let failedCommands = 0;
  let verificationEvents = 0;
  let verificationPassed = 0;
  let verificationFailed = 0;
  let changedLines = 0;
  const changedPaths = new Set<string>();
  const orderedTools: NormalizedToolCall[] = [];
  const seenTextFingerprints = new Set<string>();

  for (const turn of session.turns) {
    let messageToolRequests = 0;
    for (const message of turn.assistantMessages) {
      if (message.kind === "token_usage") tokenSamples += 1;
      else if (message.kind === "reasoning") reasoningItems += 1;
      else if (!message.contentFingerprint || !seenTextFingerprints.has(message.contentFingerprint)) {
        assistantMessages += 1;
        if (message.contentFingerprint) seenTextFingerprints.add(message.contentFingerprint);
      }
      if (message.model && message.kind !== "token_usage") increment(models, message.model);
      if (message.kind === "token_usage") modelRequests += 1;
      if (message.tokenScope === "session") {
        if (message.inputTokens?.value !== null && message.inputTokens?.value !== undefined) {
          summaryInputTokens = Math.max(summaryInputTokens, message.inputTokens.value);
          hasSummaryInputTokens = true;
        }
        if (message.outputTokens.value !== null) {
          summaryOutputTokens = Math.max(summaryOutputTokens, message.outputTokens.value);
          hasSummaryOutputTokens = true;
        }
        if (message.cachedTokens?.value !== null && message.cachedTokens?.value !== undefined) {
          summaryCachedTokens = Math.max(summaryCachedTokens, message.cachedTokens.value);
          hasSummaryCachedTokens = true;
        }
        continue;
      }
      if (message.inputTokens?.value !== null && message.inputTokens?.value !== undefined) {
        inputTokens += message.inputTokens.value;
        hasReportedInputTokens = true;
      }
      if (message.outputTokens.value !== null) {
        outputTokens += message.outputTokens.value;
        hasReportedOutputTokens = true;
      }
      if (message.cachedTokens?.value !== null && message.cachedTokens?.value !== undefined) {
        cachedTokens += message.cachedTokens.value;
        hasReportedCachedTokens = true;
      }
      messageToolRequests += message.toolRequestIds.length;
    }
    toolRequests += Math.max(messageToolRequests, turn.toolCalls.length);

    for (const originalTool of turn.toolCalls) {
      if (originalTool.executionStartedAt) toolExecutionsStarted += 1;
      if (originalTool.status === "completed") toolExecutionsCompleted += 1;
      if (originalTool.status === "failed") toolExecutionsFailed += 1;

      const semanticTools = expandToolCalls([originalTool]);
      for (const tool of semanticTools) {
      orderedTools.push(tool);
      increment(toolCallsByName, tool.name);
      if (isViewTool(tool)) {
        const pathArg = firstPathArg(tool);
        if (pathArg) viewedFiles.push(pathArg.toLowerCase());
      }
      if (isGlobTool(tool)) globCalls += 1;
      if (isSearchTool(tool)) searchCalls += 1;
      if (isEditTool(tool)) {
        editAttempts += 1;
        if (tool.status === "completed") {
          editCalls += 1;
          const stats = patchStats(tool);
          for (const changedPath of stats.paths) changedPaths.add(changedPath.toLowerCase());
          changedLines += stats.lines;
          const directPath = firstPathArg(tool);
          if (directPath) changedPaths.add(directPath.toLowerCase());
        }
      }
      if (isCommandTool(tool)) {
        commandCalls += 1;
        const command = toolCommand(tool) ?? "";
        const readPaths = shellReadPaths(command);
        viewedFiles.push(...readPaths.map((item) => item.toLowerCase()));
        if (/\brg\s+--files\b|\bget-childitem\b/i.test(command)) globCalls += 1;
        else if (/\b(?:rg|grep|select-string)\b/i.test(command)) searchCalls += 1;
      }
      if (tool.status === "failed") {
        if (isCommandTool(tool)) failedCommands += 1;
      }
      if (looksLikeVerificationTool(tool)) {
        verificationEvents += 1;
        if (tool.status === "completed") verificationPassed += 1;
        if (tool.status === "failed") verificationFailed += 1;
      }
      if (tool.name === "report_intent") {
        const args = tool.arguments as Record<string, unknown> | undefined;
        const intent = args?.intent ?? args?.summary ?? tool.intentionSummary;
        if (typeof intent === "string" && intent.trim()) declaredIntents.push(intent.trim());
      }
      }
    }

    for (const hook of turn.hooks) {
      hookInvocations += 1;
      if (hook.success === false) hookFailures += 1;
      totalHookLatencyMs += hook.durationMs ?? 0;
    }
  }

  const uniqueFilesViewed = new Set(viewedFiles).size;
  const verificationPassRate = verificationEvents ? verificationPassed / verificationEvents : 0;
  const failureStats = repeatedFailureStats(orderedTools);
  const redundancy = redundantToolStats(orderedTools);
  const taskStarts = session.turns.filter((turn) => turn.lifecycleStatus && turn.lifecycleStatus !== "unknown").length;
  const taskCompletions = session.turns.filter((turn) => turn.lifecycleStatus === "completed").length;
  const taskDenominator = Math.max(1, taskStarts || session.interactions.length || session.turns.length);
  const finalOutputTokens = hasSummaryOutputTokens ? summaryOutputTokens : hasReportedOutputTokens ? outputTokens : undefined;

  return {
    sessionId: session.sessionId,
    turns: session.turns.length,
    assistantMessages,
    reasoningItems,
    tokenSamples,
    modelRequests,
    models,
    inputTokens: hasSummaryInputTokens ? reported(summaryInputTokens) : hasReportedInputTokens ? reported(inputTokens) : unavailable(),
    outputTokens: hasSummaryOutputTokens ? reported(summaryOutputTokens) : hasReportedOutputTokens ? reported(outputTokens) : unavailable(),
    cachedTokens: hasSummaryCachedTokens ? reported(summaryCachedTokens) : hasReportedCachedTokens ? reported(cachedTokens) : unavailable(),
    aiCredits: unavailable(),
    estimatedCost: unavailable(),
    toolRequests,
    toolExecutionsStarted,
    toolExecutionsCompleted,
    toolExecutionsFailed,
    toolCallsByName,
    hookInvocations,
    hookFailures,
    totalHookLatencyMs,
    filesViewed: viewedFiles.length,
    uniqueFilesViewed,
    repeatedFileViews: Math.max(0, viewedFiles.length - uniqueFilesViewed),
    globCalls,
    searchCalls,
    editAttempts,
    editCalls,
    commandCalls,
    failedCommands,
    failedCommandRate: commandCalls ? failedCommands / commandCalls : 0,
    repeatedFailedCommandAttempts: failureStats.repeated,
    sameMistakeRetryRate: failureStats.failed ? failureStats.repeated / failureStats.failed : 0,
    verificationEvents,
    verificationPassed,
    verificationFailed,
    verificationPassRate,
    verificationClosure: verificationClosureForTools(orderedTools),
    taskStarts,
    taskCompletions,
    taskCompletionRate: taskStarts ? taskCompletions / taskStarts : 0,
    toolRequestsPerTask: toolRequests / taskDenominator,
    outputTokensPerTask: finalOutputTokens === undefined ? unavailable() : derived(finalOutputTokens / taskDenominator),
    duplicateToolCalls: redundancy.duplicate,
    redundantToolCallRate: redundancy.comparable ? redundancy.duplicate / redundancy.comparable : 0,
    declaredIntents,
    changedFiles: changedPaths.size ? derived(changedPaths.size) : unavailable(),
    changedLines: changedLines ? derived(changedLines) : unavailable(),
    parseErrors
  };
}
