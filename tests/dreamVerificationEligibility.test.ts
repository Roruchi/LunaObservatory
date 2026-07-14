import { describe, expect, it } from "vitest";
import { validateDreamPacket } from "../src/dream/validate.js";
import type {
  DreamChangeClassification,
  DreamChangeType,
  DreamEvidenceRef,
  DreamPacket,
  DreamSession,
  DreamTaskWindow,
  DreamVerificationType,
  VerificationCheck
} from "../src/dream/types.js";

function evidence(sessionId: string, suffix: string): DreamEvidenceRef {
  return {
    id: `${sessionId}:${suffix}`,
    sessionId,
    sourceFile: `C:\\frozen\\${sessionId}.jsonl`,
    lineNumber: 10,
    eventType: "response_item",
    summary: suffix
  };
}

function policy(changeType: DreamChangeType): Pick<
  DreamChangeClassification,
  "verificationRequired" | "acceptableVerificationTypes" | "repositoryTestsRelevant"
> {
  switch (changeType) {
    case "product_code":
      return { verificationRequired: true, acceptableVerificationTypes: ["test", "build", "lint", "typecheck"], repositoryTestsRelevant: true };
    case "tests":
      return { verificationRequired: true, acceptableVerificationTypes: ["test", "build", "typecheck"], repositoryTestsRelevant: true };
    case "documentation":
      return { verificationRequired: true, acceptableVerificationTypes: ["document_build", "read_back"], repositoryTestsRelevant: false };
    case "automation_memory":
      return { verificationRequired: true, acceptableVerificationTypes: ["persistence_check", "read_back"], repositoryTestsRelevant: false };
    case "external_system":
      return { verificationRequired: true, acceptableVerificationTypes: ["external_confirmation", "read_back"], repositoryTestsRelevant: false };
    case "read_only":
      return { verificationRequired: false, acceptableVerificationTypes: [], repositoryTestsRelevant: false };
    case "unknown":
      return { verificationRequired: null, acceptableVerificationTypes: [], repositoryTestsRelevant: false };
    default:
      return { verificationRequired: true, acceptableVerificationTypes: ["read_back"], repositoryTestsRelevant: false };
  }
}

function task(
  sessionId: string,
  taskNumber: number,
  changeType: DreamChangeType,
  verificationType?: DreamVerificationType,
  options: { checkBeforeChange?: boolean; checkStatus?: VerificationCheck["status"]; confidence?: "low" | "medium" | "high" } = {}
): DreamTaskWindow {
  const taskId = `${sessionId}:task:${taskNumber}`;
  const ref = evidence(sessionId, `task-${taskNumber}`);
  const changePolicy = policy(changeType);
  const change: DreamChangeClassification = {
    changeId: `${taskId}:change`,
    actionIndex: 2,
    changeType,
    target: changeType === "automation_memory"
      ? "$CODEX_HOME/automations/worker/memory.md"
      : changeType === "external_system"
        ? "browser:form-1"
        : changeType === "documentation"
          ? "docs/guide.md"
          : changeType === "product_code"
            ? "src/app.ts"
            : undefined,
    stateChanging: changeType !== "read_only",
    ...changePolicy,
    confidence: options.confidence ?? (changeType === "unknown" ? "low" : "high"),
    evidence: [`classified ${changeType}`],
    evidenceRefs: [ref]
  };
  const verificationChecks: VerificationCheck[] = verificationType
    ? [{
        command: `${verificationType} check`,
        verificationType,
        actionIndex: options.checkBeforeChange ? 1 : 3,
        target: change.target,
        fresh: !options.checkBeforeChange,
        status: options.checkStatus ?? "passed",
        evidenceRefs: [ref]
      }]
    : [];
  return {
    taskId,
    label: `${changeType} task ${taskNumber}`,
    intent: `Handle ${changeType}.`,
    segmentationConfidence: "high",
    turnIds: [`turn-${taskNumber}`],
    changes: [change],
    verificationChecks,
    finalClaims: [],
    evidenceRefs: [ref]
  };
}

