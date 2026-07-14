import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";
import { applyRepoFilter } from "../src/normalize/repoFilter.js";
import { generateScanHtmlReport } from "../src/reports/html.js";
import { generateScanReport } from "../src/reports/markdown.js";
import { scoreSession } from "../src/scoring/score.js";

describe("scan report", () => {
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
