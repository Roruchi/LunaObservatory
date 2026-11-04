import fs from "node:fs";
import path from "node:path";
import type {
  ClaimCheck,
  DreamChangeClassification,
  DreamConfidence,
  DreamEvidenceRef,
  DreamFinding,
  DreamFindingDisposition,
  DreamPacket,
  DreamReport,
  DreamScore,
  DreamSession,
  DreamSeverity,
  DreamTaskWindow,
  DreamVerificationType,
  InstructionCheck
} from "./types.js";
import type { VerificationClosure } from "../normalize/types.js";
import { buildDreamDecisionReport } from "./decisionReport.js";

function packetRef(session: DreamSession, metric: string, summary: string): DreamEvidenceRef {
  return {
    id: `${session.sessionId}:packet:${metric}`,
    sessionId: session.sessionId,
    metric,
    summary
  };
}

function metricNumber(session: DreamSession, key: string): number {
  const raw = (session.metrics as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function verificationClosure(session: DreamSession): VerificationClosure {
  const explicit = session.verificationClosure ?? (session.metrics as { verificationClosure?: VerificationClosure }).verificationClosure;
  if (explicit) return explicit;
  if (metricNumber(session, "editCalls") === 0) return "not_applicable";
  const freshChecks = session.verificationChecks.filter((check) => check.fresh !== false);
  if (!freshChecks.length) return "missing";
  const latestByLane = new Map<string, DreamSession["verificationChecks"][number]>();
  for (const check of freshChecks) latestByLane.set(check.lane ?? commandKey(check.command), check);
  const statuses = [...latestByLane.values()].map((check) => check.status);
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.length && statuses.every((status) => status === "passed")) return "passed";
  return "missing";
}

function confidenceForRefs(refs: DreamEvidenceRef[]): DreamConfidence {
  if (refs.some((ref) => ref.sourceFile && ref.lineNumber)) return "high";
  if (refs.length) return "medium";
  return "low";
}

function addFinding(
  findings: DreamFinding[],
  options: {
    severity: DreamSeverity;
    category: string;
    title: string;
    explanation: string;
    evidenceRefs: DreamEvidenceRef[];
    confidence?: DreamConfidence;
    suggestedImprovement: string;
    patternKey?: string;
    sessionId?: string;
    taskId?: string;
    disposition?: DreamFindingDisposition;
    observation?: string;
    interpretation?: string;
    alternativeExplanation?: string;
    recommendedAction?: string;
    applyTarget?: string;
  }
): void {
  if (!options.evidenceRefs.length) return;
  const prefix = options.category === "Verification quality"
    ? "VER"
    : options.category === "Evidence grounding"
      ? "EVD"
      : options.category === "Instruction adherence"
        ? "INS"
        : options.category === "Intent adherence"
          ? "INT"
          : options.category === "Efficiency"
            ? "EFF"
            : "FND";
  const findingNumber = findings.filter((finding) => finding.findingId.startsWith(`${prefix}-`)).length + 1;
  const patternKey = options.patternKey ?? `${prefix}-${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  findings.push({
    findingId: `${prefix}-${String(findingNumber).padStart(3, "0")}`,
    patternKey,
    sessionId: options.sessionId ?? options.evidenceRefs.find((ref) => ref.sessionId)?.sessionId,
    taskId: options.taskId,
    severity: options.severity,
    category: options.category,
    title: options.title,
    disposition: options.disposition ?? "reliable",
    observation: options.observation ?? options.explanation,
    interpretation: options.interpretation ?? options.explanation,
    alternativeExplanation:
      options.alternativeExplanation ?? "The frozen packet may omit context that would change this interpretation.",
    recommendedAction: options.recommendedAction ?? options.suggestedImprovement,
    applyTarget: options.applyTarget ?? "the applicable repository or agent workflow",
    explanation: options.explanation,
    evidenceRefs: options.evidenceRefs,
    confidence: options.confidence ?? confidenceForRefs(options.evidenceRefs),
    suggestedImprovement: options.suggestedImprovement
  });
}

function commandKey(command?: string): string {
  return (command ?? "")
    .replace(/\s+/g, " ")
    .replace(/>+\s*[^\s;]+(?:\.txt|\.log|\.json)?/gi, "")
    .trim()
    .toLowerCase();
}

function failedVerificationChecks(session: DreamSession): VerificationCheckWithIndex[] {
  return session.verificationChecks
    .map((check, index) => ({ ...check, index }))
    .filter((check) => check.status === "failed" && check.fresh !== false);
}

type VerificationCheckWithIndex = DreamSession["verificationChecks"][number] & { index: number };

function hasLaterPassingCheck(session: DreamSession, failed: VerificationCheckWithIndex): boolean {
  const key = failed.lane ?? commandKey(failed.command);
  if (!key) return false;
  return session.verificationChecks.some(
    (check, index) =>
      index > failed.index && check.fresh !== false && check.status === "passed" && (check.lane ?? commandKey(check.command)) === key
  );
}

function verificationCheckSummary(checks: VerificationCheckWithIndex[]): string {
  return checks
    .slice(0, 3)
    .map((check) => compactText(check.command ?? "unknown verification command", 180))
    .join("; ");
}

function unresolvedVerificationChecks(session: DreamSession): VerificationCheckWithIndex[] {
  return failedVerificationChecks(session).filter((check) => !hasLaterPassingCheck(session, check));
}

function recoveredVerificationChecks(session: DreamSession): VerificationCheckWithIndex[] {
  return failedVerificationChecks(session).filter((check) => hasLaterPassingCheck(session, check));
}

type TaskVerificationAssessment = {
  status: "verified" | "missing" | "failed" | "not_required" | "insufficient_evidence";
  changes: DreamChangeClassification[];
  matchingChecks: DreamTaskWindow["verificationChecks"];
};

function legacyVerificationType(command = ""): DreamVerificationType {
  const normalized = command.toLowerCase().replace(/\\/g, "/");
  if (/render_docx|build_whitepaper|export[^\s]*docx|pandoc|mkdocs\s+build|sphinx-build/.test(normalized)) return "document_build";
  if (/\bgit\b[^\r\n;|]*\bdiff\s+--check\b/.test(normalized)) return "diff_check";
  if (/\b(typecheck|tsc|mypy)\b/.test(normalized)) return "typecheck";
  if (/\b(lint|eslint|ruff|cspell)\b/.test(normalized)) return "lint";
  if (/\b(test|vitest|pytest|jest|cargo\s+test|go\s+test|dotnet\s+test)\b/.test(normalized)) return "test";
  if (/\b(build|compile)\b/.test(normalized)) return "build";
  if (/\b(get-content|select-string|read|view|fetch)\b/.test(normalized)) return "read_back";
  if (/\b(get-childitem|test-path|git\s+status|\bls\b|\bdir\b)\b/.test(normalized)) return "filesystem_check";
  return "unknown";
}

function taskWindows(session: DreamSession): DreamTaskWindow[] {
  if (session.tasks?.length) return session.tasks;
  const edits = metricNumber(session, "editCalls");
  const segmentationConfidence: DreamConfidence = metricNumber(session, "taskStarts") > 1 ? "low" : "medium";
  const evidenceRefs = session.evidenceRefs.length
    ? session.evidenceRefs
    : [packetRef(session, "editCalls", `editCalls=${edits}`)];
  const changes: DreamChangeClassification[] = edits > 0
    ? [{
        changeId: `${session.sessionId}:legacy-change`,
        actionIndex: 0,
        changeType: "unknown",
        stateChanging: true,
        verificationRequired: null,
        acceptableVerificationTypes: [],
        repositoryTestsRelevant: false,
        confidence: "low",
        evidence: ["Legacy Dream packet reports edit calls but does not preserve classified task targets."],
        evidenceRefs
      }]
    : [{
        changeId: `${session.sessionId}:read-only`,
        actionIndex: 0,
        changeType: "read_only",
        stateChanging: false,
        verificationRequired: false,
        acceptableVerificationTypes: [],
        repositoryTestsRelevant: false,
        confidence: "medium",
        evidence: ["Legacy Dream packet contains no successful edit calls."],
        evidenceRefs
      }];
  return [{
    taskId: `${session.sessionId}:task-1`,
    label: session.userIntent ? compactText(session.userIntent, 80) : `${repoLabel(session)} task`,
    intent: session.userIntent,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    segmentationConfidence,
    turnIds: [],
    changes,
    verificationChecks: session.verificationChecks.map((check, index) => ({
      ...check,
      actionIndex: check.actionIndex ?? index + 1,
      verificationType: check.verificationType ?? legacyVerificationType(check.command)
    })),
    finalAnswer: session.finalAnswer,
    finalClaims: session.finalClaims,
    evidenceRefs
  }];
}

function normalizedTarget(target?: string): string | undefined {
  return target?.replace(/\\/g, "/").replace(/["']/g, "").replace(/\/$/, "").toLowerCase();
}

function targetMatches(change: DreamChangeClassification, check: DreamTaskWindow["verificationChecks"][number]): boolean {
  if (!change.target || !check.target) return true;
  const changeTarget = normalizedTarget(change.target);
  const checkTarget = normalizedTarget(check.target);
  if (!changeTarget || !checkTarget) return true;
  if (checkTarget.startsWith("repo:")) {
    return ["product_code", "tests", "documentation", "repository_metadata"].includes(change.changeType);
  }
  return changeTarget === checkTarget || changeTarget.endsWith(checkTarget) || checkTarget.endsWith(changeTarget);
}

function changeGroupKey(change: DreamChangeClassification): string {
  if (["product_code", "tests", "documentation", "repository_metadata"].includes(change.changeType)) return change.changeType;
  return `${change.changeType}:${normalizedTarget(change.target) ?? "unknown-target"}`;
}

function assessTaskVerification(task: DreamTaskWindow): TaskVerificationAssessment[] {
  const stateChanges = task.changes.filter((change) => change.stateChanging);
  if (!stateChanges.length) return [{ status: "not_required", changes: task.changes, matchingChecks: [] }];
  const grouped = new Map<string, DreamChangeClassification[]>();
  for (const change of stateChanges) {
    const key = changeGroupKey(change);
    grouped.set(key, [...(grouped.get(key) ?? []), change]);
  }
  return [...grouped.values()].map((changes) => {
    if (task.segmentationConfidence === "low" || changes.some((change) => change.confidence === "low" || change.verificationRequired === null)) {
      return { status: "insufficient_evidence", changes, matchingChecks: [] };
    }
    if (changes.every((change) => change.verificationRequired === false)) {
      return { status: "not_required", changes, matchingChecks: [] };
    }
    const lastChange = Math.max(...changes.map((change) => change.actionIndex));
    const accepted = new Set(changes.flatMap((change) => change.acceptableVerificationTypes));
    const checks = task.verificationChecks
      .filter((check) => (check.actionIndex ?? Number.MAX_SAFE_INTEGER) > lastChange && check.fresh !== false)
      .filter((check) => accepted.has(check.verificationType ?? legacyVerificationType(check.command)))
      .filter((check) => changes.some((change) => targetMatches(change, check)))
      .sort((left, right) => (left.actionIndex ?? 0) - (right.actionIndex ?? 0));
    if (!checks.length) return { status: "missing", changes, matchingChecks: [] };
    const latest = checks.at(-1);
    if (latest?.status === "passed") return { status: "verified", changes, matchingChecks: checks };
    if (latest?.status === "failed") return { status: "failed", changes, matchingChecks: checks };
    return { status: "missing", changes, matchingChecks: checks };
  });
}

function changeLabel(changes: DreamChangeClassification[]): string {
  const type = changes[0]?.changeType ?? "unknown";
  const targets = [...new Set(changes.map((change) => change.target).filter(Boolean))];
  return `${type}${targets.length ? ` (${targets.slice(0, 3).join(", ")})` : ""}`;
}

function changeApplyTarget(session: DreamSession, change: DreamChangeClassification): string {
  if (change.changeType === "unknown") return "Dream analyzer change classification";
  if (["automation_memory", "external_system", "generated_asset", "local_file_organization"].includes(change.changeType)) {
    return `the ${change.changeType} workflow`;
  }
  return `${repoLabel(session)} repository verification guidance`;
}

function verificationFindings(session: DreamSession, findings: DreamFinding[]): void {
  let reliableGap = false;
  let observedVerifiedChange = false;
  let verifiedTask: DreamTaskWindow | undefined;
  let verifiedEvidenceRefs: DreamEvidenceRef[] = [];
  for (const task of taskWindows(session)) {
    for (const assessment of assessTaskVerification(task)) {
      const evidenceRefs = assessment.changes.flatMap((change) => change.evidenceRefs);
      const primary = assessment.changes[0];
      if (!primary) continue;
      if (assessment.status === "verified") {
        const requiresVerification = assessment.changes.some((change) => change.verificationRequired === true);
        observedVerifiedChange = observedVerifiedChange || requiresVerification;
        if (requiresVerification && !verifiedTask) {
          verifiedTask = task;
          verifiedEvidenceRefs = [
            ...evidenceRefs,
            ...assessment.matchingChecks.flatMap((check) => check.evidenceRefs ?? [])
          ];
        }
        const failedBeforePass = assessment.matchingChecks.slice(0, -1).filter((check) => check.status === "failed");
        if (failedBeforePass.length) {
          addFinding(findings, {
            severity: "low",
            category: "Verification quality",
            title: "Verification had failed attempts that were later recovered",
            patternKey: `verification-recovered:${primary.changeType}`,
            sessionId: session.sessionId,
            taskId: task.taskId,
            explanation: `${task.label} had ${failedBeforePass.length} failed matching verification attempt(s) before a later pass.`,
            observation: `The packet records ${failedBeforePass.length} failed check(s) and a later passing check for ${changeLabel(assessment.changes)}.`,
            interpretation: "The task reached verification closure after recovery; this is not evidence of a current application defect.",
            alternativeExplanation: "A failed command may have exercised a different optional lane; task-local target matching limits that risk.",
            evidenceRefs: [...evidenceRefs, ...assessment.matchingChecks.flatMap((check) => check.evidenceRefs ?? [])],
            recommendedAction: "Record the failed first attempt and final passing check in the task summary.",
            applyTarget: changeApplyTarget(session, primary),
            suggestedImprovement: "Record the failed first attempt and final passing check in the task summary."
          });
        }
        continue;
      }
      if (assessment.status === "not_required") continue;
      if (assessment.status === "insufficient_evidence") {
        addFinding(findings, {
          severity: "medium",
          category: "Verification quality",
          title: "Verification requirement has insufficient evidence",
          patternKey: `verification-insufficient:${primary.changeType}`,
          sessionId: session.sessionId,
          taskId: task.taskId,
          disposition: "insufficient_evidence",
          confidence: "low",
          explanation: `${task.label} contains an ambiguous ${changeLabel(assessment.changes)} action or a low-confidence task boundary.`,
          observation: `${assessment.changes.length} state-changing action(s) were captured, but change type or task association is below medium confidence.`,
          interpretation: "The packet cannot reliably decide whether verification was required for this task.",
          alternativeExplanation: "The edit-like call may be a failed attempt, a non-durable action, or a change outside the repository.",
          evidenceRefs: evidenceRefs.length ? evidenceRefs : task.evidenceRefs,
          recommendedAction: "Improve target and task-window capture before treating this as a verification failure.",
          applyTarget: "Dream analyzer change classification and task segmentation",
          suggestedImprovement: "Improve target and task-window capture before treating this as a verification failure."
        });
        continue;
      }
      reliableGap = true;
      const failed = assessment.status === "failed";
      addFinding(findings, {
        severity: "high",
        category: "Verification quality",
        title: failed ? "Relevant verification ended with a failure" : "Required verification is missing after the final relevant change",
        patternKey: `${failed ? "verification-failed" : "missing-verification"}:${primary.changeType}`,
        sessionId: session.sessionId,
        taskId: task.taskId,
        explanation: `${task.label}: ${changeLabel(assessment.changes)} requires one of ${primary.acceptableVerificationTypes.join(", ")}, but ${
          failed ? "the latest matching check failed" : "no matching fresh check was captured"
        }.`,
        observation: `${assessment.changes.length} relevant state change(s) occurred in the task; ${assessment.matchingChecks.length} matching post-change check(s) were captured.`,
        interpretation: failed
          ? "The task does not have successful verification closure for the classified change."
          : "The task lacks fresh verification of a change type that requires it.",
        alternativeExplanation: "The frozen packet may have omitted an external or repository-specific check, but classification and task evidence are at least medium confidence.",
        evidenceRefs: [...evidenceRefs, ...assessment.matchingChecks.flatMap((check) => check.evidenceRefs ?? [])],
        recommendedAction: failed
          ? "Rerun the named matching check or report the task as blocked/unverified."
          : `Run a fresh ${primary.acceptableVerificationTypes.join(" or ")} check after the final relevant change.`,
        applyTarget: changeApplyTarget(session, primary),
        suggestedImprovement: failed
          ? "Rerun the named matching check or report the task as blocked/unverified."
          : `Run a fresh ${primary.acceptableVerificationTypes.join(" or ")} check after the final relevant change.`
      });
    }
  }

  if (session.reasonCodes.includes("MISSING_VERIFICATION") && !reliableGap && observedVerifiedChange) {
    addFinding(findings, {
      severity: "medium",
      category: "Verification quality",
      title: "Session-level verification flag is a likely false positive",
      patternKey: "legacy-session-verification-measurement",
      sessionId: session.sessionId,
      taskId: verifiedTask?.taskId,
      disposition: "possible_false_positive",
      explanation: `${session.sessionId} carries the legacy MISSING_VERIFICATION reason, while task-local classified changes have matching closure.`,
      observation: "The session-level scorer flagged missing verification, but the task model found a classified durable change followed by an acceptable matching read-back or check.",
      interpretation: "The legacy score compared edit-like calls with repository-style verification without considering change type.",
      alternativeExplanation: "A separate durable change could be absent from the frozen packet; no such task-local evidence was captured.",
      evidenceRefs: [packetRef(session, "reasonCodes", "MISSING_VERIFICATION"), ...verifiedEvidenceRefs],
      confidence: "high",
      recommendedAction: "Use task-local change classification as authoritative in Dream and treat the legacy reason only as a sampling hint.",
      applyTarget: "Dream analyzer",
      suggestedImprovement: "Use task-local change classification as authoritative in Dream and treat the legacy reason only as a sampling hint."
    });
  }
}

function efficiencyFindings(session: DreamSession, findings: DreamFinding[]): void {
  const repeatedFileViews = metricNumber(session, "repeatedFileViews");
  const failedCommands = metricNumber(session, "failedCommands");
  const repeatedFailures = metricNumber(session, "repeatedFailedCommandAttempts");
  const duplicateToolCalls = metricNumber(session, "duplicateToolCalls");
  const redundantToolCallRate = metricNumber(session, "redundantToolCallRate");
  const globCalls = metricNumber(session, "globCalls");
  if (session.reasonCodes.includes("FAILED_COMMAND_LOOP") || repeatedFailures >= 2) {
    addFinding(findings, {
      severity: "medium",
      category: "Efficiency",
      title: "Repeated failed commands",
      explanation: `${session.sessionId} repeated the same failing command ${repeatedFailures} time(s) across ${failedCommands} failed command(s).`,
      evidenceRefs: [packetRef(session, "repeatedFailedCommandAttempts", `repeatedFailedCommandAttempts=${repeatedFailures}`)],
      suggestedImprovement: "Stop after repeated command failures, inspect the first actionable error, and change strategy."
    });
  }
  if (session.reasonCodes.includes("REPEATED_FILE_VIEWS") || repeatedFileViews >= 5) {
    addFinding(findings, {
      severity: "low",
      category: "Efficiency",
      title: "Repeated file reads",
      explanation: `${session.sessionId} has ${repeatedFileViews} repeated file view(s).`,
      evidenceRefs: [packetRef(session, "repeatedFileViews", `repeatedFileViews=${repeatedFileViews}`)],
      suggestedImprovement: "Cache key facts from file reads in the working notes instead of rediscovering them."
    });
  }
  if (session.reasonCodes.includes("REPEATED_GLOB_SEARCH") || globCalls >= 8) {
    addFinding(findings, {
      severity: "low",
      category: "Efficiency",
      title: "Repeated broad discovery",
      explanation: `${session.sessionId} has ${globCalls} glob/list call(s).`,
      evidenceRefs: [packetRef(session, "globCalls", `globCalls=${globCalls}`)],
      suggestedImprovement: "Narrow discovery after the first pass and reuse already-found paths."
    });
  }
  if (session.reasonCodes.includes("REDUNDANT_TOOL_CALLS") || (duplicateToolCalls >= 5 && redundantToolCallRate >= 0.2)) {
    addFinding(findings, {
      severity: "medium",
      category: "Efficiency",
      title: "State-equivalent tool calls were repeated",
      explanation: `${session.sessionId} has ${duplicateToolCalls} exact repeated read/search/command call(s) without an intervening edit (${(
        redundantToolCallRate * 100
      ).toFixed(1)}%).`,
      evidenceRefs: [packetRef(session, "duplicateToolCalls", `duplicateToolCalls=${duplicateToolCalls}`)],
      suggestedImprovement: "Reuse the earlier result unless state changed, the first call failed, or a fresh rerun is explicitly required."
    });
  }
}

function inferredInstructionStatus(instruction: InstructionCheck, session: DreamSession): InstructionCheck {
  if (instruction.status && instruction.status !== "unknown") return instruction;
  const text = instruction.text.toLowerCase();
  const commands = session.commands.join("\n").toLowerCase();
  const ranTests = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|dotnet\s+test|cargo\s+test|go\s+test)\b/.test(commands);
  const prohibitsTests = /\b(?:do not|don't|must not|never)\s+(?:run|execute)\s+(?:the\s+)?(?:tests?|test suite|vitest|jest|pytest|npm test)\b/.test(text);
  if (prohibitsTests && ranTests) {
    return {
      ...instruction,
      status: "violated",
      evidenceRefs: instruction.evidenceRefs?.length
        ? instruction.evidenceRefs
        : [packetRef(session, "commands", `commands=${session.commands.join("; ")}`)]
    };
  }
  const requiresTests = /\b(?:must|should|required to|verify with|validate with)\b[^.\n]{0,100}\b(?:run|execute|tests?|test suite|vitest|jest|pytest|npm test)\b/.test(text);
  if (requiresTests && ranTests) {
    return {
      ...instruction,
      status: "followed",
      evidenceRefs: instruction.evidenceRefs?.length
        ? instruction.evidenceRefs
        : [packetRef(session, "commands", `commands=${session.commands.join("; ")}`)]
    };
  }
  return { ...instruction, status: "unknown" };
}

function instructionFindings(session: DreamSession, findings: DreamFinding[]): InstructionCheck[] {
  const checks = session.instructionChecks.map((instruction) => inferredInstructionStatus(instruction, session));
  for (const instruction of checks) {
    if (instruction.status !== "violated" && instruction.status !== "partially_followed") continue;
    const severity = instruction.status === "violated" ? "high" : "medium";
    addFinding(findings, {
      severity,
      category: "Instruction adherence",
      title: instruction.status === "violated" ? "Explicit instruction was violated" : "Explicit instruction was weakened",
      explanation: `${session.sessionId}: ${instruction.text}`,
      evidenceRefs: instruction.evidenceRefs?.length
        ? instruction.evidenceRefs
        : [packetRef(session, "instruction", `instructionStatus=${instruction.status}`)],
      suggestedImprovement: "Treat explicit user and environment constraints as hard validation criteria."
    });
  }
  return checks;
}

function unsupportedClaimFindings(session: DreamSession, findings: DreamFinding[]): ClaimCheck[] {
  const unsupported = session.finalClaims.filter((claim) => claim.supported === false || !claim.evidenceRefs?.length);
  for (const claim of unsupported) {
    addFinding(findings, {
      severity: "medium",
      category: "Evidence grounding",
      title: "Final-answer claim lacks frozen evidence",
      explanation: `${session.sessionId}: ${claim.text}`,
      evidenceRefs: claim.evidenceRefs?.length
        ? claim.evidenceRefs
        : [packetRef(session, "finalClaims", `unsupportedClaim=${claim.text}`)],
      confidence: claim.supported === false ? "high" : "medium",
      suggestedImprovement: "Only claim completed or verified work when the frozen evidence contains matching support."
    });
  }
  return unsupported;
}

function intentFindings(session: DreamSession, findings: DreamFinding[]): void {
  const check = session.intentCheck;
  if (!check || check.status === "matched" || check.status === "unknown") return;
  addFinding(findings, {
    severity: check.status === "contradicted" ? "high" : "medium",
    category: "Intent adherence",
    title: check.status === "missing" ? "Intent evidence is missing" : "Intent was not fully satisfied",
    explanation: `${session.sessionId}: requested=${check.requested ?? "unknown"}; observed=${check.observed ?? "unknown"}`,
    evidenceRefs: check.evidenceRefs?.length ? check.evidenceRefs : [packetRef(session, "intentCheck", `intentStatus=${check.status}`)],
    confidence: check.evidenceRefs?.length ? undefined : "low",
    suggestedImprovement: "Keep the original request visible and compare final work against it before reporting completion."
  });
}

function scoreIntent(sessions: DreamSession[]): DreamScore {
  const checks = sessions.map((session) => session.intentCheck).filter(Boolean);
  if (!checks.length) {
    return {
      category: "Intent adherence",
      score: null,
      confidence: "low",
      rationale: "The frozen evidence lacks explicit intent checks, so validation can only use declared intents and metrics."
    };
  }
  const evaluated = checks.filter((check) => check?.status && check.status !== "unknown");
  if (evaluated.length / checks.length < 0.5) {
    return {
      category: "Intent adherence",
      score: null,
      confidence: "low",
      rationale: `${evaluated.length} of ${checks.length} intent check(s) could be evaluated; the remainder are unknown.`
    };
  }
  const points = evaluated.reduce((sum, check) => sum + (check?.status === "matched" ? 1 : check?.status === "partial" ? 0.5 : 0), 0);
  return {
    category: "Intent adherence",
    score: Math.round((points / evaluated.length) * 5),
    confidence: "medium",
    rationale: `${evaluated.length} intent check(s) were evaluated with matched outcomes weighted above partial, missing, or contradicted outcomes.`
  };
}

function scoreInstructions(checks: InstructionCheck[], sessions: DreamSession[]): DreamScore {
  if (!checks.length) {
    return {
      category: "Instruction adherence",
      score: null,
      confidence: "low",
      rationale: "The frozen evidence does not include explicit instruction evidence."
    };
  }
  const violated = checks.filter((check) => check.status === "violated").length;
  const partial = checks.filter((check) => check.status === "partially_followed").length;
  const followed = checks.filter((check) => check.status === "followed").length;
  const unknown = checks.filter((check) => !check.status || check.status === "unknown").length;
  const evaluated = followed + violated + partial;
  const coverage = evaluated / checks.length;
  if (evaluated === 0 || coverage < 0.5) {
    return {
      category: "Instruction adherence",
      score: null,
      confidence: "low",
      rationale: `${evaluated} of ${checks.length} captured instruction(s) could be evaluated; ${unknown} remain unknown, so missing evidence is not treated as compliance.`
    };
  }
  return {
    category: "Instruction adherence",
    score: Math.round(((followed + partial * 0.5) / evaluated) * 5),
    confidence: unknown ? "low" : "medium",
    rationale: `${followed} followed, ${violated} violated, ${partial} partially followed, and ${unknown} unknown instruction(s).`
  };
}

function scoreGrounding(unsupported: ClaimCheck[], sessions: DreamSession[]): DreamScore {
  const claims = sessions.flatMap((session) => session.finalClaims);
  if (!claims.length) {
    return {
      category: "Evidence grounding",
      score: null,
      confidence: "low",
      rationale: "The frozen evidence lacks final-answer claim text, so unsupported claims cannot be fully audited."
    };
  }
  const supported = claims.filter((claim) => claim.supported === true).length;
  const needsReview = claims.filter((claim) => claim.supported === undefined).length;
  return {
    category: "Evidence grounding",
    score: Math.round((supported / claims.length) * 5),
    confidence: "medium",
    rationale: `${supported} of ${claims.length} final-answer claim(s) have matching frozen support; ${unsupported.length} lack support and ${needsReview} need evidence review.`
  };
}

function scoreVerification(sessions: DreamSession[]): DreamScore {
  const assessments = sessions.flatMap((session) => taskWindows(session).flatMap(assessTaskVerification));
  const relevant = assessments.filter((assessment) => assessment.status !== "not_required");
  if (!relevant.length) {
    return {
      category: "Verification quality",
      score: null,
      confidence: "medium",
      rationale: "No selected task contained a classified state change that required verification."
    };
  }
  const evaluated = relevant.filter((assessment) => assessment.status !== "insufficient_evidence");
  const insufficient = relevant.length - evaluated.length;
  if (!evaluated.length) {
    return {
      category: "Verification quality",
      score: null,
      confidence: "low",
      rationale: `${insufficient} task/change assessment(s) lacked enough classification or segmentation evidence.`
    };
  }
  const missing = evaluated.filter((assessment) => assessment.status === "missing").length;
  const failed = evaluated.filter((assessment) => assessment.status === "failed").length;
  const passed = evaluated.filter((assessment) => assessment.status === "verified").length;
  return {
    category: "Verification quality",
    score: Math.round((passed / evaluated.length) * 5),
    confidence: insufficient ? "low" : "medium",
    rationale: `${passed} classified task/change group(s) are verified, ${missing} miss fresh matching verification, ${failed} end in failure, and ${insufficient} have insufficient evidence.`
  };
}

function scoreEfficiency(sessions: DreamSession[]): DreamScore {
  if (!sessions.length) {
    return { category: "Efficiency", score: null, confidence: "low", rationale: "No selected sessions were available." };
  }
  const average = averageInefficiency(sessions);
  const score = average <= 15 ? 5 : average <= 35 ? 4 : average <= 55 ? 3 : average <= 75 ? 2 : 1;
  return {
    category: "Efficiency",
    score,
    confidence: "low",
    rationale: `Average task-normalized selected-session inefficiency score is ${average.toFixed(1)} (0 is best, 100 is worst; lower is better). This is a stratified selected sample, not a population estimate.`
  };
}

function averageInefficiency(sessions: DreamSession[]): number {
  if (!sessions.length) return 0;
  return sessions.reduce((sum, session) => sum + (session.inefficiencyScore ?? 0), 0) / sessions.length;
}

function formatEvidence(refs: DreamEvidenceRef[]): string {
  return refs
    .map((ref) => {
      const location = ref.sourceFile && ref.lineNumber ? `${ref.sourceFile}:${ref.lineNumber}` : ref.metric ?? ref.id;
      return `${ref.id} (${location})`;
    })
    .join(", ");
}

function findingLine(finding: DreamFinding): string {
  return `- ${finding.severity.toUpperCase()} [${finding.category}] ${finding.title}: ${finding.explanation} Evidence: ${formatEvidence(
    finding.evidenceRefs
  )}. Confidence: ${finding.confidence}. Meaning: ${findingMeaning(finding)} What to do: ${findingAction(finding)} Recommendation: ${finding.suggestedImprovement}`;
}

function verificationReviewLine(session: DreamSession): string {
  const unresolved = unresolvedVerificationChecks(session);
  const recovered = recoveredVerificationChecks(session);
  const unresolvedText = unresolved.length ? verificationCheckSummary(unresolved) : "none";
  const recoveredText = recovered.length ? verificationCheckSummary(recovered) : "none";
  return `- ${session.sessionId}: editCalls=${metricNumber(session, "editCalls")}, verificationEvents=${metricNumber(
    session,
    "verificationEvents"
  )}, verificationPassed=${metricNumber(session, "verificationPassed")}, verificationFailed=${metricNumber(
    session,
    "verificationFailed"
  )}. Unresolved failed checks: ${unresolvedText}. Recovered failed attempts: ${recoveredText}.`;
}

function scoreRows(scores: DreamScore[]): string[] {
  return [
    "| Category | Score | Confidence | Rationale |",
    "| --- | ---: | --- | --- |",
    ...scores.map((score) => `| ${score.category} | ${score.score ?? "insufficient"} | ${score.confidence} | ${score.rationale.replace(/\|/g, "\\|")} |`)
  ];
}

function tableEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function compactText(value: string | undefined, maxLength = 180): string {
  if (!value) return "missing";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function repoLabel(session: DreamSession): string {
  const root = session.repoRoot?.replace(/[\\/]+$/, "");
  return root?.split(/[\\/]/).at(-1) ?? "unknown";
}

function inspectedSessionRows(sessions: DreamSession[]): string[] {
  if (!sessions.length) return ["No sessions were inspected."];
  return [
    "| Session | Repository | Agent | Status | Ended | Role | Class | Inefficiency | Outcome | Tasks | Tools/task | Edits | Verification closure | Repeated failures | Reasons |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |",
    ...sessions.map((session) =>
      `| ${[
        tableEscape(session.sessionId),
        tableEscape(repoLabel(session)),
        tableEscape(session.agentPath ?? "root"),
        tableEscape(session.lifecycleStatus ?? "unknown"),
        tableEscape(session.endedAt?.slice(0, 10) ?? "unknown"),
        tableEscape(session.role ?? "selected"),
        tableEscape(session.classification ?? "unknown"),
        session.inefficiencyScore ?? 0,
        session.outcomeScore ?? 0,
        metricNumber(session, "taskStarts") || metricNumber(session, "turns"),
        metricNumber(session, "toolRequestsPerTask").toFixed(1),
        metricNumber(session, "editCalls"),
        tableEscape(verificationClosure(session)),
        metricNumber(session, "repeatedFailedCommandAttempts"),
        tableEscape(session.reasonCodes.join(", ") || "-")
      ].join(" | ")} |`
    )
  ];
}

function supportLabel(claim: ClaimCheck): string {
  if (claim.supported === true) return "supported";
  if (claim.supported === false) return "unsupported";
  return "needs review";
}

function claimSummary(session: DreamSession): string {
  if (!session.finalClaims.length) return "no claims extracted";
  return session.finalClaims
    .slice(0, 3)
    .map((claim) => `${supportLabel(claim)}: ${compactText(claim.text, 100)}`)
    .join("; ");
}

function intentOutcomeRows(sessions: DreamSession[]): string[] {
  if (!sessions.length) return ["No sessions were inspected."];
  return [
    "| Session | Captured user request | Captured final answer | Final claims |",
    "| --- | --- | --- | --- |",
    ...sessions.map(
      (session) =>
        `| ${tableEscape(session.sessionId)} | ${tableEscape(compactText(session.userIntent))} | ${tableEscape(
          compactText(session.finalAnswer)
        )} | ${tableEscape(claimSummary(session))} |`
    )
  ];
}

function compareSessions(sessions: DreamSession[]): string[] {
  const efficient = sessions.filter(
    (session) =>
      session.classification === "efficient" &&
      (metricNumber(session, "editCalls") === 0 || verificationClosure(session) === "passed")
  );
  const inefficient = sessions.filter((session) => session.classification === "inefficient" || session.classification === "suspicious");
  const avg = (items: DreamSession[], key: string) =>
    (items.reduce((sum, session) => sum + metricNumber(session, key), 0) / Math.max(1, items.length)).toFixed(1);
  const repositories = [...new Set(efficient.map(repoLabel))].filter((repo) => inefficient.some((session) => repoLabel(session) === repo));
  if (!repositories.length) {
    return ["- Missing same-repository comparison set: cross-repository effort is not treated as a reliable efficiency comparison."];
  }
  return [
    ...repositories.map((repo) => {
      const good = efficient.filter((session) => repoLabel(session) === repo);
      const bad = inefficient.filter((session) => repoLabel(session) === repo);
      return `- ${repo}: ${good.length} efficient session(s) averaged ${avg(good, "toolRequestsPerTask")} tools/task, ${avg(
        good,
        "redundantToolCallRate"
      )} redundant-call rate, and ${avg(good, "repeatedFailedCommandAttempts")} repeated failures; ${bad.length} risky/inefficient session(s) averaged ${avg(
        bad,
        "toolRequestsPerTask"
      )} tools/task, ${avg(bad, "redundantToolCallRate")} redundant-call rate, and ${avg(bad, "repeatedFailedCommandAttempts")} repeated failures.`;
    }),
    "- These are task-normalized, same-repository comparisons; task difficulty can still differ."
  ];
}

function selectedSessionIds(sessions: DreamSession[], predicate: (session: DreamSession) => boolean): string {
  const ids = sessions.filter(predicate).map((session) => session.sessionId);
  if (!ids.length) return "none";
  const shown = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${shown} (+${ids.length - 5} more)` : shown;
}

function guidanceTarget(sessions: DreamSession[]): string {
  const repos = [...new Set(sessions.map(repoLabel).filter((repo) => repo !== "unknown"))];
  if (!repos.length) return "the applicable agent guidance";
  if (repos.length === 1) return `${repos[0]}'s AGENTS.md or runbook`;
  const shown = repos.slice(0, 5).join(", ");
  const remainder = repos.length > 5 ? ` (+${repos.length - 5} more evidenced repositories)` : "";
  return `shared or per-repository guidance for ${shown}${remainder}`;
}

function totalMetric(sessions: DreamSession[], key: string): number {
  return sessions.reduce((sum, session) => sum + metricNumber(session, key), 0);
}

function unresolvedVerificationCount(sessions: DreamSession[]): number {
  return sessions.reduce((sum, session) => {
    const unresolved = unresolvedVerificationChecks(session);
    if (unresolved.length) return sum + unresolved.length;
    return verificationClosure(session) === "failed" ? sum + 1 : sum;
  }, 0);
}

function recoveredVerificationCount(sessions: DreamSession[]): number {
  return sessions.reduce((sum, session) => sum + recoveredVerificationChecks(session).length, 0);
}

function isGodotVerificationCommand(command: string): boolean {
  return /\btools[\\/]godot\.ps1\b[^\r\n;|]*\b(?:parse|boot|test|export|check-android-env)\b/i.test(command) ||
    /\bgodot(?:\.exe)?\b[^\r\n;|]*\b--headless\b/i.test(command);
}

function actionableRecommendations(sessions: DreamSession[], missingEvidence: string[]): string[] {
  const recommendations: string[] = [];
  const failedVerification = unresolvedVerificationCount(sessions);
  const recoveredVerification = recoveredVerificationCount(sessions);
  const repeatedFailures = totalMetric(sessions, "repeatedFailedCommandAttempts");
  const reviewClaimCount = sessions.reduce((sum, session) => sum + session.finalClaims.filter((claim) => claim.supported === undefined).length, 0);
  const editedWithoutVerification = sessions.filter(
    (session) => metricNumber(session, "editCalls") > 0 && verificationClosure(session) === "missing"
  );
  const verificationSessions = sessions.filter(
    (session) => failedVerificationChecks(session).length > 0 || recoveredVerificationChecks(session).length > 0 || editedWithoutVerification.includes(session)
  );
  const highChurnSessions = sessions.filter(
    (session) => session.reasonCodes.includes("HIGH_TOOL_CHURN") || metricNumber(session, "toolRequestsPerTask") >= 30
  );
  const failedLoopSessions = sessions.filter(
    (session) => session.reasonCodes.includes("FAILED_COMMAND_LOOP") || metricNumber(session, "repeatedFailedCommandAttempts") >= 2
  );
  const missingIntentOrClaims = missingEvidence.filter(
    (item) => /original user intent|explicit user\/developer instruction|final assistant answer/.test(item)
  );
  const godotSessions = sessions.filter((session) =>
    [...failedVerificationChecks(session), ...recoveredVerificationChecks(session)].some((check) =>
      isGodotVerificationCommand(check.command ?? "")
    )
  );

  if (failedVerification > 0 || recoveredVerification > 0 || editedWithoutVerification.length) {
    recommendations.push(
      [
        `- **Verification closure rule:** In ${guidanceTarget(verificationSessions)}, require final answers to state \`Validation run\`, \`Result\`, \`Unresolved checks\`, \`Remaining blocker\`, and the supporting command/evidence. `,
        `Evidence: selected sessions contain ${failedVerification} unresolved failed verification check(s), ${recoveredVerification} recovered failed attempt(s), and ${editedWithoutVerification.length} edited session(s) without verification evidence, especially ${selectedSessionIds(
          sessions,
          (session) => failedVerificationChecks(session).length > 0 || editedWithoutVerification.includes(session)
        )}.`,
        ` Dream apply target: ${guidanceTarget(verificationSessions)}, not application code.`
      ].join("")
    );
  }

  if (repeatedFailures > 0 || failedLoopSessions.length) {
    recommendations.push(
      [
        "- **AGENTS.md retry discipline:** Add: after two failed commands in the same validation/debug lane, stop retrying, summarize the first actionable failure, change strategy once, then mark the task blocked if it still fails. ",
        `Evidence: failed-command-loop sessions: ${selectedSessionIds(sessions, (session) => failedLoopSessions.includes(session))}.`,
        ` Dream apply target: ${guidanceTarget(failedLoopSessions)} in a section called \`Failed validation loops\`.`
      ].join("")
    );
  }

  if (reviewClaimCount > 0) {
    recommendations.push(
      [
        "- **Final-answer claim discipline:** Add guidance that every final claim about tests, commits, pushed work, generated assets, or fixed behavior must include the exact command/result or say `not verified`. ",
        `Evidence: ${reviewClaimCount} final-answer claim(s) needed evidence review because the frozen scan could capture the claim source but not enough matching support. `,
        `Dream apply target: ${guidanceTarget(sessions)} or the applicable verification skill.`
      ].join("")
    );
  }

  if (godotSessions.length) {
    recommendations.push(
      [
        `- **Godot validation guidance:** Add or update the Godot verification runbook for ${guidanceTarget(godotSessions)} so agents use one validation ladder and record each step's result. `,
        "Suggested ladder text: `parse -> boot smoke -> focused test for touched system -> broader GUT/full suite only when scope demands it`. ",
        "Also require agents to preserve failed output instead of replacing it with reassuring prose. ",
        `Evidence: unresolved or recovered validation failures appear in ${selectedSessionIds(
          godotSessions,
          (session) => failedVerificationChecks(session).length > 0
        )}.`
      ].join("")
    );
  }

  if (highChurnSessions.length) {
    const examples = highChurnSessions
      .slice(0, 5)
      .map((session) => `${session.sessionId} (${metricNumber(session, "toolRequestsPerTask").toFixed(1)} tools/task)`)
      .join(", ");
    const remainder = highChurnSessions.length > 5 ? ` (+${highChurnSessions.length - 5} more)` : "";
    recommendations.push(
      [
        "- **Tool-call budget note:** Add guidance that high-churn sessions must checkpoint after discovery and before broad edits: list known files, chosen validation command, and next single action. ",
        `Evidence: high-tool-churn sessions: ${examples}${remainder}.`,
        ` Dream apply target: ${guidanceTarget(highChurnSessions)}.`
      ].join("")
    );
  }

  if (missingIntentOrClaims.length) {
    recommendations.push(
      [
        "- **Improve LunaObs scan capture:** Capture original user intent, explicit instructions, final assistant answer text, and extracted final claims in the frozen evidence. ",
        "Without these fields, dream cannot tell which instructions were ignored or which completion claims were unsupported. ",
        `Evidence: ${missingIntentOrClaims.length} missing-evidence entries across selected sessions.`
      ].join("")
    );
  }

  if (!recommendations.length) {
    return ["- No concrete repo/process recommendation could be derived from the selected session evidence."];
  }
  return recommendations;
}

function dreamApplyBacklog(sessions: DreamSession[], missingEvidence: string[]): string[] {
  const backlog: string[] = [];
  const failedVerification = unresolvedVerificationCount(sessions);
  const recoveredVerification = recoveredVerificationCount(sessions);
  const repeatedFailures = totalMetric(sessions, "repeatedFailedCommandAttempts");
  const reviewClaimCount = sessions.reduce((sum, session) => sum + session.finalClaims.filter((claim) => claim.supported === undefined).length, 0);
  const editedWithoutVerification = sessions.filter(
    (session) => metricNumber(session, "editCalls") > 0 && verificationClosure(session) === "missing"
  );
  const verificationSessions = sessions.filter(
    (session) => failedVerificationChecks(session).length > 0 || recoveredVerificationChecks(session).length > 0 || editedWithoutVerification.includes(session)
  );
  const highChurnSessions = sessions.filter(
    (session) => session.reasonCodes.includes("HIGH_TOOL_CHURN") || metricNumber(session, "toolRequestsPerTask") >= 30
  );
  const missingIntentOrClaims = missingEvidence.filter(
    (item) => /original user intent|explicit user\/developer instruction|final assistant answer/.test(item)
  );
  const godotSessions = sessions.filter((session) =>
    [...failedVerificationChecks(session), ...recoveredVerificationChecks(session)].some((check) =>
      isGodotVerificationCommand(check.command ?? "")
    )
  );
  const repeatedFailureSessions = sessions.filter((session) => metricNumber(session, "repeatedFailedCommandAttempts") > 0);

  if (failedVerification > 0 || recoveredVerification > 0 || editedWithoutVerification.length) {
    backlog.push(`- Update ${guidanceTarget(verificationSessions)} with a required final-answer validation block.`);
  }
  if (repeatedFailures > 0) {
    backlog.push(`- Add retry discipline to ${guidanceTarget(repeatedFailureSessions)}: after two same-lane failures, stop, summarize the first actionable error, and change strategy.`);
  }
  if (reviewClaimCount > 0) {
    backlog.push("- Add a final-answer claim rule: claims about tests, commits, generated assets, or fixed behavior need exact captured evidence or `not verified` wording.");
  }
  if (godotSessions.length) {
    backlog.push(`- Add or update Godot verification guidance for ${guidanceTarget(godotSessions)} with the parse, boot smoke, focused-test validation ladder.`);
  }
  if (highChurnSessions.length) {
    backlog.push("- Add a tool-call checkpoint rule for high-churn sessions before broad edits continue.");
  }
  if (missingIntentOrClaims.length) {
    backlog.push("- Improve LunaObs scan capture for user intent, explicit instructions, final answer text, and final claims before relying on instruction or claim judgment.");
  }
  if (!backlog.length) return ["- No apply backlog item was justified by the selected frozen evidence."];
  return backlog;
}

function lessonsFromEfficientSessions(sessions: DreamSession[]): string[] {
  const efficient = sessions.filter((session) => session.role === "efficient_success" || session.classification === "efficient");
  if (!efficient.length) return ["- Missing evidence: no efficient comparison session was selected."];
  const hasVerification = efficient.some((session) => metricNumber(session, "verificationEvents") > 0);
  const lowChurn = efficient.some((session) => metricNumber(session, "toolRequestsPerTask") <= 15);
  return [
    ...(hasVerification ? ["- Efficient sessions captured verification evidence before final reporting."] : []),
    ...(lowChurn ? ["- Efficient sessions kept discovery narrow and avoided broad repeated tool use."] : []),
    ...(hasVerification || lowChurn ? [] : ["- Efficient sessions are present, but the frozen evidence lacks enough detail for a stronger lesson."])
  ];
}

function uniqueMissingEvidence(sessions: DreamSession[]): string[] {
  return [...new Set(sessions.flatMap((session) => session.missingEvidence.map((item) => `${session.sessionId}: ${item}`)))];
}

function claimsNeedingReview(sessions: DreamSession[]): string[] {
  const claims = sessions.flatMap((session) =>
    session.finalClaims
      .filter((claim) => claim.supported === undefined)
      .map((claim) => `- ${session.sessionId}: ${compactText(claim.text, 180)}`)
  );
  return claims.length ? claims : ["- None identified."];
}

function evidenceNotes(sessions: DreamSession[]): string[] {
  if (!sessions.length) return ["- No frozen evidence references were available."];
  return [
    "- Full frozen evidence references are stored in `dream-pack.json`; this report prints only the refs attached to findings.",
    ...sessions.map((session) => `- ${session.sessionId}: ${session.evidenceRefs.length} frozen evidence reference(s) available.`)
  ];
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkup(value: string): string {
  const withoutBullet = value.replace(/^- /, "");
  return escapeHtml(withoutBullet)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function label(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scoreStatus(score: number): "good" | "warn" | "bad" {
  if (score >= 4) return "good";
  if (score >= 2) return "warn";
  return "bad";
}

function severityClass(severity: DreamSeverity): "good" | "warn" | "bad" {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "good";
}

function claimClass(claim: ClaimCheck): "good" | "warn" | "bad" {
  if (claim.supported === true) return "good";
  if (claim.supported === false) return "bad";
  return "warn";
}

function metricCard(labelText: string, value: string | number, note: string, tone: "good" | "warn" | "bad" | "neutral" = "neutral"): string {
  return `<section class="metric-card ${tone}"><span>${escapeHtml(labelText)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></section>`;
}

function htmlList(items: string[]): string {
  return items.length ? `<ul>${items.map((item) => `<li>${inlineMarkup(item)}</li>`).join("")}</ul>` : `<p class="empty">None.</p>`;
}

function sessionClaimList(session: DreamSession): string {
  if (!session.finalClaims.length) return `<p class="empty">No final claims extracted.</p>`;
  return `<ul class="claim-list">${session.finalClaims
    .map(
      (claim) =>
        `<li class="${claimClass(claim)}"><span>${escapeHtml(supportLabel(claim))}</span><p>${escapeHtml(compactText(claim.text, 220))}</p></li>`
    )
    .join("")}</ul>`;
}

function sessionCards(sessions: DreamSession[]): string {
  if (!sessions.length) return `<p class="empty">No sessions were inspected.</p>`;
  return sessions
    .map((session) => {
      const tone = verificationClosure(session) === "failed" || session.reasonCodes.includes("FAILED_COMMAND_LOOP") ? "bad" : "good";
      return `<article class="session-card ${tone}">
        <div class="session-head">
          <div>
            <h3>${escapeHtml(session.sessionId)}</h3>
            <p>${escapeHtml(repoLabel(session))} · ${escapeHtml(session.agentPath ?? "root")} · ${escapeHtml(
              session.lifecycleStatus ?? "unknown"
            )} · ${escapeHtml(session.endedAt?.slice(0, 10) ?? "date unknown")} · ${escapeHtml(session.role ?? "selected")} · ${escapeHtml(
              session.classification ?? "unknown"
            )}</p>
          </div>
          <span class="score-pill">Inefficiency ${escapeHtml(session.inefficiencyScore ?? 0)}</span>
        </div>
        <dl class="stat-grid">
          <div><dt>Outcome</dt><dd>${escapeHtml(session.outcomeScore ?? 0)}</dd></div>
          <div><dt>Tasks</dt><dd>${metricNumber(session, "taskStarts") || metricNumber(session, "turns")}</dd></div>
          <div><dt>Tools/task</dt><dd>${metricNumber(session, "toolRequestsPerTask").toFixed(1)}</dd></div>
          <div><dt>Edits</dt><dd>${metricNumber(session, "editCalls")}</dd></div>
          <div><dt>Verification closure</dt><dd>${escapeHtml(verificationClosure(session))}</dd></div>
          <div><dt>Repeated failures</dt><dd>${metricNumber(session, "repeatedFailedCommandAttempts")}</dd></div>
        </dl>
        <div class="text-grid">
          <section><h4>User request</h4><p>${escapeHtml(compactText(session.userIntent, 520))}</p></section>
          <section><h4>Final answer</h4><p>${escapeHtml(compactText(session.finalAnswer, 520))}</p></section>
        </div>
        <section>
          <h4>Final claims</h4>
          ${sessionClaimList(session)}
        </section>
        <div class="reason-row">${
          session.reasonCodes.length
            ? session.reasonCodes.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")
            : `<span class="muted">No reason codes</span>`
        }</div>
      </article>`;
    })
    .join("");
}

function findingCards(findings: DreamFinding[]): string {
  if (!findings.length) return `<p class="empty">No findings.</p>`;
  return findings
    .map(
      (finding) => `<article class="finding ${severityClass(finding.severity)}">
        <div><span>${escapeHtml(finding.severity.toUpperCase())} · ${escapeHtml(finding.category)}</span><h3>${escapeHtml(finding.title)}</h3></div>
        <p><strong>Observation:</strong> ${escapeHtml(finding.observation)}</p>
        <p><strong>Interpretation:</strong> ${escapeHtml(finding.interpretation)}</p>
        <p><strong>Alternative explanation:</strong> ${escapeHtml(finding.alternativeExplanation)}</p>
        <p><strong>Recommended action:</strong> ${escapeHtml(finding.recommendedAction)}</p>
        <p><strong>Apply target:</strong> ${escapeHtml(finding.applyTarget)}</p>
        <p><strong>Evidence:</strong> ${escapeHtml(formatEvidence(finding.evidenceRefs))}</p>
        <p><strong>Confidence:</strong> ${escapeHtml(finding.confidence)}</p>
      </article>`
    )
    .join("");
}

function findingMeaning(finding: DreamFinding): string {
  if (/unresolved failure/i.test(finding.title)) {
    return "This is an action item about verification closure. It is not, by itself, proof that the current application code is broken.";
  }
  if (/later recovered/i.test(finding.title)) {
    return "This is not automatically a code bug. The agent hit a failed validation attempt, retried, and later produced matching passing evidence.";
  }
  if (/without frozen verification/i.test(finding.title)) {
    return "This means the scan packet shows edits but no captured validation command, so completion claims are weak.";
  }
  if (/repeated failed commands/i.test(finding.title)) {
    return "This points to process waste. The next agent should stop retry loops earlier and switch strategy.";
  }
  return "Use this as process evidence from the frozen scan packet, not as proof of the current live repository state.";
}

function findingAction(finding: DreamFinding): string {
  if (/unresolved failure/i.test(finding.title)) {
    return "A follow-up agent should rerun the named command or explicitly mark that verification lane blocked/unverified before using completion language.";
  }
  if (/later recovered/i.test(finding.title)) {
    return "No source change is implied; improve the session summary so it records the failed first attempt and the later passing command.";
  }
  if (/without frozen verification/i.test(finding.title)) {
    return "Run the relevant validation command in a new session and capture the result, or remove the completion claim.";
  }
  if (/repeated failed commands/i.test(finding.title)) {
    return "Add retry discipline to agent guidance: stop after repeated failures, summarize the first actionable error, and change strategy once.";
  }
  return "Use the cited packet evidence to decide whether to update agent guidance, validation tooling, or the final-answer format.";
}

function scoreTable(scores: DreamScore[]): string {
  return `<div class="table-scroll"><table>
    <thead><tr><th>Category</th><th>Score</th><th>Confidence</th><th>Rationale</th></tr></thead>
    <tbody>${scores
      .map(
        (score) => `<tr>
          <td>${escapeHtml(score.category)}</td>
          <td>${
            score.score === null
              ? `<span class="score-cell warn">insufficient</span>`
              : `<span class="score-cell ${scoreStatus(score.score)}">${score.score}/5</span>`
          }</td>
          <td>${escapeHtml(score.confidence)}</td>
          <td>${escapeHtml(score.rationale)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

function claimsReviewTable(sessions: DreamSession[]): string {
  const rows = sessions.flatMap((session) =>
    session.finalClaims
      .filter((claim) => claim.supported === undefined)
      .map((claim) => `<tr><td>${escapeHtml(session.sessionId)}</td><td>${escapeHtml(claim.text)}</td></tr>`)
  );
  if (!rows.length) return `<p class="empty">No claims need evidence review.</p>`;
  return `<div class="table-scroll"><table><thead><tr><th>Session</th><th>Claim needing review</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function generateDreamHtmlReport(packet: DreamPacket, report: Omit<DreamReport, "html">): string {
  const sessions = packet.selectedSessions;
  const critical = report.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical");
  const nonCritical = report.findings.filter((finding) => finding.severity !== "high" && finding.severity !== "critical");
  const failedVerification = report.findings.filter(
    (finding) => finding.category === "Verification quality" && finding.disposition === "reliable" && finding.severity === "high"
  ).length;
  const recoveredVerification = report.findings.filter((finding) => /later recovered/i.test(finding.title)).length;
  const reviewClaims = sessions.reduce((sum, session) => sum + session.finalClaims.filter((claim) => claim.supported === undefined).length, 0);
  const actionablePlan = report.applyPlan.findings.filter((finding) => finding.actionClass !== "no_action");
  const recommendations = actionablePlan.length
    ? [...new Set(actionablePlan.map((finding) => `- **${finding.actionClass}:** ${finding.recommendedAction} Target: ${finding.recommendedTarget}.`))]
    : ["- No action is justified by the selected frozen evidence."];
  const backlog = actionablePlan.length
    ? [...new Set(actionablePlan.map((finding) => `- ${finding.recommendedAction} Target: ${finding.recommendedTarget}.`))]
    : ["- No apply backlog item is justified by the selected frozen evidence."];
  const css = `
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --surface: #ffffff;
      --surface-soft: #f9faf7;
      --ink: #20252d;
      --muted: #65707f;
      --line: #dfe3dc;
      --green: #24765a;
      --blue: #2f69b1;
      --amber: #b76418;
      --red: #b94136;
      --shadow: 0 12px 32px rgba(32, 37, 45, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    main { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: end; margin-bottom: 18px; }
    h1, h2, h3, h4, p { margin: 0; }
    h1 { font-size: clamp(2rem, 4vw, 3.7rem); line-height: 1; max-width: 820px; }
    h2 { font-size: 1.15rem; margin-bottom: 12px; }
    h3 { font-size: 1rem; overflow-wrap: anywhere; }
    h4 { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0; margin-bottom: 6px; }
    .eyebrow { color: var(--blue); font-weight: 800; text-transform: uppercase; font-size: 0.78rem; margin-bottom: 8px; }
    .subtitle { max-width: 860px; color: var(--muted); margin-top: 12px; }
    .note, .generated {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .generated { padding: 12px 14px; min-width: 250px; }
    .generated span, .metric-card span, dt { display: block; color: var(--muted); font-size: 0.78rem; }
    .generated strong, dd { font-weight: 760; }
    .note { padding: 12px 14px; margin: 12px 0 18px; color: var(--muted); }
    .metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric-card, .panel, .session-card, .finding {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .metric-card { padding: 14px; min-height: 112px; border-top: 4px solid #cbd2cc; }
    .metric-card.good { border-top-color: var(--green); }
    .metric-card.warn { border-top-color: var(--amber); }
    .metric-card.bad { border-top-color: var(--red); }
    .metric-card strong { display: block; font-size: 1.9rem; line-height: 1.1; margin: 8px 0; }
    .metric-card small { color: var(--muted); }
    .layout { display: grid; grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr); gap: 16px; align-items: start; }
    .section-stack { display: grid; gap: 16px; }
    .panel { padding: 18px; overflow: hidden; }
    ul { margin: 0; padding-left: 1.1rem; }
    li + li { margin-top: 8px; }
    code { font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; font-size: 0.86em; background: #eef2ed; border-radius: 5px; padding: 1px 4px; }
    .session-list { display: grid; gap: 14px; }
    .session-card { padding: 16px; border-left: 5px solid var(--green); }
    .session-card.bad { border-left-color: var(--red); }
    .session-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 12px; }
    .session-head p { color: var(--muted); font-size: 0.88rem; margin-top: 3px; }
    .score-pill {
      flex: 0 0 auto;
      background: #eef2ed;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      font-weight: 760;
      font-size: 0.8rem;
    }
    .stat-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
    .stat-grid div { background: var(--surface-soft); border: 1px solid #e6eae3; border-radius: 8px; padding: 9px; min-width: 0; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .text-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
    .text-grid section { background: var(--surface-soft); border: 1px solid #e6eae3; border-radius: 8px; padding: 12px; }
    .claim-list { list-style: none; padding: 0; display: grid; gap: 8px; }
    .claim-list li { border: 1px solid var(--line); border-left: 4px solid var(--amber); border-radius: 8px; padding: 9px; background: #fffdf8; }
    .claim-list li.good { border-left-color: var(--green); }
    .claim-list li.bad { border-left-color: var(--red); }
    .claim-list span {
      display: inline-block;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 0.72rem;
      font-weight: 800;
      margin-bottom: 3px;
    }
    .reason-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .reason-row span { background: #eef2ed; border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-size: 0.76rem; font-weight: 720; }
    .reason-row .muted { color: var(--muted); font-weight: 600; }
    .finding { padding: 14px; border-left: 5px solid var(--green); }
    .finding.warn { border-left-color: var(--amber); }
    .finding.bad { border-left-color: var(--red); }
    .finding + .finding { margin-top: 10px; }
    .finding span { color: var(--muted); font-size: 0.76rem; font-weight: 800; }
    .finding p { margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0; border-bottom: 1px solid var(--line); padding: 0 10px 10px 0; }
    td { border-bottom: 1px solid #edf0ea; padding: 10px 10px 10px 0; vertical-align: top; }
    .score-cell { display: inline-block; min-width: 48px; text-align: center; border-radius: 999px; padding: 3px 8px; color: white; font-weight: 800; }
    .score-cell.good { background: var(--green); }
    .score-cell.warn { background: var(--amber); }
    .score-cell.bad { background: var(--red); }
    .empty { color: var(--muted); }
    @media (max-width: 1000px) {
      header, .layout { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      main { width: min(100% - 20px, 1280px); padding-top: 18px; }
      .metric-grid, .text-grid, .stat-grid { grid-template-columns: 1fr; }
      .session-head { display: grid; }
      .table-scroll { overflow-x: auto; }
      table { min-width: 720px; }
    }
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LunaObs Dream Report</title>
  <style>${css}</style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">LunaObs Dream</p>
        <h1>Frozen Evidence Review</h1>
        <p class="subtitle">Human-readable review of selected scanned agent sessions, final claims, verification gaps, and practical apply recommendations.</p>
      </div>
      <aside class="generated">
        <span>Generated at</span>
        <strong>${escapeHtml(packet.generatedAt)}</strong>
      </aside>
    </header>

    <p class="note">Score note: session <strong>inefficiency</strong> runs from 0 to 100, where 0 is best and 100 is worst. Category scores run from 0 to 5, where higher is better, or show insufficient when evidence cannot support a score. This report evaluates only frozen scan evidence.</p>

    <section class="metric-grid" aria-label="Dream summary">
      ${metricCard("Selected sessions", sessions.length, "Only these sessions were inspected")}
      ${metricCard("Average inefficiency", averageInefficiency(sessions).toFixed(1), "0 best, 100 worst", averageInefficiency(sessions) >= 55 ? "bad" : averageInefficiency(sessions) >= 30 ? "warn" : "good")}
      ${metricCard("Unresolved verification", failedVerification, "Failed checks without later pass", failedVerification ? "bad" : "good")}
      ${metricCard("Recovered attempts", recoveredVerification, "Failed checks with later pass", recoveredVerification ? "warn" : "good")}
      ${metricCard("Claims to review", reviewClaims, "Captured but not fully matched", reviewClaims ? "warn" : "good")}
    </section>

    <section class="layout">
      <div class="section-stack">
        <section class="panel">
          <h2>Recommendations</h2>
          ${htmlList(recommendations)}
        </section>
        <section class="panel">
          <h2>Dream Apply Backlog</h2>
          ${htmlList([...backlog, "- Do not apply application-code fixes from this report alone; it evaluates agent behavior, not live source state."])}
        </section>
        <section class="panel">
          <h2>Scores</h2>
          ${scoreTable(report.scores)}
        </section>
      </div>

      <div class="section-stack">
        <section class="panel">
          <h2>Critical Findings</h2>
          ${findingCards(critical)}
        </section>
        <section class="panel">
          <h2>Other Findings</h2>
          ${findingCards(nonCritical)}
        </section>
        <section class="panel">
          <h2>Claims Needing Evidence Review</h2>
          ${claimsReviewTable(sessions)}
        </section>
      </div>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2>Inspected Sessions</h2>
      <div class="session-list">${sessionCards(sessions)}</div>
    </section>

    <section class="layout" style="margin-top:16px">
      <section class="panel">
        <h2>Unsupported Claims</h2>
        ${report.unsupportedClaims.length ? htmlList(report.unsupportedClaims.map((claim) => `- ${claim.text}`)) : `<p class="empty">None supported by frozen evidence.</p>`}
      </section>
      <section class="panel">
        <h2>Missing Evidence</h2>
        ${report.missingEvidence.length ? htmlList(report.missingEvidence.map((item) => `- ${item}`)) : `<p class="empty">None identified.</p>`}
      </section>
    </section>
  </main>
</body>
</html>
`;
}

export function validateDreamPacket(packet: DreamPacket): DreamReport {
  const findings: DreamFinding[] = [];
  const evaluatedInstructions: InstructionCheck[] = [];
  const ignoredInstructions: InstructionCheck[] = [];
  const unsupportedClaims: ClaimCheck[] = [];

  for (const session of packet.selectedSessions) {
    verificationFindings(session, findings);
    efficiencyFindings(session, findings);
    intentFindings(session, findings);
    const sessionInstructions = instructionFindings(session, findings);
    evaluatedInstructions.push(...sessionInstructions);
    ignoredInstructions.push(...sessionInstructions.filter((instruction) => instruction.status === "violated" || instruction.status === "partially_followed"));
    unsupportedClaims.push(...unsupportedClaimFindings(session, findings));
  }

  const severityRank: Record<DreamSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  findings.sort((left, right) => severityRank[right.severity] - severityRank[left.severity] || left.category.localeCompare(right.category));

  const scores = [
    scoreIntent(packet.selectedSessions),
    scoreInstructions(evaluatedInstructions, packet.selectedSessions),
    scoreGrounding(unsupportedClaims, packet.selectedSessions),
    scoreVerification(packet.selectedSessions),
    scoreEfficiency(packet.selectedSessions)
  ];
  const critical = findings.filter((finding) => finding.severity === "high" || finding.severity === "critical");
  const nonCritical = findings.filter((finding) => finding.severity !== "high" && finding.severity !== "critical");
  const missingEvidence = uniqueMissingEvidence(packet.selectedSessions);

  const markdown = [
    "# LunaObs Dream Report",
    "",
    "## Summary",
    "",
    `- Overall outcome: ${critical.length ? "risky or incomplete agent behavior needs attention" : "no high-severity frozen-evidence issue was found"}.`,
    `- Strongest finding: ${findings[0]?.title ?? "none"}.`,
    `- Biggest risk: ${critical[0]?.explanation ?? "missing evidence limits confidence"}`,
    `- Best lesson: ${lessonsFromEfficientSessions(packet.selectedSessions)[0]?.replace(/^- /, "") ?? "missing efficient comparison evidence"}`,
    `- Selected sessions: ${packet.selectedSessions.length}. This report evaluates only frozen scan evidence, not the live repository.`,
    "- Score note: session inefficiency is 0 best / 100 worst; category scores are 0-5 with higher better, or `insufficient` when evidence cannot support a score.",
    "",
    "## What Was Inspected",
    "",
    "The sessions below are the only sessions this report evaluated.",
    "",
    ...inspectedSessionRows(packet.selectedSessions),
    "",
    "## Sessions, Intent, And Final Claims",
    "",
    ...intentOutcomeRows(packet.selectedSessions),
    "",
    "## Scores",
    "",
    ...scoreRows(scores),
    "",
    "## Critical Findings",
    "",
    ...(critical.length ? critical.map(findingLine) : ["- None."]),
    "",
    "## Other Findings",
    "",
    ...(nonCritical.length ? nonCritical.map(findingLine) : ["- None."]),
    "",
    "## Ignored or weakened instructions",
    "",
    ...(ignoredInstructions.length
      ? ignoredInstructions.map((instruction) => `- ${instruction.status}: ${instruction.text}`)
      : ["- None supported by frozen evidence."]),
    "",
    "## Unsupported claims",
    "",
    ...(unsupportedClaims.length
      ? unsupportedClaims.map((claim) => `- Final-answer claim lacks frozen evidence: ${claim.text}`)
      : ["- None supported by frozen evidence."]),
    "",
    "## Claims needing evidence review",
    "",
    ...claimsNeedingReview(packet.selectedSessions),
    "",
    "## Verification review",
    "",
    ...packet.selectedSessions.map(verificationReviewLine),
    "",
    "## Efficiency comparison",
    "",
    ...compareSessions(packet.selectedSessions),
    "",
    "## Lessons from efficient sessions",
    "",
    ...lessonsFromEfficientSessions(packet.selectedSessions),
    "",
    "## Recommendations",
    "",
    ...actionableRecommendations(packet.selectedSessions, missingEvidence),
    "",
    "## Dream Apply Backlog",
    "",
    ...dreamApplyBacklog(packet.selectedSessions, missingEvidence),
    "- Do not apply application-code fixes from this report alone; it evaluates agent behavior, not live source state.",
    "",
    "## Missing evidence",
    "",
    ...(missingEvidence.length ? missingEvidence.map((item) => `- ${item}`) : ["- None identified."]),
    "",
    "## Evidence Notes",
    "",
    ...evidenceNotes(packet.selectedSessions),
    ""
  ].join("\n");

  const decision = buildDreamDecisionReport({
    packet,
    scores,
    findings,
    ignoredInstructions,
    unsupportedClaims,
    missingEvidence
  });
  const reportWithoutHtml = {
    scores,
    findings,
    ignoredInstructions,
    unsupportedClaims,
    missingEvidence,
    markdown: decision.markdown,
    detailsMarkdown: decision.detailsMarkdown,
    overallConfidence: decision.overallConfidence,
    applyPlan: decision.applyPlan
  };
  return { ...reportWithoutHtml, html: generateDreamHtmlReport(packet, reportWithoutHtml) };
}

export function readDreamPacket(input: string): DreamPacket {
  const resolved = path.resolve(input);
  const packetPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, "dream-pack.json") : resolved;
  return JSON.parse(fs.readFileSync(packetPath, "utf8")) as DreamPacket;
}

export function resolveDreamReportPath(input: string, out?: string): string {
  if (out) {
    const resolved = path.resolve(out);
    if (path.extname(resolved).toLowerCase() === ".md") return resolved;
    return path.join(resolved, "report.md");
  }
  const resolvedInput = path.resolve(input);
  return fs.statSync(resolvedInput).isDirectory() ? path.join(resolvedInput, "report.md") : path.join(path.dirname(resolvedInput), "report.md");
}

function htmlReportPath(markdownPath: string): string {
  return markdownPath.replace(/\.md$/i, ".html");
}

function detailsReportPath(markdownPath: string): string {
  return path.join(path.dirname(markdownPath), "details.md");
}

function applyPlanPath(markdownPath: string): string {
  return path.join(path.dirname(markdownPath), "apply-plan.json");
}

export function writeDreamValidationReport(input: string, out?: string): string {
  const packet = readDreamPacket(input);
  const report = validateDreamPacket(packet);
  const reportPath = resolveDreamReportPath(input, out);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report.markdown, "utf8");
  fs.writeFileSync(htmlReportPath(reportPath), report.html, "utf8");
  fs.writeFileSync(detailsReportPath(reportPath), report.detailsMarkdown, "utf8");
  fs.writeFileSync(applyPlanPath(reportPath), `${JSON.stringify(report.applyPlan, null, 2)}\n`, "utf8");
  return reportPath;
}

export function resolveDreamHtmlReportPath(input: string, out?: string): string {
  return htmlReportPath(resolveDreamReportPath(input, out));
}


export function resolveDreamDetailsReportPath(input: string, out?: string): string {
  return detailsReportPath(resolveDreamReportPath(input, out));
}

export function resolveDreamApplyPlanPath(input: string, out?: string): string {
  return applyPlanPath(resolveDreamReportPath(input, out));
}
