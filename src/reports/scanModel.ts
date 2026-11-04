import fs from "node:fs";
import path from "node:path";
import type { NormalizedSession, SessionClassification } from "../normalize/types.js";
import type { InefficiencyScore } from "../scoring/score.js";
import { extractPathLikeValues } from "../utils/pathMatch.js";

export type ScanSummary = {
  filesScanned: number;
  eventsParsed: number;
  parseErrors: number;
  generatedAt: string;
};

export type RepositoryReportRow = {
  name: string;
  examplePath: string;
  sessions: number;
  suspicious: number;
  maxScore: number;
  toolCalls: number;
  verificationEvents: number;
};

export type TelemetryCoverageRow = {
  metric: string;
  reported: number;
  unavailable: number;
};

export type RankedSessionRow = {
  rank: number;
  sessionId: string;
  score: number;
  outcomeScore: number;
  classification: SessionClassification;
  repository: string;
  lifecycleStatus: string;
  models: string;
  turns: number;
  outputTokens: string;
  toolCalls: number;
  toolCallsPerTask: number;
  repeatedFileViews: number;
  verificationEvents: number;
  verificationClosure: string;
  repeatedFailedAttempts: number;
  redundantToolCallRate: number;
  reasons: string[];
};

export type ScanReportModel = {
  summary: ScanSummary;
  sessionsFound: number;
  includedSessions: number;
  excludedSessions: number;
  ambiguousSessions: number;
  counts: Record<SessionClassification, number>;
  repositories: RepositoryReportRow[];
  telemetryCoverage: TelemetryCoverageRow[];
  rankedSessions: RankedSessionRow[];
  reasonCounts: Array<{ reason: string; count: number }>;
};

const classes: SessionClassification[] = ["efficient", "expensive_but_justified", "suspicious", "inefficient", "unknown"];

export function metricValue(value: { value: number | null }): string {
  return value.value === null ? "unavailable" : String(value.value);
}

export function modelSummary(models: Record<string, number>): string {
  const entries = Object.entries(models);
  return entries.length ? entries.map(([name, count]) => `${name} (${count})`).join(", ") : "-";
}

