import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonl } from "../src/fs/jsonl.js";
import { parseSessionFile } from "../src/normalize/parser.js";
import { scoreSession } from "../src/scoring/score.js";
import { prepareDreamPacket } from "../src/dream/prepare.js";
import { validateDreamPacket } from "../src/dream/validate.js";

describe("repository verification through Scan and Dream", () => {
  it.each(["passed", "failed", "stale"] as const)("preserves %s nested checks through preparation and validation", status => {
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
      call("checks", "exec", 'text(await tools.exec_command({cmd:"npm test"})); text(await tools.exec_command({cmd:"npm run build"}));', JSON.stringify([
        { exit_code: status === "failed" ? 1 : 0, output: "test result" },
        { exit_code: status === "failed" ? 1 : 0, output: "build result" }
      ]));
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
      if (status === "failed") expect(gaps[0].title).toBe("Relevant verification ended with a failure");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
