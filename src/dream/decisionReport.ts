import type {
  ClaimCheck,
  DreamApplyActionClass,
  DreamApplyPlan,
  DreamApplyPlanFinding,
  DreamChangeClassification,
  DreamChangeType,
  DreamConfidence,
  DreamEvidenceRef,
  DreamFinding,
  DreamFindingDisposition,
  DreamPacket,
  DreamScore,
  DreamSession,
  DreamSeverity,
  DreamTaskWindow,
  InstructionCheck,
  VerificationCheck
} from "./types.js";

const severityRank: Record<DreamSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

const confidenceRank: Record<DreamConfidence, number> = { low: 1, medium: 2, high: 3 };

export type DreamFindingPattern = {
  patternKey: string;
  category: string;
  title: string;
  severity: DreamSeverity;
  confidence: DreamConfidence;
  dispositionCounts: Record<DreamFindingDisposition, number>;
  findings: DreamFinding[];
  affectedSessionIds: string[];
  affectedTaskIds: string[];
  affectedRepositories: string[];
  observation: string;
  interpretation: string;
  alternativeExplanation: string;
  recommendedAction: string;
  applyTarget: string;
};

export type DreamDecisionReportInput = {
  packet: DreamPacket;
  scores: DreamScore[];
  findings: DreamFinding[];
  ignoredInstructions: InstructionCheck[];
  unsupportedClaims: ClaimCheck[];
  missingEvidence: string[];
};

export type DreamDecisionReportResult = {
  markdown: string;
  detailsMarkdown: string;
  patterns: DreamFindingPattern[];
  overallConfidence: DreamConfidence;
  applyPlan: DreamApplyPlan;
};

function compact(value: string | undefined, maxLength = 240): string {
  if (!value?.trim()) return "missing";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function tableCell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function markdownTable(headers: string[], rows: unknown[][]): string[] {
  if (!rows.length) return ["_None._"];
  return [
    `| ${headers.map(tableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`)
  ];
}

function metricNumber(session: DreamSession, key: string): number {
  const value = (session.metrics as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  }
  return 0;
}

function repoIdentity(session: DreamSession | undefined): string {
  return session?.repoRoot?.replace(/[\\/]+$/, "") || "unknown";
}

function repoName(session: DreamSession | undefined): string {
  const identity = repoIdentity(session);
  if (identity === "unknown") return identity;
  return identity.split(/[\\/]/).at(-1) || identity;
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10) || undefined;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(parsed);
}

function meaningfulIntentLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = value
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .find(
      (item) =>
        !/^<\/?environment_context>/i.test(item) &&
        !/^(automation id|automation memory|last run|session id|task id)\s*:/i.test(item)
    );
  return line?.replace(/^automation\s*:\s*/i, "").trim();
}

