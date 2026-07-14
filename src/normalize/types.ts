import type { SourceName } from "../sources/types.js";

export type RawLogEvent = {
  id: string;
  parentId?: string;
  type: string;
  timestamp: string;
  data: unknown;
  sourceFile: string;
  lineNumber: number;
};

export type EvidenceRef = {
  sourceFile: string;
  lineNumber: number;
  eventId?: string;
  eventType: string;
  fieldPath?: string;
  summary: string;
};

export type MetricValue = {
  value: number | null;
  source: "reported" | "derived" | "estimated" | "unavailable";
};

export type NormalizedTextEvidence = {
  text: string;
  evidence?: EvidenceRef[];
};

export type NormalizedInstructionEvidence = NormalizedTextEvidence & {
  role: "system" | "developer" | "user";
};

export type NormalizedSession = {
  sessionId: string;
  source: SourceName;
  sourceFiles: string[];
  repoRoot?: string;
  repoMatch: "matched" | "excluded" | "ambiguous" | "unknown";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  interactions: string[];
  turns: NormalizedTurn[];
  userIntent?: NormalizedTextEvidence;
  instructions?: NormalizedInstructionEvidence[];
  finalAnswer?: NormalizedTextEvidence;
  finalClaims?: NormalizedTextEvidence[];
  metrics: SessionMetrics;
  evidence?: EvidenceRef[];
};

export type NormalizedTurn = {
  interactionId?: string;
  turnId: string;
  startedAt?: string;
  endedAt?: string;
  assistantMessages: NormalizedAssistantMessage[];
  toolCalls: NormalizedToolCall[];
  hooks: NormalizedHookInvocation[];
};

export type NormalizedAssistantMessage = {
  messageId?: string;
  tokenScope?: "message" | "session";
  model?: string;
  contentLength: number;
  hasContent: boolean;
  hasEncryptedContent: boolean;
  hasOpaqueReasoning: boolean;
  inputTokens?: MetricValue;
  outputTokens: MetricValue;
  cachedTokens?: MetricValue;
  requestId?: string;
  serviceRequestId?: string;
  toolRequestIds: string[];
  evidence?: EvidenceRef[];
};

export type NormalizedToolCall = {
  toolCallId: string;
  name: string;
  arguments?: unknown;
  intentionSummary?: string;
  requestedAt?: string;
  executionStartedAt?: string;
  executionEndedAt?: string;
  status: "requested" | "started" | "completed" | "failed" | "unknown";
  evidence?: EvidenceRef[];
};

export type NormalizedHookInvocation = {
  hookInvocationId: string;
  hookType: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  success?: boolean;
  cwd?: string;
  toolCallIds: string[];
  evidence?: EvidenceRef[];
};

export type SessionMetrics = {
  sessionId: string;
  turns: number;
  assistantMessages: number;
  models: Record<string, number>;
  inputTokens: MetricValue;
  outputTokens: MetricValue;
  cachedTokens: MetricValue;
  aiCredits: MetricValue;
  estimatedCost: MetricValue;
  toolRequests: number;
  toolExecutionsStarted: number;
  toolExecutionsCompleted: number;
  toolExecutionsFailed: number;
  toolCallsByName: Record<string, number>;
  hookInvocations: number;
  hookFailures: number;
  totalHookLatencyMs: number;
  filesViewed: number;
  uniqueFilesViewed: number;
  repeatedFileViews: number;
  globCalls: number;
  searchCalls: number;
  editCalls: number;
  commandCalls: number;
  failedCommands: number;
  verificationEvents: number;
  verificationPassed: number;
  verificationFailed: number;
  declaredIntents: string[];
  changedFiles: MetricValue;
  changedLines: MetricValue;
  parseErrors: number;
};

export type SessionClassification =
  | "efficient"
  | "expensive_but_justified"
  | "suspicious"
  | "inefficient"
  | "unknown";
