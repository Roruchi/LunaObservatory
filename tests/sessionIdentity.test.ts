import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSessionParser } from "../src/normalize/parser.js";
import { correlateSession, correlateTraceDirectory, evaluationIdentity, taskRecordsSchema } from "../src/correlation/index.js";

const fixture = path.resolve("tests/fixtures/claude-streaming.jsonl");
const taskFile = path.resolve("tests/fixtures/correlation-tasks.json");
const tasks = taskRecordsSchema.parse(JSON.parse(fs.readFileSync(taskFile, "utf8")));
const rows = () => fs.readFileSync(fixture, "utf8").trim().split("\n").map(line => JSON.parse(line));
const directory = fs.mkdtempSync(path.resolve("tests/.session-identity-"));
const dist = path.join(directory, "dist");
const write = (file: string, data: unknown[]) => fs.writeFileSync(file, data.map(row => JSON.stringify(row)).join("\n"));

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", path.resolve("tsconfig.json"), "--outDir", dist]);
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function scan(logs: string, out: string) {
  const stdout = execFileSync(process.execPath, [path.join(dist, "cli.js"), "scan", "--source", "claude", "--logs", logs, "--all-repos", "--out", out], { encoding: "utf8" });
  const read = (name: string) => fs.readFileSync(path.join(out, "index", name), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { stdout, sessions: read("sessions.jsonl"), scores: read("inefficiency-scores.jsonl"), decisions: JSON.parse(fs.readFileSync(path.join(out, "index", "repo-filter.json"), "utf8")) };
}

describe("session identity boundaries", () => {
  it("writes and scores an identical Claude session only once", () => {
    const logs = path.join(directory, "identical"); fs.mkdirSync(logs);
    for (const name of ["a", "b"]) fs.copyFileSync(fixture, path.join(logs, `${name}.jsonl`));
    const result = scan(logs, path.join(directory, "identical-out"));
    expect(result.sessions).toHaveLength(1);
    expect(result.scores).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.stdout).toContain("Sessions found: 1");
    expect(result.sessions[0].metrics.inputTokens.value).toBe(10);
    expect(result.sessions[0].sourceFiles).toHaveLength(2);
    expect(result.sessions[0].attribution.unknowns).not.toContain("conflicting_session_copies");
  });
  it("retains additional requests in conflicting copies without duplicating a session", () => {
    const logs = path.join(directory, "conflicting"); fs.mkdirSync(logs);
    const a = path.join(logs, "a.jsonl"); const b = path.join(logs, "b.jsonl");
    fs.copyFileSync(fixture, a);
    const extra = { ...rows().at(-1), type: "assistant", uuid: "fictional-extra", requestId: "fictional-extra-request", timestamp: "2026-01-01T10:00:09Z", message: { id: "fictional-extra-message", model: "fictional-model", content: [{ type: "text", text: "Fictional extra answer." }], usage: { input_tokens: 2, output_tokens: 2 } } };
    write(b, [...rows(), extra]);
    const result = scan(logs, path.join(directory, "conflicting-out"));
    expect(result.sessions).toHaveLength(1);
    expect(result.scores).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.metrics.inputTokens.value).toBe(12);
    expect(session.metrics.modelRequests).toBe(3);
    expect(session.attribution.unknowns).toContain("conflicting_session_copies");
    expect(session.finalAnswer.evidence[0]).toMatchObject({ sourceFile: b, lineNumber: rows().length + 1 });
    const parser = createSessionParser([b, a].map(file => ({ file, source: "claude" as const })));
    expect(parser(a, "claude").session).toEqual(parser(b, "claude").session);
    expect(correlateSession(parser(a, "claude").session, tasks).status).toBe("ambiguous");
    const correlation = correlateTraceDirectory(logs, taskFile, "claude").correlations;
    expect(correlation).toHaveLength(1);
    expect(correlation[0].reasons).toEqual(["conflicting_session_copies"]);
  });
  it("keeps missing native identity unknown with and without task candidates", () => {
    const file = path.join(directory, "missing.jsonl");
    write(file, rows().map(({ sessionId, ...row }) => row));
    const session = createSessionParser([{ file, source: "claude" }])(file, "claude").session;
    for (const records of [tasks, []]) {
      const result = correlateSession(session, records);
      expect(result.status).toBe(records.length ? "ambiguous" : "unmatched");
      expect(result.taskId).toBeNull(); expect(result.attemptId).toBeNull();
      expect(result.nativeIdentityUnknowns).toEqual(["session_id_missing"]);
      expect(evaluationIdentity(result, "fictional-ref").sessionId).toEqual({ availability: "unknown", reason: "session_id_missing" });
    }
    const out = path.join(directory, "correlation.json");
    execFileSync(process.execPath, [path.join(dist, "cli.js"), "correlate", "--source", "claude", "--logs", file, "--tasks", taskFile, "--out", out]);
    const result = JSON.parse(fs.readFileSync(out, "utf8")).correlations[0];
    expect(result.status).toBe("ambiguous");
    expect(result.reasons).toContain("session_id_missing");
    expect(evaluationIdentity(result, "fictional-ref").sessionId.availability).toBe("unknown");
  });
});
