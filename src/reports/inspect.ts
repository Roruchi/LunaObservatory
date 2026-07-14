import type { EvidenceRef, MetricValue, NormalizedHookInvocation, NormalizedSession, NormalizedToolCall } from "../normalize/types.js";
import { scoreSession } from "../scoring/score.js";

function metric(value: MetricValue): string {
  return value.source === "unavailable" || value.value === null ? "unavailable" : `${value.value} ${value.source}`;
}

function duration(value?: number): string {
  if (value === undefined) return "unavailable";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function at(ref: EvidenceRef): string {
  return `${ref.sourceFile}:${ref.lineNumber}`;
}

function evidenceLine(label: string, ref: EvidenceRef, summary?: string): string {
  return `- ${label}: ${summary ?? ref.summary} at ${at(ref)}`;
}

function firstEvidence(refs: EvidenceRef[] | undefined, predicate: (ref: EvidenceRef) => boolean): EvidenceRef | undefined {
  return refs?.find(predicate);
}

function pathArg(tool: NormalizedToolCall): string | undefined {
  const args = tool.arguments;
  if (!args || typeof args !== "object") return undefined;
  for (const key of ["path", "file", "filePath", "uri"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function repoMatchLine(session: NormalizedSession): string {
  const repoEvidence = session.evidence?.find((ref) => ref.summary.startsWith("matched via hook cwd:"));
  if (repoEvidence) return repoEvidence.summary;
  if (session.repoMatch === "matched") return "matched";
  if (session.repoMatch === "excluded") return "excluded";
  if (session.repoMatch === "ambiguous") return "ambiguous";
  return "unknown";
}

function hookLatencyEvidence(hook: NormalizedHookInvocation): string | undefined {
  const start = hook.evidence?.find((ref) => ref.eventType === "hook.start");
  const end = hook.evidence?.find((ref) => ref.eventType === "hook.end");
  if (!start || !end) return undefined;
  return `- hook latency: hook.start ${start.lineNumber} to hook.end ${end.lineNumber}`;
}

function inspectEvidence(session: NormalizedSession): string[] {
  const lines: string[] = [];
  for (const turn of session.turns) {
    for (const message of turn.assistantMessages) {
      const model = firstEvidence(message.evidence, (ref) => ref.fieldPath === "data.model");
      if (model) lines.push(evidenceLine("model", model, `${model.eventType} ${model.fieldPath}=${message.model}`));
      const output = firstEvidence(message.evidence, (ref) => ref.fieldPath?.endsWith("outputTokens") === true || ref.fieldPath?.endsWith("output_tokens") === true);
      if (output && message.outputTokens.value !== null) {
        lines.push(evidenceLine("output tokens", output, `${output.eventType} ${output.fieldPath}=${message.outputTokens.value}`));
      }
      const toolRequests = firstEvidence(message.evidence, (ref) => ref.fieldPath === "data.toolRequests");
      if (toolRequests) lines.push(evidenceLine("tool requests", toolRequests, `${toolRequests.eventType} ${toolRequests.summary}`));
    }

    for (const hook of turn.hooks) {
      const hookEvidence = hookLatencyEvidence(hook);
      if (hookEvidence) lines.push(hookEvidence);
    }

    for (const tool of turn.toolCalls) {
      if (tool.name === "view") {
        const viewedPath = pathArg(tool);
        const ref = firstEvidence(tool.evidence, (item) => item.summary.startsWith("view path=")) ?? tool.evidence?.[0];
        if (viewedPath && ref) lines.push(evidenceLine("file view", ref, `view path=${viewedPath}`));
      }
      if (tool.name === "report_intent") {
        const intentRef = firstEvidence(tool.evidence, (item) => item.summary.startsWith("intent="));
        if (intentRef) lines.push(evidenceLine("declared intent", intentRef, intentRef.summary));
      }
    }
  }

  const repoEvidence = session.evidence?.find((ref) => ref.summary.startsWith("matched via hook cwd:"));
  if (repoEvidence) lines.push(evidenceLine("repo match cwd", repoEvidence, repoEvidence.summary));
  return lines;
}

function modelLines(session: NormalizedSession): string[] {
  const entries = Object.entries(session.metrics.models);
  return entries.length ? entries.map(([model, count]) => `  - ${model}: ${count}`) : ["  - unavailable"];
}

function toolLines(session: NormalizedSession): string[] {
  const entries = Object.entries(session.metrics.toolCallsByName);
  return entries.length ? entries.map(([name, count]) => `- ${name}: ${count}`) : ["- unavailable"];
}

function declaredIntentLines(session: NormalizedSession): string[] {
  return session.metrics.declaredIntents.length ? session.metrics.declaredIntents.map((intent) => `- ${intent}`) : ["- unavailable"];
}

function privacyLines(session: NormalizedSession): string[] {
  const hasEncryptedContent = session.turns.some((turn) => turn.assistantMessages.some((message) => message.hasEncryptedContent));
  const hasOpaqueReasoning = session.turns.some((turn) => turn.assistantMessages.some((message) => message.hasOpaqueReasoning));
  if (!hasEncryptedContent && !hasOpaqueReasoning) return [];
  return ["", "Privacy:", `- hasEncryptedContent: ${hasEncryptedContent}`, `- hasOpaqueReasoning: ${hasOpaqueReasoning}`];
}

export function generateInspectReport(session: NormalizedSession): string {
  const metrics = session.metrics;
  const score = scoreSession(session);
  const evidence = inspectEvidence(session);
  const lines = [
    "LunaObs Session Inspect",
    "",
    `Session: ${session.sessionId}`,
    "Source files:",
    ...session.sourceFiles.map((file) => `- ${file}`),
    "",
    "Repo match:",
    `- ${repoMatchLine(session)}`,
    "",
    "Timeline:",
    `- started: ${session.startedAt ?? "unavailable"}`,
    `- ended: ${session.endedAt ?? "unavailable"}`,
    `- duration: ${duration(session.durationMs)}`,
    "",
    "Metrics:",
    `- turns: ${metrics.turns}`,
    `- assistant messages: ${metrics.assistantMessages}`,
    "- models:",
    ...modelLines(session),
    `- output tokens: ${metric(metrics.outputTokens)}`,
    `- input tokens: ${metric(metrics.inputTokens)}`,
    `- cached tokens: ${metric(metrics.cachedTokens)}`,
    `- AI credits: ${metric(metrics.aiCredits)}`,
    `- tool requests: ${metrics.toolRequests}`,
    `- tool executions started: ${metrics.toolExecutionsStarted}`,
    `- hooks: ${metrics.hookInvocations}`,
    `- hook failures: ${metrics.hookFailures}`,
    `- hook latency: ${metrics.totalHookLatencyMs}ms`,
    `- files viewed: ${metrics.filesViewed}`,
    `- unique files viewed: ${metrics.uniqueFilesViewed}`,
    `- repeated file views: ${metrics.repeatedFileViews}`,
    `- glob calls: ${metrics.globCalls}`,
    `- edit calls: ${metrics.editCalls}`,
    `- verification events: ${metrics.verificationEvents}`,
    ...privacyLines(session),
    "",
    "Declared intents:",
    ...declaredIntentLines(session),
    "",
    "Tools:",
    ...toolLines(session),
    "",
    "Reason codes:",
    ...(score.reasonCodes.length ? score.reasonCodes.map((reason) => `- ${reason}`) : ["- unavailable"]),
    "",
    "Evidence:",
    ...(evidence.length ? evidence : ["- unavailable"]),
    ""
  ];
  return lines.join("\n");
}
