import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareDreamPacket } from "../src/dream/prepare.js";
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
    expect(selected.finalClaims.some((claim) => claim.text.includes("npm test passed") && claim.supported === true)).toBe(true);
  });
});
