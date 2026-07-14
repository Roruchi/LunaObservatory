import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDreamPacket, writeDreamValidationReport } from "../src/dream/validate.js";
import type { DreamPacket, DreamSession } from "../src/dream/types.js";

function session(overrides: Partial<DreamSession>): DreamSession {
  return {
    sessionId: "session-1",
    source: "codex",
    repoMatch: "matched",
    sourceFiles: [],
    role: "failed_or_risky",
    selectionReason: "test",
    classification: "suspicious",
    inefficiencyScore: 80,
    outcomeScore: 60,
    reasonCodes: [],
    metrics: {
      turns: 3,
      toolRequests: 5,
      editCalls: 1,
      verificationEvents: 0,
      verificationPassed: 0,
      verificationFailed: 0,
      failedCommands: 0,
      repeatedFileViews: 0,
      globCalls: 0
    },
    declaredIntents: [],
    instructionChecks: [],
    finalClaims: [],
    verificationChecks: [],
    commands: [],
    evidenceRefs: [
      {
        id: "session-1:metric:editCalls",
        sessionId: "session-1",
        metric: "editCalls",
        summary: "editCalls=1"
      }
    ],
    missingEvidence: [],
    ...overrides
  };
}

function packet(selectedSessions: DreamSession[]): DreamPacket {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-07T00:00:00.000Z",
    sourceScanPaths: ["scan-fixture"],
    evidenceBoundary: "packet only",
    selectedSessions,
    omittedSessions: []
  };
}

describe("dream validation", () => {
  it("reports ignored instructions, unsupported claims, and verification gaps", () => {
    const report = validateDreamPacket(
      packet([
        session({
          instructionChecks: [{ text: "Do not run tests.", status: "violated" }],
          finalClaims: [{ text: "All tests passed.", supported: false }],
          commands: ["npm test"]
        })
      ])
    );

    expect(report.markdown).toContain("## Ignored or weakened instructions");
    expect(report.markdown).toContain("violated: Do not run tests.");
    expect(report.markdown).toContain("## Unsupported claims");
    expect(report.markdown).toContain("All tests passed.");
    expect(report.markdown).toContain("Changes were made without frozen verification evidence");
    expect(report.markdown).toContain("## What Was Inspected");
    expect(report.markdown).toContain("Inefficiency (0 best, 100 worst)");
    expect(report.markdown).toContain("session inefficiency is 0 best / 100 worst");
    expect(report.markdown).toContain("| session-1 |");
    expect(report.html).toContain("<!doctype html>");
    expect(report.html).toContain("0 is best and 100 is worst");
    expect(report.html).toContain("Dream Apply Backlog");
    expect(report.markdown).toContain("## Dream Apply Backlog");
    expect(report.markdown).toContain("AGENTS.md");
  });

  it("does not depend on live repository files to support claims", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-dream-live-"));
    const liveFile = path.join(root, "LIVE_REPO_EVIDENCE.md");
    fs.writeFileSync(liveFile, "All tests passed and the feature is complete.\n", "utf8");
    const dreamDir = path.join(root, "dream");
    fs.mkdirSync(dreamDir);
    fs.writeFileSync(
      path.join(dreamDir, "dream-pack.json"),
      `${JSON.stringify(
        packet([
          session({
            sourceFiles: [liveFile],
            finalClaims: [{ text: "All tests passed and the feature is complete." }],
            missingEvidence: ["final answer evidence was not captured"]
          })
        ]),
        null,
        2
      )}\n`,
      "utf8"
    );

    const reportPath = writeDreamValidationReport(dreamDir, path.join(dreamDir, "report.md"));
    const report = fs.readFileSync(reportPath, "utf8");
    const html = fs.readFileSync(path.join(dreamDir, "report.html"), "utf8");

    expect(report).toContain("Final-answer claim lacks frozen evidence");
    expect(report).toContain("final answer evidence was not captured");
    expect(html).toContain("Frozen Evidence Review");
    expect(html).toContain("All tests passed and the feature is complete.");
  });

  it("distinguishes recovered verification failures from unresolved failures", () => {
    const report = validateDreamPacket(
      packet([
        session({
          metrics: {
            turns: 2,
            toolRequests: 2,
            editCalls: 1,
            verificationEvents: 2,
            verificationPassed: 1,
            verificationFailed: 1,
            failedCommands: 1,
            repeatedFileViews: 0,
            globCalls: 0
          },
          verificationChecks: [
            { command: "npm test", status: "failed" },
            { command: "npm test", status: "passed" }
          ]
        })
      ])
    );

    expect(report.markdown).toContain("Verification had failed attempts that were later recovered");
    expect(report.markdown).toContain("This is not automatically a code bug");
    expect(report.markdown).not.toContain("Verification ended with unresolved failure evidence");
    expect(report.html).toContain("Recovered attempts");
  });

  it("reports unresolved and recovered verification lanes separately", () => {
    const report = validateDreamPacket(
      packet([
        session({
          metrics: {
            turns: 2,
            toolRequests: 4,
            editCalls: 1,
            verificationEvents: 4,
            verificationPassed: 1,
            verificationFailed: 2,
            failedCommands: 2,
            repeatedFileViews: 0,
            globCalls: 0
          },
          verificationChecks: [
            { command: "pwsh ./check-errors.ps1", status: "failed" },
            { command: "npm test", status: "failed" },
            { command: "npm test", status: "passed" }
          ]
        })
      ])
    );

    expect(report.markdown).toContain("Verification ended with unresolved failure evidence");
    expect(report.markdown).toContain("pwsh ./check-errors.ps1");
    expect(report.markdown).toContain("Verification had failed attempts that were later recovered");
    expect(report.markdown).toContain("What to do:");
    expect(report.markdown).toContain("Recovered failed attempts: npm test");
    expect(report.html).toContain("What to do:");
  });
});
