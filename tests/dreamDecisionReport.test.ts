import { describe, expect, it } from "vitest";
import { buildDreamDecisionReport } from "../src/dream/decisionReport.js";
import type {
  DreamChangeType,
  DreamEvidenceRef,
  DreamFinding,
  DreamPacket,
  DreamSession,
  DreamTaskWindow
} from "../src/dream/types.js";

function ref(sessionId: string, suffix: string): DreamEvidenceRef {
  return {
    id: `${sessionId}:${suffix}`,
    sessionId,
    sourceFile: `C:\\frozen\\${sessionId}.jsonl`,
    lineNumber: 10,
    eventType: "response_item",
    summary: suffix
  };
}

function task(sessionId: string, taskId: string, changeType: DreamChangeType, verified: boolean): DreamTaskWindow {
  const changeRef = ref(sessionId, `${taskId}:change`);
  const verificationRef = ref(sessionId, `${taskId}:verification`);
  return {
    taskId,
    label: "Task 1",
    intent: changeType === "automation_memory" ? "Automation: Luna OS v2 issue worker" : "Implement the parser fix",
    startedAt: "2026-07-14T06:00:00.000Z",
    endedAt: "2026-07-14T06:30:00.000Z",
    segmentationConfidence: "high",
    turnIds: [`${taskId}:turn`],
    changes: [
      {
        changeId: `${taskId}:change`,
        actionIndex: 2,
        changeType,
        target: changeType === "automation_memory" ? "$CODEX_HOME/automations/worker/memory.md" : "src/parser.ts",
        stateChanging: true,
        verificationRequired: true,
        acceptableVerificationTypes: changeType === "automation_memory" ? ["read_back"] : ["test", "build"],
        repositoryTestsRelevant: changeType === "product_code",
        confidence: "high",
        evidence: [`classified ${changeType}`],
        evidenceRefs: [changeRef]
      }
    ],
    verificationChecks: verified
      ? [
          {
            command: changeType === "automation_memory" ? "Get-Content memory.md" : "npm test",
            verificationType: changeType === "automation_memory" ? "read_back" : "test",
            actionIndex: 3,
            fresh: true,
            status: "passed",
            evidenceRefs: [verificationRef]
          }
        ]
      : [],
    finalAnswer: "Completed the task.",
    finalClaims: [],
    evidenceRefs: [changeRef, ...(verified ? [verificationRef] : [])]
  };
}

function session(sessionId: string, repoRoot: string, taskWindow: DreamTaskWindow): DreamSession {
  return {
    sessionId,
    source: "codex",
    repoRoot,
    repoMatch: "matched",
    startedAt: taskWindow.startedAt,
    endedAt: taskWindow.endedAt,
    lifecycleStatus: "completed",
    sourceFiles: [`C:\\frozen\\${sessionId}.jsonl`],
    role: "failed_or_risky",
    classification: "suspicious",
    inefficiencyScore: 60,
    outcomeScore: 60,
    reasonCodes: [],
    metrics: { taskStarts: 1, editCalls: 1 },
    declaredIntents: [],
    userIntent: taskWindow.intent,
    instructionChecks: [],
    finalAnswer: taskWindow.finalAnswer,
    finalClaims: [],
    verificationChecks: taskWindow.verificationChecks,
    commands: taskWindow.verificationChecks.map((check) => check.command ?? "unknown"),
    evidenceRefs: taskWindow.evidenceRefs,
    missingEvidence: [],
    tasks: [taskWindow]
  };
}

function finding(
  findingId: string,
  sessionId: string,
  taskId: string,
  patternKey: string,
  disposition: DreamFinding["disposition"],
  applyTarget: string,
  recommendedAction: string
): DreamFinding {
  return {
    findingId,
    patternKey,
    sessionId,
    taskId,
    severity: "high",
    category: "Verification quality",
    title: "Changes lack matching verification",
    disposition,
    observation: "An edit-like action was captured.",
    interpretation: disposition === "possible_false_positive" ? "Dream may have classified the target incorrectly." : "Fresh verification is missing.",
    alternativeExplanation: "The action may not represent a product-code change.",
    recommendedAction,
    applyTarget,
    explanation: "Frozen evidence requires a scoped decision.",
    evidenceRefs: [ref(sessionId, `${taskId}:finding`)],
    confidence: "high",
    suggestedImprovement: recommendedAction
  };
}

