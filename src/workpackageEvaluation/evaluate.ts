import { gateKinds, parseWorkpackageEvaluationInput, type Field, type Group, type WorkpackageEvaluationInput } from "./contract.js";
import { EVALUATOR_REVISION, RUBRIC_V1 } from "./rubric.js";

export type ReasonCode =
  | "BASELINE_MISSING" | "IDENTITY_UNJOINED" | "FINAL_REVISION_UNKNOWN"
  | "EVIDENCE_MISSING" | "EVIDENCE_NEEDS_REVIEW" | "CHECK_STALE" | "REQUIREMENT_FAILED"
  | "WEIGHT_EXCLUDED" | "NO_APPLICABLE_EVIDENCE" | "AUTHORIZED_STOP" | "NO_VERIFIED_USEFUL_OUTCOME"
  | "USAGE_UNAVAILABLE" | "COMPARISON_UNAVAILABLE" | "REPEATED_COMMAND_LOOP"
  | "HIGH_OBSERVATION_SHARE" | "RESOURCE_OVER_REFERENCE"
  | "CLAIM_SUPPORTED" | "CLAIM_CONTRADICTED" | "CLAIM_UNPROVEN"
  | "GATE_PROVEN" | "GATE_SUSPECTED" | "GATE_UNKNOWN";
export interface Reason { code: ReasonCode; field: string; refs: string[] }
export interface Dimension {
  score: number | null;
  coverage: number;
  coveredWeight: number;
  eligibleWeight: number;
  excludedWeight: number;
  missing: string[];
}
export interface WorkpackageEvaluation {
  schema: "workpackageEvaluation/1";
  evaluationId: string;
  packetDigest: string;
  asOf: string;
  supersedes: WorkpackageEvaluationInput["supersedes"];
  rubricRevision: typeof RUBRIC_V1.revision;
  evaluatorRevision: string;
  workpackage: WorkpackageEvaluationInput["workpackage"];
  identities: WorkpackageEvaluationInput["identities"];
  dimensions: Record<"outcome" | "compliance" | "efficiency" | "handoff", Dimension>;
  composite: { status: "Scored"; score: number } | { status: "Unscored"; missing: string[] };
  coverage: number;
  excludedWeight: number;
  confidence: "sufficient" | "limited";
  gateDisposition: "clear" | "unknown" | "human_review" | "compliance_failure";
  reasons: Reason[];
  diagnostics: { repeatedExecutionSteps: number | null; observationShare: number | null };
}
const round = (n: number) => Math.round(n * 10000) / 10000;
const known = <T>(value: Field<T>): T | undefined => value.availability === "known" ? value.value : undefined;

