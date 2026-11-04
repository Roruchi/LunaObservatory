import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { discoverSources } from "../fs/discovery.js";
import { readJsonl } from "../fs/jsonl.js";
import { createSessionParser } from "../normalize/parser.js";
import type { NormalizedSession } from "../normalize/types.js";
import type { RequestedSource } from "../sources/types.js";
import type { Field, WorkpackageEvaluationInput } from "../workpackageEvaluation/contract.js";

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
export const taskRecordSchema = z.object({
  taskId: text, attemptId: text.nullable(), project: text,
  harness: z.enum(["codex", "claude", "copilot"]), spawnGeneration: text.nullable(),
  branchName: text.optional(), worktreePath: text.optional(), steeringInboxPath: text.optional(),
  startedAt: timestamp, endedAt: timestamp.nullable(),
  provenance: z.object({ uri: text, digest: text }).strict()
}).strict().superRefine((record, ctx) => {
  if (record.endedAt && Date.parse(record.endedAt) < Date.parse(record.startedAt))
    ctx.addIssue({ code: "custom", message: "Attempt ends before it starts" });
});
export const taskRecordsSchema = z.array(taskRecordSchema);
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type SessionObservations = {
  branches: string[]; worktreePaths: string[]; firstInstruction?: string;
};
export type Candidate = {
  taskId: string; attemptId: string | null; project: string; spawnGeneration: string | null;
  evidence: string[]; unknowns: string[]; recordIndexes: number[];
};
export type Correlation = {
  sessionId: string; source: NormalizedSession["source"];
  status: "matched" | "ambiguous" | "unmatched";
  confidence: "high" | "medium" | "low" | "none";
  taskId: string | null; attemptId: string | null;
  candidates: Candidate[]; reasons: string[];
  nativeIdentityUnknowns: string[];
};
const canonicalPath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The default consumes normalized evidence only. CLI adds native header fields below. */
export function sessionObservations(session: NormalizedSession): SessionObservations {
  return {
    branches: session.attribution?.branches ?? [],
    worktreePaths: session.attribution?.worktreePaths ?? [...new Set([
      session.repoRoot, ...session.turns.flatMap(turn => turn.hooks.map(hook => hook.cwd))
    ].filter((value): value is string => Boolean(value)))],
    firstInstruction: session.attribution?.firstInstruction?.text ?? session.turns.flatMap(turn => turn.userMessages ?? [])[0]?.text
  };
}

