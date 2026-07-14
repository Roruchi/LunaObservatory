import fs from "node:fs";
import path from "node:path";
import { homePath } from "./paths.js";
import type { DiscoveredSource, RequestedSource, SourceName } from "../sources/types.js";

function envPath(name: string, fallback: string): string {
  return process.env[name] ? path.resolve(process.env[name]!) : fallback;
}

function walkFiles(root: string, predicate: (file: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
      return;
    }
    if (predicate(current)) found.push(current);
  };
  walk(root);
  return found.sort();
}

function discoverCopilot(root: string): string[] {
  const found = new Set<string>();
  const addFiles = (folder: string, predicate: (file: string) => boolean): void => {
    for (const file of walkFiles(folder, predicate)) found.add(file);
  };

  const baseName = path.basename(root).toLowerCase();
  const sessionStateRoots = baseName === "session-state" ? [root] : [path.join(root, "session-state")];
  const jbRoots = baseName === "jb" ? [root] : [path.join(root, "jb")];
  const legacySessionRoots = baseName === "sessions" ? [root] : [path.join(root, "sessions")];

  for (const folder of sessionStateRoots) addFiles(folder, (file) => path.basename(file) === "events.jsonl");
  for (const folder of jbRoots) addFiles(folder, (file) => /^partition-\d+\.jsonl$/i.test(path.basename(file)));
  for (const folder of legacySessionRoots) addFiles(folder, (file) => file.endsWith(".jsonl"));

  return [...found].sort();
}

function discoverJsonl(root: string): string[] {
  return walkFiles(root, (file) => file.endsWith(".jsonl"));
}

export function sourceDefaults(source: Exclude<SourceName, "unknown">): { root: string; globs: string[] } {
  if (source === "copilot") {
    return {
      root: envPath("COPILOT_HOME", homePath(".copilot")),
      globs: ["session-state/*/events.jsonl", "jb/*/partition-*.jsonl", "sessions/**/*.jsonl"]
    };
  }
  if (source === "codex") {
    return {
      root: envPath("CODEX_HOME", homePath(".codex")),
      globs: ["sessions/**/*.jsonl", "archived_sessions/**/*.jsonl"]
    };
  }
  return {
    root: homePath(".claude"),
    globs: ["projects/*/*.jsonl"]
  };
}

export function discoverSources(requested: RequestedSource, logsPath?: string): DiscoveredSource[] {
  const sources: Array<Exclude<SourceName, "unknown">> =
    requested === "all" ? ["copilot", "codex", "claude"] : [requested];

  if (logsPath) {
    const resolved = path.resolve(logsPath);
    const logSources: SourceName[] = requested === "all" ? ["unknown"] : sources;
    return logSources.map((source) => ({
      source,
      root: resolved,
      globs: ["**/*.jsonl"],
      files:
        fs.existsSync(resolved) && fs.statSync(resolved).isFile()
          ? [resolved]
          : source === "copilot"
            ? discoverCopilot(resolved)
            : discoverJsonl(resolved)
    }));
  }

  return sources.map((source) => {
    const defaults = sourceDefaults(source);
    const files = source === "copilot" ? discoverCopilot(defaults.root) : discoverJsonl(defaults.root);
    return { source, root: defaults.root, globs: defaults.globs, files };
  });
}
