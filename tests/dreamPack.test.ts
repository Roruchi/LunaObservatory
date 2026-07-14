import { describe, expect, it } from "vitest";
import { selectDreamSessions } from "../src/reports/dreamPack.js";
import type { InefficiencyScore } from "../src/scoring/score.js";

function score(
  sessionId: string,
  inefficiencyScore: number,
  classification: InefficiencyScore["classification"],
  outcomeScore = 40
): InefficiencyScore {
  return {
    sessionId,
    source: "copilot",
    repoMatch: "matched",
    inefficiencyScore,
    outcomeScore,
    classification,
    reasonCodes: [],
    metrics: {} as InefficiencyScore["metrics"],
    sourceFiles: []
  };
}

describe("dream pack", () => {
  it("selects top suspicious sessions", () => {
    const selected = selectDreamSessions(
      [score("low", 10, "efficient"), score("mid", 50, "suspicious"), score("high", 90, "inefficient")],
      1
    );
    expect(selected.map((item) => item.sessionId)).toEqual(["high"]);
  });

  it("keeps efficient, inefficient, and risky representatives when available", () => {
    const selected = selectDreamSessions(
      [
        score("efficient", 5, "efficient", 80),
        score("inefficient", 90, "inefficient", 70),
        score("risky", 40, "suspicious")
      ],
      1
    );
    expect(selected.map((item) => item.sessionId)).toEqual(["efficient", "inefficient", "risky"]);
  });
});