function dreamSession(sessionId: string, tasks: DreamTaskWindow[], reasonCodes: DreamSession["reasonCodes"] = []): DreamSession {
  return {
    sessionId,
    source: "codex",
    repoRoot: "C:\\Repo\\Example",
    repoMatch: "matched",
    startedAt: "2026-07-14T08:00:00.000Z",
    endedAt: "2026-07-14T09:00:00.000Z",
    lifecycleStatus: "completed",
    sourceFiles: [`C:\\frozen\\${sessionId}.jsonl`],
    role: "failed_or_risky",
    classification: "suspicious",
    inefficiencyScore: 60,
    outcomeScore: 60,
    reasonCodes,
    metrics: { taskStarts: tasks.length, editCalls: tasks.flatMap((item) => item.changes).filter((change) => change.stateChanging).length },
    declaredIntents: [],
    instructionChecks: [],
    finalClaims: [],
    verificationChecks: tasks.flatMap((item) => item.verificationChecks),
    commands: [],
    evidenceRefs: tasks.flatMap((item) => item.evidenceRefs),
    missingEvidence: [],
    tasks
  };
}

function validate(sessions: DreamSession[]) {
  const packet: DreamPacket = {
    schemaVersion: 2,
    generatedAt: "2026-07-14T10:00:00.000Z",
    sourceScanPaths: ["fixture"],
    evidenceBoundary: "packet only",
    selectedSessions: sessions,
    omittedSessions: []
  };
  return validateDreamPacket(packet);
}

function reliableMissing(report: ReturnType<typeof validate>) {
  return report.findings.filter((finding) => finding.disposition === "reliable" && finding.patternKey.startsWith("missing-verification:"));
}

describe("Dream verification eligibility", () => {
  it("uses automation-memory read-back instead of repository tests", () => {
    const window = task("automation", 1, "automation_memory", "read_back");
    const report = validate([dreamSession("automation", [window], ["MISSING_VERIFICATION"])]);
    expect(window.changes[0]).toMatchObject({ repositoryTestsRelevant: false, verificationRequired: true });
    expect(reliableMissing(report)).toHaveLength(0);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ taskId: "automation:task:1", disposition: "possible_false_positive", applyTarget: "Dream analyzer" })
    );
    expect(report.applyPlan.findings).toContainEqual(
      expect.objectContaining({
        taskId: "automation:task:1",
        changeType: "automation_memory",
        verificationRequired: true,
        verificationObserved: true,
        actionClass: "analyzer_improvement"
      })
    );
  });

  it("never emits missing verification for read-only work", () => {
    const report = validate([dreamSession("read-only", [task("read-only", 1, "read_only")])]);
    expect(reliableMissing(report)).toHaveLength(0);
    expect(report.findings.some((finding) => finding.category === "Verification quality")).toBe(false);
  });

  it("closes a product-code change with a fresh passing build", () => {
    const report = validate([dreamSession("product", [task("product", 1, "product_code", "build")])]);
    expect(reliableMissing(report)).toHaveLength(0);
  });

  it("requires verification after the final product-code change", () => {
    const report = validate([dreamSession("stale", [task("stale", 1, "product_code", "test", { checkBeforeChange: true })])]);
    expect(reliableMissing(report)).toHaveLength(1);
    expect(reliableMissing(report)[0].taskId).toBe("stale:task:1");
  });

  it("accepts a document build for documentation-only work", () => {
    const window = task("docs", 1, "documentation", "document_build");
    const report = validate([dreamSession("docs", [window])]);
    expect(window.changes[0].repositoryTestsRelevant).toBe(false);
    expect(reliableMissing(report)).toHaveLength(0);
  });

  it("accepts read-back confirmation for an external-system mutation", () => {
    const report = validate([dreamSession("external", [task("external", 1, "external_system", "external_confirmation")])]);
    expect(reliableMissing(report)).toHaveLength(0);
  });

  it("does not let verification in a later task close an earlier task", () => {
    const first = task("multi", 1, "product_code");
    const second = task("multi", 2, "documentation", "document_build");
    const report = validate([dreamSession("multi", [first, second])]);
    expect(reliableMissing(report)).toHaveLength(1);
    expect(reliableMissing(report)[0].taskId).toBe(first.taskId);
  });

  it("marks ambiguous edits insufficient instead of high severity", () => {
    const report = validate([dreamSession("ambiguous", [task("ambiguous", 1, "unknown", undefined, { confidence: "low" })])]);
    expect(reliableMissing(report)).toHaveLength(0);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ disposition: "insufficient_evidence", severity: "medium", taskId: "ambiguous:task:1" })
    );
  });
});
