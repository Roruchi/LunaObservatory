import type { NormalizedSession } from "../normalize/types.js";
import type { ReasonCode } from "./reasonCodes.js";
import { classifySession } from "./classify.js";

export type InefficiencyScore = {
  scoringVersion: 3;
  sessionId: string;
  parentSessionId?: string;
  agentPath?: string;
  source: string;
  repoRoot?: string;
  repoMatch: NormalizedSession["repoMatch"];
  startedAt?: string;
  endedAt?: string;
  lifecycleStatus: NormalizedSession["lifecycleStatus"];
  inefficiencyScore: number;
  outcomeScore: number;
  classification: ReturnType<typeof classifySession>;
  reasonCodes: ReasonCode[];
  metrics: NormalizedSession["metrics"];
  sourceFiles: string[];
};

function metricNumber(metrics: NormalizedSession["metrics"], key: keyof NormalizedSession["metrics"]): number {
  const raw = metrics[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function hasChangeClaim(session: NormalizedSession): boolean {
  return (session.finalClaims ?? []).some((claim) =>
    /\b(added|built|changed|committed|created|documented|fixed|implemented|pushed|removed|updated|wired)\b/i.test(claim.text)
  );
}

function hasDelegation(session: NormalizedSession): boolean {
  return Object.keys(session.metrics.toolCallsByName).some((name) => /(?:^|[.:/])(?:spawn_agent|followup_task|send_message_to_thread)$/i.test(name));
}

function has(session: NormalizedSession, code: ReasonCode): boolean {
  const metrics = session.metrics;
  const taskCount = Math.max(1, metrics.taskStarts ?? 0, metrics.turns);
  const toolsPerTask = metrics.toolRequestsPerTask ?? metrics.toolRequests / taskCount;
  const outputPerTask = metricNumber(metrics, "outputTokensPerTask") || metricNumber(metrics, "outputTokens") / taskCount;
  switch (code) {
    case "MANY_TURNS":
      return taskCount >= 15 && toolsPerTask >= 30;
    case "HIGH_OUTPUT_TOKEN_OUTLIER":
      return outputPerTask >= 12000 && metricNumber(metrics, "outputTokens") >= 12000;
    case "HIGH_TOOL_CHURN":
      return metrics.toolRequests >= 40 && toolsPerTask >= 30;
    case "REPEATED_FILE_VIEWS":
      return metrics.repeatedFileViews >= 5;
    case "REPEATED_GLOB_SEARCH":
      return metrics.globCalls >= 8 && metrics.globCalls / taskCount >= 5;
    case "FAILED_COMMAND_LOOP":
      return (metrics.repeatedFailedCommandAttempts ?? 0) >= 2;
    case "MISSING_VERIFICATION":
      return metrics.editCalls > 0 && metrics.verificationClosure === "missing";
    case "UNRESOLVED_VERIFICATION":
      return metrics.editCalls > 0 && metrics.verificationClosure === "failed";
    case "REDUNDANT_TOOL_CALLS":
      return (metrics.duplicateToolCalls ?? 0) >= 5 && (metrics.redundantToolCallRate ?? 0) >= 0.2;
    case "EXPENSIVE_NO_OP":
      return (
        session.lifecycleStatus === "completed" &&
        !hasDelegation(session) &&
        hasChangeClaim(session) &&
        outputPerTask >= 8000 &&
        metrics.editCalls === 0 &&
        metrics.toolRequests === 0
      );
    case "LOW_SIGNAL_EXPLORATION":
      return session.lifecycleStatus === "completed" && !session.finalAnswer?.text && metrics.searchCalls + metrics.globCalls >= 8;
    case "HOOK_FAILURES":
      return metrics.hookFailures > 0;
    case "UNKNOWN_INPUT_TOKENS":
      return false;
  }
}

function reasonWeight(code: ReasonCode): number {
  const weights: Record<ReasonCode, number> = {
    HIGH_OUTPUT_TOKEN_OUTLIER: 18,
    MANY_TURNS: 15,
    HIGH_TOOL_CHURN: 20,
    REPEATED_FILE_VIEWS: 14,
    REPEATED_GLOB_SEARCH: 12,
    FAILED_COMMAND_LOOP: 18,
    MISSING_VERIFICATION: 20,
    UNRESOLVED_VERIFICATION: 28,
    REDUNDANT_TOOL_CALLS: 14,
    EXPENSIVE_NO_OP: 30,
    LOW_SIGNAL_EXPLORATION: 12,
    HOOK_FAILURES: 12,
    UNKNOWN_INPUT_TOKENS: 0
  };
  return weights[code];
}

export function scoreSession(session: NormalizedSession): InefficiencyScore {
  const metrics = session.metrics;
  const reasonCodes = (
    [
      "HIGH_OUTPUT_TOKEN_OUTLIER",
      "MANY_TURNS",
      "HIGH_TOOL_CHURN",
      "REPEATED_FILE_VIEWS",
      "REPEATED_GLOB_SEARCH",
      "FAILED_COMMAND_LOOP",
      "MISSING_VERIFICATION",
      "UNRESOLVED_VERIFICATION",
      "REDUNDANT_TOOL_CALLS",
      "EXPENSIVE_NO_OP",
      "LOW_SIGNAL_EXPLORATION",
      "HOOK_FAILURES"
    ] as ReasonCode[]
  ).filter((code) => has(session, code));

  const inefficiencyScore = Math.min(100, reasonCodes.reduce((sum, code) => sum + reasonWeight(code), 0));
  let outcomeScore = 30;
  if (session.lifecycleStatus === "in_progress") outcomeScore = 0;
  else if (session.lifecycleStatus === "aborted") outcomeScore = 20;
  else if (metrics.editCalls > 0) {
    if (metrics.verificationClosure === "passed") outcomeScore = session.lifecycleStatus === "completed" ? 90 : 80;
    else if (metrics.verificationClosure === "failed") outcomeScore = 30;
    else outcomeScore = session.lifecycleStatus === "completed" ? 50 : 55;
  } else if (session.lifecycleStatus === "completed" && session.finalAnswer?.text) outcomeScore = 65;
  else if (metrics.verificationPassed > 0) outcomeScore = 75;
  else if (session.finalAnswer?.text) outcomeScore = 65;
  else if (metrics.toolRequests > 0 || metrics.assistantMessages > 0) outcomeScore = 45;
  if (metrics.taskStarts > 0 && metrics.taskCompletionRate < 1) outcomeScore = Math.min(outcomeScore, 35);
  if (metrics.turns === 0) outcomeScore = 0;

  const classification = classifySession({
    metrics,
    inefficiencyScore,
    outcomeScore,
    reasonCodes
  });

  return {
    scoringVersion: 3,
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    agentPath: session.agentPath,
    source: session.source,
    repoRoot: session.repoRoot,
    repoMatch: session.repoMatch,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lifecycleStatus: session.lifecycleStatus,
    inefficiencyScore,
    outcomeScore,
    classification,
    reasonCodes,
    metrics,
    sourceFiles: session.sourceFiles
  };
}
