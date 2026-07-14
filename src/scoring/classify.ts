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
  if (
    (inefficiencyScore >= 70 && outcomeScore < 50) ||
    reasonCodes.includes("EXPENSIVE_NO_OP") ||
    (reasonCodes.includes("MISSING_VERIFICATION") && reasonCodes.includes("HIGH_TOOL_CHURN"))
  ) {
    return "inefficient";
  }
  if (outcomeScore >= 70 && inefficiencyScore < 40) return "efficient";
  if (outcomeScore >= 70 && inefficiencyScore >= 40 && metrics.verificationEvents > 0) {
    return "expensive_but_justified";
  }
  if (inefficiencyScore >= 40 || (outcomeScore >= 40 && outcomeScore <= 69)) return "suspicious";
  return "unknown";
}
