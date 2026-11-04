import type { InefficiencyScore } from "../scoring/score.js";

export function scanTerminalSummary(scores: InefficiencyScore[]): string {
  const suspicious = scores.filter((score) => score.classification === "suspicious" || score.classification === "inefficient");
  return `LunaObs scan complete. Sessions scored: ${scores.filter(score => score.inefficiencyScore !== null).length}. Unscored: ${scores.filter(score => score.inefficiencyScore === null).length}. Suspicious/inefficient: ${suspicious.length}.`;
}
