import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";
import { applyRepoFilter } from "../src/normalize/repoFilter.js";
import { generateScanHtmlReport } from "../src/reports/html.js";
import { generateScanReport } from "../src/reports/markdown.js";
import { selectDreamSessions } from "../src/dream/prepare.js";
import { scanTerminalSummary } from "../src/reports/terminal.js";
import { scoreSession } from "../src/scoring/score.js";

describe("scan report", () => {
  it("keeps final-answer-only sessions unscored in reports and out of Dream selection", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-shutdown-usage.jsonl"), "copilot");
    session.repoMatch = "matched";
    const score = scoreSession(session);
    expect(score.outcomeScore).toBeNull();
    expect(selectDreamSessions([score])).toEqual([]);
    expect(scanTerminalSummary([score])).toContain("Sessions scored: 0. Unscored: 1");
    const summary = { filesScanned: 1, eventsParsed: 1, parseErrors: 0, generatedAt: "2026-01-01T00:00:00Z" };
    expect(generateScanReport([session], [score], summary)).toContain("Unscored");
    const html = generateScanHtmlReport([session], [score], summary);
    expect(html).toContain("Unscored");
    expect(html).not.toContain("Outcome 65");
  });

  it("groups path-only Copilot partition sessions by inferred repository", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-partition-events.jsonl"), "copilot");
    applyRepoFilter(session, "C:\\Repo\\VfZ\\na-workflows", true);
    const report = generateScanReport([session], [scoreSession(session)], {
      filesScanned: 1,
      eventsParsed: 4,
      parseErrors: 0,
      generatedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(report).toContain("| na-workflows | 1 |");
    expect(report).toContain("C:\\Repo\\VfZ\\na-workflows");
  });

  it("keeps named repo worktrees below C:\\Repo grouped by worktree checkout", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-worktree-events.jsonl"), "copilot");
    applyRepoFilter(session, "C:\\Repo\\Personal\\Games\\Satori.worktrees\\copilot-worktree-1", true);
    const report = generateScanReport([session], [scoreSession(session)], {
      filesScanned: 1,
      eventsParsed: 2,
      parseErrors: 0,
      generatedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(report).toContain("| copilot-worktree-1 | 1 |");
    expect(report).toContain("C:\\Repo\\Personal\\Games\\Satori.worktrees\\copilot-worktree-1");
  });

  it("renders a standalone HTML report with the same repository grouping", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-worktree-events.jsonl"), "copilot");
    applyRepoFilter(session, "C:\\Repo\\Personal\\Games\\Satori.worktrees\\copilot-worktree-1", true);
    const report = generateScanHtmlReport([session], [scoreSession(session)], {
      filesScanned: 1,
      eventsParsed: 2,
      parseErrors: 0,
      generatedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(report).toContain("<!doctype html>");
    expect(report).toContain("Session Inefficiency Report");
    expect(report).toContain("Top Suspicious Sessions");
    expect(report).toContain("copilot-worktree-1");
    expect(report).toContain("C:\\Repo\\Personal\\Games\\Satori.worktrees\\copilot-worktree-1");
  });
});
