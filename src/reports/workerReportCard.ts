import fs from "node:fs";
import { discoverSources } from "../fs/discovery.js";
import { createSessionParser } from "../normalize/parser.js";
import type { NormalizedSession } from "../normalize/types.js";
import { correlateTraceDirectory, taskRecordsSchema, type Correlation, type TaskRecord } from "../correlation/index.js";
import type { RequestedSource } from "../sources/types.js";
import { scoreSession } from "../scoring/score.js";
import type { ReasonCode } from "../scoring/reasonCodes.js";

const reasonText: Record<ReasonCode, string> = {
  HIGH_OUTPUT_TOKEN_OUTLIER: "High output volume; task difficulty and useful output have not been assessed.",
  MANY_TURNS: "Many turns and tools per turn; this alone does not establish waste.",
  HIGH_TOOL_CHURN: "Many tool requests per turn; no comparable effort baseline is supplied.",
  REPEATED_FILE_VIEWS: "Repeated file views were observed; their necessity is unknown.",
  REPEATED_GLOB_SEARCH: "Repeated file discovery was observed; its necessity is unknown.",
  FAILED_COMMAND_LOOP: "The same command failed repeatedly without an observed successful edit between attempts.",
  MISSING_VERIFICATION: "Post-edit verification is incomplete: a recognized lane is missing or unresolved.",
  UNRESOLVED_VERIFICATION: "At least one final recognized verification lane after an edit failed.",
  REDUNDANT_TOOL_CALLS: "Repeated canonical tool signatures occurred without an observed successful edit between them; necessity is unknown.",
  EXPENSIVE_NO_OP: "A change claim has substantial output but no observed tool evidence; the claim is unverified.",
  LOW_SIGNAL_EXPLORATION: "Search activity has no recorded final answer; useful progress is unknown.",
  HOOK_FAILURES: "The trace records hook failures.",
  UNKNOWN_INPUT_TOKENS: "Input token telemetry is unavailable."
};

