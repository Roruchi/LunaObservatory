import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRepoFilter } from "../src/normalize/repoFilter.js";
import { parseSessionFile } from "../src/normalize/parser.js";

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
    expect(session.parentSessionId).toBe("synthetic-session");
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
      native("user", { content: [{ type: "tool_result", tool_use_id: "synthetic-tool", content: "Exit code: 2", is_error: true }] })
    ]);
    expect(session.metrics.verificationFailed).toBe(1);
    expect(session.turns[0].toolCalls[0].exitCode).toBe(2);
  });
});
