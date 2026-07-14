import path from "node:path";

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
