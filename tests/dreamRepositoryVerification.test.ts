import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonl } from "../src/fs/jsonl.js";
import { parseSessionFile } from "../src/normalize/parser.js";
import { analyzeDreamTasks } from "../src/dream/analyze.js";
import { normalizeEventsToSession } from "../src/normalize/sessions.js";
import type { RawLogEvent } from "../src/normalize/types.js";
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

  it("uses git -C when scoping diff verification", () => {
    const task = analyzeDreamTasks(dreamCapture("/repo/a", "git -C /repo/b diff --check"))[0];
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
