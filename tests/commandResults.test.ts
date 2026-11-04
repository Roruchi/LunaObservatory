import { describe, expect, it } from "vitest";
import { normalizeEventsToSession } from "../src/normalize/sessions.js";
import { expandToolCalls, executionDirectory, verificationLaneKey, looksLikeVerificationTool, isCommandTool, toolCommand } from "../src/normalize/toolSemantics.js";
import { scoreSession } from "../src/scoring/score.js";
import type { RawLogEvent } from "../src/normalize/types.js";

type Call = { name: string; args: unknown; output: unknown; turn?: string; cwd?: string };
const edit: Call = { name: "apply_patch", args: "*** Begin Patch\n*** Update File: map.ts\n*** End Patch", output: "Done" };
const envelope = (exit_code: number | null, session_id?: number, output = "") => ({ exit_code, session_id, output });
const wrapped = (script: string, results: unknown[]): Call => ({ name: "exec", args: script, output: JSON.stringify(results) });

function capture(calls: Call[], source: "codex" | "copilot" = "codex", nativeCwd: string | null = "/repo/a") {
  const events: RawLogEvent[] = [];
  function add(type: string, data: unknown) {
    events.push({ id: `event-${events.length}`, type, data, timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, events.length)).toISOString(), sourceFile: "fictional.jsonl", lineNumber: events.length + 1 });
  }
  if (nativeCwd) add(source === "codex" ? "session_meta" : "session.start", source === "codex" ? { cwd: nativeCwd } : { context: { cwd: nativeCwd } });
  for (const [index, call] of calls.entries()) {
    const id = `call-${index}`;
    if (source === "codex") {
      if (call.cwd) add("turn_context", { turn_id: call.turn ?? "one", cwd: call.cwd });
      add("response_item", { type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(call.args), turn_id: call.turn ?? "one" });
      add("response_item", { type: "function_call_output", call_id: id, output: call.output, turn_id: call.turn ?? "one" });
    } else {
      add("tool.execution_start", { toolCallId: id, toolName: call.name, arguments: call.args, cwd: call.cwd, turnId: call.turn ?? "one" });
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

describe("Codex wrapper failure headers", () => {
  const shapes = (header: string): unknown[] => [
    header,
    [{ type: "input_text", text: header }],
    [{ type: "text", text: header }],
    [{ type: "input_text", text: "" }, { type: "input_text", text: header }]
  ];
  const patch = 'await tools.apply_patch("*** Begin Patch\\n*** Update File: map.ts\\n*** End Patch");';

  it.each(["Script failed: patch rejected", "Script timed out", "Script terminated", "Tool call failed"])("retains %s in string and native content-block shapes", header => {
    for (const output of shapes(header)) {
      const session = capture([{ name: "exec", args: patch + 'await tools.exec_command({cmd:"npm test"});', output }]);
      const wrapper = session.turns.flatMap(turn => turn.toolCalls)[0];
      expect(wrapper.status).toBe("failed");
      expect(session.metrics.editAttempts).toBe(1);
      expect(session.metrics.editCalls).toBe(0);
      expect(session.metrics.verificationPassed).toBe(0);
      expect(session.metrics.verificationClosure).toBe("not_applicable");
    }
  });

  it("keeps an earlier passed verification fresh after a failed wrapped patch", () => {
    for (const output of shapes("Script failed: patch rejected")) {
      const session = capture([edit,
        { name: "exec_command", args: { cmd: "npm test" }, output: envelope(0) },
        { name: "exec", args: patch, output }
      ]);
      expect(session.metrics.editAttempts).toBe(2);
      expect(session.metrics.editCalls).toBe(1);
      expect(session.metrics.verificationClosure).toBe("passed");
      expect(scoreSession(session).outcomeScore).toBe(80);
    }
  });

  it("retains ordinary successful edits and ignores failure-like stdout", () => {
    const stdout = JSON.stringify(envelope(0, undefined, "Script failed: ordinary stdout"));
    for (const output of [
      ...shapes("Script completed"),
      { exit_code: 0, output: "Script failed: ordinary stdout" },
      [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: "Script failed: ordinary stdout" }],
      [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: stdout }]
    ]) {
      const session = capture([{ name: "exec", args: patch, output }]);
      expect(session.turns.flatMap(turn => turn.toolCalls)[0].status).toBe("completed");
      expect(session.metrics.editCalls).toBe(1);
      expect(session.metrics.verificationClosure).toBe("missing");
    }
    const session = capture([{ name: "exec", args: patch + 'text(await tools.exec_command({cmd:"npm test"}));', output: [
      { type: "input_text", text: "Script completed" }, { type: "input_text", text: stdout }
    ] }]);
    expect(session.metrics.editCalls).toBe(1);
    expect(session.metrics.verificationClosure).toBe("passed");
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

  it.each(["codex", "copilot"] as const)("resolves transitive %s poll bindings to the command", source => {
    const start = 'const r = await tools.exec_command({cmd:"npm test"}); text(r);';
    const polls = 'const p = await tools.write_stdin({session_id:r.session_id,chars:""}); text(p); const q = await tools.write_stdin({session_id:p.session_id,chars:""}); text(q); const final = await tools.write_stdin({session_id:q.session_id,chars:""}); text(final);';
    for (const [exit, expected] of [[0, "passed"], [1, "failed"], [null, "missing"]] as const) {
      const results = [envelope(null, 101), envelope(null, 101), envelope(null, 101), envelope(exit, exit === null ? 101 : undefined)];
      const staleWithin = capture([wrapped(start + 'await tools.apply_patch("patch");' + polls, results)], source);
      expect(staleWithin.metrics.verificationClosure).toBe("missing");
      for (const separate of [false, true]) {
        const calls = separate ? [
          wrapped(start, [results[0]]),
          { ...wrapped(polls.replace('session_id:r.session_id', 'session_id:101'), results.slice(1)), turn: "next" }
        ] : [wrapped(start + polls, results)];
        const session = capture([edit, ...calls], source);
        expect(session.metrics.verificationClosure).toBe(expected);
        expect(session.metrics.verificationEvents).toBe(1);
        expect(session.metrics.verificationPassed).toBe(exit === 0 ? 1 : 0);
        expect(session.metrics.verificationFailed).toBe(exit === 1 ? 1 : 0);
        expect(scoreSession(session).outcomeScore).toBe(exit === 0 ? 80 : exit === 1 ? 30 : 55);
        const stale = capture([calls[0], edit, ...calls.slice(1)], source);
        expect(stale.metrics.verificationClosure).toBe("missing");
      }
    }
  });

  it.each(["codex", "copilot"] as const)("isolates siblings and unmatched %s poll chains", source => {
    const initial = [edit,
      wrapped('text(await tools.exec_command({cmd:"npm test"}));', [envelope(null, 101)]),
      wrapped('text(await tools.exec_command({cmd:"npm run build"}));', [envelope(null, 202)])
    ];
    const chain = (id: number, exit: number, resultId?: number): Call => wrapped(
      `const p = await tools.write_stdin({session_id:${id},chars:""}); text(p); const q = await tools.write_stdin({session_id:p.session_id,chars:""}); text(q);`,
      [envelope(null, resultId ?? id), envelope(exit)]
    );
    const partial = capture([...initial, chain(333, 0), chain(101, 0)], source);
    expect(partial.metrics.verificationClosure).toBe("missing");
    expect(partial.metrics.verificationPassed).toBe(1);
    expect(partial.metrics.verificationFailed).toBe(0);
    const complete = capture([...initial, chain(101, 0), chain(202, 0)], source);
    expect(complete.metrics.verificationClosure).toBe("passed");
    expect(complete.metrics.verificationPassed).toBe(2);
    const failed = capture([...initial, chain(101, 0), chain(202, 1)], source);
    expect(failed.metrics.verificationClosure).toBe("failed");
    expect(failed.metrics.verificationFailed).toBe(1);
    const conflicting = capture([...initial, chain(101, 0, 202)], source);
    expect(conflicting.metrics.verificationClosure).toBe("missing");
    expect(conflicting.metrics.verificationPassed).toBe(0);
    const missingIdentity = capture([...initial, wrapped(
      'const p = await tools.write_stdin({session_id:101,chars:""}); text(p); const q = await tools.write_stdin({session_id:p.session_id,chars:""}); text(q);',
      [envelope(null), envelope(0)]
    )], source);
    expect(missingIdentity.metrics.verificationClosure).toBe("missing");
    expect(missingIdentity.metrics.verificationPassed).toBe(0);
  });

  it("does not promote a pre-edit command to fresh verification when polled later", () => {
    const session = capture([
      { name: "exec_command", args: { cmd: "npm test" }, output: envelope(null, 101) }, edit,
      { name: "write_stdin", args: { session_id: 101, chars: "" }, output: envelope(0) }
    ]);
    expect(session.metrics.verificationClosure).toBe("missing");
  });
});


describe("scoped session verification", () => {
  it.each(["codex", "copilot"] as const)("rejects foreign checks before scoring completed %s sessions", source => {
    for (const check of [
      { name: "exec_command", args: { cmd: "npm test", workdir: "/repo/b" }, output: envelope(0) },
      { name: "exec_command", args: JSON.stringify({ arguments: JSON.stringify({ command: "npm test", workdir: "/repo/b" }) }), output: envelope(0) },
      wrapped('text(await tools.exec_command({cmd:"npm test",workdir:"/repo/b"}));', [envelope(0)])
    ]) {
      const session = capture([edit, check], source);
      session.lifecycleStatus = "completed";
      expect(session.metrics.verificationClosure).toBe("missing");
      expect(scoreSession(session).outcomeScore).toBe(50);
    }
    const genuine = capture([edit, { name: "exec_command", args: { cmd: "npm test" }, output: envelope(0) }], source);
    genuine.lifecycleStatus = "completed";
    expect(genuine.metrics.verificationClosure).toBe("passed");
    expect(scoreSession(genuine).outcomeScore).toBe(90);
  });

  it.each(["codex", "copilot"] as const)("requires fresh verification for every edited %s scope", source => {
    const editA = { ...edit, cwd: "/repo/a" };
    const editB = { ...edit, cwd: "/repo/b" };
    const checkA: Call = { name: "exec_command", args: { cmd: "npm test" }, output: envelope(0), cwd: "/repo/a" };
    const checkB = { ...checkA, cwd: "/repo/b" };
    expect(capture([editA, checkA, editB, checkB], source).metrics.verificationClosure).toBe("passed");
    expect(capture([editA, editB, checkB], source).metrics.verificationClosure).toBe("missing");
    expect(capture([editA, { ...checkA, output: envelope(1) }, editB, checkB], source).metrics.verificationClosure).toBe("failed");
    expect(capture([editA, checkA, editA, editB, checkB], source).metrics.verificationClosure).toBe("missing");
    const unknownEdit = capture([edit, { ...checkA, args: { cmd: "npm test", workdir: "/repo/a" } }], source, null);
    expect(unknownEdit.metrics.verificationClosure).toBe("missing");
  });

  it.each(["codex", "copilot"] as const)("honors wrapped shell execution contexts for %s", source => {
    for (const [cmd, matching] of [
      ["rtk proxy bash -lc 'cd /repo/b && npm test'", false],
      ["rtk proxy sh -c 'cd ../b && npm test'", false],
      ['rtk proxy bash -lc "cd /repo/a && npm test"', true],
      ["rtk proxy sh -c 'cd src && npm test'", true],
      ["bash -lc 'npm test'", true],
      ["rtk proxy bash -lc 'cd $TARGET && npm test'", false],
      ["rtk proxy bash -lc 'cd /repo/$TARGET && npm test'", false],
      ["env bash -lc 'cd /repo/b && npm test'", false]
    ] as const) for (const exit of [0, 1]) for (const nested of [true, false]) {
      const check = nested ? wrapped(`text(await tools.exec_command(${JSON.stringify({ cmd })}));`, [envelope(exit)])
        : { name: "exec_command", args: { cmd }, output: envelope(exit) };
      const session = capture([edit, check], source);
      session.lifecycleStatus = "completed";
      expect(session.metrics.verificationClosure, `${source}: ${cmd}, exit=${exit}, nested=${nested}`).toBe(matching ? exit === 0 ? "passed" : "failed" : "missing");
      expect(scoreSession(session).outcomeScore).toBe(matching ? exit === 0 ? 90 : 30 : 50);
    }
  });
});


describe("unresolved context and changed-target evidence", () => {
  it.each(["codex", "copilot"] as const)("keeps present dynamic nested workdirs unknown for %s", source => {
    for (const expression of ["wd", '"/repo/" + suffix', "`/repo/${suffix}`", "null", "42"]) {
      const session = capture([edit, wrapped(`const wd = "/repo/b"; const suffix = "b"; text(await tools.exec_command({cmd:"npm test",workdir:${expression}}));`, [envelope(0)])], source);
      session.lifecycleStatus = "completed";
      const command = expandToolCalls(session.turns.flatMap(turn => turn.toolCalls)).find(tool => tool.name === "exec_command")!;
      expect(executionDirectory(command)).toBeUndefined();
      expect(session.metrics.verificationClosure).toBe("missing");
      expect(scoreSession(session).outcomeScore).toBe(50);
    }
    const omitted = capture([edit, wrapped('text(await tools.exec_command({cmd:"npm test"}));', [envelope(0)])], source);
    expect(omitted.metrics.verificationClosure).toBe("passed");
  });

  it.each(["codex", "copilot"] as const)("does not verify foreign, mixed, or unknown %s edit targets", source => {
    for (const [name, args] of [
      ["write_file", { path: "/repo/b/map.ts" }],
      ["edit_file", { paths: ["map.ts", "/repo/b/other.ts"] }],
      ["Write", { file_path: "/repo/b/map.ts" }],
      ["Edit", { file_path: "/repo/b/map.ts" }],
      ["edit", { edits: [{ path: "map.ts" }, { path: null }] }],
      ["write_file", { path: "$FILE" }],
      ["write_file", { uri: "file:///repo/b/map.ts" }],
      ["write_file", {}],
      ["apply_patch", "*** Begin Patch\n*** Update File: map.ts\n*** Update File: /repo/b/other.ts\n*** End Patch"],
      ["apply_patch", "*** Begin Patch\n*** Update File: map.ts\n*** Move to: /repo/b/map.ts\n*** End Patch"],
      ["apply_patch", "unstructured edit"]
    ] as const) {
      const session = capture([{ name, args, output: "Done" }, { name: "exec_command", args: { cmd: "npm test" }, output: envelope(0) }], source);
      session.lifecycleStatus = "completed";
      expect(session.metrics.verificationClosure, JSON.stringify([source, name, args])).toBe("missing");
      expect(scoreSession(session).outcomeScore).toBe(50);
    }
    const genuine = capture([{ name: "write_file", args: { paths: ["map.ts", "/repo/a/other.ts"] }, output: "Done" }, { name: "exec_command", args: { cmd: "npm test" }, output: envelope(0) }], source);
    expect(genuine.metrics.verificationClosure).toBe("passed");
  });

  it("does not borrow a sibling patch literal for an unresolved patch call", () => {
    const session = capture([wrapped('const other = "*** Begin Patch\\n*** Update File: map.ts\\n*** End Patch"; await tools.apply_patch(dynamicPatch); text(await tools.exec_command({cmd:"npm test"}));', [envelope(0)])]);
    expect(session.metrics.verificationClosure).toBe("missing");
  });

  it.each(["npm test", "pnpm test", "yarn test", "bun test", "tsc --noEmit"])("recognizes quoted wrapped %s consistently", cmd => {
    for (const shell of ["bash -lc", "rtk proxy sh -c"]) for (const exit of [0, 1]) {
      const session = capture([edit, { name: "exec_command", args: { cmd: `${shell} '${cmd}'` }, output: envelope(exit) }]);
      const command = expandToolCalls(session.turns.flatMap(turn => turn.toolCalls)).find(tool => tool.name === "exec_command")!;
      expect(looksLikeVerificationTool(command)).toBe(true);
      expect(verificationLaneKey(command)).toBe(verificationLaneKey({ ...command, arguments: { cmd } }));
      expect(session.metrics.verificationEvents).toBe(1);
      expect(session.metrics.verificationPassed).toBe(exit === 0 ? 1 : 0);
      expect(session.metrics.verificationFailed).toBe(exit === 1 ? 1 : 0);
      expect(session.metrics.verificationClosure).toBe(exit === 0 ? "passed" : "failed");
    }
  });
});


it("preserves unresolved nested edit target expressions", () => {
  for (const target of ["file", '"map.ts" + suffix', "`map${suffix}.ts`"]) {
    const session = capture([wrapped(`await tools.write_file({path:${target},content:"changed"}); text(await tools.exec_command({cmd:"npm test"}));`, [envelope(0)])]);
    expect(session.metrics.verificationClosure).toBe("missing");
  }
  const genuine = capture([wrapped('await tools.write_file({path:"map.ts",content:"changed"}); text(await tools.exec_command({cmd:"npm test"}));', [envelope(0)])]);
  expect(genuine.metrics.verificationClosure).toBe("passed");
});


describe("orchestration is not shell text", () => {
  it.each(["codex", "copilot"] as const)("does not certify unsupported-only %s wrappers", source => {
    for (const name of ["exec", "functions.exec", "exec_command"]) for (const query of ["pytest documentation", "npm test", "tsc --noEmit"]) {
      const script = `text(await tools.web__run({search_query:[{q:${JSON.stringify(query)}}]}));`;
      const session = capture([edit, { name, args: script, output: JSON.stringify({ exit_code: 0, output: query }) }], source);
      session.lifecycleStatus = "completed";
      const wrapper = session.turns.flatMap(turn => turn.toolCalls).at(-1)!;
      expect(isCommandTool(wrapper)).toBe(false);
      expect(toolCommand(wrapper)).toBeUndefined();
      expect(session.metrics.commandCalls).toBe(0);
      expect(session.metrics.verificationEvents).toBe(0);
      expect(session.metrics.verificationClosure).toBe("missing");
      expect(scoreSession(session).outcomeScore).toBe(50);
    }
    for (const script of ['text("pytest npm test tsc");', 'text(await tools.unsupported({command:"pytest"}));']) {
      const session = capture([edit, wrapped(script, [envelope(0, undefined, "npm test")])], source);
      expect(session.metrics.verificationEvents).toBe(0);
      expect(session.metrics.verificationClosure).toBe("missing");
    }
  });

  it.each(["codex", "copilot"] as const)("exposes only genuine shell operations from mixed %s wrappers", source => {
    for (const exit of [0, 1]) {
      const session = capture([edit, wrapped('text(await tools.web__run({search_query:[{q:"pytest npm test tsc"}]})); text(await tools.exec_command({cmd:"npm test"}));', [{ title: "documentation" }, envelope(exit)])], source);
      const original = session.turns.flatMap(turn => turn.toolCalls).at(-1)!;
      expect(isCommandTool(original)).toBe(false);
      expect(toolCommand(original)).toBeUndefined();
      const commands = expandToolCalls([original]).filter(isCommandTool);
      expect(commands.map(toolCommand)).toEqual(["npm test"]);
      expect(session.metrics.commandCalls).toBe(1);
      expect(session.metrics.verificationEvents).toBe(1);
      expect(session.metrics.verificationPassed).toBe(exit === 0 ? 1 : 0);
      expect(session.metrics.verificationClosure).toBe(exit === 0 ? "passed" : "failed");
    }
  });

  it.each(["Bash", "shell_command", "exec_command"])("preserves direct native %s shell strings", name => {
    const session = capture([edit, { name, args: "npm test", output: envelope(0) }]);
    const command = session.turns.flatMap(turn => turn.toolCalls).at(-1)!;
    expect(isCommandTool(command)).toBe(true);
    expect(toolCommand(command)).toBe("npm test");
    expect(session.metrics.verificationClosure).toBe("passed");
    const quoted = { ...command, arguments: 'echo "tools.exec_command({cmd: fake})"' };
    expect(isCommandTool(quoted)).toBe(true);
    expect(toolCommand(quoted)).toBe(quoted.arguments);
  });
});