function cleanLabel(value: string): string {
  let label = value
    .replace(/[`*_#[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  if (/luna\s*os\s*v?2\s+issue\s+worker/i.test(label)) {
    label = label.replace(/luna\s*os\s*v?2\s+issue\s+worker/i, "Luna OS v2 issue triage");
  }
  if (label.length > 72) label = `${label.slice(0, 69).trimEnd()}...`;
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : "Task";
}

export function dreamHumanLabel(session: DreamSession, task?: DreamTaskWindow): string {
  const taskLabel = task?.label?.trim();
  const usableTaskLabel = taskLabel && !/^task(?:[\s_-]*\d+)?$/i.test(taskLabel) ? taskLabel : undefined;
  const source = usableTaskLabel ?? meaningfulIntentLine(task?.intent) ?? meaningfulIntentLine(session.userIntent) ?? `${repoName(session)} task`;
  const label = cleanLabel(source);
  const date = formatDate(task?.startedAt ?? session.startedAt ?? task?.endedAt ?? session.endedAt);
  if (!date || /\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/.test(label)) return label;
  return `${label}, ${date}`;
}

function sessionMap(packet: DreamPacket): Map<string, DreamSession> {
  return new Map(packet.selectedSessions.map((session) => [session.sessionId, session]));
}

function taskForFinding(session: DreamSession | undefined, finding: DreamFinding): DreamTaskWindow | undefined {
  if (!session || !finding.taskId) return undefined;
  return session.tasks?.find((task) => task.taskId === finding.taskId);
}

function findingLabel(packet: DreamPacket, finding: DreamFinding): string {
  const session = finding.sessionId ? sessionMap(packet).get(finding.sessionId) : undefined;
  if (!session) return "Report-wide finding";
  return dreamHumanLabel(session, taskForFinding(session, finding));
}

function fallbackPatternKey(finding: DreamFinding): string {
  const slug = `${finding.category}.${finding.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return slug || finding.findingId;
}

function distinctSummary(values: string[], fallback: string, maxItems = 3): string {
  const distinct = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!distinct.length) return fallback;
  const shown = distinct.slice(0, maxItems).join(" / ");
  return distinct.length > maxItems ? `${shown} (+${distinct.length - maxItems} more)` : shown;
}

function lowestConfidence(findings: DreamFinding[]): DreamConfidence {
  return findings.reduce<DreamConfidence>(
    (lowest, finding) => (confidenceRank[finding.confidence] < confidenceRank[lowest] ? finding.confidence : lowest),
    "high"
  );
}

function highestSeverity(findings: DreamFinding[]): DreamSeverity {
  return findings.reduce<DreamSeverity>(
    (highest, finding) => (severityRank[finding.severity] > severityRank[highest] ? finding.severity : highest),
    "info"
  );
}

export function groupDreamFindings(packet: DreamPacket, findings: DreamFinding[]): DreamFindingPattern[] {
  const sessions = sessionMap(packet);
  const grouped = new Map<string, DreamFinding[]>();
  for (const finding of findings) {
    const key = finding.patternKey?.trim() || fallbackPatternKey(finding);
    grouped.set(key, [...(grouped.get(key) ?? []), finding]);
  }

  return [...grouped.entries()]
    .map(([patternKey, items]): DreamFindingPattern => {
      const affectedSessionIds = [...new Set(items.map((finding) => finding.sessionId).filter((id): id is string => Boolean(id)))];
      const affectedTaskIds = [
        ...new Set(
          items
            .filter((finding) => finding.taskId)
            .map((finding) => `${finding.sessionId ?? "unknown"}:${finding.taskId as string}`)
        )
      ];
      const repositories = new Map<string, string>();
      for (const sessionId of affectedSessionIds) {
        const repo = repoIdentity(sessions.get(sessionId));
        repositories.set(repo.toLowerCase(), repo);
      }
      if (!affectedSessionIds.length) repositories.set("unknown", "unknown");

      return {
        patternKey,
        category: items[0]?.category ?? "Unknown",
        title: items[0]?.title ?? patternKey,
        severity: highestSeverity(items),
        confidence: lowestConfidence(items),
        dispositionCounts: {
          reliable: items.filter((item) => item.disposition === "reliable").length,
          possible_false_positive: items.filter((item) => item.disposition === "possible_false_positive").length,
          insufficient_evidence: items.filter((item) => item.disposition === "insufficient_evidence").length
        },
        findings: items,
        affectedSessionIds,
        affectedTaskIds,
        affectedRepositories: [...repositories.values()],
        observation: distinctSummary(items.map((item) => item.observation), "No observation was recorded."),
        interpretation: distinctSummary(items.map((item) => item.interpretation), "No interpretation was recorded."),
        alternativeExplanation: distinctSummary(
          items.map((item) => item.alternativeExplanation),
          "No alternative explanation was recorded."
        ),
        recommendedAction: distinctSummary(
          items.map((item) => item.recommendedAction || item.suggestedImprovement),
          "No action was justified."
        ),
        applyTarget: distinctSummary(items.map((item) => item.applyTarget), "No apply target was justified.")
      };
    })
    .sort((left, right) => {
      const leftReliable = left.dispositionCounts.reliable > 0 ? 1 : 0;
      const rightReliable = right.dispositionCounts.reliable > 0 ? 1 : 0;
      return (
        rightReliable - leftReliable ||
        severityRank[right.severity] - severityRank[left.severity] ||
        right.findings.length - left.findings.length ||
        left.patternKey.localeCompare(right.patternKey)
      );
    });
}

function affectedTaskConfidence(packet: DreamPacket, finding: DreamFinding): DreamConfidence | undefined {
  if (!finding.sessionId || !finding.taskId) return undefined;
  const session = sessionMap(packet).get(finding.sessionId);
  return session?.tasks?.find((task) => task.taskId === finding.taskId)?.segmentationConfidence;
}

export function deriveDreamOverallConfidence(
  packet: DreamPacket,
  findings: DreamFinding[],
  missingEvidence: string[]
): DreamConfidence {
  const reliable = findings.filter((finding) => finding.disposition === "reliable");
  if (!reliable.length) return missingEvidence.length || findings.length ? "low" : "medium";
  if (reliable.every((finding) => finding.confidence === "low")) return "low";

  const lowSegmentation = reliable.some((finding) => affectedTaskConfidence(packet, finding) === "low");
  const uncertainCount = findings.filter((finding) => finding.disposition !== "reliable").length;
  const allHigh = reliable.every((finding) => finding.confidence === "high" && finding.evidenceRefs.length > 0);
  if (allHigh && !lowSegmentation && !missingEvidence.length && uncertainCount === 0) return "high";
  return "medium";
}

function isMeasurementFinding(finding: DreamFinding): boolean {
  const text = [
    finding.patternKey,
    finding.title,
    finding.interpretation,
    finding.recommendedAction,
    finding.applyTarget
  ]
    .join(" ")
    .toLowerCase();
  return /\bdream\b|dream[_ -]?analy[sz]er|measurement|false positive|change classification|task segmentation|scan capture|finding accuracy|mutation outcome/.test(
    text
  );
}

function isGuidanceTarget(finding: DreamFinding): boolean {
  return /agents\.md|guidance|runbook|skill/i.test(`${finding.applyTarget} ${finding.recommendedAction}`);
}

function isSharedGuidanceTarget(finding: DreamFinding): boolean {
  return /\b(shared|global|cross[- ]repository|all repositories)\b/i.test(
    `${finding.applyTarget} ${finding.recommendedAction}`
  );
}

function isNoAction(finding: DreamFinding): boolean {
  return /^(?:none|no action|no_action)$/i.test(finding.applyTarget.trim()) || /\bno[_ -]?action\b/i.test(finding.recommendedAction);
}

function actionClassFor(finding: DreamFinding, pattern: DreamFindingPattern): DreamApplyActionClass {
  if (finding.disposition === "insufficient_evidence") return "human_review_required";
  if (isMeasurementFinding(finding)) return "analyzer_improvement";
  if (isNoAction(finding)) return "no_action";
  if (finding.disposition !== "reliable") return "human_review_required";
  if (isGuidanceTarget(finding)) {
    const knownRepositories = pattern.affectedRepositories.filter((repository) => repository !== "unknown");
    const reliableScopes = new Set(
      pattern.findings
        .filter((item) => item.disposition === "reliable")
        .map((item) => `${item.sessionId ?? "report"}:${item.taskId ?? "session"}`)
    );
    if (!isSharedGuidanceTarget(finding) && reliableScopes.size >= 2 && knownRepositories.length === 1) {
      return "safe_guidance_update";
    }
    return "repository_specific_investigation";
  }
  return "repository_specific_investigation";
}

function changeTypeForFinding(packet: DreamPacket, finding: DreamFinding): DreamChangeType | undefined {
  const knownTypes: DreamChangeType[] = [
    "product_code",
    "tests",
    "documentation",
    "repository_metadata",
    "automation_memory",
    "external_system",
    "generated_asset",
    "local_file_organization",
    "read_only",
    "unknown"
  ];
  const patternType = knownTypes.find((type) => finding.patternKey.toLowerCase().includes(type));
  if (patternType) return patternType;
  if (!finding.sessionId) return undefined;
  const session = sessionMap(packet).get(finding.sessionId);
  const task = taskForFinding(session, finding);
  const types = [...new Set((task?.changes ?? []).filter((change) => change.stateChanging).map((change) => change.changeType))];
  return types.length === 1 ? types[0] : types.includes("unknown") ? "unknown" : undefined;
}

function relevantChanges(packet: DreamPacket, finding: DreamFinding): DreamChangeClassification[] {
  if (!finding.sessionId) return [];
  const session = sessionMap(packet).get(finding.sessionId);
  const task = taskForFinding(session, finding);
  const type = changeTypeForFinding(packet, finding);
  const changes = (task?.changes ?? []).filter((change) => change.stateChanging);
  return type ? changes.filter((change) => change.changeType === type) : changes;
}

function verificationRequiredForFinding(packet: DreamPacket, finding: DreamFinding): boolean | null | undefined {
  const requirements = [...new Set(relevantChanges(packet, finding).map((change) => change.verificationRequired))];
  return requirements.length === 1 ? requirements[0] : requirements.length ? null : undefined;
}

function matchingPassingCheck(change: DreamChangeClassification, checks: VerificationCheck[]): boolean {
  return checks.some(
    (check) =>
      check.status === "passed" &&
      check.fresh !== false &&
      (check.actionIndex === undefined || check.actionIndex > change.actionIndex) &&
      (!change.acceptableVerificationTypes.length ||
        (check.verificationType !== undefined && change.acceptableVerificationTypes.includes(check.verificationType)))
  );
}

function verificationObservedForFinding(packet: DreamPacket, finding: DreamFinding): boolean {
  if (!finding.sessionId) return false;
  const session = sessionMap(packet).get(finding.sessionId);
  const task = taskForFinding(session, finding);
  const changes = relevantChanges(packet, finding).filter((change) => change.verificationRequired === true);
  if (changes.length) return changes.every((change) => matchingPassingCheck(change, task?.verificationChecks ?? []));
  return (task?.verificationChecks ?? session?.verificationChecks ?? []).some(
    (check) => check.status === "passed" && check.fresh !== false
  );
}

export function buildDreamApplyPlan(
  packet: DreamPacket,
  findings: DreamFinding[],
  patterns = groupDreamFindings(packet, findings)
): DreamApplyPlan {
  const patternByKey = new Map(patterns.map((pattern) => [pattern.patternKey, pattern]));
  const sessions = sessionMap(packet);
  const applyFindings: DreamApplyPlanFinding[] = findings.map((finding) => {
    const key = finding.patternKey?.trim() || fallbackPatternKey(finding);
    const pattern = patternByKey.get(key);
    if (!pattern) throw new Error(`Missing grouped pattern for ${finding.findingId}`);
    const actionClass = actionClassFor(finding, pattern);
    const verificationRequired = verificationRequiredForFinding(packet, finding);
    return {
      findingId: finding.findingId,
      sessionId: finding.sessionId,
      taskId: finding.taskId,
      changeType: changeTypeForFinding(packet, finding),
      ...(verificationRequired === undefined ? {} : { verificationRequired }),
      verificationObserved: verificationObservedForFinding(packet, finding),
      confidence: finding.confidence,
      actionClass,
      recommendedTarget: actionClass === "analyzer_improvement" ? "Dream analyzer" : finding.applyTarget,
      recommendedAction: finding.recommendedAction || finding.suggestedImprovement,
      evidenceRefs: finding.evidenceRefs
    };
  });

  const affectedSessionIds = [...new Set(findings.map((finding) => finding.sessionId).filter((id): id is string => Boolean(id)))];
  const repositories = new Set(affectedSessionIds.map((sessionId) => repoIdentity(sessions.get(sessionId)).toLowerCase()));
  return {
    schemaVersion: 1,
    generatedAt: packet.generatedAt,
    sample: {
      selectedSessions: packet.selectedSessions.length,
      affectedSessions: affectedSessionIds.length,
      affectedRepositories: repositories.size,
      representative: false,
      note:
        "Dream uses a stratified selected sample. Recommendation counts describe only the frozen selected sessions and are not population prevalence estimates."
    },
    findings: applyFindings
  };
}

function planByFindingId(plan: DreamApplyPlan): Map<string, DreamApplyPlanFinding> {
  return new Map(plan.findings.map((finding) => [finding.findingId, finding]));
}

function patternActionClasses(pattern: DreamFindingPattern, plan: DreamApplyPlan): DreamApplyActionClass[] {
  const byId = planByFindingId(plan);
  return [
    ...new Set(
      pattern.findings
        .map((finding) => byId.get(finding.findingId)?.actionClass)
        .filter((action): action is DreamApplyActionClass => Boolean(action))
    )
  ];
}

function generalizationConfidence(pattern: DreamFindingPattern, plan: DreamApplyPlan): DreamConfidence {
  const actions = patternActionClasses(pattern, plan);
  if (actions.includes("analyzer_improvement")) return pattern.confidence;
  if (actions.includes("safe_guidance_update")) return pattern.confidence === "low" ? "medium" : pattern.confidence;
  return "low";
}

function patternSessionLabels(packet: DreamPacket, pattern: DreamFindingPattern): string {
  const sessions = sessionMap(packet);
  const labels = pattern.affectedSessionIds.map((sessionId) => {
    const session = sessions.get(sessionId);
    const taskFinding = pattern.findings.find((finding) => finding.sessionId === sessionId && finding.taskId);
    const task = taskFinding ? taskForFinding(session, taskFinding) : undefined;
    return session ? `${dreamHumanLabel(session, task)} (\`${sessionId}\`)` : `\`${sessionId}\``;
  });
  const shown = labels.slice(0, 5).join("; ");
  return labels.length > 5 ? `${shown}; +${labels.length - 5} more` : shown || "report-wide";
}

function actionablePatterns(patterns: DreamFindingPattern[], plan: DreamApplyPlan): DreamFindingPattern[] {
  return [...patterns]
    .filter((pattern) => !patternActionClasses(pattern, plan).every((action) => action === "no_action"))
    .sort((left, right) => {
      const actionWeight = (pattern: DreamFindingPattern): number => {
        const actions = patternActionClasses(pattern, plan);
        if (actions.includes("analyzer_improvement")) return 4;
        if (actions.includes("safe_guidance_update")) return 3;
        if (pattern.dispositionCounts.reliable) return 2;
        return 1;
      };
      return (
        actionWeight(right) - actionWeight(left) ||
        severityRank[right.severity] - severityRank[left.severity] ||
        right.findings.length - left.findings.length
      );
    });
}

function uniquePatternsForAction(
  patterns: DreamFindingPattern[],
  plan: DreamApplyPlan,
  actionClass: DreamApplyActionClass
): DreamFindingPattern[] {
  return patterns.filter((pattern) => patternActionClasses(pattern, plan).includes(actionClass));
}

export function renderDreamDecisionMarkdown(
  input: DreamDecisionReportInput,
  patterns: DreamFindingPattern[],
  overallConfidence: DreamConfidence,
  applyPlan: DreamApplyPlan
): string {
  const { packet, findings, missingEvidence } = input;
  const selectedRepositories = new Set(packet.selectedSessions.map((session) => repoIdentity(session).toLowerCase()));
  const reliableCount = findings.filter((finding) => finding.disposition === "reliable").length;
  const falsePositiveCount = findings.filter((finding) => finding.disposition === "possible_false_positive").length;
  const humanReview = applyPlan.findings.filter((finding) => finding.actionClass === "human_review_required");
  const guidancePatterns = uniquePatternsForAction(patterns, applyPlan, "safe_guidance_update");
  const analyzerPatterns = uniquePatternsForAction(patterns, applyPlan, "analyzer_improvement");
  const topLessons = actionablePatterns(patterns, applyPlan).slice(0, 3);

  const lines: string[] = [
    "# LunaObs Dream Decision Report",
    "",
    `Generated from frozen packet evidence at ${packet.generatedAt}.`,
    "",
    "## Decision summary",
    "",
    `- Reliable findings: **${reliableCount}**.`,
    `- Possible false positives: **${falsePositiveCount}**.`,
    `- Proposed guidance changes: **${guidancePatterns.length}**.`,
    `- Findings requiring human review: **${humanReview.length}**.`,
    `- Overall evidence confidence: **${overallConfidence}**.`,
    `- Sample: ${packet.selectedSessions.length} selected session(s) across ${selectedRepositories.size} repository identity/identities; **not representative** because Dream selection is stratified.`,
    "",
    "## Top three actionable lessons",
    ""
  ];

  if (!topLessons.length) {
    lines.push("- No actionable lesson was justified by the frozen selected evidence.");
  } else {
    topLessons.forEach((pattern, index) => {
      lines.push(
        `${index + 1}. **${pattern.title}** — ${compact(pattern.recommendedAction, 220)} ` +
          `(${pattern.findings.length} finding(s), ${pattern.affectedSessionIds.length} session(s), ${pattern.affectedRepositories.length} repository identity/identities; ${pattern.confidence} confidence).`
      );
    });
  }

  lines.push("", "## Proposed guidance changes", "");
  if (!guidancePatterns.length) {
    lines.push("- None justified. This stratified sample is not sufficient evidence for a shared-guidance change.");
  } else {
    for (const pattern of guidancePatterns) {
      lines.push(
        `- **${pattern.applyTarget}:** ${compact(pattern.recommendedAction, 260)} Evidence scope: ${pattern.dispositionCounts.reliable} reliable finding(s), ${pattern.affectedSessionIds.length} session(s), ${pattern.affectedRepositories.length} repository identity/identities.`
      );
    }
  }

  lines.push("", "## Dream analyzer changes", "");
  if (!analyzerPatterns.length) {
    lines.push("- None identified.");
  } else {
    for (const pattern of analyzerPatterns) {
      lines.push(
        `- **${pattern.title}:** ${compact(pattern.recommendedAction, 260)} Target: Dream analyzer. ` +
          `This is a measurement-correctness action, not a cross-repository guidance recommendation.`
      );
    }
  }

  lines.push("", "## Findings requiring human review", "");
  if (!humanReview.length) {
    lines.push("- None.");
  } else {
    for (const item of humanReview.slice(0, 10)) {
      const source = findings.find((finding) => finding.findingId === item.findingId);
      lines.push(
        `- **${source ? findingLabel(packet, source) : item.findingId}** (\`${item.findingId}\`): ${compact(
          item.recommendedAction,
          240
        )}`
      );
    }
    if (humanReview.length > 10) lines.push(`- ${humanReview.length - 10} additional review item(s) are listed in \`details.md\`.`);
  }

  lines.push("", "## Finding patterns", "");
  if (!patterns.length) {
    lines.push("- No finding pattern was produced.");
  } else {
    for (const pattern of patterns) {
      lines.push(
        `### ${pattern.title} (\`${pattern.patternKey}\`)`,
        "",
        `- Scope: ${pattern.findings.length} finding(s), ${pattern.affectedSessionIds.length} session(s), ${pattern.affectedTaskIds.length} task(s), ${pattern.affectedRepositories.length} repository identity/identities. Sample representative: **no**.`,
        `- Disposition: ${pattern.dispositionCounts.reliable} reliable; ${pattern.dispositionCounts.possible_false_positive} possible false positive; ${pattern.dispositionCounts.insufficient_evidence} insufficient evidence.`,
        `- Observation: ${compact(pattern.observation, 420)}`,
        `- Interpretation: ${compact(pattern.interpretation, 420)}`,
        `- Alternative explanation: ${compact(pattern.alternativeExplanation, 420)}`,
        `- Recommended action: ${compact(pattern.recommendedAction, 420)}`,
        `- Apply target: ${compact(pattern.applyTarget, 220)}`,
        `- Confidence: ${pattern.confidence}.`,
        `- Affected: ${patternSessionLabels(packet, pattern)}.`,
        ""
      );
    }
  }

  lines.push(
    "## Recommendation scope",
    "",
    ...markdownTable(
      ["Pattern", "Reliable", "Sessions", "Repositories", "Representative", "Generalization confidence", "Target"],
      patterns.map((pattern) => [
        pattern.patternKey,
        pattern.dispositionCounts.reliable,
        pattern.affectedSessionIds.length,
        pattern.affectedRepositories.length,
        "no",
        generalizationConfidence(pattern, applyPlan),
        pattern.applyTarget
      ])
    ),
    "",
    "## Missing evidence",
    ""
  );
  if (!missingEvidence.length) lines.push("- None identified.");
  else {
    lines.push(...missingEvidence.slice(0, 10).map((item) => `- ${item}`));
    if (missingEvidence.length > 10) lines.push(`- ${missingEvidence.length - 10} additional item(s) are listed in \`details.md\`.`);
  }

  lines.push(
    "",
    "## Traceability",
    "",
    "- Human labels are paired with raw session and task IDs in `details.md`.",
    "- Full task, change, verification, claim, instruction, finding, and evidence tables are in `details.md`.",
    "- Machine-readable follow-up decisions are in `apply-plan.json`.",
    "- The complete frozen evidence set remains in `dream-pack.json`.",
    ""
  );
  return lines.join("\n");
}

function evidenceIds(refs: DreamEvidenceRef[] | undefined): string {
  return refs?.length ? refs.map((ref) => ref.id).join("<br>") : "-";
}

function allEvidenceRefs(input: DreamDecisionReportInput): DreamEvidenceRef[] {
  const refs = new Map<string, DreamEvidenceRef>();
  const add = (items: DreamEvidenceRef[] | undefined): void => {
    for (const item of items ?? []) if (!refs.has(item.id)) refs.set(item.id, item);
  };
  for (const session of input.packet.selectedSessions) {
    add(session.evidenceRefs);
    for (const instruction of session.instructionChecks) add(instruction.evidenceRefs);
    for (const claim of session.finalClaims) add(claim.evidenceRefs);
    for (const check of session.verificationChecks) add(check.evidenceRefs);
    for (const task of session.tasks ?? []) {
      add(task.evidenceRefs);
      for (const change of task.changes) add(change.evidenceRefs);
      for (const check of task.verificationChecks) add(check.evidenceRefs);
      for (const claim of task.finalClaims) add(claim.evidenceRefs);
    }
  }
  for (const finding of input.findings) add(finding.evidenceRefs);
  for (const instruction of input.ignoredInstructions) add(instruction.evidenceRefs);
  for (const claim of input.unsupportedClaims) add(claim.evidenceRefs);
  return [...refs.values()].sort((left, right) =>
    `${left.sessionId ?? ""}:${left.sourceFile ?? ""}:${left.lineNumber ?? 0}:${left.id}`.localeCompare(
      `${right.sessionId ?? ""}:${right.sourceFile ?? ""}:${right.lineNumber ?? 0}:${right.id}`
    )
  );
}

export function renderDreamTraceabilityMarkdown(input: DreamDecisionReportInput, patterns: DreamFindingPattern[]): string {
  const { packet, scores, findings, ignoredInstructions, unsupportedClaims, missingEvidence } = input;
  const taskRows: unknown[][] = [];
  const changeRows: unknown[][] = [];
  const verificationRows: unknown[][] = [];
  const claimRows: unknown[][] = [];
  const instructionRows: unknown[][] = [];

  for (const session of packet.selectedSessions) {
    for (const instruction of session.instructionChecks) {
      instructionRows.push([
        dreamHumanLabel(session),
        session.sessionId,
        instruction.status ?? "unknown",
        compact(instruction.text, 500),
        evidenceIds(instruction.evidenceRefs)
      ]);
    }

    const tasks = session.tasks ?? [];
    if (!tasks.length) {
      taskRows.push([
        dreamHumanLabel(session),
        session.sessionId,
        "session-level fallback",
        metricNumber(session, "taskStarts") > 1 ? "low" : "medium",
        compact(session.userIntent, 500),
        compact(session.finalAnswer, 500),
        "No task windows were captured"
      ]);
      for (const check of session.verificationChecks) {
        verificationRows.push([
          dreamHumanLabel(session),
          session.sessionId,
          "session-level fallback",
          check.verificationType ?? "unknown",
          check.status,
          check.fresh === undefined ? "unknown" : check.fresh,
          check.actionIndex,
          check.target,
          compact(check.command, 500),
          evidenceIds(check.evidenceRefs)
        ]);
      }
      for (const claim of session.finalClaims) {
        claimRows.push([
          dreamHumanLabel(session),
          session.sessionId,
          "session-level fallback",
          claim.supported === undefined ? "needs review" : claim.supported ? "supported" : "unsupported",
          compact(claim.text, 600),
          evidenceIds(claim.evidenceRefs)
        ]);
      }
      continue;
    }

    for (const task of tasks) {
      const label = dreamHumanLabel(session, task);
      taskRows.push([
        label,
        session.sessionId,
        task.taskId,
        task.segmentationConfidence,
        compact(task.intent, 500),
        compact(task.finalAnswer, 500),
        evidenceIds(task.evidenceRefs)
      ]);
      for (const change of task.changes) {
        changeRows.push([
          label,
          session.sessionId,
          task.taskId,
          change.changeId,
          change.actionIndex,
          change.changeType,
          change.target,
          change.stateChanging,
          change.verificationRequired === null ? "unknown" : change.verificationRequired,
          change.acceptableVerificationTypes.join(", ") || "none",
          change.repositoryTestsRelevant,
          change.confidence,
          change.evidence.join(" / ") || "-",
          evidenceIds(change.evidenceRefs)
        ]);
      }
      for (const check of task.verificationChecks) {
        verificationRows.push([
          label,
          session.sessionId,
          task.taskId,
          check.verificationType ?? "unknown",
          check.status,
          check.fresh === undefined ? "unknown" : check.fresh,
          check.actionIndex,
          check.target,
          compact(check.command, 500),
          evidenceIds(check.evidenceRefs)
        ]);
      }
      for (const claim of task.finalClaims) {
        claimRows.push([
          label,
          session.sessionId,
          task.taskId,
          claim.supported === undefined ? "needs review" : claim.supported ? "supported" : "unsupported",
          compact(claim.text, 600),
          evidenceIds(claim.evidenceRefs)
        ]);
      }
    }
  }

  const sessionRows = packet.selectedSessions.map((session) => [
    dreamHumanLabel(session, session.tasks?.[0]),
    session.sessionId,
    repoIdentity(session),
    session.agentPath ?? "root",
    session.lifecycleStatus ?? "unknown",
    session.role ?? "selected",
    session.classification ?? "unknown",
    session.startedAt,
    session.endedAt,
    session.tasks?.length ?? 0,
    metricNumber(session, "editCalls"),
    session.verificationClosure ?? "unknown"
  ]);

  const findingRows = findings.map((finding) => [
    finding.findingId,
    finding.patternKey,
    findingLabel(packet, finding),
    finding.sessionId,
    finding.taskId,
    finding.disposition,
    finding.severity,
    finding.confidence,
    compact(finding.observation, 500),
    compact(finding.interpretation, 500),
    compact(finding.alternativeExplanation, 500),
    compact(finding.recommendedAction, 500),
    finding.applyTarget,
    evidenceIds(finding.evidenceRefs)
  ]);

  const evidenceRows = allEvidenceRefs(input).map((ref) => [
    ref.id,
    ref.sessionId,
    ref.sourceFile,
    ref.lineNumber,
    ref.eventType,
    ref.eventId,
    ref.fieldPath ?? ref.metric,
    compact(ref.summary, 600)
  ]);

  const lines: string[] = [
    "# LunaObs Dream Traceability Details",
    "",
    `Packet schema: ${packet.schemaVersion}. Generated at: ${packet.generatedAt}.`,
    "",
    "This appendix contains only frozen packet evidence and derived classifications. It does not describe live repository state.",
    "",
    "## Inspected sessions",
    "",
    ...markdownTable(
      ["Human label", "Session ID", "Repository", "Agent", "Status", "Role", "Class", "Started", "Ended", "Tasks", "Edits", "Verification closure"],
      sessionRows
    ),
    "",
    "## Task windows",
    "",
    ...markdownTable(
      ["Human label", "Session ID", "Task ID", "Segmentation confidence", "Intent", "Final answer", "Evidence refs"],
      taskRows
    ),
    "",
    "## Change classifications",
    "",
    ...markdownTable(
      [
        "Human label",
        "Session ID",
        "Task ID",
        "Change ID",
        "Action index",
        "Change type",
        "Target",
        "State-changing",
        "Verification required",
        "Acceptable verification",
        "Repository tests relevant",
        "Confidence",
        "Classification evidence",
        "Evidence refs"
      ],
      changeRows
    ),
    "",
    "## Verification checks",
    "",
    ...markdownTable(
      ["Human label", "Session ID", "Task ID", "Type", "Status", "Fresh", "Action index", "Target", "Command or check", "Evidence refs"],
      verificationRows
    ),
    "",
    "## Final claims",
    "",
    ...markdownTable(["Human label", "Session ID", "Task ID", "Support", "Claim", "Evidence refs"], claimRows),
    "",
    "## Instructions",
    "",
    ...markdownTable(["Human label", "Session ID", "Status", "Instruction", "Evidence refs"], instructionRows),
    "",
    "## Atomic findings",
    "",
    ...markdownTable(
      [
        "Finding ID",
        "Pattern",
        "Human label",
        "Session ID",
        "Task ID",
        "Disposition",
        "Severity",
        "Confidence",
        "Observation",
        "Interpretation",
        "Alternative explanation",
        "Recommended action",
        "Apply target",
        "Evidence refs"
      ],
      findingRows
    ),
    "",
    "## Grouped finding patterns",
    "",
    ...markdownTable(
      ["Pattern", "Title", "Reliable", "Possible false positives", "Insufficient evidence", "Sessions", "Tasks", "Repositories", "Confidence"],
      patterns.map((pattern) => [
        pattern.patternKey,
        pattern.title,
        pattern.dispositionCounts.reliable,
        pattern.dispositionCounts.possible_false_positive,
        pattern.dispositionCounts.insufficient_evidence,
        pattern.affectedSessionIds.length,
        pattern.affectedTaskIds.length,
        pattern.affectedRepositories.length,
        pattern.confidence
      ])
    ),
    "",
    "## Scores",
    "",
    ...markdownTable(
      ["Category", "Score", "Confidence", "Rationale"],
      scores.map((score) => [score.category, score.score ?? "insufficient", score.confidence, compact(score.rationale, 600)])
    ),
    "",
    "## Ignored or weakened instructions",
    "",
    ...markdownTable(
      ["Status", "Instruction", "Evidence refs"],
      ignoredInstructions.map((instruction) => [instruction.status ?? "unknown", compact(instruction.text, 600), evidenceIds(instruction.evidenceRefs)])
    ),
    "",
    "## Unsupported claims",
    "",
    ...markdownTable(
      ["Claim", "Evidence refs"],
      unsupportedClaims.map((claim) => [compact(claim.text, 600), evidenceIds(claim.evidenceRefs)])
    ),
    "",
    "## Missing evidence",
    "",
    ...(missingEvidence.length ? missingEvidence.map((item) => `- ${item}`) : ["- None identified."]),
    "",
    "## Evidence reference catalog",
    "",
    ...markdownTable(
      ["Evidence ID", "Session ID", "Source file", "Line", "Event type", "Event ID", "Field or metric", "Summary"],
      evidenceRows
    ),
    ""
  ];

  // Keep a direct packet-level trace even when a report-wide finding has no session ID.
  if (!packet.selectedSessions.length && !findings.length) {
    lines.push("No sessions or findings were present in the packet.", "");
  }
  return lines.join("\n");
}

export function buildDreamDecisionReport(input: DreamDecisionReportInput): DreamDecisionReportResult {
  const patterns = groupDreamFindings(input.packet, input.findings);
  const overallConfidence = deriveDreamOverallConfidence(input.packet, input.findings, input.missingEvidence);
  const applyPlan = buildDreamApplyPlan(input.packet, input.findings, patterns);
  return {
    markdown: renderDreamDecisionMarkdown(input, patterns, overallConfidence, applyPlan),
    detailsMarkdown: renderDreamTraceabilityMarkdown(input, patterns),
    patterns,
    overallConfidence,
    applyPlan
  };
}
