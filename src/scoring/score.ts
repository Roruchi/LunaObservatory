import type { NormalizedSession } from "../normalize/types.js";
import type { ReasonCode } from "./reasonCodes.js";
import { classifySession } from "./classify.js";

export type InefficiencyScore = {
  sessionId: string;
  source: string;
  repoMatch: NormalizedSession["repoMatch"];
  inefficiencyScore: number;
  outcomeScore: number;
  classification: ReturnType<typeof classifySession>;
  reasonCodes: ReasonCode[];
  metrics: NormalizedSession["metrics"];
  sourceFiles: string[];
};

function has(metrics: NormalizedSession["metrics"], code: ReasonCode): boolean {
  switch (code) {
    case "MANY_TURNS":
      return metrics.turns >= 15;
    case "HIGH_OUTPUT_TOKEN_OUTLIER":
      return (metrics.outputTokens.value ?? 0) >= 8000;
    case "HIGH_TOOL_CHURN":
      return metrics.toolRequests >= 40;
    case "REPEATED_FILE_VIEWS":
      return metrics.repeatedFileViews >= 5;
    case "REPEATED_GLOB_SEARCH":
      return metrics.globCalls >= 8;
    case "FAILED_COMMAND_LOOP":
      return metrics.failedCommands >= 3;
    case "MISSING_VERIFICATION":
      return metrics.editCalls > 0 && metrics.verificationEvents === 0;
    case "EXPENSIVE_NO_OP":
      return (metrics.outputTokens.value ?? 0) >= 8000 && metrics.editCalls === 0 && metrics.verificationEvents === 0;
    case "LOW_SIGNAL_EXPLORATION":
      return metrics.globCalls >= 5 && metrics.editCalls === 0 && metrics.verificationEvents === 0;
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
      "EXPENSIVE_NO_OP",
      "LOW_SIGNAL_EXPLORATION",
      "HOOK_FAILURES"
    ] as ReasonCode[]
  ).filter((code) => has(metrics, code));

  const inefficiencyScore = Math.min(100, reasonCodes.reduce((sum, code) => sum + reasonWeight(code), 0));
  let outcomeScore = 30;
  if (metrics.verificationPassed > 0) outcomeScore = 80;
  else if (metrics.verificationEvents > 0) outcomeScore = 70;
  else if (metrics.editCalls > 0) outcomeScore = 60;
  else if (metrics.toolRequests > 0 || metrics.assistantMessages > 0) outcomeScore = 45;
  if (metrics.turns === 0) outcomeScore = 0;

  const classification = classifySession({
    metrics,
    inefficiencyScore,
    outcomeScore,
    reasonCodes
  });

  return {
    sessionId: session.sessionId,
    source: session.source,
    repoMatch: session.repoMatch,
    inefficiencyScore,
    outcomeScore,
    classification,
    reasonCodes,
    metrics,
    sourceFiles: session.sourceFiles
  };
}
