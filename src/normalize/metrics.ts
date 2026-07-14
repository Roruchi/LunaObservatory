import type { MetricValue, NormalizedSession, NormalizedToolCall, SessionMetrics } from "./types.js";

export const unavailable = (): MetricValue => ({ value: null, source: "unavailable" });
export const reported = (value: number): MetricValue => ({ value, source: "reported" });
export const derived = (value: number): MetricValue => ({ value, source: "derived" });

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function textOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isViewTool(tool: NormalizedToolCall): boolean {
  return tool.name.toLowerCase() === "view";
}

function isGlobTool(name: string): boolean {
  return /glob|ls|list/i.test(name);
}

function isSearchTool(name: string): boolean {
  return /search|grep|rg|find/i.test(name);
}

function isEditTool(name: string): boolean {
  return /edit|write|patch|replace|create/i.test(name);
}

function isCommandTool(name: string): boolean {
  return /command|shell|terminal|exec|run/i.test(name);
}

function looksLikeVerification(tool: NormalizedToolCall): boolean {
  if (tool.name === "report_intent") return false;
  const haystack = `${tool.name} ${textOf(tool.arguments)}`.toLowerCase();
  return /\b(test|vitest|pytest|jest|cargo test|go test|npm run build|tsc|lint|validate|check)\b/.test(haystack);
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
  let toolRequests = 0;
  let toolExecutionsStarted = 0;
  let toolExecutionsCompleted = 0;
  let toolExecutionsFailed = 0;
  let hookInvocations = 0;
  let hookFailures = 0;
  let totalHookLatencyMs = 0;
  let globCalls = 0;
  let searchCalls = 0;
  let editCalls = 0;
  let commandCalls = 0;
  let failedCommands = 0;
  let verificationEvents = 0;
  let verificationFailed = 0;

  for (const turn of session.turns) {
    let messageToolRequests = 0;
    for (const message of turn.assistantMessages) {
      assistantMessages += 1;
      if (message.model) increment(models, message.model);
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

    for (const tool of turn.toolCalls) {
      increment(toolCallsByName, tool.name);
      if (isViewTool(tool)) {
        const pathArg = firstPathArg(tool);
        if (pathArg) viewedFiles.push(pathArg.toLowerCase());
      }
      if (isGlobTool(tool.name)) globCalls += 1;
      if (isSearchTool(tool.name)) searchCalls += 1;
      if (isEditTool(tool.name)) editCalls += 1;
      if (isCommandTool(tool.name)) commandCalls += 1;
      if (tool.executionStartedAt) toolExecutionsStarted += 1;
      if (tool.status === "completed") toolExecutionsCompleted += 1;
      if (tool.status === "failed") {
        toolExecutionsFailed += 1;
        if (isCommandTool(tool.name)) failedCommands += 1;
      }
      if (looksLikeVerification(tool)) {
        verificationEvents += 1;
        if (tool.status === "failed") verificationFailed += 1;
      }
      if (tool.name === "report_intent") {
        const args = tool.arguments as Record<string, unknown> | undefined;
        const intent = args?.intent ?? args?.summary ?? tool.intentionSummary;
        if (typeof intent === "string" && intent.trim()) declaredIntents.push(intent.trim());
      }
    }

    for (const hook of turn.hooks) {
      hookInvocations += 1;
      if (hook.success === false) hookFailures += 1;
      totalHookLatencyMs += hook.durationMs ?? 0;
    }
  }

  const uniqueFilesViewed = new Set(viewedFiles).size;
  const verificationPassed = Math.max(0, verificationEvents - verificationFailed);

  return {
    sessionId: session.sessionId,
    turns: session.turns.length,
    assistantMessages,
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
    editCalls,
    commandCalls,
    failedCommands,
    verificationEvents,
    verificationPassed,
    verificationFailed,
    declaredIntents,
    changedFiles: unavailable(),
    changedLines: unavailable(),
    parseErrors
  };
}
