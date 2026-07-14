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
    scoringVersion: 3,
    sessionId,
    source: "copilot",
    repoMatch: "matched",
    lifecycleStatus: "completed",
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

  it("prefers recent representatives over old extreme scores", () => {
    const oldExtreme = { ...score("old", 100, "inefficient", 70), repoRoot: "C:\\Repo\\A", endedAt: "2025-01-01T00:00:00.000Z" };
    const recent = { ...score("recent", 50, "suspicious", 70), repoRoot: "C:\\Repo\\A", endedAt: "2026-07-01T00:00:00.000Z" };
    expect(selectDreamSessions([oldExtreme, recent], 1).map((item) => item.sessionId)).toEqual(["recent"]);
  });

  it("selects one risk-prioritized representative per parent-child family", () => {
    const root = { ...score("root", 5, "efficient", 80), repoRoot: "C:\\Repo\\A", endedAt: "2026-07-01T00:00:00.000Z" };
    const child = {
      ...score("child", 60, "suspicious", 30),
      parentSessionId: "root",
      repoRoot: "C:\\Repo\\A",
      endedAt: "2026-07-01T00:01:00.000Z"
    };
    expect(selectDreamSessions([root, child], 1).map((item) => item.sessionId)).toEqual(["child"]);
  });

  it("does not dream about a completed child while its parent family is still active", () => {
    const root = { ...score("root", 0, "unknown", 0), lifecycleStatus: "in_progress" as const };
    const child = { ...score("child", 40, "suspicious", 50), parentSessionId: "root" };
    expect(selectDreamSessions([root, child], 1)).toEqual([]);
  });
});
