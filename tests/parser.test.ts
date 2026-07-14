import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonl } from "../src/fs/jsonl.js";
import { parseSessionFile } from "../src/normalize/parser.js";

const fixture = path.resolve("tests/fixtures/copilot-events.jsonl");
const codexFixture = path.resolve("tests/fixtures/codex-events.jsonl");

describe("jsonl parser", () => {
  it("reads valid lines and skips invalid lines", () => {
    const result = readJsonl(fixture);
    expect(result.events).toHaveLength(6);
    expect(result.parseErrors).toBe(1);
  });
});

describe("copilot parser", () => {
  it("extracts model, output tokens, tool requests, and tool execution starts", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    expect(session.turns[0].assistantMessages[0].model).toBe("gpt-5.4");
    expect(session.metrics.outputTokens.value).toBe(328);
    expect(session.metrics.toolRequests).toBe(3);
    expect(session.metrics.toolExecutionsStarted).toBe(2);
  });

  it("counts Copilot partition execution completions", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-partition-events.jsonl"), "copilot");
    expect(session.metrics.toolExecutionsStarted).toBe(2);
    expect(session.metrics.toolExecutionsCompleted).toBe(1);
    expect(session.metrics.toolExecutionsFailed).toBe(1);
  });

  it("uses Copilot shutdown model usage as session token totals", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/copilot-shutdown-usage.jsonl"), "copilot");
    expect(session.metrics.inputTokens.value).toBe(145600);
    expect(session.metrics.outputTokens.value).toBe(2310);
    expect(session.metrics.cachedTokens.value).toBe(115200);
  });

  it("calculates hook duration", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    expect(session.turns[0].hooks[0].durationMs).toBe(24);
    expect(session.metrics.totalHookLatencyMs).toBe(24);
  });
});

describe("codex parser", () => {
  it("reads payload-based events without top-level ids", () => {
    const result = readJsonl(codexFixture);
    expect(result.events).toHaveLength(10);
    expect(result.parseErrors).toBe(0);
  });

  it("extracts cwd, tool calls, verification, and token counts", () => {
    const { session } = parseSessionFile(codexFixture, "codex");
    expect(session.sessionId).toBe("codex-session-1");
    expect(session.turns.some((turn) => turn.hooks.some((hook) => hook.cwd === "C:\\Repo\\Personal\\LunaObservatory"))).toBe(true);
    expect(session.metrics.toolRequests).toBe(2);
    expect(session.metrics.toolExecutionsStarted).toBe(0);
    expect(session.metrics.toolExecutionsCompleted).toBe(2);
    expect(session.metrics.editCalls).toBe(1);
    expect(session.metrics.verificationEvents).toBe(1);
    expect(session.metrics.inputTokens.value).toBe(1000);
    expect(session.metrics.outputTokens.value).toBe(128);
    expect(session.metrics.cachedTokens.value).toBe(250);
    expect(session.metrics.models["gpt-5"]).toBeGreaterThan(0);
  });

  it("segments copied parent history from a child-agent rollout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-child-"));
    const childFixture = path.join(root, "child.jsonl");
    const events = [
      { timestamp: "2026-07-14T09:00:00.000Z", type: "session_meta", payload: { id: "child", session_id: "parent", parent_thread_id: "parent", agent_path: "/root/reviewer", cwd: "C:\\Repo\\Example" } },
      { timestamp: "2026-07-14T08:00:00.000Z", type: "session_meta", payload: { id: "parent", session_id: "parent", cwd: "C:\\Repo\\Example" } },
      { timestamp: "2026-07-14T08:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
      { timestamp: "2026-07-14T08:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Parent request that must not leak." }], internal_chat_message_metadata_passthrough: { turn_id: "parent-turn" } } },
      { timestamp: "2026-07-14T08:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "npm test" }), call_id: "parent-call", internal_chat_message_metadata_passthrough: { turn_id: "parent-turn" } } },
      { timestamp: "2026-07-14T08:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "parent-call", output: "Exit code: 0", internal_chat_message_metadata_passthrough: { turn_id: "parent-turn" } } },
      { timestamp: "2026-07-14T09:00:00.100Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are an agent in a team of agents collaborating to complete a task." }] } },
      { timestamp: "2026-07-14T09:00:00.200Z", type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      { timestamp: "2026-07-14T09:00:00.300Z", type: "turn_context", payload: { turn_id: "child-turn", cwd: "C:\\Repo\\Example", model: "gpt-5" } },
      { timestamp: "2026-07-14T09:00:00.400Z", type: "response_item", payload: { type: "agent_message", author: "/root", recipient: "/root/reviewer", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload: Review the metrics only." }], internal_chat_message_metadata_passthrough: { turn_id: "child-turn" } } },
      { timestamp: "2026-07-14T09:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Review completed." }], internal_chat_message_metadata_passthrough: { turn_id: "child-turn" } } },
      { timestamp: "2026-07-14T09:00:01.100Z", type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } }
    ];
    fs.writeFileSync(childFixture, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const { session } = parseSessionFile(childFixture, "codex");
    expect(session.sessionId).toBe("child");
    expect(session.parentSessionId).toBe("parent");
    expect(session.agentPath).toBe("/root/reviewer");
    expect(session.lifecycleStatus).toBe("completed");
    expect(session.metrics.turns).toBe(1);
    expect(session.metrics.toolRequests).toBe(0);
    expect(session.userIntent?.text).toBe("Review the metrics only.");
    expect(session.userIntent?.text).not.toContain("Parent request");
  });

  it("uses cumulative token totals when available and sums last-only usage samples", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-tokens-"));
    const tokenFixture = path.join(root, "tokens.jsonl");
    const events = [
      { timestamp: "2026-07-14T10:00:00.000Z", type: "session_meta", payload: { id: "tokens" } },
      { timestamp: "2026-07-14T10:00:00.100Z", type: "turn_context", payload: { turn_id: "turn" } },
      { timestamp: "2026-07-14T10:00:00.200Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 10 } } } },
      { timestamp: "2026-07-14T10:00:00.300Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, output_tokens: 20 } } } }
    ];
    fs.writeFileSync(tokenFixture, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const { session } = parseSessionFile(tokenFixture, "codex");
    expect(session.metrics.inputTokens.value).toBe(30);
    expect(session.metrics.outputTokens.value).toBe(30);
  });

  it("captures user intent, instructions, final answer, and final claims from Codex messages", () => {
    const { session } = parseSessionFile(codexFixture, "codex");
    expect(session.userIntent?.text).toContain("Fix the scan report.");
    expect(session.userIntent?.text).not.toContain("<environment_context>");
    expect(session.instructions?.some((instruction) => instruction.text.includes("Do not inspect the live repository"))).toBe(true);
    expect(session.finalAnswer?.text).toContain("Implemented scan capture");
    expect(session.finalClaims?.some((claim) => claim.text.includes("npm test passed"))).toBe(true);
  });
});