/** No fuzzy names, command-output parsing, nearest-time winner, or inferred attempts. */
export function correlateSession(session: NormalizedSession, records: TaskRecord[], observations = sessionObservations(session)): Correlation {
  const nativeIdentityUnknowns = session.nativeSessionId ? [] : ["session_id_missing"];
  const candidates: Candidate[] = [];
  const instruction = observations.firstInstruction ?? "";
  records.forEach((record, index) => {
    if (record.harness !== session.source) return;
    const explicitTaskIds = [...instruction.matchAll(/(?:^|\n)\s*(?:task[ _-]?id|endpoint_task_id)\s*[:=]\s*["']?([a-zA-Z0-9_.-]+)/gi)].map(match => match[1]);
    if (explicitTaskIds.some(taskId => taskId !== record.taskId)) return;
    if (records.some(other => other.taskId !== record.taskId && other.steeringInboxPath &&
      new RegExp(`(?:^|[\\s"'\x60])${escape(other.steeringInboxPath)}(?=$|[\\s"'\x60.,;])`).test(instruction))) return;
    const branch = observations.branches.includes(record.branchName ?? `fm/${record.taskId}`) &&
      (record.branchName === undefined || record.branchName === `fm/${record.taskId}`);
    const path = Boolean(record.worktreePath && observations.worktreePaths.some(value => canonicalPath(value) === canonicalPath(record.worktreePath!)));
    const inbox = Boolean(record.steeringInboxPath && new RegExp(`(?:^|[\\s"'\x60])${escape(record.steeringInboxPath)}(?=$|[\\s"'\x60.,;])`).test(instruction));
    const task = new RegExp(`(?:^|\\n)\\s*(?:task[ _-]?id|endpoint_task_id)\\s*[:=]\\s*["']?${escape(record.taskId)}["']?(?=\\s|$)`, "i").test(instruction);
    if (!branch && !path && !inbox && !task) return;
    // A known conflicting task branch is contradictory, never a weaker fallback.
    if (observations.branches.some(value => value.startsWith("fm/") && value !== `fm/${record.taskId}`)) return;
    if (record.worktreePath && observations.worktreePaths.length && !path) return;
    const start = Date.parse(session.startedAt ?? "");
    const end = Date.parse(session.endedAt ?? "");
    const completeTime = Number.isFinite(start) && Number.isFinite(end) && end >= start && record.endedAt !== null;
    if (Number.isFinite(end) && end < Date.parse(record.startedAt)) return;
    if (Number.isFinite(start) && record.endedAt !== null && start > Date.parse(record.endedAt)) return;
    const evidence = [branch && "branch", path && "worktree_path", inbox && "first_instruction_inbox", task && "first_instruction_task", completeTime && "time_overlap"].filter((value): value is string => Boolean(value));
    const unknowns = [...nativeIdentityUnknowns, ...(session.attribution?.unknowns.filter(reason => ["conflicting_session_copies", "sidechain_agent_identity_missing", "mixed_sidechain_markers", "timestamp_missing_or_invalid", "history_lineage_unknown"].includes(reason)) ?? []), !completeTime && "time_window_incomplete", !record.attemptId && "attempt_identity_unknown", !(branch || inbox || task) && "task_identity_unverified"].filter((value): value is string => Boolean(value));
    // Exact repeated caller records are one observation; contradictory metadata remains ambiguous.
    const duplicate = candidates.find(candidate => candidate.taskId === record.taskId && candidate.attemptId === record.attemptId &&
      candidate.project === record.project && candidate.spawnGeneration === record.spawnGeneration &&
      JSON.stringify(records[candidate.recordIndexes[0]]) === JSON.stringify(record));
    if (duplicate) duplicate.recordIndexes.push(index);
    else candidates.push({ taskId: record.taskId, attemptId: record.attemptId, project: record.project, spawnGeneration: record.spawnGeneration, evidence, unknowns, recordIndexes: [index] });
  });
  candidates.sort((a, b) => JSON.stringify([a.project, a.taskId, a.attemptId]).localeCompare(JSON.stringify([b.project, b.taskId, b.attemptId])));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const matched = only && only.unknowns.length === 0;
  return {
    sessionId: session.sessionId, source: session.source,
    status: matched ? "matched" : candidates.length ? "ambiguous" : "unmatched",
    confidence: matched ? only.evidence.includes("worktree_path") ? "high" : "medium" : candidates.length ? "low" : "none",
    taskId: matched ? only.taskId : null, attemptId: matched ? only.attemptId : null,
    nativeIdentityUnknowns,
    candidates, reasons: matched ? ["unique_verified_attempt"] : candidates.length > 1 ? ["multiple_candidates"] : candidates.length ? only!.unknowns : ["no_compatible_evidence"]
  };
}

function nativeObservations(file: string, session: NormalizedSession): SessionObservations {
  const observed = sessionObservations(session);
  if (session.source === "claude") return observed;
  // Header-only metadata; do not mine arbitrary tool results or assistant prose.
  const events = readJsonl(file).events;
  // Child rollouts can contain copied parent headers; normalized child scope wins.
  if (session.parentSessionId || session.agentPath) return observed;
  observed.firstInstruction = undefined;
  for (const event of events) {
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    if (event.type === "session_meta") {
      const git = data.git && typeof data.git === "object" ? data.git as Record<string, unknown> : {};
      if (typeof git.branch === "string") observed.branches.push(git.branch);
      if (typeof data.cwd === "string") observed.worktreePaths.push(data.cwd);
    }
    if (event.type === "response_item" && data.type === "message" && data.role === "user" && !observed.firstInstruction && Array.isArray(data.content)) {
      observed.firstInstruction = data.content.map(part => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
    }
    if (event.type === "user.message" && !observed.firstInstruction && typeof data.content === "string") observed.firstInstruction = data.content;
  }
  return observed;
}

export function correlateTraceDirectory(logs: string, taskFile: string, source: RequestedSource = "all") {
  const raw = fs.readFileSync(taskFile, "utf8");
  const records = taskRecordsSchema.parse(JSON.parse(raw));
  const taskRecordsDigest = createHash("sha256").update(raw).digest("hex");
  const sessions = new Map<string, { session: NormalizedSession; observations: SessionObservations; digest: string }>();
  const conflicts = new Set<string>();
  let parseErrors = 0;
  const discoveredSources = discoverSources(source, logs);
  const parseSession = createSessionParser(discoveredSources.flatMap(source => source.files.map(file => ({ file, source: source.source }))));
  for (const discovered of discoveredSources) for (const file of discovered.files) {
    const parsed = parseSession(file, discovered.source);
    parseErrors += parsed.parseErrors;
    const session = parsed.session;
    if (session.source === "unknown") {
      const events = readJsonl(file).events;
      session.source = events.some(event => event.type === "session_meta") ? "codex" : events.some(event => event.type.startsWith("assistant.")) ? "copilot" : "unknown";
    }
    const key = `${session.source}:${session.sessionId}`;
    const digest = parsed.traceDigest ?? createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const previous = sessions.get(key);
    if (previous && previous.digest !== digest) conflicts.add(key);
    else if (!previous) sessions.set(key, { session, observations: nativeObservations(file, session), digest });
  }
  const correlations = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, { session, observations, digest }]) => {
    const result = { ...correlateSession(session, records, observations), traceDigest: digest,
      ...(session.source === "claude" ? { coverage: { history: session.attribution?.historyCoverage, usage: session.attribution?.usageCoverage,
        inheritedEvents: session.attribution?.inheritedEvents, unresolvedInheritedEvents: session.attribution?.unresolvedInheritedEvents, notes: session.attribution?.notes } } : {}) };
    if (conflicts.has(key)) return { ...result, status: "ambiguous" as const, confidence: "low" as const, taskId: null, attemptId: null, reasons: ["conflicting_session_copies"] };
    return result;
  });
  return { schema: "sessionCorrelation/1" as const, taskRecordsDigest, parseErrors, correlations };
}

/** Only identity linkage feeds slice 1; no acceptance facts or usage are synthesized. */
export function evaluationIdentity(correlation: Correlation, refId: string): WorkpackageEvaluationInput["identities"][number] {
  const unknown = (reason: string): Field<string> => ({ availability: "unknown", reason });
  const known = (value: string): Field<string> => ({ availability: "known", value, refs: [refId] });
  return {
    sessionId: correlation.nativeIdentityUnknowns.length ? unknown(correlation.nativeIdentityUnknowns.join(",")) : known(correlation.sessionId),
    attemptId: correlation.status === "matched" && correlation.attemptId ? known(correlation.attemptId) : unknown(correlation.status),
    missionId: unknown("not_supplied"), workerId: unknown("not_supplied"), role: unknown("not_supplied"), model: unknown("not_supplied"),
    orchestrator: correlation.status === "matched" ? known("Firstmate") : unknown("unverified")
  };
}
