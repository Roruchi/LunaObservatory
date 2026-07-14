import { extractPathLikeValues, isPathInside } from "../utils/pathMatch.js";
import type { EvidenceRef, NormalizedSession } from "./types.js";

export type RepoFilterDecision = {
  sessionId: string;
  repoRoot: string;
  repoMatch: NormalizedSession["repoMatch"];
  cwdMatches: number;
  pathMatches: number;
  pathSignals: number;
};

export function classifyRepoMatch(session: NormalizedSession, repoRoot: string): RepoFilterDecision {
  let cwdMatches = 0;
  let pathMatches = 0;
  let pathSignals = 0;
  const evidence: EvidenceRef[] = [];

  for (const turn of session.turns) {
    for (const hook of turn.hooks) {
      if (hook.cwd && isPathInside(hook.cwd, repoRoot)) {
        cwdMatches += 1;
        const cwdEvidence = hook.evidence?.find((ref) => ref.summary === `cwd=${hook.cwd}`) ?? hook.evidence?.[0];
        if (cwdEvidence) evidence.push({ ...cwdEvidence, summary: `matched via hook cwd: ${hook.cwd}` });
      }
    }
    for (const tool of turn.toolCalls) {
      const paths = extractPathLikeValues(tool.arguments);
      pathSignals += paths.length;
      pathMatches += paths.filter((candidate) => {
        try {
          return isPathInside(candidate, repoRoot);
        } catch {
          return false;
        }
      }).length;
    }
  }

  let repoMatch: NormalizedSession["repoMatch"] = "unknown";
  if (cwdMatches > 0) repoMatch = "matched";
  else if (pathSignals > 0 && pathMatches / pathSignals >= 0.6) repoMatch = "matched";
  else if (pathSignals > 0 && pathMatches === 0) repoMatch = "excluded";
  else if (pathSignals > 0 || session.turns.length > 0) repoMatch = "ambiguous";

  session.evidence = [...(session.evidence ?? []), ...evidence];
  return { sessionId: session.sessionId, repoRoot, repoMatch, cwdMatches, pathMatches, pathSignals };
}

export function applyRepoFilter(session: NormalizedSession, repoRoot: string, allRepos = false): RepoFilterDecision {
  const decision = allRepos
    ? {
        sessionId: session.sessionId,
        repoRoot,
        repoMatch: "matched" as const,
        cwdMatches: 0,
        pathMatches: 0,
        pathSignals: 0
      }
    : classifyRepoMatch(session, repoRoot);
  session.repoRoot = repoRoot;
  session.repoMatch = decision.repoMatch;
  return decision;
}
