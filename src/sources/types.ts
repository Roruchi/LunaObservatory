export type SourceName = "copilot" | "codex" | "claude" | "unknown";

export type RequestedSource = Exclude<SourceName, "unknown"> | "all";

export type DiscoveredSource = {
  source: SourceName;
  root: string;
  globs: string[];
  files: string[];
};
