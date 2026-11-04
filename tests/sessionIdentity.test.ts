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
  it("filters nested Windows working directories through the CLI", () => {
    const root = path.join(directory, "windows-repo-filter");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const logs = path.join(root, "session.jsonl");
    const repo = "C:\\Repo\\Personal\\LunaObservatory";
    write(logs, rows().map(row => ({ ...row, cwd: `${repo}\\src` })));
    const out = path.join(root, "out");
    const stdout = execFileSync(process.execPath, [path.join(dist, "cli.js"), "scan", "--source", "claude", "--logs", logs, "--repo", repo, "--out", out], { cwd: root, encoding: "utf8" });
    const sessions = fs.readFileSync(path.join(out, "index", "sessions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ repoMatch: "matched", repoRoot: repo });
    expect(stdout).toContain("Included sessions: 1");
    expect(stdout).toContain("Excluded sessions: 0");
  });
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
  it.each(["dated", "tied", "undated-use", "undated-result", "interleaved", "undated-instruction-answer", "reversed-time"].flatMap(mode => [false, true].map(partial => ({ mode, partial }))))("orders overlapping copies before extracting evidence ($mode, partial: $partial)", ({ mode, partial }) => {
    const tied = mode === "tied";
    const logs = path.join(directory, `chronology-${mode}-${partial}`); fs.mkdirSync(logs);
    const base = { sessionId: "fictional-chronology", cwd: "/fictional/repo", gitBranch: "fm/fictional-nebula" };
    const history = [0, 1].flatMap(index => {
      const stamp = (offset: number) => `2026-01-01T10:00:0${tied ? 0 : index * 4 + offset}Z`;
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
    const undated = mode === "undated-use" ? ["edit", "tool-0", "tool-1"] :
      mode === "undated-result" ? ["edit-result", "result-0", "result-1"] :
      mode === "interleaved" ? ["user-0", "tool-0", "answer-0", "result-1"] :
      mode === "undated-instruction-answer" ? ["user-0", "answer-1"] : [];
    const records = history.map((row, index) => ({ ...row, timestamp: undated.includes(row.uuid) ? undefined : mode === "reversed-time" ? `2026-01-01T10:00:${String(30 - index).padStart(2, "0")}Z` : row.timestamp }));
    const suffix = path.join(logs, "a.jsonl"); const complete = path.join(logs, "b.jsonl");
    write(suffix, records.slice(2));
    write(complete, partial ? records.slice(0, 6) : records);
    if (tied) {
      fs.appendFileSync(complete, `\n${JSON.stringify(records[1])}`);
    }
    for (const files of [[suffix, complete], [complete, suffix]]) {
      const session = createSessionParser(files.map(file => ({ file, source: "claude" })))(suffix, "claude").session;
      expect(session.userIntent?.text).toBe("First instruction");
      expect(session.finalAnswer?.text).toBe("Final answer");
      expect(session.turns.map(turn => turn.userMessages?.[0].text)).toEqual(["First instruction", "Later instruction"]);
      expect(session.turns.flatMap(turn => turn.toolCalls).map(tool => tool.exitCode)).toEqual([0, 1, 0]);
      const tools = session.turns.flatMap(turn => turn.toolCalls);
      expect(tools.map(tool => tool.name)).toEqual(["Edit", "Bash", "Bash"]);
      expect(tools[0].arguments).toMatchObject({ file_path: "/fictional/repo/app.ts", path: "/fictional/repo/app.ts" });
      expect(tools[0].evidence).toContainEqual(expect.objectContaining({ sourceFile: complete, lineNumber: 2, fieldPath: "message.content.tool_use" }));
      expect(tools[1].arguments).toEqual({ command: "npm test" });
      expect(tools[1].evidence).toContainEqual(expect.objectContaining({ fieldPath: "message.content.tool_use" }));
      expect(session.metrics.editCalls).toBe(1);
      expect(session.metrics.toolRequests).toBe(3);
      expect(session.metrics.verificationEvents).toBe(2);
      expect(session.metrics.verificationPassed).toBe(1);
      expect(session.metrics.verificationFailed).toBe(1);
      expect(session.metrics.verificationClosure).toBe("passed");
      expect(session.attribution?.unknowns).not.toContain("orphan_tool_result");
      if (mode === "dated" || tied) expect(session.turns.map(turn => turn.startedAt)).toEqual(["2026-01-01T10:00:00.000Z", tied ? "2026-01-01T10:00:00.000Z" : "2026-01-01T10:00:04.000Z"]);
      if (undated.length) expect(session.attribution?.unknowns).toContain("timestamp_missing_or_invalid");
    }
  });
  it("uses timestamps to order records without a recorded relative order", () => {
    const files = [2, 1].map((second, index) => {
      const file = path.join(directory, `unconstrained-${index}.jsonl`);
      write(file, [{ type: "assistant", sessionId: "fictional-unconstrained", uuid: `answer-${second}`, requestId: `request-${second}`, timestamp: `2026-01-01T10:00:0${second}Z`, message: { id: `message-${second}`, content: [{ type: "text", text: `Answer ${second}` }] } }]);
      return file;
    });
    for (const order of [files, [...files].reverse()]) {
      const session = createSessionParser(order.map(file => ({ file, source: "claude" })))(files[0], "claude").session;
      expect(session.turns.flatMap(turn => turn.assistantMessages).map(message => message.text)).toEqual(["Answer 1", "Answer 2"]);
      expect(session.finalAnswer?.text).toBe("Answer 2");
    }
  });
  it("reconciles 50,000 synthetic records with an overlapping suffix", () => {
    const count = 50_000;
    const records = Array.from({ length: count }, (_, index) => ({
      type: "assistant", sessionId: "fictional-large-overlap", uuid: `large-event-${index}`, requestId: `large-request-${index}`,
      timestamp: "2026-01-01T10:00:00Z",
      message: { id: `large-message-${index}`, model: "fictional-model", content: [{ type: "text", text: `Answer ${index}` }], usage: { input_tokens: 1, output_tokens: 1 } }
    }));
    const suffix = path.join(directory, "large-a.jsonl"); const complete = path.join(directory, "large-b.jsonl");
    write(suffix, records.slice(count / 2)); write(complete, records);
    const start = performance.now();
    const session = createSessionParser([suffix, complete].map(file => ({ file, source: "claude" })))(suffix, "claude").session;
    const elapsed = performance.now() - start;
    expect(session.metrics.modelRequests).toBe(count);
    expect(session.metrics.inputTokens.value).toBe(count);
    expect(session.metrics.outputTokens.value).toBe(count);
    expect(session.turns.flatMap(turn => turn.assistantMessages).map(message => message.messageId)).toEqual(records.map(row => row.message.id));
    expect(session.finalAnswer?.text).toBe(`Answer ${count - 1}`);
    expect(session.nativeSessionId).toBe("fictional-large-overlap");
    console.log(`Synthetic overlapping transcript: ${count} records in ${Math.round(elapsed)}ms`);
  }, 20_000);
  it("selects the earliest eligible rank as overlapping chains become ready", () => {
    const chains = [[6, 0, 4], [3, 1], [7, 2], [5, 8]];
    const files = chains.map((chain, index) => {
      const file = path.join(directory, `ready-${index}.jsonl`);
      write(file, chain.map(value => ({ type: "assistant", sessionId: "fictional-ready", uuid: `ready-${value}`, requestId: `ready-request-${value}`, timestamp: `2026-01-01T10:00:0${value}Z`, message: { id: `ready-message-${value}`, content: [{ type: "text", text: `Answer ${value}` }] } })));
      return file;
    });
    for (const order of [files, [...files].reverse()]) {
      const session = createSessionParser(order.map(file => ({ file, source: "claude" })))(files[0], "claude").session;
      expect(session.turns.flatMap(turn => turn.assistantMessages).map(message => message.text)).toEqual([3, 1, 5, 6, 0, 4, 7, 2, 8].map(value => `Answer ${value}`));
    }
  });
  it("retains deterministic cycle fallback and resumes eligible ordering", () => {
    const records = [0, 1, 2, 3].map(index => ({ type: "assistant", sessionId: "fictional-cycle", uuid: `cycle-${index}`, requestId: `cycle-request-${index}`, timestamp: `2026-01-01T10:00:0${index}Z`, message: { id: `cycle-message-${index}`, content: [{ type: "text", text: `Answer ${index}` }] } }));
    const a = path.join(directory, "cycle-a.jsonl"); const b = path.join(directory, "cycle-b.jsonl");
    write(a, records); write(b, [records[2], records[1]]);
    for (const files of [[a, b], [b, a]]) {
      const session = createSessionParser(files.map(file => ({ file, source: "claude" })))(a, "claude").session;
      expect(session.turns.flatMap(turn => turn.assistantMessages).map(message => message.text)).toEqual(["Answer 0", "Answer 1", "Answer 2", "Answer 3"]);
      expect(session.metrics.modelRequests).toBe(4);
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
