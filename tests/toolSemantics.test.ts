import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/normalize/parser.js";
import {
  expandToolCalls,
  isCommandTool,
  isEditTool,
  looksLikeVerificationTool,
  repeatedFailureStats,
  verificationClosureForTools,
  verificationLaneKey
} from "../src/normalize/toolSemantics.js";
import type { NormalizedToolCall } from "../src/normalize/types.js";

function tool(name: string, status: NormalizedToolCall["status"], args?: unknown, id = `${name}-${status}`): NormalizedToolCall {
  return { toolCallId: id, name, status, arguments: args };
}

describe("tool semantics", () => {
  it("recognizes real Copilot vocabulary and keeps verification lanes distinct", () => {
    const unit = tool("run_in_terminal", "completed", { command: "npm run test:unit", workdir: "C:\\Repo\\A" }, "unit");
    const e2e = tool("run_in_terminal", "completed", { command: "npm run test:e2e", workdir: "C:\\Repo\\A" }, "e2e");
    const otherRepo = tool("run_in_terminal", "completed", { command: "npm run test:unit", workdir: "C:\\Repo\\B" }, "other");
    expect(isCommandTool(unit)).toBe(true);
    expect(looksLikeVerificationTool(unit)).toBe(true);
    expect(verificationLaneKey(unit)).not.toBe(verificationLaneKey(e2e));
    expect(verificationLaneKey(unit)).not.toBe(verificationLaneKey(otherRepo));
    expect(isEditTool(tool("replace_string_in_file", "completed"))).toBe(true);
    expect(isEditTool(tool("insert_edit_into_file", "completed"))).toBe(true);
  });

  it("expands current Codex orchestration into ordered edit and command operations", () => {
    const script =
      'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n-old\\n+new\\n*** End Patch"; await tools.apply_patch(patch); await tools.shell_command({command:"npm run test:unit",workdir:"C:\\\\Repo\\\\A"});';
    const outer = tool("exec", "completed", script, "outer");
    const operations = expandToolCalls([outer]);
    expect(operations.map((operation) => operation.name)).toEqual(["apply_patch", "shell_command"]);
    expect(isEditTool(operations[0])).toBe(true);
    expect(looksLikeVerificationTool(operations[1])).toBe(true);
    expect(verificationClosureForTools([outer])).toBe("passed");
  });

  it("requires every final post-edit verification lane to finish", () => {
    const edit = tool("apply_patch", "completed", "*** Begin Patch\n*** End Patch", "edit");
    const test = tool("shell_command", "completed", { command: "npm test", workdir: "C:\\Repo\\A" }, "test");
    const requestedBuild = tool("shell_command", "requested", { command: "npm run build", workdir: "C:\\Repo\\A" }, "build");
    expect(verificationClosureForTools([edit, test, requestedBuild])).toBe("missing");
    expect(verificationClosureForTools([edit, test, { ...requestedBuild, status: "failed" }])).toBe("failed");
    expect(verificationClosureForTools([edit, test, { ...requestedBuild, status: "completed" }])).toBe("passed");
  });

  it("resets same-command failure episodes only after a successful state change", () => {
    const failure = (id: string) => tool("shell_command", "failed", { command: "npm test", workdir: "C:\\Repo\\A" }, id);
    const failedEdit = tool("apply_patch", "failed", "patch", "failed-edit");
    const completedEdit = tool("apply_patch", "completed", "patch", "completed-edit");
    expect(repeatedFailureStats([failure("1"), failure("2"), failedEdit, failure("3")]).repeated).toBe(2);
    expect(repeatedFailureStats([failure("1"), failure("2"), completedEdit, failure("3")]).repeated).toBe(1);
  });

  it("parses array-shaped Codex output without losing a successful patch or failed check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-exec-"));
    const fixture = path.join(root, "exec.jsonl");
    const script =
      'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n-old\\n+new\\n*** End Patch"; await tools.apply_patch(patch); await tools.shell_command({command:"npm test",workdir:"C:\\\\Repo\\\\A"});';
    const events = [
      { timestamp: "2026-07-14T11:00:00.000Z", type: "session_meta", payload: { id: "exec-session" } },
      { timestamp: "2026-07-14T11:00:00.100Z", type: "turn_context", payload: { turn_id: "turn" } },
      { timestamp: "2026-07-14T11:00:00.200Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: script, call_id: "call", internal_chat_message_metadata_passthrough: { turn_id: "turn" } } },
      { timestamp: "2026-07-14T11:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: "Exit code: 1\nTests failed" }], internal_chat_message_metadata_passthrough: { turn_id: "turn" } } }
    ];
    fs.writeFileSync(fixture, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const { session } = parseSessionFile(fixture, "codex");
    expect(session.metrics.editAttempts).toBe(1);
    expect(session.metrics.editCalls).toBe(1);
    expect(session.metrics.verificationEvents).toBe(1);
    expect(session.metrics.verificationPassed).toBe(0);
    expect(session.metrics.verificationFailed).toBe(1);
    expect(session.metrics.verificationClosure).toBe("failed");
  });

  it("does not assign one compound-wrapper failure to every nested command", () => {
    const script =
      'await tools.apply_patch("*** Begin Patch\\n*** End Patch"); await tools.shell_command({command:"npm test",workdir:"C:\\\\Repo\\\\A"}); await tools.shell_command({command:"npm run build",workdir:"C:\\\\Repo\\\\A"});';
    const outer = {
      ...tool("exec", "completed", script, "compound"),
      outputText: "Script completed\nExit code: 1\nOne nested command failed"
    };

    const operations = expandToolCalls([outer]);
    expect(operations.map((operation) => operation.status)).toEqual(["completed", "requested", "requested"]);
    expect(verificationClosureForTools([outer])).toBe("missing");
    expect(repeatedFailureStats([outer]).failed).toBe(0);
  });

  it("retains Copilot run_in_terminal arguments through completion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-copilot-command-"));
    const fixture = path.join(root, "copilot.jsonl");
    const events = [
      { id: "1", timestamp: "2026-07-14T12:00:00.000Z", type: "assistant.turn_start", data: { turnId: "turn" } },
      { id: "2", timestamp: "2026-07-14T12:00:00.100Z", type: "tool.execution_start", data: { turnId: "turn", toolCallId: "call", toolName: "run_in_terminal", arguments: { command: "dotnet test C:\\Repo\\A\\test.csproj", workdir: "C:\\Repo\\A" } } },
      { id: "3", timestamp: "2026-07-14T12:00:01.000Z", type: "tool.execution_complete", data: { turnId: "turn", toolCallId: "call", toolName: "run_in_terminal", success: false, status: "failed", result: { result: [{ type: "text", value: "Exit code 1" }] } } }
    ];
    fs.writeFileSync(fixture, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const { session } = parseSessionFile(fixture, "copilot");
    expect(session.metrics.commandCalls).toBe(1);
    expect(session.metrics.failedCommands).toBe(1);
    expect(session.metrics.verificationEvents).toBe(1);
    expect(session.turns[0].toolCalls[0].arguments).toEqual({ command: "dotnet test C:\\Repo\\A\\test.csproj", workdir: "C:\\Repo\\A" });
  });
});
