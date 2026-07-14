import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";
import { applyRepoFilter, canonicalizeObservedRepoRoots } from "../src/normalize/repoFilter.js";
import type { NormalizedSession } from "../src/normalize/types.js";
import { repositoryRootForPath } from "../src/utils/pathMatch.js";

const fixture = path.resolve("tests/fixtures/copilot-events.jsonl");

describe("repo filter", () => {
  it("includes sessions where hook cwd is inside repo", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    const decision = applyRepoFilter(session, "C:\\Repo\\Personal\\LunaObservatory");
    expect(decision.repoMatch).toBe("matched");
    expect(session.repoMatch).toBe("matched");
  });

  it("does not relabel a no-cwd all-repos session as the scanner repository", () => {
    const session = {
      sessionId: "unknown-repo",
      source: "codex",
      sourceFiles: [],
      repoMatch: "unknown",
      lifecycleStatus: "unknown",
      interactions: [],
      turns: [],
      metrics: {} as NormalizedSession["metrics"]
    } as NormalizedSession;
    const decision = applyRepoFilter(session, path.resolve("."), true);
    expect(decision.repoMatch).toBe("unknown");
    expect(decision.repoRoot).toBeUndefined();
    expect(session.repoRoot).toBeUndefined();
  });

  it("normalizes nested working directories to one repository root", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    session.turns[0].hooks.push({
      hookInvocationId: "nested",
      hookType: "context",
      startedAt: "2026-07-14T00:00:00.000Z",
      cwd: path.resolve("src"),
      toolCallIds: []
    });
    const decision = applyRepoFilter(session, path.resolve("."), true);
    expect(path.resolve(decision.repoRoot ?? "")).toBe(path.resolve("."));
  });

  it("normalizes a linked git worktree to its shared repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-worktree-"));
    const main = path.join(root, "main");
    const worktree = path.join(root, "worktree");
    const nested = path.join(worktree, "src");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "worktree"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "worktree")}\n`, "utf8");
    expect(repositoryRootForPath(nested)).toBe(path.resolve(main));
  });

  it("maps deleted Codex worktrees to an unambiguous durable repository from the same scan", () => {
    const durable = parseSessionFile(path.resolve("tests/fixtures/codex-events.jsonl"), "codex").session;
    const stale = parseSessionFile(path.resolve("tests/fixtures/codex-events.jsonl"), "codex").session;
    durable.repoRoot = "C:\\Repo\\Personal\\Games\\Satori";
    stale.repoRoot = "C:\\Users\\tester\\.codex\\worktrees\\a1b2\\Satori";

    canonicalizeObservedRepoRoots([durable, stale]);

    expect(stale.repoRoot).toBe(durable.repoRoot);
  });

  it("does not guess when two durable roots share a repository name", () => {
    const first = parseSessionFile(path.resolve("tests/fixtures/codex-events.jsonl"), "codex").session;
    const second = parseSessionFile(path.resolve("tests/fixtures/codex-events.jsonl"), "codex").session;
    const stale = parseSessionFile(path.resolve("tests/fixtures/codex-events.jsonl"), "codex").session;
    first.repoRoot = "C:\\Repo\\One\\Satori";
    second.repoRoot = "D:\\Repo\\Two\\Satori";
    stale.repoRoot = "C:\\Users\\tester\\.codex\\worktrees\\a1b2\\Satori";

    canonicalizeObservedRepoRoots([first, second, stale]);

    expect(stale.repoRoot).toBe("C:\\Users\\tester\\.codex\\worktrees\\a1b2\\Satori");
  });
});
