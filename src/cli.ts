#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { defaultConfig } from "./config.js";
import { discoverSources } from "./fs/discovery.js";
import { readJsonlObjects, writeJsonl } from "./fs/jsonl.js";
import { detectRepoRoot, ensureLunaObsDirs, getLunaObsPaths } from "./fs/paths.js";
import { applyRepoFilter } from "./normalize/repoFilter.js";
import { parseSessionFile } from "./normalize/parser.js";
import type { NormalizedSession } from "./normalize/types.js";
import { generateScanHtmlReport } from "./reports/html.js";
import { generateInspectReport } from "./reports/inspect.js";
import { generateScanReport } from "./reports/markdown.js";
import type { ScanSummary } from "./reports/scanModel.js";
import { scanTerminalSummary } from "./reports/terminal.js";
import { prepareDreamPacket, writePreparedDreamPacket } from "./dream/prepare.js";
import { resolveDreamHtmlReportPath, writeDreamValidationReport } from "./dream/validate.js";
import { scoreSession, type InefficiencyScore } from "./scoring/score.js";
import { installDreamSkill, type SkillAgent } from "./skills/install.js";
import type { RequestedSource } from "./sources/types.js";

function numberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Expected a positive number, got ${value}`);
  return parsed;
}

function sourceOption(value: string): RequestedSource {
  if (["copilot", "codex", "claude", "all"].includes(value)) return value as RequestedSource;
  throw new Error(`Expected source to be copilot, codex, claude, or all. Got ${value}`);
}

function agentOption(value: string): SkillAgent {
  if (["codex", "copilot", "claude", "all"].includes(value)) return value as SkillAgent;
  throw new Error(`Expected agent to be codex, copilot, claude, or all. Got ${value}`);
}

function initProject(root: string, out = ".lunaobs"): void {
  const paths = getLunaObsPaths(root, out);
  ensureLunaObsDirs(paths);
  const configPath = path.join(paths.lunaobs, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  }
  installDreamSkill(root, "canonical");
}

function writeScanReports(
  reportsDir: string,
  sessions: NormalizedSession[],
  scores: InefficiencyScore[],
  summary: ScanSummary,
  top: number
): { markdownPath: string; htmlPath: string } {
  fs.mkdirSync(reportsDir, { recursive: true });
  const markdownPath = path.join(reportsDir, "inefficiency-report.md");
  const htmlPath = path.join(reportsDir, "inefficiency-report.html");
  fs.writeFileSync(markdownPath, generateScanReport(sessions, scores, summary, top), "utf8");
  fs.writeFileSync(htmlPath, generateScanHtmlReport(sessions, scores, summary, top), "utf8");
  return { markdownPath, htmlPath };
}

function scan(options: {
  source: RequestedSource;
  logs?: string;
  repo?: string;
  allRepos?: boolean;
  out?: string;
  top: number;
}): void {
  const outputRoot = detectRepoRoot();
  const repoRoot = options.repo ? path.resolve(options.repo) : outputRoot;
  initProject(outputRoot, options.out);
  const paths = getLunaObsPaths(outputRoot, options.out);
  const discovered = discoverSources(options.source, options.logs);
  fs.writeFileSync(path.join(paths.index, "discovered-sources.json"), `${JSON.stringify(discovered, null, 2)}\n`, "utf8");

  const sessions: NormalizedSession[] = [];
  const repoFilter = [];
  let eventsParsed = 0;
  let parseErrors = 0;
  let filesScanned = 0;

  for (const source of discovered) {
    for (const file of source.files) {
      const parsed = parseSessionFile(file, source.source);
      filesScanned += 1;
      eventsParsed += parsed.eventsParsed;
      parseErrors += parsed.parseErrors;
      const decision = applyRepoFilter(parsed.session, repoRoot, Boolean(options.allRepos));
      repoFilter.push(decision);
      sessions.push(parsed.session);
    }
  }

  const scores = sessions
    .filter((session) => session.repoMatch === "matched" || session.repoMatch === "ambiguous")
    .map((session) => scoreSession(session))
    .sort((a, b) => b.inefficiencyScore - a.inefficiencyScore);

  const summary: ScanSummary = {
    filesScanned,
    eventsParsed,
    parseErrors,
    generatedAt: new Date().toISOString()
  };

  fs.writeFileSync(path.join(paths.index, "repo-filter.json"), `${JSON.stringify(repoFilter, null, 2)}\n`, "utf8");
  writeJsonl(path.join(paths.index, "sessions.jsonl"), sessions);
  writeJsonl(
    path.join(paths.index, "session-metrics.jsonl"),
    sessions.map((session) => session.metrics)
  );
  writeJsonl(path.join(paths.index, "inefficiency-scores.jsonl"), scores);
  const reportPaths = writeScanReports(paths.reports, sessions, scores, summary, options.top);

  const included = sessions.filter((session) => session.repoMatch === "matched").length;
  const excluded = sessions.filter((session) => session.repoMatch === "excluded").length;
  const ambiguous = sessions.filter((session) => session.repoMatch === "ambiguous").length;
  console.log(
    [
      "Scan complete",
      "",
      `Files scanned: ${filesScanned}`,
      `Events parsed: ${eventsParsed}`,
      `Sessions found: ${sessions.length}`,
      `Included sessions: ${included}`,
      `Excluded sessions: ${excluded}`,
      `Ambiguous sessions: ${ambiguous}`,
      "",
      "Run:",
      "lunaobs inspect <sessionId>",
      "",
      scanTerminalSummary(scores)
    ].join("\n")
  );
  console.log(`Markdown report: ${reportPaths.markdownPath}`);
  console.log(`HTML report: ${reportPaths.htmlPath}`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function latestSession(sessions: NormalizedSession[]): NormalizedSession | undefined {
  const included = sessions.filter((session) => session.repoMatch === "matched");
  const candidates = included.length ? included : sessions;
  return [...candidates].sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
}

function inspectSession(root: string, sessionId: string, out = ".lunaobs"): void {
  const paths = getLunaObsPaths(root, out);
  const sessions = readJsonlObjects<NormalizedSession>(path.join(paths.index, "sessions.jsonl"));
  const session = sessionId === "latest" ? latestSession(sessions) : sessions.find((item) => item.sessionId === sessionId);
  if (!session) {
    console.error(sessionId === "latest" ? "No scanned sessions found." : `Session not found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  const report = generateInspectReport(session);
  const sessionReportDir = path.join(paths.reports, "sessions", sanitizePathSegment(session.sessionId));
  fs.mkdirSync(sessionReportDir, { recursive: true });
  const reportPath = path.join(sessionReportDir, "inspect.md");
  fs.writeFileSync(reportPath, report, "utf8");
  console.log(report);
  console.log(`Inspect report: ${reportPath}`);
}