function packet(selectedSessions: DreamSession[]): DreamPacket {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-14T08:00:00.000Z",
    sourceScanPaths: ["frozen-scan"],
    evidenceBoundary: "packet only",
    selectedSessions,
    omittedSessions: []
  };
}

describe("Dream decision report", () => {
  it("groups repeated possible false positives and routes measurement fixes to Dream", () => {
    const firstTask = task("session-1", "task-1", "automation_memory", true);
    const secondTask = task("session-2", "task-1", "automation_memory", true);
    const findings = [
      finding(
        "VER-001",
        "session-1",
        "task-1",
        "verification.missing.automation_memory",
        "possible_false_positive",
        "Dream analyzer",
        "Classify automation memory before evaluating verification."
      ),
      finding(
        "VER-002",
        "session-2",
        "task-1",
        "verification.missing.automation_memory",
        "possible_false_positive",
        "Dream analyzer",
        "Classify automation memory before evaluating verification."
      )
    ];

    const result = buildDreamDecisionReport({
      packet: packet([
        session("session-1", "C:\\Repo\\LunaOs_2", firstTask),
        session("session-2", "C:\\Repo\\LunaOs_2", secondTask)
      ]),
      scores: [],
      findings,
      ignoredInstructions: [],
      unsupportedClaims: [],
      missingEvidence: []
    });

    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].dispositionCounts.possible_false_positive).toBe(2);
    expect(result.markdown.match(/### Changes lack matching verification/g)).toHaveLength(1);
    expect(result.markdown).toContain("Possible false positives: **2**");
    expect(result.markdown).toContain("Luna OS v2 issue triage, 14 July 2026");
    expect(result.markdown).toContain("not representative");
    expect(result.applyPlan.findings.every((item) => item.actionClass === "analyzer_improvement")).toBe(true);
    expect(result.applyPlan.findings.every((item) => item.recommendedTarget === "Dream analyzer")).toBe(true);
    expect(result.detailsMarkdown).toContain("## Change classifications");
    expect(result.detailsMarkdown).toContain("task-1:change");
    expect(result.detailsMarkdown).toContain("## Evidence reference catalog");
  });

  it("permits a repository-specific guidance update only after repeated reliable task evidence", () => {
    const firstTask = task("session-1", "task-1", "product_code", false);
    const secondTask = task("session-2", "task-1", "product_code", false);
    const findings = [
      finding(
        "VER-001",
        "session-1",
        "task-1",
        "verification.missing.product_code",
        "reliable",
        "Example AGENTS.md",
        "Add a fresh product-code verification rule."
      ),
      finding(
        "VER-002",
        "session-2",
        "task-1",
        "verification.missing.product_code",
        "reliable",
        "Example AGENTS.md",
        "Add a fresh product-code verification rule."
      )
    ];
    const result = buildDreamDecisionReport({
      packet: packet([
        session("session-1", "C:\\Repo\\Example", firstTask),
        session("session-2", "C:\\Repo\\Example", secondTask)
      ]),
      scores: [],
      findings,
      ignoredInstructions: [],
      unsupportedClaims: [],
      missingEvidence: []
    });

    expect(result.applyPlan.findings.every((item) => item.actionClass === "safe_guidance_update")).toBe(true);
    expect(result.markdown).toContain("Proposed guidance changes: **1**");
    expect(result.overallConfidence).toBe("high");
  });

  it("does not generalize shared guidance from a cross-repository stratified sample", () => {
    const firstTask = task("session-1", "task-1", "product_code", false);
    const secondTask = task("session-2", "task-1", "product_code", false);
    const findings = [
      finding(
        "VER-001",
        "session-1",
        "task-1",
        "verification.missing.product_code",
        "reliable",
        "Shared AGENTS.md guidance",
        "Add a shared verification rule."
      ),
      finding(
        "VER-002",
        "session-2",
        "task-1",
        "verification.missing.product_code",
        "reliable",
        "Shared AGENTS.md guidance",
        "Add a shared verification rule."
      )
    ];
    const result = buildDreamDecisionReport({
      packet: packet([
        session("session-1", "C:\\Repo\\One", firstTask),
        session("session-2", "C:\\Repo\\Two", secondTask)
      ]),
      scores: [],
      findings,
      ignoredInstructions: [],
      unsupportedClaims: [],
      missingEvidence: []
    });

    expect(result.applyPlan.findings.every((item) => item.actionClass === "repository_specific_investigation")).toBe(true);
    expect(result.markdown).toContain("Proposed guidance changes: **0**");
    expect(result.applyPlan.sample.representative).toBe(false);
  });
});
