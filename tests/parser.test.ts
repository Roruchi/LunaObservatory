import { describe, expect, it } from "vitest";
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
    expect(session.metrics.toolExecutionsStarted).toBe(2);
    expect(session.metrics.toolExecutionsCompleted).toBe(2);
    expect(session.metrics.editCalls).toBe(1);
    expect(session.metrics.verificationEvents).toBe(1);
    expect(session.metrics.inputTokens.value).toBe(1000);
    expect(session.metrics.outputTokens.value).toBe(128);
    expect(session.metrics.cachedTokens.value).toBe(250);
    expect(session.metrics.models["gpt-5"]).toBeGreaterThan(0);
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