function existingRepoRoot(candidate: string): string | undefined {
  if (process.platform !== "win32" && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate)) return undefined;
  let current = path.resolve(candidate);
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    return undefined;
  }

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function heuristicRepoRoot(candidate: string): string | undefined {
  const normalized = candidate.replace(/\//g, "\\");
  const repoWorktreeMatch = normalized.match(/^(.+\\[^\\\s"'`|<>]+\.worktrees\\[^\\\s"'`|<>]+)/i);
  if (repoWorktreeMatch) return repoWorktreeMatch[1];
  const repoMatch = normalized.match(/^([A-Za-z]:\\Repo\\[^\\\s"'`|<>]+\\[^\\\s"'`|<>]+)/i);
  if (repoMatch) return repoMatch[1];
  const worktreeMatch = normalized.match(/^(.+\\(?:worktrees|copilot-worktrees)\\[^\\\s"'`|<>]+\\[^\\\s"'`|<>]+)/i);
  return worktreeMatch?.[1];
}

function repositoryCandidate(raw: string): string | undefined {
  return existingRepoRoot(raw) ?? heuristicRepoRoot(raw);
}

function pathFragments(value: string): string[] {
  const fragments = [value];
  const pathPattern = /[A-Za-z]:[\\/][^\s"'`|<>]+/g;
  for (const match of value.matchAll(pathPattern)) fragments.push(match[0]);
  return fragments;
}

function mostLikelyRepository(paths: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const raw of paths) {
    for (const fragment of pathFragments(raw)) {
      const repo = repositoryCandidate(fragment);
      if (repo) counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]?.[0];
}

function repoPath(session: NormalizedSession): string {
  if (session.repoRoot) return repositoryCandidate(session.repoRoot) ?? session.repoRoot;
  const toolPaths: string[] = [];
  for (const turn of session.turns) {
    for (const hook of turn.hooks) {
      if (hook.cwd) return repositoryCandidate(hook.cwd) ?? hook.cwd;
    }
    for (const tool of turn.toolCalls) {
      toolPaths.push(...extractPathLikeValues(tool.arguments));
    }
  }
  const inferred = mostLikelyRepository(toolPaths);
  if (inferred) return inferred;
  return "unknown";
}

function repoName(repo: string): string {
  if (repo === "unknown") return repo;
  const normalized = repo.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function repositoryRows(sessions: NormalizedSession[], scores: InefficiencyScore[]): RepositoryReportRow[] {
  const scoresBySession = new Map(scores.map((score) => [score.sessionId, score]));
  const repos = new Map<string, RepositoryReportRow>();

  for (const session of sessions) {
    if (session.repoMatch === "excluded") continue;
    const repo = repoPath(session);
    const name = repoName(repo);
    const row =
      repos.get(name) ?? {
        name,
        examplePath: repo,
        sessions: 0,
        suspicious: 0,
        maxScore: 0,
        toolCalls: 0,
        verificationEvents: 0
      };
    const score = scoresBySession.get(session.sessionId);
    row.sessions += 1;
    row.toolCalls += session.metrics.toolRequests;
    row.verificationEvents += session.metrics.verificationEvents;
    row.maxScore = Math.max(row.maxScore, score?.inefficiencyScore ?? 0);
    if (score && (score.classification === "suspicious" || score.classification === "inefficient")) row.suspicious += 1;
    if (row.examplePath === "unknown" && repo !== "unknown") row.examplePath = repo;
    repos.set(name, row);
  }

  return [...repos.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

function telemetryCoverageRows(sessions: NormalizedSession[]): TelemetryCoverageRow[] {
  const unavailable = {
    inputTokens: sessions.filter((session) => session.metrics.inputTokens.source === "unavailable").length,
    outputTokens: sessions.filter((session) => session.metrics.outputTokens.source === "unavailable").length,
    cachedTokens: sessions.filter((session) => session.metrics.cachedTokens.source === "unavailable").length
  };
  return [
    { metric: "Input tokens", reported: sessions.length - unavailable.inputTokens, unavailable: unavailable.inputTokens },
    { metric: "Output tokens", reported: sessions.length - unavailable.outputTokens, unavailable: unavailable.outputTokens },
    { metric: "Cached tokens", reported: sessions.length - unavailable.cachedTokens, unavailable: unavailable.cachedTokens },
    {
      metric: "Task completion marker",
      reported: sessions.filter((session) => session.lifecycleStatus !== "unknown").length,
      unavailable: sessions.filter((session) => session.lifecycleStatus === "unknown").length
    },
    {
      metric: "User intent",
      reported: sessions.filter((session) => Boolean(session.userIntent?.text)).length,
      unavailable: sessions.filter((session) => !session.userIntent?.text).length
    },
    {
      metric: "Final answer",
      reported: sessions.filter((session) => Boolean(session.finalAnswer?.text)).length,
      unavailable: sessions.filter((session) => !session.finalAnswer?.text).length
    }
  ];
}

export function buildScanReportModel(
  sessions: NormalizedSession[],
  scores: InefficiencyScore[],
  summary: ScanSummary,
  top = 5
): ScanReportModel {
  const counts = Object.fromEntries(classes.map((name) => [name, scores.filter((score) => score.classification === name).length])) as Record<
    SessionClassification,
    number
  >;
  const reasonCounts = new Map<string, number>();
  for (const score of scores) {
    for (const reason of score.reasonCodes) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const rankedSessions = [...scores]
    .filter(
      (score) =>
        (score.repoMatch === "matched" || score.repoMatch === "ambiguous") &&
        ["suspicious", "inefficient", "expensive_but_justified"].includes(score.classification)
    )
    .sort((a, b) => b.inefficiencyScore - a.inefficiencyScore)
    .slice(0, top)
    .map((score, index) => ({
      rank: index + 1,
      sessionId: score.sessionId,
      score: score.inefficiencyScore,
      outcomeScore: score.outcomeScore,
      classification: score.classification,
      repository: repoName(repoPath(sessions.find((session) => session.sessionId === score.sessionId) ?? ({ repoRoot: score.repoRoot } as NormalizedSession))),
      lifecycleStatus: score.lifecycleStatus,
      models: modelSummary(score.metrics.models),
      turns: score.metrics.taskStarts || score.metrics.turns,
      outputTokens: metricValue(score.metrics.outputTokens),
      toolCalls: score.metrics.toolRequests,
      toolCallsPerTask: score.metrics.toolRequestsPerTask,
      repeatedFileViews: score.metrics.repeatedFileViews,
      verificationEvents: score.metrics.verificationEvents,
      verificationClosure: score.metrics.verificationClosure,
      repeatedFailedAttempts: score.metrics.repeatedFailedCommandAttempts,
      redundantToolCallRate: score.metrics.redundantToolCallRate,
      reasons: score.reasonCodes
    }));

  return {
    summary,
    sessionsFound: sessions.length,
    includedSessions: sessions.filter((session) => session.repoMatch === "matched").length,
    excludedSessions: sessions.filter((session) => session.repoMatch === "excluded").length,
    ambiguousSessions: sessions.filter((session) => session.repoMatch === "ambiguous").length,
    counts,
    repositories: repositoryRows(sessions, scores),
    telemetryCoverage: telemetryCoverageRows(sessions),
    rankedSessions,
    reasonCounts: [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
  };
}