function regenerateReport(root: string, out = ".lunaobs", top = 5): void {
  const paths = getLunaObsPaths(root, out);
  const sessions = readJsonlObjects<NormalizedSession>(path.join(paths.index, "sessions.jsonl"));
  const scores = readJsonlObjects<InefficiencyScore>(path.join(paths.index, "inefficiency-scores.jsonl"));
  const summary: ScanSummary = {
    filesScanned: new Set(sessions.flatMap((session) => session.sourceFiles)).size,
    eventsParsed: 0,
    parseErrors: sessions.reduce((sum, session) => sum + session.metrics.parseErrors, 0),
    generatedAt: new Date().toISOString()
  };
  const reportPaths = writeScanReports(paths.reports, sessions, scores, summary, top);
  console.log(`Markdown report: ${reportPaths.markdownPath}`);
  console.log(`HTML report: ${reportPaths.htmlPath}`);
}

function prepareDream(input: string, out: string, top = 5): void {
  const pack = prepareDreamPacket(input, top);
  const packetPath = writePreparedDreamPacket(pack, out);
  console.log(`Dream pack prepared with ${pack.selectedSessions.length} session(s): ${packetPath}`);
}

function validateDream(input: string, out?: string): void {
  const reportPath = writeDreamValidationReport(input, out);
  console.log(`Dream report: ${reportPath}`);
  console.log(`Dream HTML report: ${resolveDreamHtmlReportPath(input, out)}`);
}

const program = new Command();

program.name("lunaobs").description("Local-first observatory for coding-agent session traces.").version("0.1.0");

program
  .command("init")
  .description("Create .lunaobs output folders and install the canonical Dream skill scaffold.")
  .option("--out <path>", "output folder", ".lunaobs")
  .action((options: { out: string }) => {
    const root = detectRepoRoot();
    initProject(root, options.out);
    console.log(`Initialized LunaObs at ${path.join(root, options.out)}`);
  });

program
  .command("scan")
  .description("Discover native agent session logs, parse metrics, score sessions, and write a report.")
  .option("--source <source>", "copilot|codex|claude|all", sourceOption, "all")
  .option("--logs <path>", "log file or folder to scan")
  .option("--repo <path>", "repo root to filter against")
  .option("--all-repos", "disable repo filtering")
  .option("--out <path>", "output folder", ".lunaobs")
  .option("--top <number>", "number of top sessions in reports", numberOption, 5)
  .action((options: { source: RequestedSource; logs?: string; repo?: string; allRepos?: boolean; out: string; top: number }) => {
    scan(options);
  });

program
  .command("report")
  .description("Regenerate the markdown report from existing scan outputs.")
  .option("--out <path>", "output folder", ".lunaobs")
  .option("--top <number>", "number of top sessions in reports", numberOption, 5)
  .action((options: { out: string; top: number }) => {
    regenerateReport(detectRepoRoot(), options.out, options.top);
  });

program
  .command("inspect")
  .description("Print a readable breakdown for one scanned session.")
  .argument("<sessionId>", "session ID or latest")
  .option("--out <path>", "output folder", ".lunaobs")
  .action((sessionId: string, options: { out: string }) => {
    inspectSession(detectRepoRoot(), sessionId, options.out);
  });

const dream = program.command("dream").description("Prepare or validate Dream investigation artifacts.");

dream
  .command("prepare")
  .description("Create a frozen Dream packet from LunaObs scan output.")
  .option("--input <path>", "scan output folder or index folder", path.join(".lunaobs"))
  .option("--out <path>", "dream packet folder", path.join(".lunaobs", "dream"))
  .option("--top <number>", "representative sessions per group", numberOption, 5)
  .action((options: { input: string; out: string; top: number }) => {
    prepareDream(options.input, options.out, options.top);
  });

dream
  .command("validate")
  .description("Evaluate a prepared Dream packet and write a Markdown report.")
  .option("--input <path>", "dream packet folder or dream-pack.json", path.join(".lunaobs", "dream"))
  .option("--out <path>", "report Markdown path or output folder")
  .action((options: { input: string; out?: string }) => {
    validateDream(options.input, options.out);
  });

const skill = program.command("skill").description("Install LunaObs skills for supported coding agents.");

skill
  .command("install")
  .requiredOption("--agent <agent>", "codex|copilot|claude|all", agentOption)
  .action((options: { agent: SkillAgent }) => {
    const root = detectRepoRoot();
    const installed = installDreamSkill(root, options.agent);
    console.log(`Installed LunaObs Dream skill:\n${installed.map((dir) => `- ${dir}`).join("\n")}`);
  });

program.parse();
