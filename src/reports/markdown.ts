import type { NormalizedSession } from "../normalize/types.js";
import type { InefficiencyScore } from "../scoring/score.js";
import { buildScanReportModel, type ScanSummary } from "./scanModel.js";

export type { ScanSummary } from "./scanModel.js";

function tableEscape(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function repositoryRows(model: ReturnType<typeof buildScanReportModel>): string[] {
  const rows = model.repositories;
  if (!rows.length) return ["No repositories found."];
  return [
    "| Repository | Sessions | Suspicious/Inefficient | Max score | Tool calls | Verification events | Example path |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((row) =>
      `| ${[
        tableEscape(row.name),
        row.sessions,
        row.suspicious,
        row.maxScore,
        row.toolCalls,
        row.verificationEvents,
        tableEscape(row.examplePath)
      ].join(" | ")} |`
    )
  ];
}

function telemetryCoverageRows(model: ReturnType<typeof buildScanReportModel>): string[] {
  return [
    "| Metric | Reported | Unavailable |",
    "| --- | ---: | ---: |",
    ...model.telemetryCoverage.map((row) => `| ${row.metric} | ${row.reported} | ${row.unavailable} |`)
  ];
}

export function generateScanReport(
  sessions: NormalizedSession[],
  scores: InefficiencyScore[],
  summary: ScanSummary,
  top = 5
): string {
  const model = buildScanReportModel(sessions, scores, summary, top);

  const lines = [
    "# LunaObs Scan Report",
    "",
    "Low-confidence session heuristics only; these numbers do not establish workpackage quality or acceptance. Workers without tool evidence are unscored.",
    "",
    "## Summary",
    "",
    `- Files scanned: ${summary.filesScanned}`,
    `- Events parsed: ${summary.eventsParsed}`,
    `- Parse errors: ${summary.parseErrors}`,
    `- Sessions found: ${model.sessionsFound}`,
    `- Included sessions: ${model.includedSessions}`,
    `- Excluded sessions: ${model.excludedSessions}`,
    `- Ambiguous sessions: ${model.ambiguousSessions}`,
    `- Generated at: ${summary.generatedAt}`,
    "",
    "## Classification counts",
    "",
    `- Efficient: ${model.counts.efficient}`,
    `- Expensive but justified: ${model.counts.expensive_but_justified}`,
    `- Suspicious: ${model.counts.suspicious}`,
    `- Inefficient: ${model.counts.inefficient}`,
    `- Unknown: ${model.counts.unknown}`,
    "",
    "## Repositories",
    "",
    ...repositoryRows(model),
    "",
    "## Evidence and telemetry coverage",
    "",
    ...telemetryCoverageRows(model),
    "",
    "## Top suspicious sessions",
    "",
    "| Rank | Score | Outcome | Class | Session | Repository | Status | Tasks | Output tokens | Tools/task | Verification closure | Repeated failures | Redundant calls | Reasons |",
    "| --- | ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ...model.rankedSessions.map((score) =>
      `| ${[
        score.rank,
        score.score,
        score.outcomeScore,
        score.classification,
        tableEscape(score.sessionId),
        tableEscape(score.repository),
        tableEscape(score.lifecycleStatus),
        score.turns,
        score.outputTokens,
        score.toolCallsPerTask.toFixed(1),
        tableEscape(score.verificationClosure),
        score.repeatedFailedAttempts,
        `${(score.redundantToolCallRate * 100).toFixed(1)}%`,
        tableEscape(score.reasons.join(", ") || "-")
      ].join(" | ")} |`
    ),
    "",
    "## Repeated patterns",
    "",
    ...(model.reasonCounts.length ? model.reasonCounts.map(({ reason, count }) => `- ${reason}: ${count}`) : ["- None"]),
    "",
    "## Recommended Dream investigation",
    "",
    ...(model.rankedSessions.length
      ? model.rankedSessions.map((score) => `${score.rank}. ${score.sessionId} (${score.classification}, score ${score.score})`)
      : ["No suspicious sessions selected."]),
    ""
  ];
  return lines.join("\n");
}
