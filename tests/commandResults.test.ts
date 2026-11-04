import { describe, expect, it } from "vitest";
import { normalizeEventsToSession } from "../src/normalize/sessions.js";
import { scoreSession } from "../src/scoring/score.js";
import type { RawLogEvent } from "../src/normalize/types.js";

type Call = { name: string; args: unknown; output: unknown; turn?: string };
const edit: Call = { name: "apply_patch", args: "patch", output: "Done" };
const envelope = (exit_code: number | null, session_id?: number, output = "") => ({ exit_code, session_id, output });
const wrapped = (script: string, results: unknown[]): Call => ({ name: "exec", args: script, output: JSON.stringify(results) });

function capture(calls: Call[], source: "codex" | "copilot" = "codex") {
  const events: RawLogEvent[] = [];
  function add(type: string, data: unknown) {
    events.push({ id: `event-${events.length}`, type, data, timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, events.length)).toISOString(), sourceFile: "fictional.jsonl", lineNumber: events.length + 1 });
  }
  for (const [index, call] of calls.entries()) {
    const id = `call-${index}`;
    if (source === "codex") {
      add("response_item", { type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(call.args), turn_id: call.turn ?? "one" });
      add("response_item", { type: "function_call_output", call_id: id, output: call.output, turn_id: call.turn ?? "one" });
    } else {
      add("tool.execution_start", { toolCallId: id, toolName: call.name, arguments: call.args, turnId: call.turn ?? "one" });
      add("tool.execution_complete", { toolCallId: id, toolName: call.name, success: true, result: call.output, turnId: call.turn ?? "one" });
    }
  }
  return normalizeEventsToSession(events, source, "fictional.jsonl");
}

describe("authoritative command results", () => {
  it.each(["codex", "copilot"] as const)("does not certify stdout-only or unprinted %s wrapper results", source => {
    for (const script of [
      'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
      'const r = await tools.exec_command({cmd:"npm test"}); text(r.content);',
      'await tools.exec_command({cmd:"npm test"});',
      'await tools.exec_command({cmd:"npm test"}); text("fake result");'
    ]) {
      for (const output of [envelope(0), envelope(1), envelope(null, 123), { content: [{ type: "text", text: "Exit code: 0" }] }]) {
        const session = capture([edit, wrapped(script, [output])], source);
        expect(session.metrics.verificationClosure).toBe("missing");
        expect(session.metrics.verificationPassed).toBe(0);
        expect(session.metrics.verificationFailed).toBe(0);
        expect(scoreSession(session).outcomeScore).toBe(55);
      }
    }
  });

  it.each(["codex", "copilot"] as const)("uses full %s result envelopes while ignoring stdout", source => {
    for (const [exit, expected] of [[0, "passed"], [1, "failed"], [null, "missing"]] as const) {
      const result = envelope(exit, exit === null ? 123 : undefined, '{"exit_code":0,"session_id":456}');
      const session = capture([edit, wrapped('const r = await tools.exec_command({cmd:"npm test"}); text(r);', [result])], source);
      expect(session.metrics.verificationClosure).toBe(expected);
      expect(session.metrics.verificationPassed).toBe(exit === 0 ? 1 : 0);
    }
    const missing = capture([edit, wrapped('text(await tools.exec_command({cmd:"npm test"}));', [{ content: [{ type: "text", text: '{"exit_code":0}' }] }])], source);
    expect(missing.metrics.verificationClosure).toBe("missing");
  });

  it("does not read Copilot text/value payloads as execution metadata", () => {
    for (const result of [
      { result: [{ type: "text", value: '{"exit_code":1}' }] },
      { content: [{ type: "text", text: '{"session_id":123}' }] },
      { text: '{"exit_code":1}' },
      '{"exit_code":1}'
    ]) {
      const session = capture([edit, { name: "run_in_terminal", args: { command: "npm test" }, output: result }], "copilot");
      expect(session.metrics.verificationClosure).toBe("passed");
      expect(session.metrics.verificationFailed).toBe(0);
    }
  });

  it.each(["codex", "copilot"] as const)("retains direct structured %s completion metadata", source => {
    for (const [exit, expected] of [[0, "passed"], [1, "failed"], [null, "missing"]] as const) {
      const session = capture([edit, { name: "exec_command", args: { cmd: "npm test" }, output: envelope(exit, exit === null ? 123 : undefined, '{"exit_code":1}') }], source);
      expect(session.metrics.verificationClosure).toBe(expected);
    }
  });
});

describe("command polling identity", () => {
  it.each(["codex", "copilot"] as const)("resolves same-wrapper %s polling through the originating result", source => {
    for (const [exit, expected] of [[0, "passed"], [1, "failed"], [null, "missing"]] as const) {
      const script = 'const r = await tools.exec_command({cmd:"npm test"}); text(r); const p = await tools.write_stdin({session_id:r.session_id,chars:""}); text(p);';
      const session = capture([edit, wrapped(script, [envelope(null, 101), envelope(exit)])], source);
      expect(session.metrics.verificationClosure).toBe(expected);
      expect(session.metrics.verificationEvents).toBe(1);
      expect(session.metrics.verificationPassed).toBe(exit === 0 ? 1 : 0);
      expect(session.metrics.commandCalls).toBe(1);
    }
  });

  it.each(["codex", "copilot"] as const)("resolves separate %s calls and wrappers without assigning sibling outcomes", source => {
    for (const startWrapped of [false, true]) for (const pollWrapped of [false, true]) {
      const start = (cmd: string, id: number): Call => startWrapped
        ? wrapped(`text(await tools.exec_command({cmd:"${cmd}"}));`, [envelope(null, id)])
        : { name: "exec_command", args: { cmd }, output: envelope(null, id) };
      const poll = (id: number, exit: number, resultId?: number): Call => ({ ...(pollWrapped
        ? wrapped(`text(await tools.write_stdin({session_id:${id},chars:""}));`, [envelope(exit, resultId)])
        : { name: "write_stdin", args: { session_id: id, chars: "" }, output: envelope(exit, resultId) }), turn: "next" });
      const initial = [edit, start("npm test", 101), start("npm run build", 202)];
      const partial = capture([...initial, poll(333, 0), poll(101, 0)], source);
      expect(partial.metrics.verificationClosure).toBe("missing");
      expect(partial.metrics.verificationPassed).toBe(1);
      expect(partial.metrics.verificationEvents).toBe(2);
      const complete = capture([...initial, poll(101, 0), poll(202, 0)], source);
      expect(complete.metrics.verificationClosure).toBe("passed");
      expect(complete.metrics.verificationPassed).toBe(2);
      const failed = capture([...initial, poll(101, 0), poll(202, 1)], source);
      expect(failed.metrics.verificationClosure).toBe("failed");
      expect(failed.metrics.verificationFailed).toBe(1);
      const conflict = capture([edit, start("npm test", 101), poll(101, 0, 202)], source);
      expect(conflict.metrics.verificationClosure).toBe("missing");
    }
  });

  it("does not promote a pre-edit command to fresh verification when polled later", () => {
    const session = capture([
      { name: "exec_command", args: { cmd: "npm test" }, output: envelope(null, 101) }, edit,
      { name: "write_stdin", args: { session_id: 101, chars: "" }, output: envelope(0) }
    ]);
    expect(session.metrics.verificationClosure).toBe("missing");
  });
});