// Report only metadata and aggregate evidence. Never render prompts, final answers,
// command payloads, tool results, declared intents, or evidence summaries.
const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ").replace(/`/g, "&#96;");
const key = (session: Pick<NormalizedSession, "source" | "sessionId">) => `${session.source}:${session.sessionId}`;
function duration(session: NormalizedSession): string {
  const start = Date.parse(session.startedAt ?? "");
  const end = Date.parse(session.endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? `${((end - start) / 60000).toFixed(1)} min observed wall time` : "unknown";
}

export function generateWorkerReportCards(sessions: NormalizedSession[], records: TaskRecord[], correlations: Correlation[]): string {
  const byKey = new Map(sessions.map(session => [key(session), session]));
  const joins = new Map(correlations.map(correlation => [key(correlation), correlation]));
  const lines = ["# Worker report cards", "",
    "Quality: **Unscored**. Acceptance receipts and comparable effort baselines are not supplied. All trace findings have **low confidence** as measures of work quality.", "",
    "Each card describes one native worker session separately. Candidate task associations and parent links are diagnostic, not verified attempts. Do not sum parent/child tools, durations, or costs. Observed wall time is not active execution time or the administrative task window. Recognized successes are transcript observations, not independent acceptance receipts; incomplete multi-command results remain unresolved.", ""];
  const taskIds = [...new Set(records.map(record => record.taskId))];
  for (const taskId of taskIds) {
    lines.push(`## Task: ${safe(taskId)}`, "");
    const selected = new Map<string, string>();
    for (const correlation of correlations) {
      if (correlation.taskId === taskId || correlation.candidates.some(candidate => candidate.taskId === taskId)) {
        selected.set(key(correlation), correlation.status === "matched" ? "verified task/attempt correlation" : "candidate task association");
      }
    }
    // Include execution parents without promoting their correlation or inheriting scores.
    for (const sessionKey of [...selected.keys()]) {
      let session = byKey.get(sessionKey);
      const visited = new Set<string>();
      while (session?.parentSessionId) {
        const parentKey = `${session.source}:${session.parentSessionId}`;
        if (visited.has(parentKey)) break;
        visited.add(parentKey);
        const parent = byKey.get(parentKey);
        if (!parent) break;
        if (!selected.has(parentKey)) selected.set(parentKey, "native parent link only; task/attempt unverified");
        session = parent;
      }
    }
    if (!selected.size) lines.push("**Unscored / low confidence**: no compatible worker session found. Harness: " +
      [...new Set(records.filter(record => record.taskId === taskId).map(record => record.harness))].join(", ") +
      "; model, duration, tools, verification and outcome unknown. Correlation: unmatched. No worker or attempt identity is invented.", "");
    for (const [sessionKey, association] of selected) {
      const session = byKey.get(sessionKey);
      if (!session) {
        lines.push(`Worker ${safe(sessionKey)}: **Unscored / low confidence**, normalized trace unavailable.`, "");
        continue;
      }
      const join = joins.get(sessionKey);
      const metrics = session.metrics;
      const score = scoreSession(session);
      const tools = Object.entries(metrics.toolCallsByName).map(([name, count]) => `${safe(name)}: ${count}`).join(", ") || "none recorded";
      const models = Object.keys(metrics.models).map(safe).join(", ") || "unknown";
      const attempt = join?.status === "matched" ? safe(join.attemptId ?? "unknown") : "unknown (not verified)";
      lines.push(`### Worker: ${safe(session.nativeSessionId ?? session.sessionId)}`, "",
        "| Field | Evidence |", "| --- | --- |",
        `| Task association | ${safe(association)} |`,
        `| Attempt | ${attempt} |`,
        `| Candidate attempts | ${safe(join?.candidates.map(candidate => `${candidate.taskId}: ${candidate.attemptId ?? "unknown"}; generation ${candidate.spawnGeneration ?? "unknown"}; anchors ${candidate.evidence.join(", ") || "none"}; unknowns ${candidate.unknowns.join(", ") || "none recorded"}`).join(" / ") || "none recorded")} |`,
        `| Harness / model | ${safe(session.source)} / ${models} |`,
        `| Native identity | ${session.nativeSessionId ? "recorded" : "missing; display ID is a fallback"} |`,
        `| Trace provenance | ${session.sourceFiles.map(safe).join(", ")}; SHA-256 ${safe(join?.traceDigest ?? "unavailable")} |`,
        `| Parent session | ${safe(session.parentSessionId ?? "none recorded")} |`,
        `| Duration | ${duration(session)}; ${safe(session.startedAt ?? "unknown")} → ${safe(session.endedAt ?? "unknown")} |`,
        `| Tools | ${metrics.toolRequests} native requests; ${tools} |`,
        `| Edits / commands | ${metrics.editCalls} successful direct/expanded edits; ${metrics.commandCalls} recognized command operations; shell-driven edits may be unobserved |`,
        `| Verification | ${metrics.verificationEvents} recognized operations; ${metrics.verificationPassed} recorded successes; ${metrics.verificationFailed} failures; post-edit closure: ${safe(metrics.verificationClosure)} |`,
        `| Outcome | **Unscored / low confidence**: native lifecycle ${safe(session.lifecycleStatus)}; final answer ${session.finalAnswer?.text ? "present" : "absent"}; accepted work not assessed |`,
        `| Inefficiency | **Unscored / low confidence**: ${metrics.toolRequests ? "trace signals only; comparable effort and necessity unknown" : "no tool evidence; absence of flags does not establish efficiency"} |`,
        `| Correlation | ${safe(join?.status ?? "unmatched")}; confidence ${safe(join?.confidence ?? "none")}; reasons: ${safe(join?.reasons.join(", ") || "no correlation evidence")} |`,
        `| Coverage | ${metrics.parseErrors} parse errors; history ${safe(session.attribution?.historyCoverage ?? "unknown")}; usage ${safe(session.attribution?.usageCoverage ?? "unknown")}; unknowns: ${safe(session.attribution?.unknowns.join(", ") || "none recorded (completeness not established)")} |`, "",
        "Trace findings:", "",
        ...(score.reasonCodes.length ? score.reasonCodes.map(reason => `- ${reasonText[reason]}`) : ["- No heuristic flags detected. This is not an accepted outcome or an efficiency rating."]), "");
    }
  }
  return lines.join("\n");
}

export function reportCardsFromTraces(logs: string, taskFile: string, source: RequestedSource = "all"): string {
  const records = taskRecordsSchema.parse(JSON.parse(fs.readFileSync(taskFile, "utf8")));
  const correlation = correlateTraceDirectory(logs, taskFile, source);
  const discovered = discoverSources(source, logs);
  const parse = createSessionParser(discovered.flatMap(item => item.files.map(file => ({ file, source: item.source }))));
  const sessions = new Map<string, NormalizedSession>();
  for (const item of discovered) for (const file of item.files) {
    const session = parse(file, item.source).session;
    if (!sessions.has(key(session))) sessions.set(key(session), session);
  }
  return generateWorkerReportCards([...sessions.values()], records, correlation.correlations) +
    `\nProvenance: task-record SHA-256 ${correlation.taskRecordsDigest}; ${correlation.parseErrors} parse errors across discovered traces. Traces were read locally; no transcript text is included.\n`;
}
