import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonl } from "../src/fs/jsonl.js";
import { parseSessionFile } from "../src/normalize/parser.js";
import { analyzeDreamTasks } from "../src/dream/analyze.js";
import { normalizeEventsToSession } from "../src/normalize/sessions.js";
import type { NormalizedSession, RawLogEvent } from "../src/normalize/types.js";
import { scoreSession } from "../src/scoring/score.js";
import { prepareDreamPacket } from "../src/dream/prepare.js";
import { validateDreamPacket } from "../src/dream/validate.js";

describe("repository verification through Scan and Dream", () => {
  it.each([
    { name: "passed", status: "passed", checks: [["npm test", 0], ["npm run build", 0]] },
    { name: "failed", status: "failed", checks: [["npm test", 1], ["npm run build", 1]] },
    { name: "stale", status: "stale", checks: [["npm test", 0], ["npm run build", 0]] },
    { name: "failed test then passing build", status: "failed", checks: [["npm test", 1], ["npm run build", 0]] },
    { name: "failed build then passing test", status: "failed", checks: [["npm run build", 1], ["npm test", 0]] },
    { name: "same-lane recovery", status: "passed", checks: [["npm test", 1], ["npm test", 0]] },
    { name: "same-type distinct command", status: "failed", checks: [["npm test -- unit", 1], ["npm test -- integration", 0]] },
    { name: "distinct workdir", status: "failed", checks: [["npm test", 1, "a"], ["npm test", 0, "b"]] }
  ] as const)("preserves $name nested checks through preparation and validation", ({ status, checks }) => {
    const root = fs.mkdtempSync(path.resolve("tests/.dream-repository-"));
    try {
      const events: unknown[] = [];
      const add = (type: string, payload: unknown) => events.push({
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, events.length)).toISOString(), type, payload
      });
      add("session_meta", { id: "verified-worker", cwd: root });
      add("turn_context", { turn_id: "one", cwd: root });
      add("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix map.ts." }] });
      const call = (id: string, name: string, args: unknown, output: unknown) => {
        add("response_item", { type: "function_call", call_id: id, name, arguments: JSON.stringify(args), turn_id: "one" });
        add("response_item", { type: "function_call_output", call_id: id, output, turn_id: "one" });
      };
      const edit = () => call("edit", "apply_patch", "*** Begin Patch\n*** Update File: map.ts\n@@\n-old\n+new\n*** End Patch", "Success");
      if (status !== "stale") edit();
      call("checks", "exec", checks.map(([cmd, , workdir]) =>
        `text(await tools.exec_command(${JSON.stringify({ cmd, workdir })}));`
      ).join(" "), JSON.stringify(checks.map(([, exit_code]) => ({ exit_code, output: "check result" }))));
      if (status === "stale") edit();
      add("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished." }] });
      const transcript = path.join(root, "events.jsonl");
      writeJsonl(transcript, events);
      const { session } = parseSessionFile(transcript, "codex");
      session.repoMatch = "matched";
      session.lifecycleStatus = "completed";
      const score = scoreSession(session);
      expect(session.metrics.verificationClosure).toBe(status === "stale" ? "missing" : status);
      if (status === "passed") expect(score.outcomeScore).toBeGreaterThanOrEqual(80);
      fs.mkdirSync(path.join(root, "index"));
      writeJsonl(path.join(root, "index", "sessions.jsonl"), [session]);
      writeJsonl(path.join(root, "index", "inefficiency-scores.jsonl"), [score]);
      const packet = prepareDreamPacket(root, 1);
      expect(packet.selectedSessions).toHaveLength(1);
      expect(packet.selectedSessions[0].verificationChecks).toHaveLength(2);
      expect(packet.selectedSessions[0].verificationChecks.every(check => check.target?.startsWith("repo:"))).toBe(true);
      const report = validateDreamPacket(packet);
      expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(status === "passed" ? 5 : 0);
      const gaps = report.findings.filter(finding => finding.category === "Verification quality" && finding.severity === "high");
      expect(gaps).toHaveLength(status === "passed" ? 0 : 1);
      if (status === "failed") {
        expect(gaps[0].title).toBe("Relevant verification ended with a failure");
        expect(report.findings.some(finding => finding.title === "Verification had failed attempts that were later recovered")).toBe(false);
      }
      if (checks[0][1] === 1 && status === "passed") {
        expect(report.findings.some(finding => finding.title === "Verification had failed attempts that were later recovered")).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function dreamCapture(root: string | undefined, command: string, workdir?: string, exitCode = 0, stdout = "check result") {
  const events: RawLogEvent[] = [];
  const add = (type: string, data: unknown) => events.push({
    id: `event-${events.length}`, type, data,
    timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, events.length)).toISOString(),
    sourceFile: "fictional.jsonl", lineNumber: events.length + 1
  });
  if (root) add("session_meta", { id: "worker", cwd: root });
  add("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the repository." }] });
  add("response_item", {
    type: "function_call", call_id: "wrapper", name: "exec", turn_id: "one",
    arguments: JSON.stringify(`await tools.apply_patch("*** Begin Patch\\n*** Update File: ${root ? `${root}/` : ""}${command.includes("docs:build") ? "docs/guide.md" : "map.ts"}\\n@@\\n-old\\n+new\\n*** End Patch"); text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir })}));`)
  });
  add("response_item", { type: "function_call_output", call_id: "wrapper", turn_id: "one", output: JSON.stringify({ exit_code: exitCode, output: stdout }) });
  const session = normalizeEventsToSession(events, "codex", "fictional.jsonl");
  session.repoRoot = root;
  session.repoMatch = "matched";
  session.lifecycleStatus = "completed";
  return session;
}

