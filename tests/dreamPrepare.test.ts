import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScanPacket, prepareDreamPacket } from "../src/dream/prepare.js";
import { scoreSession } from "../src/scoring/score.js";
import { writeJsonl } from "../src/fs/jsonl.js";
import { parseSessionFile } from "../src/normalize/parser.js";

const codexFixture = path.resolve("tests/fixtures/codex-events.jsonl");

describe("dream preparation", () => {
  it("turns normalized captured text into readable dream fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-dream-prepare-"));
    const index = path.join(root, "index");
    fs.mkdirSync(index, { recursive: true });
    const { session } = parseSessionFile(codexFixture, "codex");
    session.repoMatch = "matched";
    writeJsonl(path.join(index, "sessions.jsonl"), [session]);
    writeJsonl(path.join(index, "inefficiency-scores.jsonl"), []);

    const packet = prepareDreamPacket(root, 1);
    const selected = packet.selectedSessions[0];

    expect(typeof selected.userIntent).toBe("string");
    expect(selected.userIntent).toContain("Fix the scan report.");
    expect(typeof selected.finalAnswer).toBe("string");
    expect(selected.finalAnswer).toContain("Implemented scan capture");
    expect(selected.instructionChecks.some((instruction) => instruction.text.includes("Do not inspect the live repository"))).toBe(true);
    expect(selected.verificationClosure).toBe("missing");
    expect(selected.verificationChecks.some((check) => check.command?.includes("npm test") && check.fresh === false)).toBe(true);
    expect(selected.finalClaims.some((claim) => claim.text.includes("npm test passed") && claim.supported === false)).toBe(true);
  });
});


it("recomputes obsolete cached scores before Dream selection", () => {
  const root = fs.mkdtempSync(path.resolve("tests/.dream-cache-"));
  try {
    const { session } = parseSessionFile(codexFixture, "codex");
    session.repoMatch = "matched";
    session.lifecycleStatus = "completed";
    session.turns.forEach(turn => { turn.toolCalls = []; });
    session.finalAnswer = { text: "Finished." };
    const current = scoreSession(session);
    writeJsonl(path.join(root, "sessions.jsonl"), [session]);
    writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [{ ...current, scoringVersion: 3, outcomeScore: 65, inefficiencyScore: 0 }]);
    expect(loadScanPacket(root).scores[0]).toMatchObject({ scoringVersion: 4, outcomeScore: null, inefficiencyScore: null });
    expect(prepareDreamPacket(root, 1).selectedSessions).toEqual([]);
    writeJsonl(path.join(root, "inefficiency-scores.jsonl"), [current]);
    expect(loadScanPacket(root).scores).toEqual([current]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
