import fs from "node:fs";
import path from "node:path";
import { readJsonlObjects } from "../fs/jsonl.js";
import type { EvidenceRef, NormalizedSession, NormalizedTextEvidence, NormalizedToolCall } from "../normalize/types.js";
import { scoreSession, type InefficiencyScore } from "../scoring/score.js";
import type { ClaimCheck, DreamEvidenceRef, DreamPacket, DreamSelectionRole, DreamSession, InstructionCheck, VerificationCheck } from "./types.js";

type LoadedScan = {
  sourceScanPath: string;
  sessions: NormalizedSession[];
  scores: InefficiencyScore[];
};

function asArrayInput(input: string | string[]): string[] {
  return Array.isArray(input)
    ? input
    : input
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveIndexDir(scanPath: string): string {
  const resolved = path.resolve(scanPath);
  if (fs.statSync(resolved).isFile()) return path.dirname(resolved);
  if (fs.existsSync(path.join(resolved, "sessions.jsonl"))) return resolved;
  if (fs.existsSync(path.join(resolved, "index", "sessions.jsonl"))) return path.join(resolved, "index");
  throw new Error(`No LunaObs scan index found at ${scanPath}`);
}

export function loadScanPacket(scanPath: string): LoadedScan {
  const indexDir = resolveIndexDir(scanPath);
  const sessions = readJsonlObjects<NormalizedSession>(path.join(indexDir, "sessions.jsonl"));
  const scorePath = path.join(indexDir, "inefficiency-scores.jsonl");
  const existingScores = readJsonlObjects<InefficiencyScore>(scorePath);
  const scoreById = new Map(existingScores.map((score) => [score.sessionId, score]));
  const scores = sessions.map((session) => scoreById.get(session.sessionId) ?? scoreSession(session));
  return {
    sourceScanPath: path.dirname(indexDir),
    sessions,
    scores
  };
}

function evidenceId(sessionId: string, suffix: string): string {
  return `${sessionId}:${suffix.replace(/[^a-zA-Z0-9._:-]/g, "_")}`;
}

function fromEvidenceRef(sessionId: string, ref: EvidenceRef, index: number): DreamEvidenceRef {
  return {
    id: evidenceId(sessionId, `event:${ref.eventId ?? "line"}:${index}`),
    sessionId,
    sourceFile: ref.sourceFile,
    lineNumber: ref.lineNumber,
    eventId: ref.eventId,
    eventType: ref.eventType,
    fieldPath: ref.fieldPath,
    summary: ref.summary
  };
}

function fromEvidenceList(sessionId: string, refs?: EvidenceRef[]): DreamEvidenceRef[] {
  return (refs ?? []).map((ref, index) => fromEvidenceRef(sessionId, ref, index));
}

function metricEvidence(sessionId: string, metric: string, value: unknown): DreamEvidenceRef {
  const normalized = typeof value === "object" && value !== null && "value" in value ? (value as { value: unknown }).value : value;
  return {
    id: evidenceId(sessionId, `metric:${metric}`),
    sessionId,
    metric,
    summary: `${metric}=${normalized ?? "unavailable"}`
  };
}

function metricNumber(session: NormalizedSession, key: keyof NormalizedSession["metrics"]): number {
  const raw = session.metrics[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function collectEvidence(session: NormalizedSession): DreamEvidenceRef[] {
  const refs: DreamEvidenceRef[] = [];
  let index = 0;
  for (const ref of session.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
  for (const ref of session.userIntent?.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
  for (const instruction of session.instructions ?? []) {
    for (const ref of instruction.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
  }
  for (const ref of session.finalAnswer?.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
  for (const claim of session.finalClaims ?? []) {
    for (const ref of claim.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
  }
  for (const turn of session.turns) {
    for (const message of turn.assistantMessages) {
      for (const ref of message.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
    }
    for (const tool of turn.toolCalls) {
      for (const ref of tool.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
    }
    for (const hook of turn.hooks) {
      for (const ref of hook.evidence ?? []) refs.push(fromEvidenceRef(session.sessionId, ref, index++));
    }
  }

  refs.push(metricEvidence(session.sessionId, "turns", session.metrics.turns));
  refs.push(metricEvidence(session.sessionId, "toolRequests", session.metrics.toolRequests));
  refs.push(metricEvidence(session.sessionId, "editCalls", session.metrics.editCalls));
  refs.push(metricEvidence(session.sessionId, "failedCommands", session.metrics.failedCommands));
  refs.push(metricEvidence(session.sessionId, "verificationEvents", session.metrics.verificationEvents));
  refs.push(metricEvidence(session.sessionId, "verificationFailed", session.metrics.verificationFailed));
  refs.push(metricEvidence(session.sessionId, "repeatedFileViews", session.metrics.repeatedFileViews));
  refs.push(metricEvidence(session.sessionId, "globCalls", session.metrics.globCalls));
  return refs;
}

function toolCommand(tool: NormalizedToolCall): string | undefined {
  if (!/command|shell|terminal|exec|run/i.test(tool.name)) return undefined;
  const args = tool.arguments;
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return tool.name;
  const command = (args as Record<string, unknown>).command;
  if (typeof command === "string") return command;
  return JSON.stringify(args);
}

function textOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function looksLikeVerificationTool(tool: NormalizedToolCall): boolean {
  if (tool.name === "report_intent") return false;
  const command = toolCommand(tool) ?? textOf(tool.arguments);
  const haystack = `${tool.name} ${command}`.toLowerCase();
  if (/\b(test|vitest|pytest|jest|cargo test|go test|npm run build|tsc|lint|validate|check)\b/.test(haystack)) return true;
  if (/\baddons[\\/]+gut\b|\bgut_cmdln\.gd\b|\bgodot\b.*\b--headless\b|\btools[\\/]+godot\.ps1\b/i.test(command)) return true;
  return false;
}

function collectCommands(session: NormalizedSession): string[] {
  return session.turns.flatMap((turn) => turn.toolCalls.map(toolCommand).filter((command): command is string => Boolean(command)));
}

function verificationChecksFor(session: NormalizedSession): VerificationCheck[] {
  return session.turns.flatMap((turn) =>
    turn.toolCalls
      .filter(looksLikeVerificationTool)
      .map((tool) => ({
        command: toolCommand(tool) ?? tool.name,
        status: tool.status === "failed" ? "failed" : tool.status === "completed" ? "passed" : "unknown",
        evidenceRefs: fromEvidenceList(session.sessionId, tool.evidence)
      }))
  );
}

function missingEvidenceFor(session: NormalizedSession): string[] {
  const missing: string[] = [];
  if (!session.userIntent?.text && !session.metrics.declaredIntents.length) {
    missing.push("original user intent was not captured in the frozen scan evidence");
  }
  if (!session.finalAnswer?.text) missing.push("final assistant answer text was not captured in the frozen scan evidence");
  if (!session.instructions?.length) missing.push("explicit user/developer instruction text was not captured in the frozen scan evidence");
  if (!session.metrics.verificationEvents) missing.push("verification evidence is absent or incomplete");
  return missing;
}

function instructionChecksFor(session: NormalizedSession): InstructionCheck[] {
  return (session.instructions ?? []).map((instruction) => ({
    text: instruction.text,
    status: "unknown",
    evidenceRefs: fromEvidenceList(session.sessionId, instruction.evidence)
  }));
}

function inferClaimSupport(session: NormalizedSession, claim: NormalizedTextEvidence): boolean | undefined {
  const text = claim.text.toLowerCase();
  const verificationEvents = metricNumber(session, "verificationEvents");
  const verificationFailed = metricNumber(session, "verificationFailed");
  const verificationPassed = metricNumber(session, "verificationPassed");
  const editCalls = metricNumber(session, "editCalls");
  const verificationClaim = /\b(test|tests|build|lint|validated|verified|verification|passed)\b/.test(text);
  if (verificationClaim) {
    const universalPassClaim = /\b(all tests passed|all checks passed|full .*passed|0 failed|no failures|no errors?)\b/.test(text);
    if (verificationEvents === 0) return false;
    if (verificationFailed === 0 && verificationPassed > 0) return true;
    if (universalPassClaim && verificationFailed > 0) return false;
    if (verificationFailed > 0 && verificationPassed === 0) return false;
    return undefined;
  }

  const changeClaim = /\b(added|captured|changed|completed|created|documented|fixed|implemented|removed|updated|wired)\b/.test(text);
  if (changeClaim && editCalls === 0) return false;
  return undefined;
}

function claimEvidenceRefs(session: NormalizedSession, claim: NormalizedTextEvidence, supported: boolean | undefined): DreamEvidenceRef[] {
  const refs = fromEvidenceList(session.sessionId, claim.evidence);
  const text = claim.text.toLowerCase();
  if (/\b(test|tests|build|lint|validated|verified|verification|passed)\b/.test(text)) {
    refs.push(metricEvidence(session.sessionId, "verificationEvents", session.metrics.verificationEvents));
    refs.push(metricEvidence(session.sessionId, "verificationFailed", session.metrics.verificationFailed));
  }
  if (supported === false && /\b(added|captured|changed|completed|created|documented|fixed|implemented|removed|updated|wired)\b/.test(text)) {
    refs.push(metricEvidence(session.sessionId, "editCalls", session.metrics.editCalls));
  }
  return refs;
}

function finalClaimsFor(session: NormalizedSession): ClaimCheck[] {
  return (session.finalClaims ?? []).map((claim) => {
    const supported = inferClaimSupport(session, claim);
    return {
      text: claim.text,
      supported,
      evidenceRefs: claimEvidenceRefs(session, claim, supported)
    };
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeDreamSession(
  session: NormalizedSession,
  score: InefficiencyScore,
  role: DreamSelectionRole,
  selectionReason: string
): DreamSession {
  const existing = session as NormalizedSession & Partial<Pick<DreamSession, "intentCheck" | "instructionChecks" | "verificationChecks">>;
  const legacyDreamFields = session as unknown as Partial<Pick<DreamSession, "userIntent" | "finalAnswer">>;
  return {
    sessionId: session.sessionId,
    source: session.source,
    repoMatch: session.repoMatch,
    sourceFiles: session.sourceFiles,
    role,
    selectionReason,
    classification: score.classification,
    inefficiencyScore: score.inefficiencyScore,
    outcomeScore: score.outcomeScore,
    reasonCodes: score.reasonCodes,
    metrics: session.metrics,
    declaredIntents: session.metrics.declaredIntents,
    userIntent: stringField(legacyDreamFields.userIntent) ?? session.userIntent?.text ?? session.metrics.declaredIntents[0],
    intentCheck: existing.intentCheck,
    instructionChecks: existing.instructionChecks ?? instructionChecksFor(session),
    finalAnswer: stringField(legacyDreamFields.finalAnswer) ?? session.finalAnswer?.text,
    finalClaims: finalClaimsFor(session),
    verificationChecks: existing.verificationChecks ?? verificationChecksFor(session),
    commands: collectCommands(session),
    evidenceRefs: collectEvidence(session),
    missingEvidence: missingEvidenceFor(session)
  };
}

function roleSelections(scores: InefficiencyScore[], perGroupLimit: number): Array<{ score: InefficiencyScore; role: DreamSelectionRole; reason: string }> {
  const selected: Array<{ score: InefficiencyScore; role: DreamSelectionRole; reason: string }> = [];

  const efficient = [...scores]
    .filter((score) => ["efficient", "expensive_but_justified"].includes(score.classification) && score.outcomeScore >= 70)
    .sort((a, b) => b.outcomeScore - a.outcomeScore || a.inefficiencyScore - b.inefficiencyScore)
    .slice(0, perGroupLimit);

  const inefficientSuccess = [...scores]
    .filter((score) => ["suspicious", "inefficient"].includes(score.classification) && score.outcomeScore >= 60)
    .sort((a, b) => b.inefficiencyScore - a.inefficiencyScore)
    .slice(0, perGroupLimit);

  const failedOrRisky = [...scores]
    .filter(
      (score) =>
        score.outcomeScore < 60 ||
        score.reasonCodes.some((reason) => ["FAILED_COMMAND_LOOP", "MISSING_VERIFICATION", "HOOK_FAILURES"].includes(reason)) ||
        score.metrics.verificationFailed > 0
    )
    .sort((a, b) => b.inefficiencyScore - a.inefficiencyScore || a.outcomeScore - b.outcomeScore)
    .slice(0, perGroupLimit);

  for (const score of efficient) selected.push({ score, role: "efficient_success", reason: "efficient successful representative" });
  for (const score of inefficientSuccess) selected.push({ score, role: "inefficient_success", reason: "inefficient successful representative" });
  for (const score of failedOrRisky) selected.push({ score, role: "failed_or_risky", reason: "failed or risky representative" });

  if (!selected.length) {
    selected.push(
      ...[...scores]
        .sort((a, b) => b.inefficiencyScore - a.inefficiencyScore)
        .slice(0, perGroupLimit)
        .map((score) => ({ score, role: "failed_or_risky" as const, reason: "fallback representative" }))
    );
  }

  const deduped = new Map<string, { score: InefficiencyScore; role: DreamSelectionRole; reason: string }>();
  for (const item of selected) {
    if (!deduped.has(item.score.sessionId)) deduped.set(item.score.sessionId, item);
  }
  return [...deduped.values()];
}

export function selectDreamSessions(scores: InefficiencyScore[], top = 5): InefficiencyScore[] {
  return roleSelections(scores, top).map((item) => item.score);
}

export function prepareDreamPacket(scanInputs: string | string[], top = 5): DreamPacket {
  const loaded = asArrayInput(scanInputs).flatMap((input) => loadScanPacket(input));
  const sessions = loaded.flatMap((scan) => scan.sessions);
  const scores = loaded.flatMap((scan) => scan.scores);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const selections = roleSelections(scores, top);
  const selectedIds = new Set(selections.map((selection) => selection.score.sessionId));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceScanPaths: loaded.map((scan) => scan.sourceScanPath),
    evidenceBoundary:
      "Dream mode evaluates only frozen scan evidence included in this prepared dream evidence set. Validation must not inspect the live repository, git history, or external tools.",
    selectedSessions: selections
      .map((selection) => {
        const session = sessionById.get(selection.score.sessionId);
        return session ? normalizeDreamSession(session, selection.score, selection.role, selection.reason) : undefined;
      })
      .filter((session): session is DreamSession => Boolean(session)),
    omittedSessions: scores
      .filter((score) => !selectedIds.has(score.sessionId))
      .map((score) => ({
        sessionId: score.sessionId,
        classification: score.classification,
        inefficiencyScore: score.inefficiencyScore,
        outcomeScore: score.outcomeScore
      }))
  };
}

function packetSummaryLines(packet: DreamPacket): string[] {
  return [
    "# LunaObs Dream Pack",
    "",
    `Generated at: ${packet.generatedAt}`,
    "",
    "## Evidence boundary",
    "",
    packet.evidenceBoundary,
    "",
    "## Selected sessions",
    "",
    ...(packet.selectedSessions.length
      ? packet.selectedSessions.map(
          (session, index) =>
            `${index + 1}. ${session.sessionId} - ${session.role}, ${session.classification ?? "unknown"}, score ${
              session.inefficiencyScore ?? "unknown"
            }, reasons: ${session.reasonCodes.join(", ") || "none"}`
        )
      : ["No sessions selected."]),
    ""
  ];
}

function dreamTaskLines(): string[] {
  return [
    "# LunaObs Dream Task",
    "",
    "Evaluate only the frozen evidence in `dream-pack.json`.",
    "",
    "Do not inspect the live repository, run git, read source files outside the prepared dream evidence, run tests, or call external tools to fill evidence gaps.",
    "The prepared dream evidence is the source of truth. Missing fields must become missing-evidence notes or low-confidence observations.",
    "",
    "Required workflow:",
    "",
    "1. Run `lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md`.",
    "2. Read the generated Markdown report.",
    "3. Summarize strongest findings, ignored instructions, unsupported claims, verification gaps, efficiency lessons, recommendations, and missing evidence.",
    ""
  ];
}

export function writePreparedDreamPacket(packet: DreamPacket, outDir: string): string {
  const dreamDir = path.resolve(outDir);
  fs.mkdirSync(path.join(dreamDir, "output"), { recursive: true });
  const packetPath = path.join(dreamDir, "dream-pack.json");
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(dreamDir, "dream-pack.md"), packetSummaryLines(packet).join("\n"), "utf8");
  fs.writeFileSync(path.join(dreamDir, "DREAM_TASK.md"), dreamTaskLines().join("\n"), "utf8");
  return packetPath;
}
