import { extractPathLikeValues, isPathInside, pathStyle, repositoryRootForPath } from "../utils/pathMatch.js";
import type { EvidenceRef, NormalizedSession } from "./types.js";

export type RepoFilterDecision = {
  sessionId: string;
  repoRoot?: string;
  repoMatch: NormalizedSession["repoMatch"];
  cwdMatches: number;
  pathMatches: number;
  pathSignals: number;
};

function observedRepoRoot(session: NormalizedSession): string | undefined {
  const counts = new Map<string, number>();
  for (const turn of session.turns) {
    for (const hook of turn.hooks) {
      if (hook.cwd) {
        const root = repositoryRootForPath(hook.cwd) ?? hook.cwd;
        counts.set(root, (counts.get(root) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

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
  const observedRoot = allRepos ? observedRepoRoot(session) : undefined;
  const effectiveRoot = allRepos ? observedRoot : repositoryRootForPath(repoRoot) ?? repoRoot;
  const decision: RepoFilterDecision = allRepos
    ? {
        sessionId: session.sessionId,
        ...(effectiveRoot ? { repoRoot: effectiveRoot } : {}),
        repoMatch: effectiveRoot ? "matched" : "unknown",
        cwdMatches: 0,
        pathMatches: 0,
        pathSignals: 0
      }
    : classifyRepoMatch(session, effectiveRoot ?? repoRoot);
  session.repoRoot = effectiveRoot;
  session.repoMatch = decision.repoMatch;
  return decision;
}

function isEphemeralCodexWorktree(repoRoot: string): boolean {
  return /[\\/]\.codex[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+$/i.test(repoRoot.replace(/[\\/]+$/, ""));
}

/**
 * Historical Codex worktrees are often deleted before a scan runs, so their
 * `.git` pointer can no longer reveal the shared repository. When the same
 * scan contains one unambiguous durable root with the same repository name,
 * use that root for the stale worktree sessions as well.
 */
export function canonicalizeObservedRepoRoots(sessions: NormalizedSession[]): void {
  const durableByName = new Map<string, Set<string>>();
  for (const session of sessions) {
    const root = session.repoRoot;
    if (!root || isEphemeralCodexWorktree(root)) continue;
    const name = pathStyle(root).basename(root.replace(/[\\/]+$/, "")).toLowerCase();
    const roots = durableByName.get(name) ?? new Set<string>();
    roots.add(root);
    durableByName.set(name, roots);
  }

  for (const session of sessions) {
    const root = session.repoRoot;
    if (!root || !isEphemeralCodexWorktree(root)) continue;
    const name = pathStyle(root).basename(root.replace(/[\\/]+$/, "")).toLowerCase();
    const durable = [...(durableByName.get(name) ?? [])];
    if (durable.length === 1) session.repoRoot = durable[0];
  }
}
