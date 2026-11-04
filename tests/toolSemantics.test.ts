import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSession } from "../src/scoring/score.js";
import { parseSessionFile } from "../src/normalize/parser.js";
import {
  commandResults,
  executionDirectory,
  executionScope,
  expandToolCalls,
  toolCommand,
  canonicalToolSignature,
  redundantToolStats,
  isCommandTool,
  isEditTool,
  looksLikeVerificationTool,
  repeatedFailureStats,
  verificationClosureForTools,
  verificationLaneKey
} from "../src/normalize/toolSemantics.js";
import type { NormalizedToolCall } from "../src/normalize/types.js";

function tool(name: string, status: NormalizedToolCall["status"], args?: unknown, id = `${name}-${status}`): NormalizedToolCall {
  return { toolCallId: id, name, status, arguments: args, executionCwd: "/repo/a", executionRoot: "/repo/a" };
}

function recorded(call: NormalizedToolCall, output: unknown): NormalizedToolCall {
  return { ...call, commandResults: commandResults(output, call, true) };
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
      'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n-old\\n+new\\n*** End Patch"; await tools.apply_patch(patch); text(await tools.shell_command({command:"npm run test:unit",workdir:"C:\\\\Repo\\\\A"}));';
    const outer = { ...recorded(tool("exec", "completed", script, "outer"), "Exit code: 0"), executionCwd: "C:/Repo/A", executionRoot: "C:/Repo/A" };
    const operations = expandToolCalls([outer]);
    expect(operations.map((operation) => operation.name)).toEqual(["apply_patch", "shell_command"]);
    expect(isEditTool(operations[0])).toBe(true);
    expect(looksLikeVerificationTool(operations[1])).toBe(true);
    expect(verificationClosureForTools([outer])).toBe("passed");
  });

  it("requires every final post-edit verification lane to finish", () => {
    const edit = { ...tool("apply_patch", "completed", "*** Begin Patch\n*** End Patch", "edit"), executionCwd: "C:/Repo/A", executionRoot: "C:/Repo/A" };
    const test = tool("shell_command", "completed", { command: "npm test", workdir: "C:\\Repo\\A" }, "test");
    const requestedBuild = tool("shell_command", "requested", { command: "npm run build", workdir: "C:\\Repo\\A" }, "build");
    expect(verificationClosureForTools([edit, test, requestedBuild])).toBe("missing");
    expect(verificationClosureForTools([edit, test, { ...requestedBuild, status: "failed" }])).toBe("failed");
    expect(verificationClosureForTools([edit, test, { ...requestedBuild, status: "completed" }])).toBe("passed");
  });

  it("resets same-command failure episodes only after a successful state change", () => {
    const failure = (id: string) => tool("shell_command", "failed", { command: "npm test", workdir: "C:\\Repo\\A" }, id);
    const failedEdit = tool("apply_patch", "failed", "patch", "failed-edit");
    const completedEdit = { ...tool("apply_patch", "completed", "patch", "completed-edit"), executionCwd: "C:/Repo/A", executionRoot: "C:/Repo/A" };
    expect(repeatedFailureStats([failure("1"), failure("2"), failedEdit, failure("3")]).repeated).toBe(2);
    expect(repeatedFailureStats([failure("1"), failure("2"), completedEdit, failure("3")]).repeated).toBe(1);
  });

  it("parses array-shaped Codex output without losing a successful patch or failed check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-exec-"));
    const fixture = path.join(root, "exec.jsonl");
    const script =
      'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n-old\\n+new\\n*** End Patch"; await tools.apply_patch(patch); text(await tools.shell_command({command:"npm test",workdir:"C:\\\\Repo\\\\A"}));';
    const events = [
      { timestamp: "2026-07-14T11:00:00.000Z", type: "session_meta", payload: { id: "exec-session", cwd: "C:/Repo/A" } },
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

describe("native command argument regressions", () => {
  it.each(["exec_command", "functions.exec_command", "Bash", "run_in_terminal"])("extracts cmd and command envelopes for %s", name => {
    for (const args of [{ cmd: "npm test" }, { command: "npm test" }, { arguments: { cmd: "npm test" } }, JSON.stringify({ cmd: "npm test" })]) {
      const check = tool(name, "completed", args);
      expect(toolCommand(check)).toBe("npm test");
      expect(looksLikeVerificationTool(check)).toBe(true);
    }
  });

  it("keeps nested cmd calls distinct and never borrows a later command", () => {
    const script = 'await tools.exec_command({cmd:"npm test", workdir:"/fictional/repo"}); await tools.exec_command({cmd:"npm run build", workdir:"/fictional/repo"}); await tools.exec_command({cmd: dynamicCommand, workdir:"/fictional/repo"});';
    const outer = tool("functions.exec", "completed", script);
    const expanded = expandToolCalls([outer]);
    expect(expanded.map(toolCommand)).toEqual(["npm test", "npm run build", undefined]);
    expect(new Set(expanded.map(canonicalToolSignature)).size).toBe(3);
    expect(redundantToolStats([outer])).toEqual({ duplicate: 0, comparable: 3 });
    expect(redundantToolStats([outer, { ...outer, toolCallId: "other" }])).toEqual({ duplicate: 2, comparable: 6 });
  });

  it("handles single-quoted literals, escaped quotes, and tool names inside strings", () => {
    const outer = tool("exec", "completed", String.raw`await tools.exec_command({cmd: 'npm test', workdir: '/fictional/repo'}); await tools.exec_command({cmd: "echo \"tools.exec_command({cmd: fake})\"", workdir: "/fictional/repo"});`);
    const expanded = expandToolCalls([outer]);
    expect(expanded).toHaveLength(2);
    expect(toolCommand(expanded[0])).toBe("npm test");
    expect(toolCommand(expanded[1])).toContain("tools.exec_command");
  });

  it.each(["codex", "claude", "copilot"] as const)("retains direct and nested cmd checks through realistic %s events", source => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-native-cmd-"));
    try {
      const fixture = path.join(root, "events.jsonl");
      const calls = [
        { name: "apply_patch", args: "*** Begin Patch\n*** End Patch" },
        { name: source === "claude" ? "Bash" : source === "copilot" ? "run_in_terminal" : "exec_command", args: { cmd: "npm test", workdir: "/fictional/repo" } },
        { name: "exec", args: 'const results = await Promise.allSettled([tools.exec_command({cmd:"npm run build",workdir:"/fictional/repo"}), tools.exec_command({cmd:"npm run lint",workdir:"/fictional/repo"})]); for (const result of results) text(result);' }
      ];
      const stamp = "2026-01-01T10:00:00Z";
      const events: unknown[] = source === "codex" ? [{ type: "session_meta", timestamp: stamp, payload: { id: "fictional-cmd", cwd: "/fictional/repo" } }, { type: "turn_context", timestamp: stamp, payload: { turn_id: "turn" } }] : source === "copilot" ? [{ type: "session.start", timestamp: stamp, data: { context: { cwd: "/fictional/repo" } } }] : [];
      calls.forEach((call, index) => {
        const id = `call-${index}`;
        if (source === "codex") events.push(
          { type: "response_item", timestamp: stamp, payload: { type: call.name === "exec" ? "custom_tool_call" : "function_call", call_id: id, name: call.name, ...(call.name === "exec" ? { input: call.args } : { arguments: JSON.stringify(call.args) }) } },
          { type: "response_item", timestamp: stamp, payload: { type: "function_call_output", call_id: id, output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: call.name === "exec" ? JSON.stringify([{ exit_code: 0, output: "" }, { exit_code: 0, output: "" }]) : "Exit code: 0" }] } }
        );
        else if (source === "claude") events.push(
          { type: "assistant", uuid: `${id}-request`, sessionId: "fictional-cmd", cwd: "/fictional/repo", timestamp: stamp, message: { id, model: "fictional-model", content: [{ type: "tool_use", id, name: call.name, input: call.args }] } },
          { type: "user", uuid: `${id}-result`, sessionId: "fictional-cmd", cwd: "/fictional/repo", timestamp: stamp, message: { content: [{ type: "tool_result", tool_use_id: id, content: call.name === "exec" ? JSON.stringify([{ exit_code: 0, output: "" }, { exit_code: 0, output: "" }]) : "Exit code: 0", is_error: false }] } }
        );
        else events.push(
          { id: `${id}-request`, type: "tool.execution_start", timestamp: stamp, data: { turnId: "turn", toolCallId: id, toolName: call.name, arguments: call.args } },
          { id: `${id}-result`, type: "tool.execution_complete", timestamp: stamp, data: { turnId: "turn", toolCallId: id, toolName: call.name, success: true, result: { content: call.name === "exec" ? JSON.stringify([{ exit_code: 0, output: "" }, { exit_code: 0, output: "" }]) : "Exit code: 0" } } }
        );
      });
      fs.writeFileSync(fixture, events.map(event => JSON.stringify(event)).join("\n"));
      const { session, parseErrors } = parseSessionFile(fixture, source);
      expect(parseErrors).toBe(0);
      expect(session.metrics.verificationEvents).toBe(3);
      expect(session.metrics.verificationPassed).toBe(3);
      expect(session.metrics.verificationClosure).toBe("passed");
      expect(session.metrics.duplicateToolCalls).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves dynamic commands unknown instead of extracting literals from other properties", () => {
    for (const script of [
      'await tools.exec_command({cmd: dynamic, note: \'{cmd:"npm test"}\'});',
      'await tools.exec_command({cmd: "npm test" + suffix});',
      'await tools.exec_command({cmd: `npm test ${target}`});'
    ]) {
      expect(toolCommand(expandToolCalls([tool("exec", "completed", script)])[0])).toBeUndefined();
    }
  });

  it("does not promote partial or multi-command failed results into passing verification", () => {
    const edit = tool("apply_patch", "completed", "patch");
    const script = 'await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"npm run build"});';
    for (const outputText of ['{"exit_code":null,"session_id":123}', '{"exit_code":0}', '{"session_id":123}', 'Script running with cell ID 123', '{"exit_code":1,"output":"failed"}']) {
      const outer = { ...tool("exec", "completed", script), outputText };
      expect(expandToolCalls([outer]).map(call => call.status)).toEqual(["requested", "requested"]);
      expect(verificationClosureForTools([edit, outer])).toBe("missing");
    }
  });
});