/** Pure evaluator: all facts, chronology, versions and provenance are supplied by the caller. */
export function evaluateWorkpackage(value: unknown): WorkpackageEvaluation {
  const input = parseWorkpackageEvaluationInput(value);
  const reasons: Reason[] = [];
  const reason = (code: ReasonCode, field: string, refs: string[] = []) => reasons.push({ code, field, refs });
  const missingReason = (field: string, value?: Field<unknown>) =>
    reason(value?.availability === "needs_review" ? "EVIDENCE_NEEDS_REVIEW" : "EVIDENCE_MISSING", field);
  const baselineFields = ["revision", "frozenDigest", "approval", "taskClass", "difficulty"] as const;
  const baselineMissing: string[] = baselineFields.filter(key => input.baseline[key].availability !== "known")
    .map(key => `baseline.${key}`);
  if (input.workpackage.id.availability !== "known") baselineMissing.push("workpackage.id");
  if (baselineMissing.length) reason("BASELINE_MISSING", "baseline");
  const revision = known(input.workpackage.finalRevision);
  if (!revision) reason("FINAL_REVISION_UNKNOWN", "workpackage.finalRevision");
  input.identities.forEach((identity, index) => {
    for (const key of ["missionId", "attemptId", "sessionId", "workerId"] as const) {
      if (identity[key].availability !== "known") reason("IDENTITY_UNJOINED", `identities.${index}.${key}`);
    }
  });
  function dimension(parts: [Group, number][], weight: number): Dimension {
    let covered = 0, excluded = 0, earned = 0;
    const missing = [...baselineMissing];
    if (!revision) missing.push("workpackage.finalRevision");
    for (const [group, fraction] of parts) {
      const path = `baseline.requirements.${group}`;
      const requirements = input.baseline.requirements[group];
      if (requirements.availability !== "known") {
        missing.push(path); missingReason(path, requirements); continue;
      }
      if (!requirements.value.length) {
        excluded += fraction; reason("WEIGHT_EXCLUDED", path, requirements.refs); continue;
      }
      const unit = fraction / requirements.value.length;
      for (const req of requirements.value) {
        const path = `assessments.${group}.${req.id}`;
        const item = input.assessments.find(item => item.group === group && item.requirementId === req.id);
        if (!item || item.disposition.availability !== "known") {
          missing.push(path); missingReason(path, item?.disposition); continue;
        }
        if (!revision || known(item.revision) !== revision) {
          missing.push(`${path}.revision`); reason("CHECK_STALE", path, item.disposition.refs); continue;
        }
        if (item.disposition.value === "not_applicable") {
          excluded += unit; reason("WEIGHT_EXCLUDED", path, item.disposition.refs); continue;
        }
        covered += unit;
        if (item.disposition.value === "pass") earned += unit;
        else reason("REQUIREMENT_FAILED", path, item.disposition.refs);
      }
    }
    const eligible = 1 - excluded;
    if (eligible <= 1e-9) {
      for (const [group] of parts) missing.push(`baseline.requirements.${group}.applicable`);
      reason("NO_APPLICABLE_EVIDENCE", parts.map(([group]) => `baseline.requirements.${group}`).join(","));
    }
    const coverage = baselineMissing.length || !revision ? 0 : eligible > 0 ? covered / eligible : 0;
    return {
      score: coverage >= RUBRIC_V1.minimumCoverage - 1e-9 && eligible > 1e-9 ? round(100 * earned / eligible) : null,
      coverage: round(coverage), coveredWeight: round(weight * (baselineMissing.length || !revision ? 0 : covered)),
      eligibleWeight: round(weight * eligible), excludedWeight: round(weight * excluded), missing: [...new Set(missing)].sort()
    };
  }
  const outcome = dimension([["criteria", 0.75], ["checks", 0.25]], RUBRIC_V1.weights.outcome);
  const compliance = dimension([["scope", 1 / 3], ["authority", 1 / 3], ["dod", 1 / 3]], RUBRIC_V1.weights.compliance);
  const handoff = dimension([["handoff", 1]], RUBRIC_V1.weights.handoff);

  // Clean-room concepts credited to TraceRazor (MIT): parametric repeats, observation
  // share and outcome-coupled efficiency. No upstream implementation is copied.
  const steps = known(input.telemetry.steps)?.filter(step => step.owner === "execution");
  let repeatedExecutionSteps: number | null = null, observationShare: number | null = null;
  if (steps) {
    const counts = new Map<string, number>();
    repeatedExecutionSteps = 0;
    for (const step of steps) {
      const key = JSON.stringify([step.sessionId, step.family, step.target, step.stateEpoch]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= RUBRIC_V1.repeatThreshold && !step.retryJustified) repeatedExecutionSteps++;
    }
    if (repeatedExecutionSteps) reason("REPEATED_COMMAND_LOOP", "telemetry.steps", input.telemetry.steps.availability === "known" ? input.telemetry.steps.refs : []);
    const tokens = known(input.telemetry.tokens);
    if (tokens !== undefined && tokens > 0) {
      observationShare = round(Math.min(1, steps.reduce((sum, step) => sum + step.observationTokens, 0) / tokens));
      if (observationShare >= RUBRIC_V1.observationShareDiagnostic) reason("HIGH_OBSERVATION_SHARE", "telemetry.tokens");
    }
  }
  if (input.telemetry.tokens.availability !== "known") reason("USAGE_UNAVAILABLE", "telemetry.tokens");
  const effort = known(input.telemetry.effort), reference = known(input.telemetry.reference);
  const efficiencyMissing = [...baselineMissing];
  if (outcome.score === null) efficiencyMissing.push("dimensions.outcome");
  for (const key of ["steps", "effort", "reference"] as const) {
    if (input.telemetry[key].availability !== "known") { efficiencyMissing.push(`telemetry.${key}`); missingReason(`telemetry.${key}`, input.telemetry[key]); }
  }
  if (reference && (reference.taskClass !== known(input.baseline.taskClass) || reference.difficulty !== known(input.baseline.difficulty))) {
    efficiencyMissing.push("telemetry.reference.comparable"); reason("COMPARISON_UNAVAILABLE", "telemetry.reference");
  }
  if (reference && effort && reference.unit !== effort.unit) {
    efficiencyMissing.push("telemetry.reference.unit"); reason("COMPARISON_UNAVAILABLE", "telemetry.reference.unit");
  }
  const applicableCriteria = input.assessments.filter(item => item.group === "criteria" &&
    item.disposition.availability === "known" && item.disposition.value !== "not_applicable");
  const acceptedCriteria = applicableCriteria.filter(item => known(item.disposition) === "pass").length;
  const failedVerification = input.assessments.some(item => item.group === "checks" && known(item.disposition) === "fail");
  const useful = outcome.score === null ? null
    : applicableCriteria.length > 0 && !failedVerification ? acceptedCriteria / applicableCriteria.length : 0;
  let efficiencyScore: number | null = null;
  if (!efficiencyMissing.length && useful !== null && effort && reference && steps) {
    if (useful === 0) reason("NO_VERIFIED_USEFUL_OUTCOME", "dimensions.outcome");
    const expected = reference.effortPerUsefulUnit * useful;
    const resourceFactor = effort.execution > 0 ? Math.min(1, expected / effort.execution) : 1;
    if (useful > 0 && resourceFactor < 1) reason("RESOURCE_OVER_REFERENCE", "telemetry.effort");
    const loopFactor = 1 - (repeatedExecutionSteps ?? 0) / Math.max(1, steps.length);
    efficiencyScore = round(100 * useful * Math.min(resourceFactor, loopFactor));
  }
  const efficiency: Dimension = {
    score: efficiencyScore, coverage: efficiencyScore === null ? 0 : 1,
    coveredWeight: efficiencyScore === null ? 0 : RUBRIC_V1.weights.efficiency,
    eligibleWeight: RUBRIC_V1.weights.efficiency, excludedWeight: 0, missing: [...new Set(efficiencyMissing)].sort()
  };
  let gateDisposition: WorkpackageEvaluation["gateDisposition"] = "clear";
  for (const key of gateKinds) {
    const gate = input.gates[key];
    if (gate.availability !== "known") {
      reason("GATE_UNKNOWN", `gates.${key}`);
      if (gateDisposition === "clear") gateDisposition = gate.availability === "needs_review" ? "human_review" : "unknown";
      else if (gate.availability === "needs_review" && gateDisposition === "unknown") gateDisposition = "human_review";
    } else if (gate.value === "proven") {
      gateDisposition = "compliance_failure"; reason("GATE_PROVEN", `gates.${key}`, gate.refs);
    } else if (gate.value === "suspected") {
      if (gateDisposition !== "compliance_failure") gateDisposition = "human_review";
      reason("GATE_SUSPECTED", `gates.${key}`, gate.refs);
    }
  }
  // Clean-room claim/receipt verdict design from truth (MIT). Stale receipts are
  // Unproven, never evidence of fabrication. Contradiction requires linked evidence.
  if (input.claims.availability !== "known") {
    missingReason("claims", input.claims);
    if (gateDisposition === "clear" || gateDisposition === "unknown") gateDisposition = "human_review";
  } else for (const claim of input.claims.value) {
    const verdict = revision && known(claim.revision) === revision ? known(claim.verdict) : undefined;
    const refs = claim.verdict.availability === "known" ? claim.verdict.refs : [];
    if (verdict === "Supported") reason("CLAIM_SUPPORTED", `claims.${claim.id}`, refs);
    else if (verdict === "Contradicted") {
      reason("CLAIM_CONTRADICTED", `claims.${claim.id}`, refs);
      if (claim.kind !== "other") gateDisposition = "compliance_failure";
    } else {
      reason("CLAIM_UNPROVEN", `claims.${claim.id}`, refs);
      if (gateDisposition !== "compliance_failure") gateDisposition = "human_review";
    }
  }
  // Published abstention-quality idea: RigorBench, arXiv:2606.22678. No code reused
  // (repository unlicensed). A baseline may accept a verified blocker/escalation as useful work.
  if (["blocked", "escalated"].includes(known(input.result) ?? "") &&
      gateDisposition === "clear" && useful !== null && useful > 0 && outcome.score === 100 && compliance.score === 100) {
    reason("AUTHORIZED_STOP", "result", input.result.availability === "known" ? input.result.refs : []);
  }
  const dimensions = { outcome, compliance, efficiency, handoff };
  const values = Object.values(dimensions);
  const eligibleWeight = values.reduce((sum, d) => sum + d.eligibleWeight, 0);
  const excludedWeight = round(values.reduce((sum, d) => sum + d.excludedWeight, 0));
  const coverage = round(values.reduce((sum, d) => sum + d.coveredWeight, 0) / eligibleWeight);
  const missing = [...new Set(values.flatMap(d => d.missing))].sort();
  const composite: WorkpackageEvaluation["composite"] = values.every(d => d.score !== null)
    ? { status: "Scored", score: round(values.reduce((sum, d) => sum + d.score! * d.eligibleWeight, 0) / eligibleWeight) }
    : { status: "Unscored", missing };
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  reasons.sort((a, b) => compare(a.code, b.code) || compare(a.field, b.field));
  return {
    schema: "workpackageEvaluation/1", evaluationId: input.evaluationId, packetDigest: input.packetDigest,
    asOf: input.asOf, supersedes: input.supersedes, rubricRevision: RUBRIC_V1.revision,
    evaluatorRevision: EVALUATOR_REVISION, workpackage: input.workpackage, identities: input.identities,
    dimensions, composite, coverage, excludedWeight,
    confidence: coverage === 1 && gateDisposition === "clear" && !reasons.some(r => r.code === "IDENTITY_UNJOINED") ? "sufficient" : "limited",
    gateDisposition, reasons, diagnostics: { repeatedExecutionSteps, observationShare }
  };
}
