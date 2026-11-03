/** Immutable pilot policy: changing any rule requires a new revision. */
export const RUBRIC_V1 = Object.freeze({
  revision: "workpackageEvaluation.rubric/1",
  weights: Object.freeze({ outcome: 40, compliance: 30, efficiency: 20, handoff: 10 }),
  minimumCoverage: 1,
  repeatThreshold: 3,
  observationShareDiagnostic: 0.8
} as const);
export const EVALUATOR_REVISION = "workpackageEvaluation.evaluator/2";
