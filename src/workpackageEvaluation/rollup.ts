import { parseWorkpackageEvaluationInput } from "./contract.js";

/** Roll up one frozen workpackage packet, never averages of session scores.
 * Accepted outcomes have no per-worker credit allocation in this prototype.
 */
export function rollupWorkpackage(value: unknown) {
  const input = parseWorkpackageEvaluationInput(value);
  const id = input.workpackage.id, revision = input.workpackage.finalRevision;
  const criteria = input.baseline.requirements.criteria;
  const acceptedOutcomes: { workpackageId: string; revision: string; criterionId: string }[] = [];
  const frozen = [input.baseline.revision, input.baseline.frozenDigest, input.baseline.approval]
    .every(field => field.availability === "known");
  if (frozen && id.availability === "known" && revision.availability === "known" && criteria.availability === "known") {
    for (const criterion of criteria.value) {
      const assessment = input.assessments.find(item => item.group === "criteria" && item.requirementId === criterion.id);
      if (assessment?.disposition.availability === "known" && assessment.disposition.value === "pass" &&
          assessment.revision.availability === "known" && assessment.revision.value === revision.value) {
        acceptedOutcomes.push({ workpackageId: id.value, revision: revision.value, criterionId: criterion.id });
      }
    }
  }
  acceptedOutcomes.sort((a, b) => a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0);
  return {
    workpackage: input.workpackage, acceptedOutcomes,
    identities: input.identities,
    outcomeAllocation: "shared_unallocated" as const,
    // A packet contains one curated, deduplicated, disjoint accounting window.
    // Missing/ambiguous allocation remains unavailable; no worker is charged for it.
    effort: input.telemetry.effort,
    identityCoverage: input.identities.every(identity =>
      [identity.sessionId, identity.attemptId, identity.workerId, identity.missionId].every(field => field.availability === "known"))
      ? "joined" as const : "incomplete" as const
  };
}
