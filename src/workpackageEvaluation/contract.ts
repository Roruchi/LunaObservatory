import { z } from "zod";

const text = z.string().min(1);
const refs = z.array(text).min(1);
/** Availability belongs to each field, rather than being inferred from null/absence. */
export function field<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("availability", [
    z.object({ availability: z.literal("known"), value, refs }).strict(),
    z.object({ availability: z.enum(["unknown", "needs_review"]), reason: text }).strict()
  ]);
}
const refSchema = z.object({
  id: text, uri: text, digest: text,
  source: z.enum(["reviewer", "receipt", "approved_baseline", "telemetry", "worker"])
}).strict();
const requirement = z.object({ id: text, description: text }).strict();
export const groups = ["criteria", "checks", "scope", "authority", "dod", "handoff"] as const;
export const gateKinds = [
  "unauthorized_action", "unauthorized_spend", "unapproved_destruction",
  "security_breach", "privacy_breach", "fabricated_claim"
] as const;
const requirements = z.object({
  criteria: field(z.array(requirement).min(1)), checks: field(z.array(requirement)),
  scope: field(z.array(requirement).min(1)), authority: field(z.array(requirement).min(1)),
  dod: field(z.array(requirement).min(1)), handoff: field(z.array(requirement).min(1))
}).strict();
const assessment = z.object({
  group: z.enum(groups), requirementId: text,
  disposition: field(z.enum(["pass", "fail", "not_applicable"])),
  justification: text, revision: field(text)
}).strict();
const identity = z.object({
  missionId: field(text), attemptId: field(text), sessionId: field(text), workerId: field(text),
  role: field(text), model: field(text), orchestrator: field(text)
}).strict();
const step = z.object({
  id: text, sessionId: text,
  owner: z.enum(["execution", "orchestration"]),
  // Parametric keys are curated evidence, not shell parsing or a trace adapter.
  family: text, target: text, stateEpoch: z.number().int().nonnegative(),
  retryJustified: z.boolean(), observationTokens: z.number().int().nonnegative()
}).strict();
const telemetry = z.object({
  steps: field(z.array(step)),
  effort: field(z.object({
    unit: text,
    execution: z.number().finite().nonnegative(), orchestration: z.number().finite().nonnegative(),
    unattributed: z.number().finite().nonnegative(), allocation: z.literal("disjoint_verified")
  }).strict()),
  tokens: field(z.number().int().nonnegative()),
  reference: field(z.object({
    taskClass: text, difficulty: text, unit: text, effortPerUsefulUnit: z.number().finite().positive()
  }).strict())
}).strict();
export const inputSchema = z.object({
  schema: z.literal("workpackageEvaluation.input/1"),
  evaluationId: text, packetDigest: text, asOf: z.string().datetime({ offset: true }), supersedes: field(text),
  workpackage: z.object({ id: field(text), finalRevision: field(text) }).strict(),
  identities: z.array(identity).min(1),
  baseline: z.object({
    revision: field(text), frozenDigest: field(text), approval: field(text),
    taskClass: field(text), difficulty: field(text), requirements
  }).strict(),
  result: field(z.enum(["completed", "partial", "blocked", "escalated", "aborted"])),
  assessments: z.array(assessment),
  gates: z.object({
    unauthorized_action: field(z.enum(["clear", "proven", "suspected"])),
    unauthorized_spend: field(z.enum(["clear", "proven", "suspected"])),
    unapproved_destruction: field(z.enum(["clear", "proven", "suspected"])),
    security_breach: field(z.enum(["clear", "proven", "suspected"])),
    privacy_breach: field(z.enum(["clear", "proven", "suspected"])),
    fabricated_claim: field(z.enum(["clear", "proven", "suspected"]))
  }).strict(),
  claims: field(z.array(z.object({
    id: text, kind: z.enum(["completion", "verification", "other"]),
    verdict: field(z.enum(["Supported", "Contradicted", "Unproven"])), revision: field(text)
  }).strict())),
  telemetry,
  provenance: z.array(refSchema).min(1)
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (values: string[], name: string) => {
    if (new Set(values).size !== values.length) issue(`Duplicate ${name}`);
  };
  unique(input.provenance.map(ref => ref.id), "provenance id");
  const knownRefs = new Map(input.provenance.map(ref => [ref.id, ref]));
  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.availability === "known") {
      for (const ref of obj.refs as string[]) if (!knownRefs.has(ref)) issue(`Unresolved ref: ${ref}`);
    }
    Object.values(obj).forEach(child => { if (Array.isArray(child)) child.forEach(walk); else walk(child); });
  }
  walk(input);
  for (const group of groups) {
    const list = input.baseline.requirements[group];
    if (list.availability === "known") unique(list.value.map(item => item.id), `${group} requirement`);
  }
  unique(input.assessments.map(item => `${item.group}:${item.requirementId}`), "assessment");
  for (const item of input.assessments) {
    const list = input.baseline.requirements[item.group];
    if (list.availability !== "known" || !list.value.some(req => req.id === item.requirementId)) {
      issue(`Assessment outside frozen baseline: ${item.requirementId}`);
    }
    if (item.disposition.availability === "known" &&
        !item.disposition.refs.some(ref => ["reviewer", "receipt"].includes(knownRefs.get(ref)?.source ?? ""))) {
      issue(`Assessment needs independent evidence: ${item.requirementId}`);
    }
  }
  if (input.baseline.approval.availability === "known" &&
      !input.baseline.approval.refs.some(ref => knownRefs.get(ref)?.source === "approved_baseline")) {
    issue("Baseline approval needs approved_baseline provenance");
  }
  const independent = (value: { availability: string; refs?: string[] }, label: string) => {
    if (value.availability === "known" && !value.refs?.some(ref =>
      ["reviewer", "receipt"].includes(knownRefs.get(ref)?.source ?? ""))) issue(`${label} needs independent evidence`);
  };
  for (const key of gateKinds) independent(input.gates[key], `Gate ${key}`);
  if (input.claims.availability === "known") {
    unique(input.claims.value.map(claim => claim.id), "claim id");
    for (const claim of input.claims.value) independent(claim.verdict, `Claim ${claim.id}`);
  }
  if (input.telemetry.steps.availability === "known") {
    unique(input.telemetry.steps.value.map(step => step.id), "step id");
    const sessions = input.identities.flatMap(id => id.sessionId.availability === "known" ? [id.sessionId.value] : []);
    for (const step of input.telemetry.steps.value) if (!sessions.includes(step.sessionId)) issue("Unjoined step session");
    if (input.telemetry.tokens.availability === "known" && input.telemetry.steps.value.reduce((sum, step) =>
      sum + step.observationTokens, 0) > input.telemetry.tokens.value) issue("Observation tokens exceed measured tokens");
  }
});

export type WorkpackageEvaluationInput = z.infer<typeof inputSchema>;
export type Field<T> = { availability: "known"; value: T; refs: string[] } |
  { availability: "unknown" | "needs_review"; reason: string };
export type Group = typeof groups[number];
export const parseWorkpackageEvaluationInput = (value: unknown): WorkpackageEvaluationInput => inputSchema.parse(value);
