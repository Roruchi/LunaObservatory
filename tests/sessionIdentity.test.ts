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
  it("orders a later suffix and a complete copy chronologically before extracting evidence", () => {
    const logs = path.join(directory, "chronology"); fs.mkdirSync(logs);
    const base = { sessionId: "fictional-chronology", cwd: "/fictional/repo", gitBranch: "fm/fictional-nebula" };
    const history = [0, 1].flatMap(index => {
      const stamp = (offset: number) => `2026-01-01T10:00:0${index * 4 + offset}Z`;
      return [
        { ...base, type: "user", uuid: `user-${index}`, timestamp: stamp(0), message: { content: index ? "Later instruction" : "First instruction" } },
        ...(index ? [] : [
          { ...base, type: "assistant", uuid: "edit", requestId: "edit-request", timestamp: stamp(0), message: { id: "edit-message", content: [{ type: "tool_use", id: "edit-tool", name: "Edit", input: { file_path: "/fictional/repo/app.ts" } }] } },
          { ...base, type: "user", uuid: "edit-result", timestamp: stamp(0), toolUseResult: { exitCode: 0 }, message: { content: [{ type: "tool_result", tool_use_id: "edit-tool", content: "Fictional edit", is_error: false }] } }
        ]),
        { ...base, type: "assistant", uuid: `tool-${index}`, requestId: `request-tool-${index}`, timestamp: stamp(1), message: { id: `message-tool-${index}`, content: [{ type: "tool_use", id: `check-${index}`, name: "Bash", input: { command: "npm test" } }] } },
        { ...base, type: "user", uuid: `result-${index}`, timestamp: stamp(2), toolUseResult: { exitCode: index ? 0 : 1 }, message: { content: [{ type: "tool_result", tool_use_id: `check-${index}`, content: "Fictional check", is_error: !index }] } },
        { ...base, type: "assistant", uuid: `answer-${index}`, requestId: `request-answer-${index}`, timestamp: stamp(3), message: { id: `message-answer-${index}`, content: [{ type: "text", text: index ? "Final answer" : "Earlier answer" }] } }
      ];
    });
    const suffix = path.join(logs, "a.jsonl"); const complete = path.join(logs, "b.jsonl");
    write(suffix, history.slice(6)); write(complete, history);
    for (const files of [[suffix, complete], [complete, suffix]]) {
      const session = createSessionParser(files.map(file => ({ file, source: "claude" })))(suffix, "claude").session;
      expect(session.userIntent?.text).toBe("First instruction");
      expect(session.finalAnswer?.text).toBe("Final answer");
      expect(session.turns.map(turn => turn.userMessages?.[0].text)).toEqual(["First instruction", "Later instruction"]);
      expect(session.turns.flatMap(turn => turn.toolCalls).map(tool => tool.exitCode)).toEqual([0, 1, 0]);
      expect(session.metrics.verificationClosure).toBe("passed");
      expect(session.turns.map(turn => turn.startedAt)).toEqual(["2026-01-01T10:00:00.000Z", "2026-01-01T10:00:04.000Z"]);
    }
  });
  it("keeps unidentified observations at the same line in different copies separate", () => {
    const files = [4, 6].map((value, index) => {
      const file = path.join(directory, `unidentified-${index}.jsonl`);
      write(file, [{ type: "assistant", sessionId: "fictional-unidentified", timestamp: "2026-01-01T10:00:00Z", message: { content: [], usage: { input_tokens: value, output_tokens: value, cache_read_input_tokens: value, cache_creation_input_tokens: value } } }]);
      return file;
    });
    const session = createSessionParser(files.map(file => ({ file, source: "claude" })))(files[0], "claude").session;
    expect(session.metrics.modelRequests).toBe(2);
    for (const field of ["inputTokens", "outputTokens", "cachedTokens"] as const) expect(session.metrics[field].value).toBe(10);
    expect(session.turns.flatMap(turn => turn.assistantMessages).map(message => message.cacheCreationTokens?.value)).toEqual([4, 6]);
    expect(session.attribution?.usageCoverage).toBe("partial");
  });
  it.each(["claude", "codex", "copilot"] as const)("keeps missing %s native identity unknown with and without candidates", harness => {
    const file = path.join(directory, `missing-${harness}.jsonl`);
    const timestamp = "2026-01-01T10:00:00Z";
    const data = harness === "claude" ? rows().map(({ sessionId, ...row }) => row) : harness === "codex" ? [
      { type: "session_meta", timestamp, payload: { cwd: tasks[0].worktreePath, git: { branch: tasks[0].branchName } } },
      { type: "turn_context", timestamp, payload: { turn_id: "fictional-turn", cwd: tasks[0].worktreePath } }
    ] : [
      { type: "assistant.turn_start", timestamp, data: { turnId: "fictional-turn" } },
      { type: "user.message", timestamp, data: { content: "Task id: fictional-nebula", turnId: "fictional-turn" } },
      { type: "hook.start", timestamp, data: { hookInvocationId: "fictional-hook", input: { cwd: tasks[0].worktreePath }, turnId: "fictional-turn" } },
      { type: "tool.execution_complete", timestamp, data: { id: "fictional-tool-id" } }
    ];
    write(file, data);
    const session = createSessionParser([{ file, source: harness }])(file, harness).session;
    expect(session.nativeSessionId).toBeNull();
    const harnessTasks = tasks.map(task => ({ ...task, harness }));
    for (const records of [harnessTasks, []]) {
      const result = correlateSession(session, records);
      expect(result.status).toBe(records.length ? "ambiguous" : "unmatched");
      expect(result.taskId).toBeNull(); expect(result.attemptId).toBeNull();
      expect(result.nativeIdentityUnknowns).toEqual(["session_id_missing"]);
      expect(evaluationIdentity(result, "fictional-ref").sessionId).toEqual({ availability: "unknown", reason: "session_id_missing" });
    }
    const out = path.join(directory, `correlation-${harness}.json`);
    const harnessTaskFile = path.join(directory, `tasks-${harness}.json`);
    fs.writeFileSync(harnessTaskFile, JSON.stringify(harnessTasks));
    execFileSync(process.execPath, [path.join(dist, "cli.js"), "correlate", "--source", harness, "--logs", file, "--tasks", harnessTaskFile, "--out", out]);
    const result = JSON.parse(fs.readFileSync(out, "utf8")).correlations[0];
    expect(result.status).toBe("ambiguous");
    expect(result.reasons).toContain("session_id_missing");
    expect(evaluationIdentity(result, "fictional-ref").sessionId.availability).toBe("unknown");
  });
});
