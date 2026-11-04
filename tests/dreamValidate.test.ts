import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDreamPacket, writeDreamValidationReport } from "../src/dream/validate.js";
import type { DreamPacket, DreamSession } from "../src/dream/types.js";

function session(overrides: Partial<DreamSession>): DreamSession {
  const result: DreamSession = {
    sessionId: "session-1",
    source: "codex",
    repoRoot: "C:\\Repo\\Example",
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
  if (!overrides.tasks) {
    // These synthetic checks ran in the same explicitly recorded repository as the edit.
    const executionScope = result.repoRoot;
    const verificationChecks = result.verificationChecks.map((check, index) => ({
      ...check,
      target: check.target ?? (executionScope ? `repo:${executionScope}` : undefined),
      lane: check.lane ?? (executionScope && check.command ? `${executionScope}:${check.command}` : undefined),
      actionIndex: check.actionIndex ?? index + 2,
      fresh: check.fresh ?? true
    }));
    result.tasks = [
      {
        taskId: `${result.sessionId}:task:1`,
        label: "Example product-code task",
        intent: result.userIntent ?? "Update the application.",
        segmentationConfidence: "high",
        turnIds: ["turn-1"],
        changes: [
          {
            changeId: `${result.sessionId}:task:1:change:1`,
            actionIndex: 1,
            changeType: "product_code",
            target: executionScope ? path.win32.join(executionScope, "src", "app.ts") : undefined,
            executionScope,
            stateChanging: true,
            verificationRequired: true,
            acceptableVerificationTypes: ["test", "build", "lint", "typecheck", "diff_check"],
            repositoryTestsRelevant: true,
            confidence: "high",
            evidence: ["explicit product-code test target"],
            evidenceRefs: result.evidenceRefs
          }
        ],
        verificationChecks,
        finalAnswer: result.finalAnswer,
        finalClaims: result.finalClaims,
        evidenceRefs: result.evidenceRefs
      }
    ];
    result.verificationChecks = verificationChecks;
  }
  return result;
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

    expect(report.markdown).toContain("# LunaObs Dream Decision Report");
    expect(report.markdown).toContain("Explicit instruction was violated");
    expect(report.markdown).toContain("Do not run tests.");
    expect(report.markdown).toContain("All tests passed.");
    expect(report.markdown).toContain("Required verification is missing after the final relevant change");
    expect(report.markdown).toContain("Reliable findings: **3**");
    expect(report.detailsMarkdown).toContain("## Inspected sessions");
    expect(report.detailsMarkdown).toContain("## Atomic findings");
    expect(report.detailsMarkdown).toContain("session-1");
    expect(report.html).toContain("<!doctype html>");
    expect(report.html).toContain("0 is best and 100 is worst");
    expect(report.html).toContain("Dream Apply Backlog");
    expect(report.markdown).toContain("## Finding patterns");
    expect(report.applyPlan.findings.some((finding) => finding.recommendedTarget.includes("Example"))).toBe(true);
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
    const details = fs.readFileSync(path.join(dreamDir, "details.md"), "utf8");
    const applyPlan = JSON.parse(fs.readFileSync(path.join(dreamDir, "apply-plan.json"), "utf8")) as {
      schemaVersion: number;
      findings: Array<{ findingId: string; actionClass: string; evidenceRefs: unknown[] }>;
    };

    expect(report).toContain("Final-answer claim lacks frozen evidence");
    expect(report).toContain("final answer evidence was not captured");
    expect(html).toContain("Frozen Evidence Review");
    expect(html).toContain("All tests passed and the feature is complete.");
    expect(details).toContain("## Evidence reference catalog");
    expect(details).toContain("All tests passed and the feature is complete.");
    expect(applyPlan.schemaVersion).toBe(1);
    expect(applyPlan.findings.every((finding) => finding.findingId && finding.actionClass && Array.isArray(finding.evidenceRefs))).toBe(true);
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
    expect(report.markdown).toContain("not evidence of a current application defect");
    expect(report.markdown).not.toContain("Relevant verification ended with a failure");
    expect(report.html).toContain("Recovered attempts");
  });

  it("reports an unresolved matching failure separately from a recovered task", () => {
    const report = validateDreamPacket(
      packet([
        session({
          sessionId: "failed-session",
          metrics: {
            turns: 1,
            toolRequests: 2,
            editCalls: 1,
            verificationEvents: 1,
            verificationPassed: 0,
            verificationFailed: 1,
            failedCommands: 1,
            repeatedFileViews: 0,
            globCalls: 0
          },
          verificationChecks: [{ command: "npm test", verificationType: "test", status: "failed" }]
        }),
        session({
          sessionId: "recovered-session",
          verificationChecks: [
            { command: "npm test", verificationType: "test", status: "failed" },
            { command: "npm test", verificationType: "test", status: "passed" }
          ]
        })
      ])
    );

    expect(report.markdown).toContain("Relevant verification ended with a failure");
    expect(report.markdown).toContain("Verification had failed attempts that were later recovered");
    expect(report.detailsMarkdown).toContain("failed-session");
    expect(report.detailsMarkdown).toContain("recovered-session");
    expect(report.html).toContain("Recommended action:");
  });

  it.each(["missing edit scope", "missing check target", "foreign check scope"])(
    "does not infer recovery from %s",
    (missingEvidence) => {
      const captured = session({
        verificationChecks: [
          { command: "npm test", status: "failed" },
          { command: "npm test", status: "passed" }
        ]
      });
      const task = captured.tasks![0];
      if (missingEvidence === "missing edit scope") task.changes[0].executionScope = undefined;
      for (const check of task.verificationChecks) {
        if (missingEvidence === "missing check target") check.target = undefined;
        if (missingEvidence === "foreign check scope") check.target = "repo:C:\\Repo\\Other";
      }

      const report = validateDreamPacket(packet([captured]));

      expect(report.markdown).toContain("Required verification is missing after the final relevant change");
      expect(report.markdown).not.toContain("Verification had failed attempts that were later recovered");
    }
  );

  it("keeps unknown instruction evidence unscored and avoids double-negation false positives", () => {
    const report = validateDreamPacket(
      packet([
        session({
          instructionChecks: [{ text: "Do not stop without running tests.", status: "unknown" }],
          commands: ["npm test"]
        })
      ])
    );
    const instructionScore = report.scores.find((score) => score.category === "Instruction adherence");
    expect(instructionScore?.score).toBeNull();
    expect(report.markdown).not.toContain("violated: Do not stop without running tests.");
  });

  it("infers a captured positive test requirement only when matching evidence exists", () => {
    const report = validateDreamPacket(
      packet([
        session({
          instructionChecks: [{ text: "You must run tests before completion.", status: "unknown" }],
          commands: ["npm test"]
        })
      ])
    );
    const instructionScore = report.scores.find((score) => score.category === "Instruction adherence");
    expect(instructionScore?.score).toBe(5);
  });

  it("targets recommendations to the evidenced repository without hardcoded project guidance", () => {
    const report = validateDreamPacket(packet([session({ repoRoot: "C:\\Repo\\Acme", verificationClosure: "missing" })]));
    expect(report.markdown).toContain("Acme repository verification guidance");
    expect(report.applyPlan.findings.some((finding) => finding.actionClass === "repository_specific_investigation")).toBe(true);
    expect(report.markdown).not.toContain("Satori");
  });

  it("keeps a single Godot failure repository-specific instead of generalizing guidance", () => {
    const passingOnly = validateDreamPacket(
      packet([
        session({
          repoRoot: "C:\\Repo\\Satori",
          commands: [".\\tools\\godot.ps1 -Command parse"],
          verificationChecks: [{ command: ".\\tools\\godot.ps1 -Command parse", verificationType: "test", status: "passed" }]
        })
      ])
    );
    expect(passingOnly.markdown).not.toContain("Godot validation guidance");

    const failed = validateDreamPacket(
      packet([
        session({
          repoRoot: "C:\\Repo\\Satori",
          commands: [".\\tools\\godot.ps1 -Command parse"],
          verificationChecks: [{ command: ".\\tools\\godot.ps1 -Command parse", verificationType: "test", status: "failed" }]
        })
      ])
    );
    expect(failed.markdown).toContain("Relevant verification ended with a failure");
    expect(failed.markdown).toContain("Satori repository verification guidance");
    expect(failed.markdown).not.toContain("Godot validation guidance");
    expect(failed.applyPlan.findings.some((finding) => finding.actionClass === "repository_specific_investigation")).toBe(true);
  });
});
