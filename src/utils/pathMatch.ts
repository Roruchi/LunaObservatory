import path from "node:path";
import fs from "node:fs";

export function normalizeForMatch(value: string): string {
  return path.resolve(value).toLowerCase();
}

export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalizeForMatch(child);
  const normalizedParent = normalizeForMatch(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`)
  );
}

export function repositoryRootForPath(candidate: string): string | undefined {
  let current = path.resolve(candidate);
  try {
    if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) current = path.dirname(current);
    while (true) {
      const gitMarker = path.join(current, ".git");
      if (fs.existsSync(gitMarker)) {
        if (fs.statSync(gitMarker).isFile()) {
          const pointer = fs.readFileSync(gitMarker, "utf8").match(/^gitdir:\s*(.+)$/im)?.[1]?.trim();
          const gitDir = pointer ? path.resolve(current, pointer) : undefined;
          const sharedRoot = gitDir?.match(/^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/i)?.[1];
          if (sharedRoot) return path.resolve(sharedRoot);
        }
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Fall through to path-shape inference for stale or unavailable paths.
  }

  const normalized = path.resolve(candidate).replace(/\//g, "\\");
  const repoWorktreeMatch = normalized.match(/^(.+\\[^\\\s"'`|<>]+\.worktrees\\[^\\\s"'`|<>]+)/i);
  if (repoWorktreeMatch) return repoWorktreeMatch[1];
  const repoMatch = normalized.match(/^([A-Za-z]:\\Repo\\[^\\\s"'`|<>]+\\[^\\\s"'`|<>]+)/i);
  if (repoMatch) return repoMatch[1];
  const worktreeMatch = normalized.match(/^(.+\\(?:worktrees|copilot-worktrees)\\[^\\\s"'`|<>]+\\[^\\\s"'`|<>]+)/i);
  return worktreeMatch?.[1];
}

export function extractPathLikeValues(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (typeof node === "string") {
      try {
        const parsed = JSON.parse(node) as unknown;
        if (parsed && typeof parsed === "object") {
          visit(parsed);
          return;
        }
      } catch {
        // Plain strings are inspected below.
      }
      if (/([a-zA-Z]:\\|\/).+/.test(node) || node.includes("\\") || node.includes("/")) {
        found.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object") {
      for (const [key, nested] of Object.entries(node)) {
        if (/path|file|cwd|dir|command|cmd|args|arguments|result|value/i.test(key)) visit(nested);
      }
    }
  };
  visit(value);
  return found;
}
