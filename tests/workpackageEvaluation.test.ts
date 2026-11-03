import { describe, expect, it } from "vitest";
import { evaluateWorkpackage, parseWorkpackageEvaluationInput, rollupWorkpackage, RUBRIC_V1 } from "../src/workpackageEvaluation/index.js";
import { gateKinds } from "../src/workpackageEvaluation/contract.js";
import { known, scorecardFixtures, syntheticPacket, unknown } from "./fixtures/workpackageEvaluation.js";

describe("synthetic workpackage evidence scorecards", () => {
  for (const fixture of scorecardFixtures) {
    it(`scores ${fixture.name} against its expected result`, () => {
      const result = evaluateWorkpackage(fixture.input);
      expect(Object.values(result.dimensions).map(d => d.score)).toEqual(fixture.expected.scores);
      expect(result.composite.status === "Scored" ? result.composite.score : null).toBe(fixture.expected.composite);
      expect(result.coverage).toBe(fixture.expected.coverage);
      expect(result.gateDisposition).toBe(fixture.expected.gate);
      expect(result.reasons.map(r => r.code)).toEqual(fixture.expected.reasons);
      expect(result.rubricRevision).toBe(RUBRIC_V1.revision);
    });
    it(`repeats ${fixture.name} deterministically without mutating the packet`, () => {
      const original = structuredClone(fixture.input);
      const once = evaluateWorkpackage(fixture.input);
      const twice = evaluateWorkpackage(structuredClone(fixture.input));
      expect(twice).toEqual(once); // Includes reasons, coverage, scores and gate disposition.
      expect(fixture.input).toEqual(original);
    });
  }

  it.each([
    ["wrong schema", (p: any) => { p.schema = "workpackageEvaluation.input/99"; }],
    ["invalid timestamp", (p: any) => { p.asOf = "not-an-instant"; }],
    ["absent field availability", (p: any) => { p.baseline.difficulty = "moderate"; }],
    ["extra field", (p: any) => { p.secret = "fictional"; }],
    ["missing gate", (p: any) => { delete p.gates.privacy_breach; }],
    ["unresolved receipt", (p: any) => { p.assessments[0].disposition.refs = ["absent"]; }],
    ["worker-only acceptance", (p: any) => { p.provenance[0].source = "worker"; }],
    ["duplicate assessment", (p: any) => { p.assessments.push(p.assessments[0]); }],
    ["outside frozen criteria", (p: any) => { p.assessments[0].requirementId = "extra"; }],
    ["invalid numeric telemetry", (p: any) => { p.telemetry.tokens.value = Number.NaN; }],
    ["negative effort", (p: any) => { p.telemetry.effort.value.execution = -1; }],
    ["duplicate source event", (p: any) => { p.telemetry.steps.value.push(p.telemetry.steps.value[0]); }],
    ["unjoined step", (p: any) => { p.telemetry.steps.value[0].sessionId = "unjoined"; }],
    ["impossible token share", (p: any) => { p.telemetry.tokens.value = 1; }]
  ])("rejects %s", (_name, mutate) => {
    const input = syntheticPacket(); mutate(input);
    expect(() => parseWorkpackageEvaluationInput(input)).toThrow();
  });

  const evidenceStates = ["pass", "fail", "not_applicable", "absent", "unknown", "needs_review", "stale"] as const;
  const evidenceCases = evidenceStates.flatMap(criteria =>
    [...evidenceStates, "empty" as const].map(checks => ({ criteria, checks })));
  it.each(evidenceCases)("derives useful credit with criteria=$criteria and checks=$checks", ({ criteria, checks }) => {
    const input = syntheticPacket();
    input.claims = known([]);
    input.telemetry.effort = known({ unit: "fictional-effort-unit", execution: 0.1, orchestration: 0, unattributed: 0, allocation: "disjoint_verified" });
    for (const [group, state] of [["criteria", criteria], ["checks", checks]] as const) {
      const assessment = input.assessments.find(item => item.group === group)!;
      if (state === "empty" || state === "absent") {
        input.assessments = input.assessments.filter(item => item.group !== group);
        if (state === "empty") input.baseline.requirements.checks = known([]);
      } else if (state === "stale") assessment.revision = known("fictional-revision-a");
      else if (state === "unknown" || state === "needs_review") {
        assessment.disposition = { availability: state, reason: "Synthetic unavailable assessment" };
      } else assessment.disposition = known(state);
    }
    const result = evaluateWorkpackage(input);
    const complete = ["pass", "fail", "not_applicable", "empty"];
    const excludedCriteria = criteria === "not_applicable";
    const excludedChecks = checks === "not_applicable" || checks === "empty";
    const scorable = complete.includes(criteria) && complete.includes(checks) && !(excludedCriteria && excludedChecks);
    const expected = scorable ? criteria === "pass" && checks !== "fail" ? 100 : 0 : null;
    expect(result.dimensions.efficiency.score).toBe(expected);
    expect(result.reasons.some(reason => reason.code === "NO_VERIFIED_USEFUL_OUTCOME")).toBe(expected === 0);
    if (scorable) {
      const eligible = (excludedCriteria ? 0 : 75) + (excludedChecks ? 0 : 25);
      const earned = (criteria === "pass" ? 75 : 0) + (checks === "pass" ? 25 : 0);
      expect(result.dimensions.outcome.score).toBe(Math.round(100 * earned / eligible * 10000) / 10000);
    } else {
      expect(result.dimensions.outcome.score).toBeNull();
      expect(result.composite.status).toBe("Unscored");
    }
  });
  it("counts accepted applicable criteria without awarding check-only credit", () => {
    const input = syntheticPacket();
    if (input.baseline.requirements.criteria.availability !== "known") throw new Error("Synthetic fixture error");
    for (const [id, disposition] of [["failed", "fail"], ["excluded", "not_applicable"]] as const) {
      input.baseline.requirements.criteria.value.push({ id, description: `Synthetic ${id} criterion` });
      input.assessments.push({ ...input.assessments[0], requirementId: id, disposition: known(disposition) });
    }
    input.telemetry.effort = known({ unit: "fictional-effort-unit", execution: 0.1, orchestration: 0, unattributed: 0, allocation: "disjoint_verified" });
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.outcome.score).toBeCloseTo(66.6667, 4);
    expect(result.dimensions.efficiency.score).toBe(50);
  });
  it("requires every applicable check to pass", () => {
    const input = syntheticPacket();
    if (input.baseline.requirements.checks.availability !== "known") throw new Error("Synthetic fixture error");
    for (const [id, disposition] of [["failed-check", "fail"], ["excluded-check", "not_applicable"]] as const) {
      input.baseline.requirements.checks.value.push({ id, description: `Synthetic ${id}` });
      input.assessments.push({ ...input.assessments[1], requirementId: id, disposition: known(disposition) });
    }
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(0);
    input.assessments.find(item => item.requirementId === "failed-check")!.disposition = known("pass");
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(100);
  });
  for (const stop of ["blocked", "escalated"] as const) {
    it(`recognizes a clear accepted ${stop} result`, () => {
      const input = syntheticPacket(); input.result = known(stop);
      expect(evaluateWorkpackage(input).reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(true);
    });
    it(`withholds ${stop} authorization without applicable useful criteria`, () => {
      const input = syntheticPacket(); input.result = known(stop);
      input.assessments[0].disposition = known("not_applicable");
      const result = evaluateWorkpackage(input);
      expect(result.dimensions.outcome.score).toBe(100);
      expect(result.dimensions.efficiency.score).toBe(0);
      expect(result.reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(false);
    });
    for (const gate of gateKinds) {
      it.each(["proven", "suspected", "unknown", "needs_review"] as const)(`withholds ${stop} authorization for ${gate}=%s`, state => {
        const input = syntheticPacket(); input.result = known(stop);
        input.gates[gate] = state === "unknown" || state === "needs_review"
          ? { availability: state, reason: "Synthetic unresolved gate" } : known(state);
        const result = evaluateWorkpackage(input);
        expect(result.gateDisposition).toBe(state === "proven" ? "compliance_failure" : state === "unknown" ? "unknown" : "human_review");
        expect(result.reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(false);
        expect(result.reasons.some(reason => reason.code === "STOP_AUTHORIZATION_WITHHELD")).toBe(true);
        expect(Object.values(result.dimensions).map(dimension => dimension.score)).toEqual([100, 100, 100, 100]);
        expect(result.composite).toEqual({ status: "Scored", score: 100 });
      });
    }
    it.each(["unknown", "needs_review"] as const)(`withholds ${stop} authorization for %s claims`, availability => {
      const input = syntheticPacket(); input.result = known(stop);
      input.claims = { availability, reason: "Synthetic unresolved claims" };
      const result = evaluateWorkpackage(input);
      expect(result.gateDisposition).toBe("human_review");
      expect(result.reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(false);
      expect(result.reasons.some(reason => reason.code === "STOP_AUTHORIZATION_WITHHELD")).toBe(true);
      expect(result.composite).toEqual({ status: "Scored", score: 100 });
    });
    it.each([true, false])(`withholds ${stop} authorization regardless of contradicted claim ordering (%s)`, reverse => {
      const input = syntheticPacket(); input.result = known(stop);
      if (input.claims.availability !== "known") throw new Error("Synthetic fixture error");
      input.claims.value.push({ id: "other-claim", kind: "other", verdict: known("Contradicted"), revision: known("fictional-revision-b") });
      if (reverse) input.claims.value.reverse();
      const result = evaluateWorkpackage(input);
      expect(result.gateDisposition).toBe("clear");
      expect(result.confidence).toBe("limited");
      expect(result.reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(false);
      expect(result.reasons.some(reason => reason.code === "STOP_AUTHORIZATION_WITHHELD")).toBe(true);
      expect(result.reasons.some(reason => reason.code === "CLAIM_CONTRADICTED")).toBe(true);
      expect(result.composite).toEqual({ status: "Scored", score: 100 });
    });
    for (const kind of ["completion", "verification", "other"] as const) {
      it.each(["Supported", "Contradicted", "Unproven", "unknown", "needs_review", "stale", "revision_unknown", "revision_needs_review"] as const)(`resolves ${stop} authorization after ${kind} claim %s`, state => {
        const input = syntheticPacket(); input.result = known(stop);
        if (input.claims.availability !== "known") throw new Error("Synthetic fixture error");
        const claim = input.claims.value[0]; claim.kind = kind;
        if (state === "stale") claim.revision = known("fictional-revision-a");
        else if (state === "revision_unknown" || state === "revision_needs_review") {
          claim.revision = { availability: state === "revision_unknown" ? "unknown" : "needs_review", reason: "Synthetic unresolved revision" };
        } else claim.verdict = state === "unknown" || state === "needs_review"
          ? { availability: state, reason: "Synthetic unresolved verdict" } : known(state);
        const result = evaluateWorkpackage(input);
        const expectedGate = state === "Supported" ? "clear"
          : state === "Contradicted" ? kind === "other" ? "clear" : "compliance_failure" : "human_review";
        expect(result.gateDisposition).toBe(expectedGate);
        expect(result.reasons.some(reason => reason.code === "AUTHORIZED_STOP")).toBe(state === "Supported");
        expect(result.reasons.some(reason => reason.code === "STOP_AUTHORIZATION_WITHHELD")).toBe(state !== "Supported");
        expect(result.confidence).toBe(state === "Supported" ? "sufficient" : "limited");
        expect(Object.values(result.dimensions).map(dimension => dimension.score)).toEqual([100, 100, 100, 100]);
        expect(result.composite).toEqual({ status: "Scored", score: 100 });
      });
    }
  }

  it("retains raw scores for every proven hard gate", () => {
    for (const gate of gateKinds) {
      const input = syntheticPacket(); input.gates[gate] = known("proven");
      const result = evaluateWorkpackage(input);
      expect(result.gateDisposition).toBe("compliance_failure");
      expect(result.dimensions.outcome.score).toBe(100);
      expect(result.composite).toEqual({ status: "Scored", score: 100 });
      expect(result.confidence).toBe("limited");
    }
  });
  it("escalates suspected gates and preserves proven failure precedence", () => {
    const input = syntheticPacket(); input.gates.unauthorized_action = known("suspected");
    expect(evaluateWorkpackage(input).gateDisposition).toBe("human_review");
    input.gates.unauthorized_action = known("proven"); input.gates.privacy_breach = known("suspected");
    expect(evaluateWorkpackage(input).gateDisposition).toBe("compliance_failure");
  });
  it("shows unknown and needs_review gate dispositions explicitly", () => {
    const input = syntheticPacket(); input.gates.security_breach = unknown();
    expect(evaluateWorkpackage(input).gateDisposition).toBe("unknown");
    input.gates.privacy_breach = { availability: "needs_review", reason: "Synthetic dispute" };
    expect(evaluateWorkpackage(input).gateDisposition).toBe("human_review");
  });
  it("treats stale checks as missing evidence, without accusing fabrication", () => {
    const input = syntheticPacket(); input.assessments[1].revision = known("fictional-revision-a");
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.outcome.score).toBeNull();
    expect(result.composite.status).toBe("Unscored");
    expect(result.reasons.some(r => r.code === "CHECK_STALE")).toBe(true);
    expect(result.gateDisposition).toBe("clear");
  });
  it("separates contradicted and unproven claims from stale receipts", () => {
    const input = syntheticPacket();
    if (input.claims.availability !== "known") throw new Error("Synthetic fixture error");
    input.claims.value[0].verdict = known("Contradicted");
    expect(evaluateWorkpackage(input).gateDisposition).toBe("compliance_failure");
    input.claims.value[0].verdict = known("Unproven");
    expect(evaluateWorkpackage(input).gateDisposition).toBe("human_review");
    input.claims.value[0].verdict = known("Supported");
    input.claims.value[0].revision = known("fictional-revision-a");
    const stale = evaluateWorkpackage(input);
    expect(stale.gateDisposition).toBe("human_review");
    expect(stale.reasons.some(r => r.code === "CLAIM_CONTRADICTED")).toBe(false);
  });
  it("excludes explicitly inapplicable weight and reports the denominator", () => {
    const input = syntheticPacket(); input.assessments[1].disposition = known("not_applicable");
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.outcome).toMatchObject({ score: 100, eligibleWeight: 30, excludedWeight: 10, coverage: 1 });
    expect(result.excludedWeight).toBe(10);
    expect(result.composite).toEqual({ status: "Scored", score: 100 });
  });
  it("keeps needs_review acceptance unscored and lists its field", () => {
    const input = syntheticPacket(); input.assessments[0].disposition = { availability: "needs_review", reason: "Synthetic reviewer disagreement" };
    const result = evaluateWorkpackage(input);
    expect(result.composite.status).toBe("Unscored");
    expect(result.dimensions.outcome.missing).toContain("assessments.criteria.lantern");
    expect(result.reasons.some(r => r.code === "EVIDENCE_NEEDS_REVIEW")).toBe(true);
  });
  it("does not reward token minimization or an easier comparison cohort", () => {
    const input = syntheticPacket(); const original = evaluateWorkpackage(input);
    input.telemetry.tokens = known(1000000);
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(original.dimensions.efficiency.score);
    input.telemetry.reference = known({ taskClass: "implementation", difficulty: "easy", unit: "fictional-effort-unit", effortPerUsefulUnit: 100 });
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBeNull();
  });
  it("does not require unavailable token telemetry when other efficiency evidence is sufficient", () => {
    const input = syntheticPacket(); input.telemetry.tokens = unknown();
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.efficiency.score).toBe(100);
    expect(result.reasons.some(r => r.code === "USAGE_UNAVAILABLE")).toBe(true);
  });
  it("charges effort per useful outcome without double counting repeat penalties", () => {
    const input = structuredClone(scorecardFixtures[5].input);
    input.telemetry.effort = known({ unit: "fictional-effort-unit", execution: 20, orchestration: 0, unattributed: 0, allocation: "disjoint_verified" });
    const result = evaluateWorkpackage(input);
    // Resource factor .5, loop factor .4: use .4, not their product .2.
    expect(result.dimensions.efficiency.score).toBe(40);
    const accepted = syntheticPacket();
    accepted.telemetry.effort = input.telemetry.effort;
    expect(evaluateWorkpackage(accepted).dimensions.efficiency.score).toBe(50);
  });
  it("refuses to compare incompatible effort units", () => {
    const input = syntheticPacket();
    if (input.telemetry.reference.availability !== "known") throw new Error("Synthetic fixture error");
    input.telemetry.reference.value.unit = "different-fictional-unit";
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.efficiency.score).toBeNull();
    expect(result.dimensions.efficiency.missing).toContain("telemetry.reference.unit");
  });
  it("leaves entirely inapplicable dimensions unscored with explicit gaps", () => {
    const input = syntheticPacket();
    input.assessments.filter(a => a.group === "criteria" || a.group === "checks").forEach(a => { a.disposition = known("not_applicable"); });
    const result = evaluateWorkpackage(input);
    expect(result.dimensions.outcome).toMatchObject({ score: null, excludedWeight: 40, eligibleWeight: 0 });
    expect(result.dimensions.outcome.missing).toContain("baseline.requirements.criteria.applicable");
    expect(result.composite.status).toBe("Unscored");
  });
  it("does not penalize justified retries or repeats after state changes", () => {
    const input = structuredClone(scorecardFixtures[5].input);
    if (input.telemetry.steps.availability !== "known") throw new Error("Synthetic fixture error");
    input.telemetry.steps.value.forEach((step, i) => { step.stateEpoch = i; });
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(100);
    input.telemetry.steps.value.forEach(step => { step.stateEpoch = 0; step.retryJustified = true; });
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(100);
  });
  it("preserves distinct identities, counts shared acceptance once and separates overhead", () => {
    const input = structuredClone(scorecardFixtures[4].input);
    const rollup = rollupWorkpackage(input);
    expect(rollup.acceptedOutcomes).toHaveLength(1);
    expect(rollup.identities).toHaveLength(3);
    expect(rollup.outcomeAllocation).toBe("shared_unallocated");
    expect(rollup.effort).toMatchObject({ value: { execution: 10, orchestration: 90, unattributed: 7 } });
    expect(evaluateWorkpackage(input).dimensions.efficiency.score).toBe(100);
    input.identities.push({ ...input.identities[0], sessionId: known("fictional-second-session-same-attempt") });
    expect(rollupWorkpackage(input).acceptedOutcomes).toHaveLength(1);
    expect(rollupWorkpackage(input).identities).toHaveLength(4);
  });
  it("does not infer missing historical identities", () => {
    const input = syntheticPacket(); input.identities[0].attemptId = unknown();
    const result = evaluateWorkpackage(input);
    expect(result.identities[0].attemptId.availability).toBe("unknown");
    expect(result.confidence).toBe("limited");
    expect(rollupWorkpackage(input).identityCoverage).toBe("incomplete");
  });
  it("abstains without a frozen baseline or final revision", () => {
    const input = syntheticPacket(); input.baseline.approval = unknown();
    expect(evaluateWorkpackage(input).composite.status).toBe("Unscored");
    expect(rollupWorkpackage(input).acceptedOutcomes).toEqual([]);
    input.workpackage.finalRevision = unknown();
    expect(evaluateWorkpackage(input).coverage).toBe(0);
  });
  it("is independent of assessment and provenance order", () => {
    const input = syntheticPacket(); const original = evaluateWorkpackage(input);
    input.assessments.reverse(); input.provenance.reverse();
    expect(evaluateWorkpackage(input)).toEqual(original);
  });
});