describe("Dream authoritative outcomes and repository scope", () => {
  it.each([0, 1])("uses exit %s despite deceptive sibling stdout", exit => {
    const session = dreamCapture("/repo/a", "npm test", undefined, exit, exit === 0 ? "Exit code: 1; Script failed; patch failed" : "Exit code: 0");
    const task = analyzeDreamTasks(session)[0];
    expect(task.changes[0].stateChanging).toBe(true);
    expect(task.verificationChecks[0]).toMatchObject({ status: exit === 0 ? "passed" : "failed", fresh: true });
  });

  it.each(["npm test", "npm run typecheck", "npm run lint", "npm run docs:build", "npm run build", "git diff --check"])("scopes %s to its execution context", command => {
    for (const [root, cmd, workdir, matches] of [
      ["/repo/a", command, undefined, true],
      ["/repo/a", command, "/repo/a", true],
      ["/repo/a", command, "packages/ui", true],
      ["/repo/a", command, "/repo/b", false],
      ["/repo/a", command, "../b", false],
      ["/repo/a", command, "/other/a", false],
      ["/repo/a", `cd /repo/b && ${command}`, "/repo/a", false],
      ["/repo/a", `cd /repo/a && ${command}`, "/repo/b", true],
      ["/repo/a", command, "$UNKNOWN", false],
      [undefined, command, undefined, false]
    ] as const) {
      const task = analyzeDreamTasks(dreamCapture(root, cmd, workdir))[0];
      expect(task.verificationChecks[0].fresh, `${root}: ${cmd} in ${workdir}`).toBe(matches);
      if (matches) expect(task.verificationChecks[0].target).toBe("repo:/repo/a");
    }
  });

  it.each(["", "rtk ", "rtk proxy "])("uses %sgit -C when scoping diff verification", prefix => {
    const task = analyzeDreamTasks(dreamCapture("/repo/a", `${prefix}git -C /repo/b diff --check`))[0];
    expect(task.verificationChecks[0]).toMatchObject({ target: "repo:/repo/b", fresh: false });
  });

  it.each([true, false])("validates only matching repository checks (matching=%s)", matching => {
    const root = fs.mkdtempSync(path.resolve("tests/.dream-scope-"));
    try {
      const session = dreamCapture("/repo/a", "npm test", matching ? "/repo/a" : "/repo/b", 0, "Exit code: 1; patch failed");
      writeJsonl(path.join(root, "sessions.jsonl"), [session]);
      writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [scoreSession(session)]);
      const packet = prepareDreamPacket(root, 1);
      expect(packet.selectedSessions).toHaveLength(1);
      if (!matching) {
        const check = packet.selectedSessions[0].tasks![0].verificationChecks[0];
        check.fresh = true;
      }
      const report = validateDreamPacket(packet);
      expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(matching ? 5 : 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("Dream native execution location", () => {
  it.each(["/linked/worktree/a", "/home/user/.codex/worktrees/deleted/a"])("keeps matching checks in %s after repository grouping", cwd => {
    const session = dreamCapture(cwd, "rtk npm test");
    session.repoRoot = "/repo/a";
    const task = analyzeDreamTasks(session)[0];
    expect(session.turns.flatMap(turn => turn.toolCalls)[0].executionCwd).toBe(cwd);
    expect(task.changes[0]).toMatchObject({ target: `${cwd}/map.ts`, executionScope: cwd, changeType: "product_code", stateChanging: true });
    expect(task.verificationChecks[0]).toMatchObject({ target: `repo:${cwd}`, fresh: true, status: "passed" });
  });

  it("does not infer execution location from a grouped root", () => {
    const session = dreamCapture(undefined, "npm test");
    session.repoRoot = "/repo/a";
    const task = analyzeDreamTasks(session)[0];
    expect(task.changes[0].executionScope).toBeUndefined();
    expect(task.verificationChecks[0].target).toBeUndefined();
    expect(task.verificationChecks[0].fresh).toBe(false);
  });

  it("does not credit the main checkout for worktree edits", () => {
    const session = dreamCapture("/home/user/.codex/worktrees/deleted/a", "rtk proxy git -C /repo/a diff --check");
    session.repoRoot = "/repo/a";
    expect(analyzeDreamTasks(session)[0].verificationChecks[0].fresh).toBe(false);
  });

  it.each(["/linked/worktree/a", "/home/user/.codex/worktrees/deleted/a"])("validates frozen matching worktree evidence in %s", cwd => {
    const root = fs.mkdtempSync(path.resolve("tests/.dream-native-"));
    try {
      const session = dreamCapture(cwd, "rtk proxy npm test");
      session.repoRoot = "/repo/a";
      writeJsonl(path.join(root, "sessions.jsonl"), [session]);
      writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [scoreSession(session)]);
      const packet = prepareDreamPacket(root, 1);
      expect(packet.selectedSessions).toHaveLength(1);
      expect(validateDreamPacket(packet).scores.find(score => score.category === "Verification quality")?.score).toBe(5);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});


function nativeEvents(records: Array<[string, unknown]>): RawLogEvent[] {
  return records.map(([type, data], index) => ({
    id: `native-${index}`, type, data, sourceFile: "native.jsonl", lineNumber: index + 1,
    timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, index)).toISOString()
  }));
}

describe("native cwd provenance", () => {
  it.each(["/linked/a", "/repo/b"])("uses each Codex action context, including %s", checkCwd => {
    const session = normalizeEventsToSession(nativeEvents([
      ["session_meta", { id: "native-worker", cwd: "/repo/main" }],
      ["turn_context", { turn_id: "one", cwd: "/linked/a" }],
      ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix map.ts" }] }],
      ["response_item", { type: "function_call", call_id: "edit", name: "apply_patch", arguments: JSON.stringify("*** Begin Patch\n*** Update File: map.ts\n@@\n-old\n+new\n*** End Patch") }],
      ["response_item", { type: "function_call_output", call_id: "edit", output: "Success" }],
      ["turn_context", { turn_id: "one", cwd: checkCwd }],
      ["response_item", { type: "function_call", call_id: "check", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }],
      ["response_item", { type: "function_call_output", call_id: "check", output: { exit_code: 0, output: "Exit code: 1" } }]
    ]), "codex", "native.jsonl");
    session.repoRoot = "/repo/main";
    const tools = session.turns.flatMap(turn => turn.toolCalls);
    expect(tools.map(tool => tool.executionCwd)).toEqual(["/linked/a", checkCwd]);
    expect(tools.map(tool => tool.executionRoot)).toEqual(["/repo/main", "/repo/main"]);
    const task = analyzeDreamTasks(session)[0];
    expect(task.changes[0]).toMatchObject({ target: "/linked/a/map.ts", executionScope: "/linked/a", stateChanging: true });
    expect(task.verificationChecks[0]).toMatchObject({ target: `repo:${checkCwd}`, status: "passed", fresh: checkCwd === "/linked/a" });
  });

  it.each(["session", "start", "hook"])("retains Copilot %s cwd on tool completion", contextSource => {
    const events: Array<[string, unknown]> = [];
    if (contextSource === "session") events.push(["session.start", { context: { cwd: "/linked/a" } }]);
    events.push(["assistant.message", { turnId: "one", toolRequests: [{ toolCallId: "check", name: "shell_command", arguments: { command: "npm test" } }] }]);
    events.push(["tool.execution_start", { turnId: "one", toolCallId: "check", toolName: "shell_command", arguments: { command: "npm test" }, ...(contextSource === "start" ? { cwd: "/linked/a" } : {}) }]);
    if (contextSource === "hook") events.push(["hook.start", { turnId: "one", hookInvocationId: "hook", input: { cwd: "/linked/a", toolCalls: [{ id: "check", name: "shell_command", args: JSON.stringify({ command: "npm test" }) }] } }]);
    events.push(["tool.execution_complete", { turnId: "one", toolCallId: "check", success: true, output: "passed" }]);
    const session = normalizeEventsToSession(nativeEvents(events), "copilot", "native.jsonl");
    const tool = session.turns.flatMap(turn => turn.toolCalls)[0];
    expect(tool.executionCwd).toBe("/linked/a");
    expect(tool.executionRoot).toBe(contextSource === "session" ? "/linked/a" : undefined);
    expect(analyzeDreamTasks(session)[0].verificationChecks[0]).toMatchObject({ target: "repo:/linked/a", status: "passed" });
  });

  it("retains Claude tool-use cwd after grouping", () => {
    const { session } = parseSessionFile(path.resolve("tests/fixtures/claude-streaming.jsonl"), "claude");
    session.repoRoot = "/repo/main";
    expect(session.turns.flatMap(turn => turn.toolCalls).every(tool => tool.executionCwd === "/fictional/worktrees/nebula")).toBe(true);
    expect(analyzeDreamTasks(session)[0].verificationChecks[0]).toMatchObject({ target: "repo:/fictional/worktrees/nebula", fresh: true, status: "passed" });
  });
});


it("does not let one execution scope satisfy a sibling scope during frozen validation", () => {
  const root = fs.mkdtempSync(path.resolve("tests/.dream-siblings-"));
  try {
    const session = dreamCapture("/repo/a", "npm test");
    writeJsonl(path.join(root, "sessions.jsonl"), [session]);
    writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [scoreSession(session)]);
    const packet = prepareDreamPacket(root, 1);
    const task = packet.selectedSessions[0].tasks![0];
    const sibling = analyzeDreamTasks(dreamCapture("/repo/b", "npm test"))[0];
    task.changes.push({ ...sibling.changes[0], changeId: "sibling-change", actionIndex: 2 });
    expect(validateDreamPacket(packet).scores.find(score => score.category === "Verification quality")?.score).toBe(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


describe("execution cwd and native worktree scope", () => {
  it.each(["/repo/a", "/linked/worktree/a", "/home/user/.codex/worktrees/deleted/a"])("accepts root checks for child edits in %s", nativeRoot => {
    for (const [command, file] of [
      ["npm test", "map.ts"], ["npm run typecheck", "map.ts"], ["npm run lint", "map.ts"],
      ["npm run build", "map.ts"], ["npm run docs:build", "guide.md"], ["rtk proxy git diff --check", "map.ts"]
    ]) {
      const session = normalizeEventsToSession(nativeEvents([
        ["session_meta", { id: "root-worker", cwd: nativeRoot }],
        ["turn_context", { turn_id: "one", cwd: `${nativeRoot}/src` }],
        ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix and verify." }] }],
        ["response_item", { type: "function_call", call_id: "edit", name: "apply_patch", arguments: JSON.stringify(`*** Begin Patch\n*** Update File: ${file}\n*** End Patch`) }],
        ["response_item", { type: "function_call_output", call_id: "edit", output: "Success" }],
        ["response_item", { type: "function_call", call_id: "check", name: "exec_command", arguments: JSON.stringify({ cmd: command, workdir: nativeRoot }) }],
        ["response_item", { type: "function_call_output", call_id: "check", output: { exit_code: 0, output: "ok" } }]
      ]), "codex", "native.jsonl");
      session.repoRoot = "/grouped/main";
      const task = analyzeDreamTasks(session)[0];
      expect(task.changes[0]).toMatchObject({ executionScope: nativeRoot, target: `${nativeRoot}/src/${file}`, stateChanging: true });
      expect(task.verificationChecks[0], command).toMatchObject({ target: `repo:${nativeRoot}`, fresh: true, status: "passed" });
    }
  });

  it("keeps different native cwd lanes distinct through frozen Dream validation", () => {
    const root = fs.mkdtempSync(path.resolve("tests/.dream-lanes-"));
    try {
      const session = dreamCapture("/repo/a", "npm test", undefined, 1);
      const second = dreamCapture("/repo/a", "npm test");
      const secondCall = second.turns.flatMap(turn => turn.toolCalls)[0];
      secondCall.toolCallId = "second-wrapper";
      secondCall.name = "exec_command";
      secondCall.arguments = { cmd: "npm test" };
      secondCall.commandResults = [{ status: "completed" }];
      secondCall.executionCwd = "/repo/a/packages/ui";
      session.turns.at(-1)!.toolCalls.push(secondCall);
      writeJsonl(path.join(root, "sessions.jsonl"), [session]);
      writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [scoreSession(session)]);
      const packet = prepareDreamPacket(root, 1);
      const checks = packet.selectedSessions[0].tasks![0].verificationChecks;
      expect(checks.map(check => check.fresh)).toEqual([true, true]);
      expect(checks.map(check => check.status)).toEqual(["failed", "passed"]);
      expect(checks[0].lane).not.toBe(checks[1].lane);
      expect(validateDreamPacket(packet).scores.find(score => score.category === "Verification quality")?.score).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["view_image", "view", "glob", "imagegen_inspect", "shell_command"])("resolves relative filesystem verification for %s", name => {
    const session = dreamCapture("/repo/a", "npm test");
    const edit = session.turns.flatMap(turn => turn.toolCalls)[0];
    edit.name = "write_file";
    edit.arguments = { path: "images/chart.png" };
    const check = { ...edit, toolCallId: "file-check", name,
      arguments: name === "shell_command" ? { command: "cat images/chart.png" } : { path: "images/chart.png" }, outputText: "image contents" };
    session.turns.at(-1)!.toolCalls.push(check);
    const task = analyzeDreamTasks(session)[0];
    expect(task.changes[0].target).toBe("/repo/a/images/chart.png");
    expect(task.verificationChecks[0]).toMatchObject({ target: "/repo/a/images/chart.png", fresh: name === "view_image" || name === "view" || name === "imagegen_inspect" || name === "shell_command" });
    check.executionCwd = "/repo/b";
    expect(analyzeDreamTasks(session)[0].verificationChecks[0].fresh).toBe(false);
    check.executionCwd = undefined;
    expect(analyzeDreamTasks(session)[0].verificationChecks[0].target).toBeUndefined();
  });
});


type CapturedCall = { name: string; args: unknown; output: unknown };
function captureVerificationCalls(calls: CapturedCall[]) {
  const records: Array<[string, unknown]> = [
    ["session_meta", { id: "coverage-worker", cwd: "/repo/a" }],
    ["turn_context", { turn_id: "one", cwd: "/repo/a" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Update and verify the files." }] }]
  ];
  for (const [index, call] of calls.entries()) records.push(
    ["response_item", { type: "function_call", call_id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.args) }],
    ["response_item", { type: "function_call_output", call_id: `call-${index}`, output: call.output }]
  );
  const session = normalizeEventsToSession(nativeEvents(records), "codex", "native.jsonl");
  session.repoMatch = "matched";
  session.lifecycleStatus = "completed";
  return session;
}

function frozenVerification(session: NormalizedSession) {
  const root = fs.mkdtempSync(path.resolve("tests/.dream-coverage-"));
  try {
    writeJsonl(path.join(root, "sessions.jsonl"), [session]);
    writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [scoreSession(session)]);
    const packet = prepareDreamPacket(root, 1);
    expect(packet.selectedSessions).toHaveLength(1);
    return { packet, report: validateDreamPacket(packet) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe("verification coverage boundaries", () => {
  it.each(["command", "cmd"])("rejects foreign Copilot JSON-string workdir for %s", field => {
    const args = JSON.stringify({ arguments: JSON.stringify({ [field]: "npm test", workdir: "/repo/b" }) });
    const session = normalizeEventsToSession(nativeEvents([
      ["session.start", { context: { cwd: "/repo/a" } }],
      ["tool.execution_start", { turnId: "one", toolCallId: "edit", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Update File: map.ts\n*** End Patch" }],
      ["tool.execution_complete", { turnId: "one", toolCallId: "edit", success: true, output: "Done" }],
      ["tool.execution_start", { turnId: "one", toolCallId: "check", toolName: "shell_command", arguments: args }],
      ["tool.execution_complete", { turnId: "one", toolCallId: "check", success: true, output: "passed" }]
    ]), "copilot", "native.jsonl");
    session.userIntent = { text: "Fix map.ts and verify." };
    session.repoMatch = "matched";
    session.lifecycleStatus = "completed";
    const { packet, report } = frozenVerification(session);
    expect(packet.selectedSessions[0].tasks![0].verificationChecks[0]).toMatchObject({ target: "repo:/repo/b", fresh: false, status: "passed" });
    expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(0);
  });

  it.each([
    { files: ["docs/a.md", "docs/b.md"], build: "npm run docs:build" },
    { files: ["package.json", "tsconfig.json"], build: "npm run build" }
  ])("requires coverage of every changed target in $files", ({ files, build }) => {
    const edit = (file: string): CapturedCall => ({ name: "apply_patch", args: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch`, output: "Done" });
    const read = (file: string): CapturedCall => ({ name: "view", args: { path: file }, output: "file contents" });
    const check: CapturedCall = { name: "exec_command", args: { cmd: build }, output: { exit_code: 0, output: "built" } };
    for (const [calls, expected] of [
      [[edit(files[0]), edit(files[1]), read(files[0])], 3],
      [[edit(files[0]), edit(files[1]), read(files[0]), read(files[1])], 5],
      [[edit(files[0]), read(files[0]), edit(files[1]), read(files[1])], 5],
      [[edit(files[0]), edit(files[1]), check], 5],
      [[edit(files[0]), read(files[0]), edit(files[0]), edit(files[1]), read(files[1])], 3],
      [[edit(files[0]), edit(files[1]), { ...check, args: { cmd: build, workdir: "/repo/b" } }], 0]
    ] as Array<[CapturedCall[], number]>) {
      const { report } = frozenVerification(captureVerificationCalls(calls));
      expect(report.scores.find(score => score.category === "Verification quality")?.score, JSON.stringify(calls)).toBe(expected);
    }
  });

  it.each([
    { target: "/tmp/output/result.bin", inspected: "/tmp/output", matches: true },
    { target: "/tmp/output", inspected: "/tmp/output/nested", matches: true },
    { target: "/tmp/output/result.bin", inspected: "/tmp/output2", matches: false },
    { target: "/tmp/output2/result.bin", inspected: "/tmp/output", matches: false }
  ])("shares local directory inspection matching for $target and $inspected", ({ target, inspected, matches }) => {
    const { packet, report } = frozenVerification(captureVerificationCalls([
      { name: "exec_command", args: { cmd: `cp /tmp/input.bin ${target}` }, output: { exit_code: 0, output: "copied" } },
      { name: "exec_command", args: { cmd: `ls ${inspected}` }, output: { exit_code: 0, output: "result.bin" } }
    ]));
    const task = packet.selectedSessions[0].tasks![0];
    expect(task.changes[0].changeType).toBe("local_file_organization");
    expect(task.verificationChecks[0].fresh).toBe(matches);
    expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(matches ? 5 : 0);
  });
});


it("uses wrapped execution context consistently in session metrics and frozen Dream", () => {
  for (const [cmd, target, matching] of [
    ["rtk proxy bash -lc 'cd /repo/b && npm test'", "repo:/repo/b", false],
    ["rtk proxy sh -c 'cd /repo/a/src && npm test'", "repo:/repo/a", true],
    ["rtk proxy bash -lc 'cd $TARGET && npm test'", undefined, false]
  ] as const) for (const exit of [0, 1]) {
    const session = dreamCapture("/repo/a", cmd, undefined, exit);
    expect(session.metrics.verificationClosure).toBe(matching ? exit === 0 ? "passed" : "failed" : "missing");
    const { packet, report } = frozenVerification(session);
    const check = packet.selectedSessions[0].tasks![0].verificationChecks[0];
    if (target === undefined) {
      expect(check).toBeUndefined();
    } else {
      expect(check.target).toBe(target);
      expect(check.fresh).toBe(matching);
    }
    expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(matching && exit === 0 ? 5 : 0);
  }
});


it.each(["Edit", "Write"])("checks native Claude %s targets before awarding verification", name => {
  const root = fs.mkdtempSync(path.resolve("tests/.claude-edit-scope-"));
  try {
    for (const target of ["/repo/a/map.ts", "/repo/b/map.ts"]) {
      const events = [
        { type: "assistant", uuid: "edit-request", message: { id: "edit-message", content: [{ type: "tool_use", id: "edit", name, input: { file_path: target, content: "changed" } }] } },
        { type: "user", uuid: "edit-result", message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "Done", is_error: false }] } },
        { type: "assistant", uuid: "check-request", message: { id: "check-message", content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "bash -lc 'npm test'" } }] } },
        { type: "user", uuid: "check-result", toolUseResult: { exitCode: 0 }, message: { content: [{ type: "tool_result", tool_use_id: "check", content: "Tests passed", is_error: false }] } }
      ].map((event, index) => ({ ...event, sessionId: "claude-scope", cwd: "/repo/a", timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, index)).toISOString() }));
      const transcript = path.join(root, "events.jsonl");
      writeJsonl(transcript, events);
      const { session } = parseSessionFile(transcript, "claude");
      session.lifecycleStatus = "completed";
      expect(session.metrics.verificationClosure).toBe(target.startsWith("/repo/a/") ? "passed" : "missing");
      expect(scoreSession(session).outcomeScore).toBe(target.startsWith("/repo/a/") ? 90 : 50);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


it("does not turn unsupported orchestration into frozen Dream verification", () => {
  const session = captureVerificationCalls([
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: map.ts\n*** End Patch", output: "Done" },
    { name: "exec", args: 'text(await tools.web__run({search_query:[{q:"pytest npm test tsc"}]}));', output: JSON.stringify({ exit_code: 0, output: "pytest" }) }
  ]);
  const { packet, report } = frozenVerification(session);
  expect(packet.selectedSessions[0].tasks![0].verificationChecks).toEqual([]);
  expect(session.metrics.verificationEvents).toBe(0);
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(0);
});


it.each(["rg -n pytest README.md", "grep 'npm test' README.md", "echo tsc", 'echo "cat docs/a.md"'])("does not turn command arguments into frozen verification: %s", cmd => {
  const session = captureVerificationCalls([
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: docs/a.md\n*** End Patch", output: "Done" },
    { name: "exec_command", args: { cmd }, output: { exit_code: 0, output: "matching text" } }
  ]);
  const { packet, report } = frozenVerification(session);
  expect(packet.selectedSessions[0].tasks![0].verificationChecks).toEqual([]);
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(0);
});

it("keeps unsupported read argument structures unknown", () => {
  const session = captureVerificationCalls([
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: docs/a.md\n*** End Patch", output: "Done" },
    { name: "exec", args: 'text(await tools.view({path:"docs/a.md",...options}));', output: "file contents" }
  ]);
  const { packet, report } = frozenVerification(session);
  expect(packet.selectedSessions[0].tasks![0].verificationChecks[0].target).toBeUndefined();
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(0);
});


it.each([
  ["test -f map.ts", false], ["CI=1 npm test", true], ["rtk CI=1 npm test", true],
  ["bash -c 'CI=1 npm test'", true], ["sh -c 'CI=1 npm test'", true], ["CI=$VALUE npm test", true]
])("uses the approved check policy in frozen Dream: %s", (cmd, verified) => {
  const session = dreamCapture("/repo/a", cmd);
  const { packet, report } = frozenVerification(session);
  expect(session.metrics.verificationClosure).toBe(verified ? "passed" : "missing");
  expect(packet.selectedSessions[0].tasks![0].verificationChecks.length).toBe(verified ? 1 : 0);
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(verified ? 5 : 0);
});


it.each([
  ["ROOT=$(git rev-parse --show-toplevel) npm test", true], ["ROOT=$OTHER npm test", true]
])("preserves opaque assignment bodies in frozen Dream: %s", (cmd, verified) => {
  const { packet, report } = frozenVerification(dreamCapture("/repo/a", cmd));
  expect(packet.selectedSessions[0].tasks![0].verificationChecks.length).toBe(verified ? 1 : 0);
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(verified ? 5 : 0);
});


it.each([true, false])("preserves option-bearing checks through frozen Dream (failed=%s)", failed => {
  const checks = failed ? [["pytest -q", 1], ["npm run build", 0]] as const : [["npm test -- --runInBand", 0]] as const;
  const session = captureVerificationCalls([
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: map.ts\n*** End Patch", output: "Done" },
    ...checks.map(([cmd, exit_code]) => ({ name: "exec_command", args: { cmd }, output: { exit_code, output: "check result" } }))
  ]);
  const { packet, report } = frozenVerification(session);
  expect(session.metrics.verificationClosure).toBe(failed ? "failed" : "passed");
  expect(packet.selectedSessions[0].tasks![0].verificationChecks.map(check => check.status)).toEqual(failed ? ["failed", "passed"] : ["passed"]);
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(failed ? 0 : 5);
});


it.each(["TEST_SUITE=integration npm test", "TEST_SUITE=$SUITE npm test", "bash -c 'TEST_SUITE=integration npm test'"])("preserves assignment-selected failures in frozen Dream: %s", later => {
  const opaque = later.includes("$SUITE");
  const session = captureVerificationCalls([
    { name: "apply_patch", args: "*** Begin Patch\n*** Update File: map.ts\n*** End Patch", output: "Done" },
    { name: "exec_command", args: { cmd: opaque ? "TEST_SUITE=$SUITE npm test" : "TEST_SUITE=unit npm test" }, output: { exit_code: 1, output: "failed" } },
    { name: "exec_command", args: { cmd: later }, output: { exit_code: 0, output: "passed" } }
  ]);
  const { packet, report } = frozenVerification(session);
  const checks = packet.selectedSessions[0].tasks![0].verificationChecks;
  expect(checks[0].lane).not.toBe(checks[1].lane);
  expect(session.metrics.verificationClosure).toBe("failed");
  expect(report.scores.find(score => score.category === "Verification quality")?.score).toBe(0);
});
