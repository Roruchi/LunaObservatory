import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/normalize/parser.js";
import fs from "node:fs";
import { generateWorkerReportCards, reportCardsFromTraces } from "../src/reports/workerReportCard.js";
import { correlateSession, correlateTraceDirectory, type TaskRecord } from "../src/correlation/index.js";
import { calculateMetrics } from "../src/normalize/metrics.js";
import type { NormalizedSession } from "../src/normalize/types.js";
import path from "node:path";

const task: TaskRecord = {
  taskId: "fictional-nebula", attemptId: null, project: "fictional-project", harness: "claude", spawnGeneration: null,
  startedAt: "2026-01-01T09:59:00Z", endedAt: "2026-01-01T10:10:00Z",
  provenance: { uri: "fictional://task", digest: "fictional-digest" }
};

describe("worker report cards", () => {
  it("includes tool-bearing parents separately without promoting diagnostic links to verified attempts", () => {
    const parent = parseSessionFile(path.resolve("tests/fixtures/claude-streaming.jsonl"), "claude").session;
    const childBase: Omit<NormalizedSession, "metrics"> = {
      sessionId: "fictional-child", nativeSessionId: "fictional-child", source: "claude", sourceFiles: [],
      parentSessionId: parent.sessionId, repoMatch: "unknown", lifecycleStatus: "completed", interactions: [],
      startedAt: "2026-01-01T10:00:01Z", endedAt: "2026-01-01T10:01:00Z",
      finalAnswer: { text: "PRIVATE FINAL ANSWER MUST NOT APPEAR" },
      attribution: { branches: [], worktreePaths: [], firstInstruction: { text: "Task id: fictional-nebula" }, unknowns: [] },
      turns: [{ turnId: "one", assistantMessages: [], toolCalls: [], hooks: [] }]
    };
    const child = { ...childBase, metrics: calculateMetrics(childBase) };
    const parentJoin = correlateSession(parent, [task], { branches: [], worktreePaths: [] });
    const childJoin = correlateSession(child, [task]);
    const card = generateWorkerReportCards([parent, child], [task], [parentJoin, childJoin]);
    expect(card.match(/### Worker:/g)).toHaveLength(2);
    expect(card).toContain("native parent link only; task/attempt unverified");
    expect(card).toContain("no tool evidence; absence of flags does not establish efficiency");
    expect(card).toContain("unknown (not verified)");
    expect(card).toContain("unmatched; confidence none");
    expect(card).toContain("1 recognized operations; 1 recorded successes");
    expect(card).not.toContain("PRIVATE FINAL ANSWER");
    expect(card).not.toContain("npm test");
    expect(card).not.toContain("Updated fictional file");
    expect(card).not.toContain("65");
  });

  it("retains tasks with no session and never presents missing evidence as zero quality", () => {
    const card = generateWorkerReportCards([], [task], []);
    expect(card).toContain("Task: fictional-nebula");
    expect(card).toContain("no compatible worker session found");
    expect(card).toContain("model, duration, tools, verification and outcome unknown");
    expect(card).not.toContain("0/0");
  });
});


it.each(["codex", "copilot"] as const)("uses shared %s identity for default all-source report cards", source => {
  const root = fs.mkdtempSync(path.resolve("tests/.report-identity-"));
  try {
    const logs = path.join(root, "logs");
    fs.mkdirSync(logs);
    const file = path.join(logs, "worker.jsonl");
    fs.copyFileSync(path.resolve(`tests/fixtures/${source}-events.jsonl`), file);
    const session = parseSessionFile(file, "unknown").session;
    expect(session.source).toBe(source);
    if (source === "codex") {
      const stamp = session.startedAt!;
      const child = [
        { type: "session_meta", payload: { id: "fictional-child", parent_thread_id: session.nativeSessionId } },
        { type: "turn_context", payload: { turn_id: "child-turn" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] } }
      ];
      fs.writeFileSync(path.join(logs, "child.jsonl"), child.map(event => JSON.stringify({ ...event, timestamp: stamp })).join("\n"));
    }
    const records = [{ ...task, harness: source, nativeSessionId: source === "codex" ? "fictional-child" : session.nativeSessionId,
      startedAt: session.startedAt!, endedAt: session.endedAt! }];
    const taskFile = path.join(root, "tasks.json");
    fs.writeFileSync(taskFile, JSON.stringify(records));
    const correlation = correlateTraceDirectory(logs, taskFile);
    expect(correlation.correlations).toContainEqual(expect.objectContaining({ source, sessionId: session.sessionId }));
    const report = reportCardsFromTraces(logs, taskFile);
    expect(report).toContain(`### Worker: ${session.nativeSessionId}`);
    expect(report).toContain(`| Harness / model | ${source} /`);
    expect(report).not.toContain("normalized trace unavailable");
    if (source === "codex") {
      expect(report).toContain("### Worker: fictional-child");
      expect(report).toContain("native parent link only; task/attempt unverified");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
