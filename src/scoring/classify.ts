import type { SessionClassification, SessionMetrics } from "../normalize/types.js";
import type { ReasonCode } from "./reasonCodes.js";

export function classifySession(input: {
  metrics: SessionMetrics;
  inefficiencyScore: number;
  outcomeScore: number;
  reasonCodes: ReasonCode[];
}): SessionClassification {
  const { metrics, inefficiencyScore, outcomeScore, reasonCodes } = input;
  if (metrics.turns === 0 && metrics.assistantMessages === 0) return "unknown";
  if (outcomeScore === 0) return "unknown";
  if (
    (inefficiencyScore >= 70 && outcomeScore < 50) ||
    reasonCodes.includes("EXPENSIVE_NO_OP") ||
    (reasonCodes.includes("UNRESOLVED_VERIFICATION") && inefficiencyScore >= 50) ||
    (reasonCodes.includes("MISSING_VERIFICATION") && reasonCodes.includes("HIGH_TOOL_CHURN"))
  ) {
    return "inefficient";
  }
  const materialEffortReason = reasonCodes.some((reason) =>
    ["MANY_TURNS", "HIGH_TOOL_CHURN", "FAILED_COMMAND_LOOP", "REDUNDANT_TOOL_CALLS", "EXPENSIVE_NO_OP", "LOW_SIGNAL_EXPLORATION"].includes(
      reason
    )
  );
  if (outcomeScore >= 70 && inefficiencyScore < 40 && !materialEffortReason) return "efficient";
  if (outcomeScore >= 70 && (metrics.verificationClosure === "passed" || metrics.editCalls === 0)) {
    return "expensive_but_justified";
  }
  if (
    inefficiencyScore >= 40 ||
    reasonCodes.includes("MISSING_VERIFICATION") ||
    reasonCodes.includes("UNRESOLVED_VERIFICATION") ||
    outcomeScore < 40
  )
    return "suspicious";
  return "unknown";
}
