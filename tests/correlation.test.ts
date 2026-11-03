import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { correlateSession, correlateTraceDirectory, evaluationIdentity, taskRecordsSchema, type SessionObservations } from "../src/correlation/index.js";
import { parseSessionFile } from "../src/normalize/parser.js";
const trace = path.resolve("tests/fixtures/claude-streaming.jsonl");
const taskFile = path.resolve("tests/fixtures/correlation-tasks.json");
const records = () => taskRecordsSchema.parse(JSON.parse(fs.readFileSync(taskFile, "utf8")));
const session = () => parseSessionFile(trace, "claude").session;
const observed = (extra: Partial<SessionObservations> = {}): SessionObservations => ({ branches: [], worktreePaths: [], ...extra });

describe("verifiable Firstmate correlation", () => {
  it("accepts a unique identity plus overlapping time, preserving task and attempt separately", () => {
    const result = correlateSession(session(), records());
    expect(result.status).toBe("matched");
    expect(result.confidence).toBe("high");
    expect(result.taskId).toBe("fictional-nebula");
    expect(result.attemptId).toBe("fictional-nebula-attempt-a");
    expect(result.candidates[0].evidence).toEqual(["branch", "worktree_path", "first_instruction_task", "time_overlap"]);
    const identity = evaluationIdentity(result, "fictional-correlation-ref");
    expect(identity.attemptId).toEqual({ availability: "known", value: result.attemptId, refs: ["fictional-correlation-ref"] });
    expect(identity.model.availability).toBe("unknown");
  });
  it("returns ambiguous for overlapping retries rather than ranking a winner", () => {
    const tasks = records(); tasks.push({ ...tasks[0], attemptId: "fictional-nebula-attempt-b", spawnGeneration: "fictional-generation-b" });
    const result = correlateSession(session(), tasks);
    expect(result.status).toBe("ambiguous"); expect(result.attemptId).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(evaluationIdentity(result, "fictional-ref").attemptId.availability).toBe("unknown");
  });
  it("leaves unrelated, nonoverlapping and contradictory sessions unmatched", () => {
    expect(correlateSession(session(), records(), observed()).status).toBe("unmatched");
    expect(correlateSession({ ...session(), startedAt: "2026-01-02T10:00:00Z", endedAt: "2026-01-02T10:01:00Z" }, records()).status).toBe("unmatched");
    expect(correlateSession(session(), records(), observed({ branches: ["fm/fictional-other"], worktreePaths: ["/fictional/worktrees/nebula"] })).status).toBe("unmatched");
    expect(correlateSession(session(), records().map(record => ({ ...record, harness: "codex" }))).status).toBe("unmatched");
  });
  it("rejects contradictory task anchors even when branch and path agree", () => {
    const item = session();
    item.attribution!.firstInstruction = { text: "Task id: fictional-other" };
    expect(correlateSession(item, records()).status).toBe("unmatched");
  });
  it("reports path/time alone, missing attempt identity and incomplete times as ambiguous", () => {
    const result = correlateSession(session(), records(), observed({ worktreePaths: ["/fictional/worktrees/nebula/"] }));
    expect(result.status).toBe("ambiguous"); expect(result.reasons).toContain("task_identity_unverified");
    expect(correlateSession(session(), records().map(record => ({ ...record, attemptId: null }))).status).toBe("ambiguous");
    expect(correlateSession(session(), records().map(record => ({ ...record, endedAt: null }))).status).toBe("ambiguous");
    expect(correlateSession({ ...session(), startedAt: undefined }, records()).status).toBe("ambiguous");
  });
  it("uses explicit first-instruction task/inbox anchors with exact token boundaries", () => {
    expect(correlateSession(session(), records(), observed({ firstInstruction: "Task id: fictional-nebula" })).status).toBe("matched");
    expect(correlateSession(session(), records(), observed({ firstInstruction: "Inbox: '/fictional/state/fictional-nebula.inbox'" })).status).toBe("matched");
    expect(correlateSession(session(), records(), observed({ firstInstruction: "Task id: fictional-nebula-extra" })).status).toBe("unmatched");
    expect(correlateSession(session(), records(), observed({ firstInstruction: "Discuss fictional-nebula in a report." })).status).toBe("unmatched");
  });
  it("deduplicates repeated records without collapsing conflicting provenance or generations", () => {
    const task = records()[0];
    expect(correlateSession(session(), [task, structuredClone(task)]).status).toBe("matched");
    expect(correlateSession(session(), [task, { ...task, spawnGeneration: "fictional-other-generation" }]).status).toBe("ambiguous");
  });
  it("supports multiple sessions for one attempt without duplicating sessions or accepted outcomes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-correlation-"));
    try {
      fs.copyFileSync(trace, path.join(directory, "a.jsonl"));
      fs.copyFileSync(trace, path.join(directory, "a-copy.jsonl"));
      fs.copyFileSync(path.resolve("tests/fixtures/claude-usage-missing.jsonl"), path.join(directory, "b.jsonl"));
      const result = correlateTraceDirectory(directory, taskFile);
      expect(result.correlations).toHaveLength(2);
      expect(result.correlations.map(item => item.attemptId)).toEqual(["fictional-nebula-attempt-a", "fictional-nebula-attempt-a"]);
      fs.appendFileSync(path.join(directory, "a-copy.jsonl"), "\n");
      expect(correlateTraceDirectory(directory, taskFile).correlations[0].reasons).toEqual(["conflicting_session_copies"]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("uses Codex headers and Copilot normalized context without changing their adapters", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-native-"));
    try {
      const task = records()[0];
      const tasks = path.join(directory, "tasks.json");
      fs.writeFileSync(tasks, JSON.stringify([{ ...task, harness: "codex" }, { ...task, harness: "copilot" }]));
      const logs = path.join(directory, "logs"); fs.mkdirSync(logs);
      const stamp = "2026-01-01T10:00:00Z";
      fs.writeFileSync(path.join(logs, "codex.jsonl"), [
        { type: "session_meta", timestamp: stamp, payload: { id: "synthetic-codex", cwd: task.worktreePath, git: { branch: task.branchName } } },
        { type: "turn_context", timestamp: stamp, payload: { turn_id: "synthetic-turn", cwd: task.worktreePath } }
      ].map(row => JSON.stringify(row)).join("\n"));
      fs.writeFileSync(path.join(logs, "copilot.jsonl"), [
        { id: "synthetic-start", type: "assistant.turn_start", timestamp: stamp, data: { turnId: "synthetic-turn" } },
        { id: "synthetic-user", type: "user.message", timestamp: stamp, data: { content: "Task id: fictional-nebula", turnId: "synthetic-turn" } },
        { id: "synthetic-hook", type: "hook.start", timestamp: stamp, data: { hookInvocationId: "synthetic-hook", input: { sessionId: "synthetic-copilot", cwd: task.worktreePath }, turnId: "synthetic-turn" } }
      ].map(row => JSON.stringify(row)).join("\n"));
      const results = correlateTraceDirectory(logs, tasks).correlations;
      expect(results).toHaveLength(2);
      expect(results.map(result => result.status)).toEqual(["matched", "matched"]);
      expect(results.map(result => result.source)).toEqual(["codex", "copilot"]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects invalid caller records and reversed attempt windows", () => {
    expect(() => taskRecordsSchema.parse([{ taskId: "fictional" }])).toThrow();
    expect(() => taskRecordsSchema.parse(records().map(record => ({ ...record, endedAt: "2025-01-01T00:00:00Z" })))).toThrow();
  });
  it("runs the local CLI with explicit input/output and emits no prompt content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-cli-"));
    try {
      const out = path.join(directory, "correlations.json");
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
      const dist = path.join(directory, "dist");
      fs.symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "junction");
      execFileSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", path.resolve("tsconfig.json"), "--outDir", dist]);
      const stdout = execFileSync(process.execPath, [path.join(dist, "cli.js"), "correlate", "--logs", trace, "--tasks", taskFile, "--out", out], { encoding: "utf8" });
      const result = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(result.schema).toBe("sessionCorrelation/1");
      expect(result.correlations[0].status).toBe("matched");
      expect(stdout).toContain("Correlated 1 session(s)");
      expect(fs.readFileSync(out, "utf8")).not.toContain("Build a fictional star map");
      expect(result.taskRecordsDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
