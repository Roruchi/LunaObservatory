import type { SourceName } from "../sources/types.js";
import { stableId } from "../utils/stableId.js";
import { durationMs, maxIso, minIso } from "../utils/time.js";
import { calculateMetrics, reported, unavailable } from "./metrics.js";
import type {
  EvidenceRef,
  NormalizedAssistantMessage,
  NormalizedHookInvocation,
  NormalizedInstructionEvidence,
  NormalizedSession,
  NormalizedTextEvidence,
  NormalizedToolCall,
  NormalizedTurn,
  RawLogEvent
} from "./types.js";

type MessageRole = "system" | "developer" | "user" | "assistant";

type MutableTurn = NormalizedTurn & {
  toolMap: Map<string, NormalizedToolCall>;
  hookMap: Map<string, NormalizedHookInvocation>;
};

function objectData(event: RawLogEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
}

function nestedObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function modelUsageTotals(data: Record<string, unknown>): { inputTokens?: number; outputTokens?: number; cachedTokens?: number } {
  const modelMetrics = nestedObject(data.modelMetrics);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let hasInputTokens = false;
  let hasOutputTokens = false;
  let hasCachedTokens = false;

  if (modelMetrics) {
    for (const metric of Object.values(modelMetrics)) {
      const usage = nestedObject(nestedObject(metric)?.usage);
      const input = numberValue(usage?.inputTokens);
      const output = numberValue(usage?.outputTokens);
      const cacheRead = numberValue(usage?.cacheReadTokens);
      const cacheWrite = numberValue(usage?.cacheWriteTokens);
      if (input !== undefined) {
        inputTokens += input;
        hasInputTokens = true;
      }
      if (output !== undefined) {
        outputTokens += output;
        hasOutputTokens = true;
      }
      if (cacheRead !== undefined || cacheWrite !== undefined) {
        cachedTokens += (cacheRead ?? 0) + (cacheWrite ?? 0);
        hasCachedTokens = true;
      }
    }
  }

  const tokenDetails = nestedObject(data.tokenDetails);
  if (!hasInputTokens) {
    const input = numberValue(nestedObject(tokenDetails?.input)?.tokenCount);
    if (input !== undefined) {
      inputTokens = input;
      hasInputTokens = true;
    }
  }
  if (!hasOutputTokens) {
    const output = numberValue(nestedObject(tokenDetails?.output)?.tokenCount);
    if (output !== undefined) {
      outputTokens = output;
      hasOutputTokens = true;
    }
  }
  if (!hasCachedTokens) {
    const cacheRead = numberValue(nestedObject(tokenDetails?.cache_read)?.tokenCount);
    const cacheWrite = numberValue(nestedObject(tokenDetails?.cache_write)?.tokenCount);
    if (cacheRead !== undefined || cacheWrite !== undefined) {
      cachedTokens = (cacheRead ?? 0) + (cacheWrite ?? 0);
      hasCachedTokens = true;
    }
  }

  return {
    inputTokens: hasInputTokens ? inputTokens : undefined,
    outputTokens: hasOutputTokens ? outputTokens : undefined,
    cachedTokens: hasCachedTokens ? cachedTokens : undefined
  };
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function getTurn(turns: Map<string, MutableTurn>, turnId: string, interactionId?: string): MutableTurn {
  const existing = turns.get(turnId);
  if (existing) {
    if (!existing.interactionId && interactionId) existing.interactionId = interactionId;
    return existing;
  }
  const turn: MutableTurn = {
    turnId,
    interactionId,
    assistantMessages: [],
    toolCalls: [],
    hooks: [],
    toolMap: new Map(),
    hookMap: new Map()
  };
  turns.set(turnId, turn);
  return turn;
}

function findTurnByToolCall(turns: Map<string, MutableTurn>, toolCallIds: string[]): MutableTurn | undefined {
  for (const turn of turns.values()) {
    if (toolCallIds.some((toolCallId) => turn.toolMap.has(toolCallId))) return turn;
  }
  return undefined;
}

function touchTurnTime(turn: MutableTurn, timestamp: string): void {
  turn.startedAt = minIso([turn.startedAt, timestamp]);
  turn.endedAt = maxIso([turn.endedAt, timestamp]);
}

function addOrUpdateTool(turn: MutableTurn, tool: NormalizedToolCall): NormalizedToolCall {
  const existing = turn.toolMap.get(tool.toolCallId);
  if (existing) {
    Object.assign(existing, {
      ...tool,
      arguments: tool.arguments ?? existing.arguments,
      evidence: [...(existing.evidence ?? []), ...(tool.evidence ?? [])]
    });
    return existing;
  }
  turn.toolMap.set(tool.toolCallId, tool);
  turn.toolCalls.push(tool);
  return tool;
}

function evidence(event: RawLogEvent, fieldPath: string | undefined, summary: string): EvidenceRef {
  return {
    sourceFile: event.sourceFile,
    lineNumber: event.lineNumber,
    eventId: event.id,
    eventType: event.type,
    fieldPath,
    summary
  };
}

function firstPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  for (const key of ["path", "file", "filePath", "uri"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractSessionId(events: RawLogEvent[], sourceFile: string): string {
  for (const event of events) {
    const data = objectData(event);
    const input = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : undefined;
    const sessionId = stringValue(input?.sessionId) ?? stringValue(data.sessionId) ?? stringValue(data.session_id) ?? stringValue(data.id);
    if (sessionId) return sessionId;
  }
  return stableId(sourceFile);
}

function codexTurnId(data: Record<string, unknown>): string | undefined {
  const passthrough = nestedObject(data.internal_chat_message_metadata_passthrough);
  return stringValue(passthrough?.turn_id) ?? stringValue(data.turn_id) ?? stringValue(data.turnId);
}

function textContentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    const item = nestedObject(part);
    const text = stringValue(item?.text) ?? stringValue(item?.message);
    return sum + (text?.length ?? 0);
  }, 0);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = nestedObject(part);
      return stringValue(item?.text) ?? stringValue(item?.message) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clipText(text: string, maxLength: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function excerpt(text: string, maxLength = 120): string {
  return clipText(text.replace(/\s+/g, " "), maxLength);
}

function roleValue(value: unknown): MessageRole | undefined {
  if (value === "system" || value === "developer" || value === "user" || value === "assistant") return value;
  return undefined;
}

function stripBlock(text: string, tagName: string): string {
  return text.replace(new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, "gi"), "").trim();
}

function stripContextBlocks(text: string): string {
  return [
    "environment_context",
    "permissions instructions",
    "app-context",
    "apps_instructions",
    "skills_instructions",
    "plugins_instructions",
    "collaboration_mode"
  ].reduce((current, tag) => stripBlock(current, tag), text);
}

function isContextOnlyUserMessage(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  const withoutBlocks = normalizeText(stripContextBlocks(normalized));
  if (!withoutBlocks) return true;
  if (/^# AGENTS\.md instructions\b/i.test(withoutBlocks)) return true;
  if (/^<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/i.test(withoutBlocks)) return true;
  if (/^### Available skills\b/i.test(withoutBlocks)) return true;
  if (withoutBlocks.includes("### Available skills") && withoutBlocks.includes("### How to use skills")) return true;
  return false;
}

function extractUserIntentText(text: string): string {
  const withoutBlocks = normalizeText(stripContextBlocks(text));
  const requestMarker = /##\s*My request for Codex:\s*/i.exec(withoutBlocks);
  if (requestMarker) {
    return clipText(withoutBlocks.slice(requestMarker.index + requestMarker[0].length), 2400);
  }
  return clipText(withoutBlocks, 2400);
}

function instructionSnippets(text: string): string[] {
  const lines = normalizeText(text)
    .split(/\n+/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .filter(Boolean);
  const pattern =
    /\b(approval policy|avoid|do not|don't|forbidden|important|must|must not|never|only|preserve|required|should|should not|verify|verification|without)\b/i;
  const snippets: string[] = [];
  for (const line of lines) {
    if (snippets.length >= 8) break;
    if (line.length < 8 || line.length > 420) continue;
    if (!pattern.test(line)) continue;
    const clipped = clipText(line, 260);
    if (!snippets.includes(clipped)) snippets.push(clipped);
  }
  return snippets;
}

function addInstructionSnippets(
  instructions: NormalizedInstructionEvidence[],
  role: "system" | "developer" | "user",
  text: string,
  event: RawLogEvent
): void {
  if (instructions.length >= 24) return;
  for (const snippet of instructionSnippets(text)) {
    if (instructions.length >= 24) return;
    const exists = instructions.some((instruction) => instruction.role === role && instruction.text === snippet);
    if (exists) continue;
    instructions.push({
      role,
      text: snippet,
      evidence: [evidence(event, "data.content", `captured ${role} instruction: ${excerpt(snippet)}`)]
    });
  }
}

function finalClaimTexts(finalAnswer: string): string[] {
  const withoutCode = finalAnswer.replace(/```[\s\S]*?```/g, " ");
  const lineParts = withoutCode.split(/\n+/);
  const sentenceParts = withoutCode.split(/(?<=[.!?])\s+/);
  const claimPattern =
    /\b(added|built|captured|changed|committed|completed|created|documented|done|fixed|implemented|passed|pushed|ran|removed|tested|updated|validated|verified|wired)\b/i;
  const claims: string[] = [];
  for (const part of [...lineParts, ...sentenceParts]) {
    if (claims.length >= 8) break;
    const normalized = normalizeText(part.replace(/^[-*#>\s]+/, "").replace(/\*\*/g, ""));
    if (normalized.length < 8) continue;
    if (/^(changed|result|resultaat|tests?|validation|verificatie|verified|what changed):?$/i.test(normalized)) continue;
    if (/^if you want\b/i.test(normalized)) continue;
    if (!claimPattern.test(normalized)) continue;
    const clipped = clipText(normalized, 260);
    if (!claims.includes(clipped)) claims.push(clipped);
  }
  return claims;
}

function addSyntheticCwdHook(turn: MutableTurn, event: RawLogEvent, cwd?: string): void {
  if (!cwd) return;
  const hookInvocationId = `context:${turn.turnId}`;
  if (turn.hookMap.has(hookInvocationId)) return;
  const hook: NormalizedHookInvocation = {
    hookInvocationId,
    hookType: "context",
    startedAt: event.timestamp,
    endedAt: event.timestamp,
    durationMs: 0,
    success: true,
    cwd,
    toolCallIds: [],
    evidence: [evidence(event, "data.cwd", `cwd=${cwd}`)]
  };
  turn.hookMap.set(hookInvocationId, hook);
  turn.hooks.push(hook);
}

export function normalizeEventsToSession(
  events: RawLogEvent[],
  source: SourceName,
  sourceFile: string,
  parseErrors = 0
): NormalizedSession {
  const turns = new Map<string, MutableTurn>();
  const sessionId = extractSessionId(events, sourceFile);
  const interactions = new Set<string>();
  const turnModels = new Map<string, string>();
  const instructions: NormalizedInstructionEvidence[] = [];
  let userIntent: NormalizedTextEvidence | undefined;
  let finalAnswer: NormalizedTextEvidence | undefined;
  let currentTurnId = "unknown";

  for (const event of events) {
    const data = objectData(event);
    const turnId = codexTurnId(data) ?? stringValue(data.turnId) ?? currentTurnId;
    const interactionId = stringValue(data.interactionId);
    if (interactionId) interactions.add(interactionId);

    if (event.type === "session_meta") {
      const metaTurnId = stringValue(data.id) ?? currentTurnId;
      currentTurnId = metaTurnId;
      const turn = getTurn(turns, metaTurnId);
      touchTurnTime(turn, event.timestamp);
      addSyntheticCwdHook(turn, event, stringValue(data.cwd));
      const model = stringValue(data.model);
      if (model) turnModels.set(metaTurnId, model);
      continue;
    }

    if (event.type === "turn_context") {
      const contextTurnId = stringValue(data.turn_id) ?? turnId;
      currentTurnId = contextTurnId;
      const turn = getTurn(turns, contextTurnId);
      touchTurnTime(turn, event.timestamp);
      addSyntheticCwdHook(turn, event, stringValue(data.cwd));
      const model = stringValue(data.model);
      if (model) turnModels.set(contextTurnId, model);
      continue;
    }

    if (event.type === "session.shutdown") {
      const usage = modelUsageTotals(data);
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.cachedTokens !== undefined) {
        const shutdownTurnId = turnId === "unknown" ? "session-shutdown" : turnId;
        const turn = getTurn(turns, shutdownTurnId);
        touchTurnTime(turn, event.timestamp);
        turn.assistantMessages.push({
          messageId: event.id,
          tokenScope: "session",
          model: stringValue(data.currentModel),
          contentLength: 0,
          hasContent: false,
          hasEncryptedContent: false,
          hasOpaqueReasoning: false,
          inputTokens: usage.inputTokens === undefined ? unavailable() : reported(usage.inputTokens),
          outputTokens: usage.outputTokens === undefined ? unavailable() : reported(usage.outputTokens),
          cachedTokens: usage.cachedTokens === undefined ? unavailable() : reported(usage.cachedTokens),
          toolRequestIds: [],
          evidence: [
            ...(usage.inputTokens === undefined ? [] : [evidence(event, "data.modelMetrics.*.usage.inputTokens", `inputTokens=${usage.inputTokens}`)]),
            ...(usage.outputTokens === undefined ? [] : [evidence(event, "data.modelMetrics.*.usage.outputTokens", `outputTokens=${usage.outputTokens}`)]),
            ...(usage.cachedTokens === undefined ? [] : [evidence(event, "data.modelMetrics.*.usage.cacheReadTokens", `cachedTokens=${usage.cachedTokens}`)])
          ]
        });
      }
      continue;
    }

    if (event.type === "event_msg") {
      const eventType = stringValue(data.type);
      const eventTurnId = stringValue(data.turn_id) ?? turnId;
      const turn = getTurn(turns, eventTurnId);
      if (eventTurnId !== "unknown") currentTurnId = eventTurnId;
      touchTurnTime(turn, event.timestamp);

      if (eventType === "agent_message") {
        const content = stringValue(data.message) ?? "";
        if (content.trim()) {
          const text = clipText(content, 2400);
          finalAnswer = {
            text,
            evidence: [evidence(event, "data.message", `captured final assistant answer: ${excerpt(text)}`)]
          };
        }
        turn.assistantMessages.push({
          messageId: event.id,
          model: turnModels.get(eventTurnId),
          contentLength: content.length,
          hasContent: content.length > 0,
          hasEncryptedContent: false,
          hasOpaqueReasoning: false,
          outputTokens: unavailable(),
          toolRequestIds: [],
          evidence: turnModels.get(eventTurnId)
            ? [evidence(event, "data.model", `model=${turnModels.get(eventTurnId)}`)]
            : undefined
        });
      }

      if (eventType === "token_count") {
        const info = nestedObject(data.info);
        const lastUsage = nestedObject(info?.last_token_usage);
        const inputTokens = numberValue(lastUsage?.input_tokens);
        const outputTokens = numberValue(lastUsage?.output_tokens);
        const cachedTokens = numberValue(lastUsage?.cached_input_tokens);
        if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined) {
          turn.assistantMessages.push({
            messageId: `${event.id}:token_count`,
            contentLength: 0,
            hasContent: false,
            hasEncryptedContent: false,
            hasOpaqueReasoning: false,
            inputTokens: inputTokens === undefined ? unavailable() : reported(inputTokens),
            outputTokens: outputTokens === undefined ? unavailable() : reported(outputTokens),
            cachedTokens: cachedTokens === undefined ? unavailable() : reported(cachedTokens),
            toolRequestIds: [],
            evidence: [
              ...(inputTokens === undefined ? [] : [evidence(event, "data.info.last_token_usage.input_tokens", `inputTokens=${inputTokens}`)]),
              ...(outputTokens === undefined ? [] : [evidence(event, "data.info.last_token_usage.output_tokens", `outputTokens=${outputTokens}`)]),
              ...(cachedTokens === undefined ? [] : [evidence(event, "data.info.last_token_usage.cached_input_tokens", `cachedTokens=${cachedTokens}`)])
            ]
          });
        }
      }
      continue;
    }

    if (event.type === "response_item") {
      const responseTurnId = codexTurnId(data) ?? turnId;
      const turn = getTurn(turns, responseTurnId);
      if (responseTurnId !== "unknown") currentTurnId = responseTurnId;
      touchTurnTime(turn, event.timestamp);
      const payloadType = stringValue(data.type);

      if (payloadType === "message") {
        const role = roleValue(data.role);
        const contentText = extractTextContent(data.content);

        if ((role === "system" || role === "developer" || role === "user") && contentText.trim()) {
          addInstructionSnippets(instructions, role, contentText, event);
        }

        if (role === "user" && !userIntent && !isContextOnlyUserMessage(contentText)) {
          const intentText = extractUserIntentText(contentText);
          if (intentText) {
            userIntent = {
              text: intentText,
              evidence: [evidence(event, "data.content", `captured original user intent: ${excerpt(intentText)}`)]
            };
          }
        }

        if (role === "assistant") {
          const contentLength = textContentLength(data.content);
          const text = clipText(contentText, 2400);
          if (text) {
            finalAnswer = {
              text,
              evidence: [evidence(event, "data.content", `captured final assistant answer: ${excerpt(text)}`)]
            };
          }
          turn.assistantMessages.push({
            messageId: stringValue(data.id) ?? event.id,
            model: turnModels.get(responseTurnId),
            contentLength,
            hasContent: contentLength > 0,
            hasEncryptedContent: false,
            hasOpaqueReasoning: false,
            outputTokens: unavailable(),
            toolRequestIds: [],
            evidence: turnModels.get(responseTurnId)
              ? [evidence(event, "data.model", `model=${turnModels.get(responseTurnId)}`)]
              : undefined
          });
        }
      } else if (payloadType === "reasoning") {
        turn.assistantMessages.push({
          messageId: stringValue(data.id) ?? event.id,
          model: turnModels.get(responseTurnId),
          contentLength: 0,
          hasContent: false,
          hasEncryptedContent: Boolean(data.encrypted_content),
          hasOpaqueReasoning: Boolean(data.encrypted_content),
          outputTokens: unavailable(),
          toolRequestIds: []
        });
      } else if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "tool_search_call") {
        const toolCallId = stringValue(data.call_id) ?? stringValue(data.id);
        if (toolCallId) {
          const parsedArgs = parseArgs(data.arguments ?? data.input);
          const toolName = stringValue(data.name) ?? "unknown";
          const pathArg = firstPathArg(parsedArgs);
          addOrUpdateTool(turn, {
            toolCallId,
            name: toolName,
            arguments: parsedArgs,
            requestedAt: event.timestamp,
            executionStartedAt: event.timestamp,
            status: "started",
            evidence: [
              evidence(event, "data.name", `tool=${toolName}`),
              ...(pathArg ? [evidence(event, "data.arguments.path", `${toolName} path=${pathArg}`)] : [])
            ]
          });
        }
      } else if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output" ||
        payloadType === "tool_search_output"
      ) {
        const toolCallId = stringValue(data.call_id);
        if (toolCallId) {
          const toolTurn = findTurnByToolCall(turns, [toolCallId]) ?? turn;
          const output = stringValue(data.output) ?? "";
          const failed = /Exit code:\s*(?!0\b)\d+/i.test(output);
          touchTurnTime(toolTurn, event.timestamp);
          addOrUpdateTool(toolTurn, {
            toolCallId,
            name: toolTurn.toolMap.get(toolCallId)?.name ?? "unknown",
            executionEndedAt: event.timestamp,
            status: failed ? "failed" : "completed",
            evidence: output
              ? [evidence(event, "data.output", `${failed ? "failed" : "completed"} output: ${excerpt(output, 220)}`)]
              : undefined
          });
        }
      }
      continue;
    }

    if (event.type === "assistant.turn_start") {
      const turn = getTurn(turns, turnId, interactionId);
      currentTurnId = turnId;
      touchTurnTime(turn, event.timestamp);
      continue;
    }

    if (event.type === "assistant.message") {
      const turn = getTurn(turns, turnId, interactionId);
      touchTurnTime(turn, event.timestamp);
      const toolRequests = Array.isArray(data.toolRequests) ? (data.toolRequests as Array<Record<string, unknown>>) : [];
      const outputTokens = numberValue(data.outputTokens);
      const model = stringValue(data.model);
      const message: NormalizedAssistantMessage = {
        messageId: stringValue(data.messageId),
        model,
        contentLength: typeof data.content === "string" ? data.content.length : 0,
        hasContent: typeof data.content === "string" && data.content.length > 0,
        hasEncryptedContent: Boolean(data.encryptedContent),
        hasOpaqueReasoning: Boolean(data.reasoningOpaque),
        outputTokens: outputTokens === undefined ? unavailable() : reported(outputTokens),
        requestId: stringValue(data.requestId),
        serviceRequestId: stringValue(data.serviceRequestId),
        toolRequestIds: toolRequests.map((request) => stringValue(request.toolCallId) ?? "").filter(Boolean),
        evidence: [
          ...(model ? [evidence(event, "data.model", `model=${model}`)] : []),
          ...(outputTokens === undefined ? [] : [evidence(event, "data.outputTokens", `outputTokens=${outputTokens}`)]),
          evidence(event, "data.toolRequests", `toolRequests.length=${toolRequests.length}`)
        ]
      };
      turn.assistantMessages.push(message);
      for (const request of toolRequests) {
        const toolCallId = stringValue(request.toolCallId) ?? stringValue(request.id);
        if (!toolCallId) continue;
        const toolName = stringValue(request.name) ?? "unknown";
        const pathArg = firstPathArg(request.arguments);
        const intent =
          toolName === "report_intent" && request.arguments && typeof request.arguments === "object"
            ? stringValue((request.arguments as Record<string, unknown>).intent) ??
              stringValue((request.arguments as Record<string, unknown>).summary)
            : undefined;
        addOrUpdateTool(turn, {
          toolCallId,
          name: toolName,
          arguments: request.arguments,
          intentionSummary: stringValue(request.intentionSummary),
          requestedAt: event.timestamp,
          status: "requested",
          evidence: [
            evidence(event, "data.toolRequests", `tool=${toolName}`),
            ...(pathArg ? [evidence(event, "data.toolRequests.arguments.path", `${toolName} path=${pathArg}`)] : []),
            ...(intent ? [evidence(event, "data.toolRequests.arguments.intent", `intent=${intent}`)] : [])
          ]
        });
      }
      continue;
    }

    if (event.type === "tool.execution_start") {
      const toolCallId = stringValue(data.toolCallId);
      if (!toolCallId) continue;
      const turn = getTurn(turns, turnId);
      touchTurnTime(turn, event.timestamp);
      const toolName = stringValue(data.toolName) ?? "unknown";
      const pathArg = firstPathArg(data.arguments);
      addOrUpdateTool(turn, {
        toolCallId,
        name: toolName,
        arguments: data.arguments,
        executionStartedAt: event.timestamp,
        status: "started",
        evidence: [
          evidence(event, "data.toolName", `tool=${toolName}`),
          ...(pathArg ? [evidence(event, "data.arguments.path", `${toolName} path=${pathArg}`)] : [])
        ]
      });
      continue;
    }

    if (event.type === "tool.execution_end" || event.type === "tool.execution_complete") {
      const toolCallId = stringValue(data.toolCallId);
      if (!toolCallId) continue;
      const turn = findTurnByToolCall(turns, [toolCallId]) ?? getTurn(turns, turnId);
      touchTurnTime(turn, event.timestamp);
      const status = stringValue(data.status)?.toLowerCase();
      const failed = data.success === false || status === "failed" || status === "error" || status === "cancelled";
      const existingArguments = turn.toolMap.get(toolCallId)?.arguments;
      const completionArguments =
        event.type === "tool.execution_complete" && data.result !== undefined
          ? { arguments: existingArguments, result: data.result }
          : existingArguments;
      addOrUpdateTool(turn, {
        toolCallId,
        name: stringValue(data.toolName) ?? turn.toolMap.get(toolCallId)?.name ?? "unknown",
        arguments: completionArguments,
        executionEndedAt: event.timestamp,
        status: failed ? "failed" : "completed"
      });
      continue;
    }

    if (event.type === "hook.start") {
      const input = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {};
      const toolCalls = Array.isArray(input.toolCalls) ? (input.toolCalls as Array<Record<string, unknown>>) : [];
      const toolCallIds = toolCalls.map((call) => stringValue(call.id) ?? "").filter(Boolean);
      const hookTurnId = stringValue(data.turnId) ?? stringValue(toolCalls[0]?.turnId) ?? turnId;
      const turn = findTurnByToolCall(turns, toolCallIds) ?? getTurn(turns, hookTurnId);
      touchTurnTime(turn, event.timestamp);
      const hookInvocationId = stringValue(data.hookInvocationId);
      if (!hookInvocationId) continue;
      const hook: NormalizedHookInvocation = {
        hookInvocationId,
        hookType: stringValue(data.hookType) ?? "unknown",
        startedAt: event.timestamp,
        cwd: stringValue(input.cwd),
        toolCallIds,
        evidence: [
          evidence(event, "data.hookInvocationId", `hook.start=${hookInvocationId}`),
          ...(stringValue(input.cwd) ? [evidence(event, "data.input.cwd", `cwd=${stringValue(input.cwd)}`)] : [])
        ]
      };
      turn.hookMap.set(hookInvocationId, hook);
      turn.hooks.push(hook);
      for (const call of toolCalls) {
        const toolCallId = stringValue(call.id);
        if (!toolCallId) continue;
        const parsedArgs = parseArgs(call.args);
        const toolName = stringValue(call.name) ?? "unknown";
        const pathArg = firstPathArg(parsedArgs);
        addOrUpdateTool(turn, {
          toolCallId,
          name: toolName,
          arguments: parsedArgs,
          status: "unknown",
          evidence: [
            evidence(event, "data.input.toolCalls", `tool=${toolName}`),
            ...(pathArg ? [evidence(event, "data.input.toolCalls.args.path", `${toolName} path=${pathArg}`)] : [])
          ]
        });
      }
      continue;
    }

    if (event.type === "hook.end") {
      const hookInvocationId = stringValue(data.hookInvocationId);
      if (!hookInvocationId) continue;
      for (const turn of turns.values()) {
        const hook = turn.hookMap.get(hookInvocationId);
        if (!hook) continue;
        hook.endedAt = event.timestamp;
        hook.success = typeof data.success === "boolean" ? data.success : undefined;
        hook.durationMs = durationMs(hook.startedAt, hook.endedAt);
        hook.evidence = [...(hook.evidence ?? []), evidence(event, "data.hookInvocationId", `hook.end=${hookInvocationId}`)];
        touchTurnTime(turn, event.timestamp);
        break;
      }
    }
  }

  const normalizedTurns = [...turns.values()]
    .map(({ toolMap: _toolMap, hookMap: _hookMap, ...turn }) => turn)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const finalClaims = finalAnswer
    ? finalClaimTexts(finalAnswer.text).map((text) => ({
        text,
        evidence: finalAnswer?.evidence?.map((ref) => ({ ...ref, summary: `captured final-answer claim: ${excerpt(text)}` }))
      }))
    : [];

  const sessionBase = {
    sessionId,
    source,
    sourceFiles: [sourceFile],
    repoMatch: "unknown" as const,
    startedAt: minIso(events.map((event) => event.timestamp)),
    endedAt: maxIso(events.map((event) => event.timestamp)),
    interactions: [...interactions].sort(),
    turns: normalizedTurns,
    ...(userIntent ? { userIntent } : {}),
    ...(instructions.length ? { instructions } : {}),
    ...(finalAnswer ? { finalAnswer } : {}),
    ...(finalClaims.length ? { finalClaims } : {})
  };
  const session: NormalizedSession = {
    ...sessionBase,
    durationMs: durationMs(sessionBase.startedAt, sessionBase.endedAt),
    metrics: calculateMetrics(sessionBase, parseErrors)
  };
  return session;
}
