import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRepoFilter } from "../src/normalize/repoFilter.js";
import { createSessionParser, parseSessionFile } from "../src/normalize/parser.js";

const fixture = path.resolve("tests/fixtures/claude-streaming.jsonl");
function parseRows(rows: unknown[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-claude-"));
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n"));
  try { return parseSessionFile(file, "claude"); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const native = (type: string, message: unknown, extra = {}) => ({ type, sessionId: "synthetic-session", timestamp: "2026-01-01T10:00:00Z", message, ...extra });

describe("Claude Code native transcripts (fully synthetic)", () => {
  it("deduplicates split streaming usage and tool calls, while retaining edits and verification", () => {
    const { session, parseErrors } = parseSessionFile(fixture, "claude");
    expect(parseErrors).toBe(0);
    expect(session.source).toBe("claude");
    expect(session.sessionId).toBe("synthetic-session-a");
    expect(session.metrics.modelRequests).toBe(2);
    expect(session.metrics.inputTokens.value).toBe(10);
    expect(session.metrics.outputTokens.value).toBe(7);
    expect(session.metrics.cachedTokens.value).toBe(3);
    expect(session.turns[0].assistantMessages[0].cacheCreationTokens?.value).toBe(5);
    expect(session.metrics.toolRequests).toBe(2);
    expect(session.metrics.editCalls).toBe(1);
    expect(session.metrics.changedFiles.value).toBe(1);
    expect(session.metrics.commandCalls).toBe(1);
    expect(applyRepoFilter(session, "/fictional/worktrees/nebula", true).repoRoot).toBe("/fictional/worktrees/nebula");
    expect(session.metrics.verificationPassed).toBe(1);
    expect(session.metrics.verificationClosure).toBe("passed");
    expect(session.turns[0].toolCalls[1].exitCode).toBe(0);
    expect(session.attribution?.firstInstruction?.text).toContain("Task id: fictional-nebula");
    expect(session.attribution?.unknowns).toContain("usage_missing_or_partial");
    expect(session.startedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(session.durationMs).toBe(6000);
  });
  it("autodetects native Claude records in explicit mixed trace directories", () => {
    expect(parseSessionFile(fixture, "unknown").session.metrics).toEqual(parseSessionFile(fixture, "claude").session.metrics);
  });
  it("keeps missing usage unavailable and never infers completion from final prose", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/claude-usage-missing.jsonl"), "claude");
    expect(session.metrics.inputTokens).toEqual({ value: null, source: "unavailable" });
    expect(session.metrics.outputTokens).toEqual({ value: null, source: "unavailable" });
    expect(session.metrics.cachedTokens.value).toBeNull();
    expect(session.lifecycleStatus).toBe("unknown");
    expect(session.finalAnswer?.text).toBe("Fictional checkpoint.");
  });
  it("deduplicates by request id even when message ids differ", () => {
    const { session } = parseRows([1, 2].map(index => native("assistant", { id: `synthetic-${index}`, usage: { output_tokens: 4 }, content: [{ type: "text", text: "Fictional answer." }] }, { requestId: "synthetic-request" })));
    expect(session.metrics.outputTokens.value).toBe(4);
    expect(session.metrics.modelRequests).toBe(1);
    expect(session.turns[0].assistantMessages[0].text).toBe("Fictional answer.");
  });
  it("unions split records when a later record bridges request and message ids", () => {
    const { session } = parseRows([
      native("assistant", { usage: { output_tokens: 4 }, content: [] }, { requestId: "synthetic-request" }),
      native("assistant", { id: "synthetic-message", usage: { output_tokens: 4 }, content: [] }),
      native("assistant", { id: "synthetic-message", usage: { output_tokens: 4 }, content: [] }, { requestId: "synthetic-request" })
    ]);
    expect(session.metrics.outputTokens.value).toBe(4);
    expect(session.metrics.modelRequests).toBe(1);
  });
  it("retains sidechain identity, malformed-line counts and unknown timestamps", () => {
    const { session, parseErrors } = parseRows([
      native("assistant", { id: "synthetic-child", content: [{ type: "text", text: "Fictional child." }] }, { isSidechain: true, agentId: "synthetic-agent", timestamp: undefined }),
      "invalid synthetic JSON"
    ]);
    expect(parseErrors).toBe(1);
    expect(session.attribution?.isSidechain).toBe(true);
    expect(session.attribution?.agentId).toBe("synthetic-agent");
    expect(session.sessionId).toBe("synthetic-session:agent:synthetic-agent");
    expect(session.parentSessionId).toBeUndefined();
    expect(session.startedAt).toBeUndefined();
    expect(session.metrics.outputTokens.value).toBeNull();
    expect(session.attribution?.unknowns).toContain("timestamp_missing_or_invalid");
  });
  it("does not turn an unobserved or background Bash result into a passing check", () => {
    const { session } = parseRows([
      native("assistant", { id: "synthetic-request", content: [{ type: "tool_use", id: "synthetic-tool", name: "Bash", input: { command: "npm test" } }] }),
      native("user", { content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: "Job started." }] }, { toolUseResult: { isBackground: true } })
    ]);
    expect(session.metrics.verificationPassed).toBe(0);
    expect(session.turns[0].toolCalls[0].status).toBe("unknown");
    expect(session.turns[0].toolCalls[0].exitCode).toBeUndefined();
  });
  it("joins failures to the original call across turns and recognizes reported exit codes", () => {
    const { session } = parseRows([
      native("assistant", { id: "synthetic-request", content: [{ type: "tool_use", id: "synthetic-tool", name: "Bash", input: { command: "npm test" } }] }),
      native("user", { content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: "Exit code: 2", is_error: true }] }, { toolUseResult: { exitCode: 2 } })
    ]);
    expect(session.metrics.verificationFailed).toBe(1);
    expect(session.turns[0].toolCalls[0].exitCode).toBe(2);
  });
  it.each([
    { nested: false, rewritten: false, sidechainParent: false },
    { nested: false, rewritten: true, sidechainParent: false },
    { nested: true, rewritten: true, sidechainParent: false },
    { nested: true, rewritten: true, sidechainParent: true }
  ])("attributes corpus history across layouts and agent markers: %j", ({ nested, rewritten, sidechainParent }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-lineage-"));
    const parent = [
      native("user", { content: "Fictional parent instruction." }, { uuid: "parent-user", cwd: "/fictional/parent" }),
      native("assistant", { id: "parent-message", model: "fictional-model", usage: { input_tokens: 10, output_tokens: 10 }, content: [
        { type: "text", text: "Fictional parent answer." },
        { type: "tool_use", id: "parent-tool", name: "Read", input: { file_path: "/fictional/parent.txt" } }
      ] }, { uuid: "parent-event", requestId: "parent-request" }),
      native("user", { content: [{ type: "tool_result", tool_use_id: "parent-tool", content: "Fictional parent data.", is_error: false }] }, { uuid: "parent-result" })
    ].map(row => ({ ...row, sessionId: "a-parent-session", ...(sidechainParent ? { isSidechain: true, agentId: "fictional-parent-agent" } : {}) }));
    try {
      const parentFile = path.join(directory, "parent.jsonl");
      const childFile = path.join(directory, nested ? "parent/subagents/renamed-child.jsonl" : "renamed-child.jsonl");
      fs.mkdirSync(path.dirname(childFile), { recursive: true });
      const own = [
        native("user", { content: "Fictional child instruction." }, { uuid: "child-user", parentUuid: "parent-result", cwd: "/fictional/child" }),
        native("assistant", { id: "child-message", model: "fictional-model", usage: { input_tokens: 2, output_tokens: 2 }, content: [{ type: "text", text: "Fictional child answer." }] }, { uuid: "child-event", parentUuid: "child-user" })
      ].map(row => ({ ...row, sessionId: "z-renamed-session", isSidechain: true, agentId: "fictional-agent" }));
      fs.writeFileSync(parentFile, parent.map(row => JSON.stringify(row)).join("\n"));
      const copied = parent.map(row => rewritten ? { ...row, sessionId: "z-renamed-session", isSidechain: true, agentId: "fictional-agent" } : row);
      fs.writeFileSync(childFile, [...copied, ...own].map(row => JSON.stringify(row)).join("\n"));
      const files = [childFile, parentFile];
      const read = vi.spyOn(fs, "readFileSync");
      let parse: ReturnType<typeof createSessionParser>;
      try {
        parse = createSessionParser(files.map(file => ({ file, source: "unknown" })));
        const child = parse(childFile, "unknown").session;
        expect(child.metrics.outputTokens.value).toBe(2);
        for (const file of files) expect(read.mock.calls.filter(args => args[0] === file)).toHaveLength(1);
      } finally { read.mockRestore(); }
      const child = parse!(childFile, "unknown").session;
      const original = parse!(parentFile, "unknown").session;
      expect(child.parentSessionId).toBeUndefined();
      expect(child.metrics.inputTokens.value).toBe(2);
      expect(child.metrics.outputTokens.value! + original.metrics.outputTokens.value!).toBe(12);
      expect(child.metrics.toolRequests).toBe(0);
      expect(child.turns).toHaveLength(1);
      expect(child.userIntent?.text).toBe("Fictional child instruction.");
      expect(child.attribution?.worktreePaths).toEqual(["/fictional/child"]);
      expect(child.attribution?.historyCoverage).toBe("partial");
      expect(child.attribution?.usageCoverage).toBe("partial");
      expect(child.attribution?.inheritedEvents).toBe(3);
      const alone = parseSessionFile(childFile, "claude").session;
      expect(alone.attribution?.historyCoverage).toBe("partial");
      expect(alone.attribution?.usageCoverage).toBe("partial");
      expect(alone.attribution?.unknowns).toContain("history_lineage_unknown");
      expect(alone.attribution?.unresolvedInheritedEvents).toBeNull();
      expect(alone.metrics.outputTokens.value).toBe(12);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("recognizes inherited message/request ids without event UUIDs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-message-lineage-"));
    try {
      const inherited = native("assistant", { id: "fictional-parent-message", usage: { output_tokens: 10 }, content: [] }, { requestId: "fictional-parent-request" });
      const own = native("assistant", { id: "fictional-own-message", usage: { output_tokens: 2 }, content: [] }, { sessionId: "z-fictional-child", isSidechain: true, agentId: "fictional-agent" });
      fs.writeFileSync(path.join(directory, "parent.jsonl"), JSON.stringify(inherited));
      const file = path.join(directory, "child.jsonl");
      fs.writeFileSync(file, [ { ...inherited, sessionId: "z-fictional-child", isSidechain: true, agentId: "fictional-agent" }, own ].map(row => JSON.stringify(row)).join("\n"));
      const parse = createSessionParser([file, path.join(directory, "parent.jsonl")].map(file => ({ file, source: "claude" })));
      expect(parse(file, "claude").session.metrics.outputTokens.value).toBe(2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([false, true])("retains measured totals when a parent continues after a fork, nested: %s", nested => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-fork-"));
    try {
      const parentFile = path.join(directory, "z-parent.jsonl");
      const childFile = path.join(directory, nested ? "parent/subagents/a-child.jsonl" : "a-child.jsonl");
      fs.mkdirSync(path.dirname(childFile), { recursive: true });
      const shared = [
        native("user", { content: "Fictional parent instruction." }, { uuid: "fork-user" }),
        native("assistant", { id: "fork-request", usage: { input_tokens: 10, output_tokens: 10 }, content: [] }, { uuid: "fork-answer", parentUuid: "fork-user" }),
        native("user", { content: "Fictional fork boundary." }, { uuid: "fork-boundary", parentUuid: "fork-answer" })
      ];
      fs.writeFileSync(parentFile, [...shared, native("user", { content: "Fictional parent continuation." }, { uuid: "fork-later", parentUuid: "fork-boundary", timestamp: "2026-01-01T10:02:00Z" })].map(row => JSON.stringify(row)).join("\n"));
      const copied = shared.map(row => ({ ...row, isSidechain: true, agentId: "fictional-child-agent" }));
      const own = native("assistant", { id: "fork-own-request", usage: { input_tokens: 2, output_tokens: 2 }, content: [] }, { uuid: "fork-own", parentUuid: "fork-boundary", isSidechain: true, agentId: "fictional-child-agent", timestamp: "2026-01-01T10:01:00Z" });
      fs.writeFileSync(childFile, [...copied, own].map(row => JSON.stringify(row)).join("\n"));
      const parse = createSessionParser([childFile, parentFile].map(file => ({ file, source: "claude" })));
      const parent = parse(parentFile, "claude").session;
      const child = parse(childFile, "claude").session;
      expect(parent.metrics.inputTokens.value).toBe(10);
      expect(child.metrics.inputTokens.value).toBe(2);
      expect(parent.metrics.outputTokens.value! + child.metrics.outputTokens.value!).toBe(12);
      expect(child.attribution?.inheritedEvents).toBe(3);
      expect(child.attribution?.historyCoverage).toBe("partial");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps shared usage when lexical ownership differs from native lineage", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-allocation-"));
    try {
      const parentFile = path.join(directory, "parent.jsonl");
      const childFile = path.join(directory, "child.jsonl");
      const shared = native("assistant", { id: "fictional-shared", usage: { output_tokens: 10 }, content: [] }, { uuid: "shared-event", sessionId: "z-parent" });
      fs.writeFileSync(parentFile, JSON.stringify(shared));
      fs.writeFileSync(childFile, [
        { ...shared, sessionId: "a-child", isSidechain: true, agentId: "fictional-agent" },
        native("assistant", { id: "fictional-own", usage: { output_tokens: 2 }, content: [] }, { uuid: "own-event", sessionId: "a-child", isSidechain: true, agentId: "fictional-agent" })
      ].map(row => JSON.stringify(row)).join("\n"));
      const parse = createSessionParser([parentFile, childFile].map(file => ({ file, source: "claude" })));
      const parent = parse(parentFile, "claude").session;
      const child = parse(childFile, "claude").session;
      expect(parent.metrics.outputTokens.value).toBeNull();
      expect(child.metrics.outputTokens.value).toBe(12);
      expect(parent.attribution?.inheritedEvents).toBe(1);
      expect(parent.attribution?.historyCoverage).toBe("partial");
      expect(child.attribution?.notes).toContain("Event ownership uses event timestamp, transcript first-event time, then transcript ID; allocation of shared history can differ from native lineage, including when a parent continues after a fork.");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([true, false])("deduplicates repeated users and tool events with UUIDs: %s", uuid => {
    const rows = [
      native("user", { id: "fictional-user", content: "Fictional instruction." }, uuid ? { uuid: "user-event" } : {}),
      native("assistant", { id: "fictional-request", content: [{ type: "tool_use", id: "fictional-tool", name: "Read", input: {} }] }, uuid ? { uuid: "tool-event" } : {}),
      native("user", { id: "fictional-result", content: [{ type: "tool_result", tool_use_id: "fictional-tool", content: "Fictional data.", is_error: false }] }, uuid ? { uuid: "result-event" } : {})
    ];
    const { session } = parseRows(rows.flatMap(row => [row, row]));
    expect(session.turns).toHaveLength(1);
    expect(session.metrics.toolRequests).toBe(1);
    expect(session.turns[0].toolCalls[0].evidence).toHaveLength(2);
  });
  it("retains unidentified events separately with partial history and usage coverage", () => {
    const event = native("user", { content: "Fictional repeated instruction." });
    const { session } = parseRows([event, event]);
    expect(session.turns).toHaveLength(2);
    expect(session.attribution?.historyCoverage).toBe("partial");
    expect(session.attribution?.usageCoverage).toBe("partial");
    expect(session.attribution?.unknowns).toContain("history_event_identity_missing");
  });
  it.each(["timestamp", "first-event", "transcript-id", "missing-time"])("resolves ownership deterministically by %s", rule => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-synthetic-ownership-"));
    try {
      const files = [path.join(directory, "z-original.jsonl"), path.join(directory, "a-copy.jsonl")];
      files.forEach((file, index) => {
        const sessionId = rule === "transcript-id" || rule === "missing-time" ? index ? "z-copy" : "a-owner" : index ? "a-copy" : "z-owner";
        const rows = [native("assistant", { id: "fictional-shared", usage: { output_tokens: 10 }, content: [] }, {
          sessionId, uuid: "shared-event", timestamp: rule === "missing-time" ? undefined : index && rule === "timestamp" ? "2026-01-01T10:01:00Z" : "2026-01-01T10:00:00Z"
        })];
        if (!index && rule === "first-event") rows.unshift(native("user", { content: "Fictional earlier instruction." }, { sessionId, uuid: "earlier-event", timestamp: "2026-01-01T09:59:00Z" }));
        if (index && rule === "timestamp") rows.unshift(native("user", { content: "Fictional earlier copy context." }, { sessionId, uuid: "copy-context", timestamp: "2026-01-01T09:58:00Z" }));
        fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n"));
      });
      const parse = createSessionParser(files.map(file => ({ file, source: "claude" })));
      const original = parse(files[0], "claude").session;
      const copied = parse(files[1], "claude").session;
      expect(original.metrics.outputTokens.value).toBe(10);
      expect(copied.metrics.outputTokens.value).toBeNull();
      expect(copied.attribution?.inheritedEvents).toBe(1);
      expect(copied.attribution?.historyCoverage).toBe("partial");
      const reversed = createSessionParser([...files].reverse().map(file => ({ file, source: "claude" })));
      expect(files.map(file => reversed(file, "claude").session.metrics.outputTokens.value)).toEqual([10, null]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("marks ambiguous lineage as partial rather than claiming complete history or usage", () => {
    const { session } = parseRows([
      native("assistant", { id: "fictional-child", usage: { input_tokens: 2, output_tokens: 2 }, content: [] },
        { uuid: "child-event", parentUuid: "unavailable-parent-event", isSidechain: true, agentId: "fictional-agent" })
    ]);
    expect(session.attribution?.historyCoverage).toBe("partial");
    expect(session.attribution?.usageCoverage).toBe("partial");
    expect(session.attribution?.unknowns).toContain("history_lineage_unknown");
  });
  it.each(["Exit code: 1", "Process exited with code 1"])("treats Read content as data: %s", content => {
    const { session } = parseRows([
      native("assistant", { id: "fictional-read", content: [{ type: "tool_use", id: "fictional-tool", name: "Read", input: {} }] }),
      native("user", { content: [{ type: "tool_result", tool_use_id: "fictional-tool", content, is_error: false }] })
    ]);
    expect(session.turns[0].toolCalls[0].status).toBe("completed");
    expect(session.turns[0].toolCalls[0].exitCode).toBeUndefined();
  });
  it.each(["Exit code: 0", "Process exited with code 0"])("does not accept Bash stdout as execution metadata: %s", content => {
    const { session } = parseRows([
      native("assistant", { id: "fictional-bash", content: [{ type: "tool_use", id: "fictional-tool", name: "Bash", input: { command: "npm test" } }] }),
      native("user", { content: [{ type: "tool_result", tool_use_id: "fictional-tool", content }] })
    ]);
    expect(session.turns[0].toolCalls[0].status).toBe("unknown");
    expect(session.turns[0].toolCalls[0].exitCode).toBeUndefined();
    expect(session.metrics.verificationPassed).toBe(0);
  });

});
