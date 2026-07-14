import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";
import { calculateMetrics } from "../src/normalize/metrics.js";
import type { NormalizedSession, NormalizedToolCall } from "../src/normalize/types.js";

const fixture = path.resolve("tests/fixtures/copilot-events.jsonl");

describe("metrics", () => {
  it("counts file views, unique file views, and repeated file views", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    expect(session.metrics.filesViewed).toBe(2);
    expect(session.metrics.uniqueFilesViewed).toBe(1);
    expect(session.metrics.repeatedFileViews).toBe(1);
  });

  it("does not count requested verification or failed edit attempts as successful state", () => {
    const tools: NormalizedToolCall[] = [
      { toolCallId: "failed-edit", name: "apply_patch", arguments: "patch", status: "failed" },
      { toolCallId: "edit", name: "apply_patch", arguments: "patch", status: "completed" },
      { toolCallId: "test", name: "shell_command", arguments: { command: "npm test", workdir: "C:\\Repo\\A" }, status: "requested" }
    ];
    const base = {
      sessionId: "metrics",
      source: "codex" as const,
      sourceFiles: [],
      repoMatch: "unknown" as const,
      lifecycleStatus: "unknown" as const,
      interactions: [],
      turns: [{ turnId: "turn", assistantMessages: [], toolCalls: tools, hooks: [] }]
    } satisfies Omit<NormalizedSession, "metrics">;
    const metrics = calculateMetrics(base);
    expect(metrics.editAttempts).toBe(2);
    expect(metrics.editCalls).toBe(1);
    expect(metrics.verificationEvents).toBe(1);
    expect(metrics.verificationPassed).toBe(0);
    expect(metrics.verificationClosure).toBe("missing");
  });
});