describe("command completion evidence", () => {
  it("requires output evidence even for one nested command", () => {
    const edit = tool("apply_patch", "completed", "patch");
    const wrapper = tool("exec", "completed", 'text(await tools.exec_command({cmd:"npm test"}));');
    expect(verificationClosureForTools([edit, wrapper])).toBe("missing");
    expect(verificationClosureForTools([edit, recorded(wrapper, "Exit code: 0")])).toBe("passed");
    expect(verificationClosureForTools([edit, recorded(wrapper, '{"exit_code":1}')])).toBe("failed");
  });

  it("keeps output-only envelopes unresolved instead of reading stdout as metadata", () => {
    const edit = tool("apply_patch", "completed", "patch");
    const wrapper = tool("exec", "completed", 'text(await tools.exec_command({cmd:"npm test"}));');
    for (const output of ['{"exit_code":0}', '{"exit_code":1}', 'Exit code: 0']) {
      expect(verificationClosureForTools([edit, recorded(wrapper, JSON.stringify({ output }))])).toBe("missing");
    }
  });

  it("does not count stdout as additional nested command results", () => {
    const edit = tool("apply_patch", "completed", "patch");
    const wrapper = tool("exec", "completed", 'text(await tools.exec_command({cmd:"npm test"})); text(await tools.exec_command({cmd:"npm run build"}));');
    for (const outputText of [
      JSON.stringify({ exit_code: 0, output: '{"exit_code":0}' }),
      "Exit code: 0\nOutput:\nExit code: 0"
    ]) {
      expect(verificationClosureForTools([edit, recorded(wrapper, outputText)])).toBe("missing");
    }
    expect(verificationClosureForTools([edit, recorded(wrapper, JSON.stringify([
      { exit_code: 0, output: '{"exit_code":1}' }, { exit_code: 0, output: '{"session_id":123}' }
    ]))])).toBe("passed");
  });

  it.each(["codex", "copilot"] as const)("preserves structured completion evidence for %s", source => {
    const root = fs.mkdtempSync(path.resolve("tests/.command-evidence-"));
    try {
      const fixture = path.join(root, "events.jsonl");
      for (const nested of [false, true]) {
        for (const [result, expected] of [
          [{ exit_code: 1, output: "tests failed" }, "failed"],
          [{ exit_code: -1, output: "terminated" }, "failed"],
          [{ exit_code: null, session_id: 123, output: "started" }, "missing"],
          [{ session_id: 123, output: "started" }, "missing"],
          [{ exit_code: 0, output: "tests passed" }, "passed"],
          [{ exit_code: 0, output: '{"exit_code":1}' }, "passed"],
          [{ exit_code: 0, output: '{"session_id":123}' }, "passed"],
          [{ exit_code: 0, output: "Exit code: 1\nScript failed" }, "passed"],
          [{ exit_code: 1, output: '{"exit_code":0}' }, "failed"],
          [{ exit_code: null, session_id: 123, output: '{"exit_code":0}' }, "missing"],
          ["Exit code: 0\nOutput:\nExit code: 1\n{\"session_id\":123}", "passed"],
          ["Process exited with code 0\nFinal output:\n{\"exit_code\":1}", "passed"],
          ["Process running with session ID 123", "missing"]
        ] as const) {
          for (const output of [...(typeof result === "string" ? [result] : [result, JSON.stringify(result)]), [{ type: "input_text", text: typeof result === "string" ? result : JSON.stringify(result) }]]) {
            const observed = !nested && source === "copilot" && (output !== result || typeof result === "string") ? "passed" : expected;
            const events: unknown[] = [source === "codex" ? { type: "session_meta", payload: { cwd: "/repo/a" } } : { type: "session.start", data: { context: { cwd: "/repo/a" } } }];
            for (const [id, name, args, response] of [
              ["edit", "apply_patch", "patch", "Done"],
              ["check", nested ? "exec" : "exec_command", nested ? 'text(await tools.exec_command({cmd:"npm test"}));' : { cmd: "npm test" }, output]
            ] as const) {
              if (source === "codex") events.push(
                { type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } },
                { type: "response_item", payload: { type: "function_call_output", call_id: id, output: response } }
              );
              else events.push(
                { type: "tool.execution_start", data: { toolCallId: id, toolName: name, arguments: args } },
                { type: "tool.execution_complete", data: { toolCallId: id, toolName: name, success: true, result: response } }
              );
            }
            fs.writeFileSync(fixture, events.map(event => JSON.stringify({ ...event as object, timestamp: "2026-01-01T10:00:00Z" })).join("\n"));
            const { session } = parseSessionFile(fixture, source);
            expect(session.metrics.verificationClosure).toBe(observed);
            expect(session.metrics.verificationPassed).toBe(observed === "passed" ? 1 : 0);
            expect(scoreSession(session).outcomeScore).toBe(observed === "passed" ? 80 : observed === "failed" ? 30 : 55);
          }
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


describe("resolved execution identity", () => {
  const command = (id: string, cwd: string | undefined, status: NormalizedToolCall["status"] = "completed"): NormalizedToolCall => ({
    toolCallId: id, name: "exec_command", arguments: { cmd: "npm test" }, status,
    executionCwd: cwd, executionRoot: "/repo/a"
  });

  it("keeps native cwd separate from native worktree scope", () => {
    const child = command("child", "/repo/a/packages/ui");
    expect(executionDirectory(child)).toBe("/repo/a/packages/ui");
    expect(executionScope(child)).toBe("/repo/a");
    const foreign = command("foreign", "/repo/b");
    expect(executionScope(foreign)).toBe("/repo/b");
    expect(executionScope(command("unknown", undefined))).toBeUndefined();
  });

  it("uses resolved native cwd for closure, recovery, failure episodes, and duplicates", () => {
    const edit = tool("apply_patch", "completed", "patch", "edit");
    const failure = command("failed-root", "/repo/a", "failed");
    const childPass = command("passed-child", "/repo/a/packages/ui");
    const rootPass = command("passed-root", "/repo/a");
    expect(verificationLaneKey(failure)).not.toBe(verificationLaneKey(childPass));
    expect(canonicalToolSignature(failure)).not.toBe(canonicalToolSignature(childPass));
    expect(verificationClosureForTools([edit, failure, childPass])).toBe("failed");
    expect(verificationClosureForTools([edit, failure, childPass, rootPass])).toBe("passed");
    expect(repeatedFailureStats([failure, childPass, { ...failure, toolCallId: "failed-again" }])).toEqual({ repeated: 1, failed: 2 });
    expect(redundantToolStats([rootPass, childPass])).toEqual({ duplicate: 0, comparable: 2 });
    expect(redundantToolStats([rootPass, { ...rootPass, toolCallId: "root-again" }])).toEqual({ duplicate: 1, comparable: 2 });
  });

  it.each(["npm test", "rtk npm test", "rtk proxy npm test"])("resolves relative workdirs for %s", cmd => {
    const call = { ...command("relative", "/repo/a"), arguments: { cmd, workdir: "packages/ui" } };
    expect(executionDirectory(call)).toBe("/repo/a/packages/ui");
    expect(verificationLaneKey(call)).toMatch(/^\/repo\/a\/packages\/ui\|/);
    expect(executionDirectory({ ...call, executionCwd: undefined })).toBeUndefined();
  });

  it.each(["git", "rtk git", "rtk proxy git"])("uses %s -C in the shared lane identity", prefix => {
    const call = { ...command("git", "/repo/a"), arguments: { cmd: `${prefix} -C ../b diff --check` } };
    expect(executionDirectory(call)).toBe("/repo/b");
    expect(verificationLaneKey(call)).toMatch(/^\/repo\/b\|/);
  });

  it("carries native scope and cwd through nested operations", () => {
    const wrapper = { ...command("wrapper", "/repo/a/src"), name: "exec", arguments: 'text(await tools.exec_command({cmd:"npm test",workdir:".."}));' };
    const nested = expandToolCalls([wrapper])[0];
    expect(nested.executionRoot).toBe("/repo/a");
    expect(nested.executionCwd).toBe("/repo/a/src");
    expect(executionDirectory(nested)).toBe("/repo/a");
  });

  it("does not conflate relative reads in different directories", () => {
    const read = { ...command("read", "/repo/a"), name: "view", arguments: { path: "images/chart.png" } };
    expect(redundantToolStats([read, { ...read, toolCallId: "other-read", executionCwd: "/repo/b" }]).duplicate).toBe(0);
  });
});


describe("command argument envelopes", () => {
  it.each(["command", "cmd"])("decodes workdir alongside %s in every supported envelope", field => {
    for (const workdir of ["/repo/b", "../b", ".", "$UNKNOWN"]) {
      const args = { [field]: "npm test", workdir };
      for (const envelope of [args, JSON.stringify(args), { arguments: args }, { arguments: JSON.stringify(args) }, JSON.stringify({ arguments: { arguments: JSON.stringify(args) } })]) {
        const call: NormalizedToolCall = { toolCallId: "envelope", name: "shell_command", arguments: envelope,
          executionCwd: "/repo/a", executionRoot: "/repo/a", status: "completed" };
        const directory = workdir === "." ? "/repo/a" : workdir === "$UNKNOWN" ? undefined : "/repo/b";
        expect(toolCommand(call)).toBe("npm test");
        expect(executionDirectory(call)).toBe(directory);
        expect(executionScope(call)).toBe(directory);
        expect(verificationLaneKey(call)).toBe(`${directory ?? "unknown-workdir:envelope"}|npm:test|npm test`);
        expect(canonicalToolSignature(call)).toBe(`shell_command:${verificationLaneKey(call)}`);
      }
    }
  });
});


describe("wrapped command context", () => {
  it.each(["bash -lc", "sh -c", "rtk proxy bash -lc", "rtk proxy sh -c", "/bin/bash -c"])("resolves static %s directories", shell => {
    const foreign = { ...tool("exec_command", "completed", { cmd: `${shell} 'cd /repo/b && npm test'` }), toolCallId: "wrapped-foreign" };
    expect(executionDirectory(foreign)).toBe("/repo/b");
    expect(executionScope(foreign)).toBe("/repo/b");
    expect(verificationLaneKey(foreign)).toMatch(/^\/repo\/b\|/);
    const child = { ...foreign, arguments: { cmd: `${shell} 'cd src && npm test'` } };
    expect(executionDirectory(child)).toBe("/repo/a/src");
    expect(executionScope(child)).toBe("/repo/a");
  });

  it.each([
    "rtk proxy bash -lc 'cd $DIR && npm test'",
    "rtk proxy bash -lc 'cd /repo/$DIR && npm test'",
    "rtk proxy bash -lc 'cd `pwd` && npm test'",
    "env bash -lc 'cd /repo/b && npm test'",
    "bash script.sh npm test",
    "rtk proxy bash -lc 'cd /repo/a/* && npm test'",
    "rtk proxy bash -lc 'cd - && npm test'",
    "rtk proxy bash -lc 'pushd /repo/b && npm test'",
    "(cd /repo/b && npm test)"
  ])("does not infer shared identities for unresolved context: %s", cmd => {
    const first = tool("exec_command", "completed", { cmd }, "unknown-first");
    const second = { ...first, toolCallId: "unknown-second" };
    expect(executionDirectory(first)).toBeUndefined();
    expect(executionScope(first)).toBeUndefined();
    expect(verificationLaneKey(first)).not.toBe(verificationLaneKey(second));
    expect(canonicalToolSignature(first)).not.toBe(canonicalToolSignature(second));
    expect(redundantToolStats([first, second]).duplicate).toBe(0);
    expect(repeatedFailureStats([{ ...first, status: "failed" }, { ...second, status: "failed" }])).toEqual({ repeated: 0, failed: 2 });
  });
});


it("resets failure episodes only after edits in the same known scope", () => {
  const failed = tool("exec_command", "failed", { cmd: "npm test" }, "failure-a");
  const retry = { ...failed, toolCallId: "retry-a" };
  const edit = tool("apply_patch", "completed", "patch", "edit-a");
  expect(repeatedFailureStats([failed, edit, retry]).repeated).toBe(0);
  expect(repeatedFailureStats([failed, { ...edit, executionCwd: "/repo/b" }, retry]).repeated).toBe(1);
  expect(repeatedFailureStats([failed, { ...edit, executionCwd: undefined }, retry]).repeated).toBe(1);
});
