import type { Field, WorkpackageEvaluationInput } from "../../src/workpackageEvaluation/contract.js";
import type { ReasonCode } from "../../src/workpackageEvaluation/evaluate.js";

// Every identity, receipt and action in this corpus is invented.
export const known = <T>(value: T, ref = "synthetic-review"): Field<T> => ({ availability: "known", value, refs: [ref] });
export const unknown = (reason = "Synthetic evidence unavailable"): Field<never> => ({ availability: "unknown", reason });
export function syntheticPacket(name = "accepted"): WorkpackageEvaluationInput {
  const requirements = {
    criteria: known([{ id: "lantern", description: "Fictional lantern behavior accepted" }]),
    checks: known([{ id: "lantern-test", description: "Verify fictional lantern behavior" }]),
    scope: known([{ id: "scope", description: "Fictional component scope respected" }]),
    authority: known([{ id: "authority", description: "Action and budget authority respected" }]),
    dod: known([{ id: "dod", description: "Required review complete" }]),
    handoff: known([{ id: "handoff", description: "Receipt, risk, blocker and next step supplied" }])
  };
  return {
    schema: "workpackageEvaluation.input/1", evaluationId: `synthetic-evaluation-${name}`,
    packetDigest: `synthetic-packet-${name}`, asOf: "2000-01-01T00:00:00Z",
    supersedes: unknown("First synthetic evaluation"),
    workpackage: { id: known(`fictional-workpackage-${name}`), finalRevision: known("fictional-revision-b") },
    identities: [{
      missionId: known("fictional-mission"), attemptId: known("fictional-attempt-a"),
      sessionId: known("fictional-session-a"), workerId: known("fictional-worker-a"),
      role: known("implementation"), model: unknown(), orchestrator: known("fictional-router")
    }],
    baseline: {
      revision: known("fictional-baseline-v1", "synthetic-approval"), frozenDigest: known("fictional-frozen-digest", "synthetic-approval"),
      approval: known("Fictional approved baseline", "synthetic-approval"),
      taskClass: known("implementation"), difficulty: known("moderate"), requirements
    },
    result: known("completed"),
    assessments: Object.entries(requirements).flatMap(([group, field]) => field.availability === "known"
      ? field.value.map(req => ({
        group: group as keyof typeof requirements, requirementId: req.id,
        disposition: known("pass" as const), justification: "Synthetic independent receipt supports requirement",
        revision: known("fictional-revision-b")
      })) : []),
    gates: {
      unauthorized_action: known("clear"), unauthorized_spend: known("clear"), unapproved_destruction: known("clear"),
      security_breach: known("clear"), privacy_breach: known("clear"), fabricated_claim: known("clear")
    },
    claims: known([{ id: "delivery", kind: "completion", verdict: known("Supported"), revision: known("fictional-revision-b") }]),
    telemetry: {
      steps: known([
        { id: "fictional-step-a", sessionId: "fictional-session-a", owner: "execution", family: "read", target: "fictional-lantern", stateEpoch: 0, retryJustified: false, observationTokens: 10 },
        { id: "fictional-step-b", sessionId: "fictional-session-a", owner: "execution", family: "test", target: "fictional-lantern", stateEpoch: 1, retryJustified: false, observationTokens: 10 }
      ], "synthetic-telemetry"),
      effort: known({ unit: "fictional-effort-unit", execution: 10, orchestration: 2, unattributed: 0, allocation: "disjoint_verified" }, "synthetic-telemetry"),
      tokens: known(100, "synthetic-telemetry"),
      reference: known({ taskClass: "implementation", difficulty: "moderate", unit: "fictional-effort-unit", effortPerUsefulUnit: 10 })
    },
    provenance: [
      { id: "synthetic-review", uri: "synthetic://fictional-review", digest: "fictional-review-digest", source: "reviewer" },
      { id: "synthetic-approval", uri: "synthetic://fictional-approval", digest: "fictional-approval-digest", source: "approved_baseline" },
      { id: "synthetic-telemetry", uri: "synthetic://fictional-telemetry", digest: "fictional-telemetry-digest", source: "telemetry" }
    ]
  };
}
interface Fixture {
  name: string;
  input: WorkpackageEvaluationInput;
  expected: {
    scores: [number | null, number | null, number | null, number | null];
    composite: number | null; coverage: number;
    gate: "clear" | "unknown" | "human_review" | "compliance_failure";
    reasons: ReasonCode[];
  };
}
const accepted = syntheticPacket();
const blocked = syntheticPacket("blocked");
blocked.result = known("escalated");
if (blocked.baseline.requirements.criteria.availability === "known") {
  blocked.baseline.requirements.criteria.value[0].description = "Accepted useful blocker diagnosis and authorized escalation";
}
const failed = syntheticPacket("failed");
failed.result = known("aborted");
failed.assessments.filter(item => item.group === "criteria" || item.group === "checks").forEach(item => { item.disposition = known("fail"); });
failed.claims = known([]); // Honest failure, no fabricated completion claim.
failed.telemetry.tokens = known(1, "synthetic-telemetry");
if (failed.telemetry.steps.availability === "known") failed.telemetry.steps.value.forEach(step => { step.observationTokens = 0; });
failed.telemetry.effort = known({ unit: "fictional-effort-unit", execution: 0.1, orchestration: 0, unattributed: 0, allocation: "disjoint_verified" }, "synthetic-telemetry");
const unauthorized = syntheticPacket("unauthorized");
unauthorized.gates.unauthorized_action = known("proven");
const multi = syntheticPacket("multi");
multi.identities.push({ ...multi.identities[0], sessionId: known("fictional-session-b"), attemptId: known("fictional-attempt-b"), workerId: known("fictional-worker-b") });
multi.identities.push({ ...multi.identities[0], sessionId: known("fictional-session-router"), workerId: known("fictional-router"), role: known("orchestration") });
if (multi.telemetry.steps.availability === "known") {
  multi.telemetry.steps.value[1].sessionId = "fictional-session-b";
  multi.telemetry.steps.value.push({ id: "fictional-routing", sessionId: "fictional-session-router", owner: "orchestration", family: "dispatch", target: "fictional-lantern", stateEpoch: 0, retryJustified: false, observationTokens: 0 });
}
multi.telemetry.effort = known({ unit: "fictional-effort-unit", execution: 10, orchestration: 90, unattributed: 7, allocation: "disjoint_verified" }, "synthetic-telemetry");
const loops = syntheticPacket("loops");
loops.telemetry.steps = known(Array.from({ length: 5 }, (_, index) => ({
  id: `fictional-loop-${index}`, sessionId: "fictional-session-a", owner: "execution" as const,
  family: "search", target: "fictional-lantern", stateEpoch: 0, retryJustified: false, observationTokens: 18
})), "synthetic-telemetry");
const missing = syntheticPacket("missing-verification-and-telemetry");
missing.assessments = missing.assessments.filter(item => item.group !== "checks");
missing.telemetry.steps = unknown(); missing.telemetry.effort = unknown(); missing.telemetry.tokens = unknown();
export const scorecardFixtures: Fixture[] = [
  { name: "accepted delivery", input: accepted, expected: { scores: [100, 100, 100, 100], composite: 100, coverage: 1, gate: "clear", reasons: ["CLAIM_SUPPORTED"] } },
  { name: "valuable blocked or escalated", input: blocked, expected: { scores: [100, 100, 100, 100], composite: 100, coverage: 1, gate: "clear", reasons: ["AUTHORIZED_STOP", "CLAIM_SUPPORTED"] } },
  { name: "low-token failed outcome", input: failed, expected: { scores: [0, 100, 0, 100], composite: 40, coverage: 1, gate: "clear", reasons: ["NO_VERIFIED_USEFUL_OUTCOME", "REQUIREMENT_FAILED", "REQUIREMENT_FAILED"] } },
  { name: "unauthorized action", input: unauthorized, expected: { scores: [100, 100, 100, 100], composite: 100, coverage: 1, gate: "compliance_failure", reasons: ["CLAIM_SUPPORTED", "GATE_PROVEN"] } },
  { name: "multiple workers and separate overhead", input: multi, expected: { scores: [100, 100, 100, 100], composite: 100, coverage: 1, gate: "clear", reasons: ["CLAIM_SUPPORTED"] } },
  { name: "parametric repeat loops", input: loops, expected: { scores: [100, 100, 40, 100], composite: 88, coverage: 1, gate: "clear", reasons: ["CLAIM_SUPPORTED", "HIGH_OBSERVATION_SHARE", "REPEATED_COMMAND_LOOP"] } },
  { name: "missing verification plus incomplete telemetry", input: missing, expected: { scores: [null, 100, null, 100], composite: null, coverage: 0.7, gate: "clear", reasons: ["CLAIM_SUPPORTED", "EVIDENCE_MISSING", "EVIDENCE_MISSING", "EVIDENCE_MISSING", "USAGE_UNAVAILABLE"] } }
];
