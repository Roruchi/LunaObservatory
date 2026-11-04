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

export type SessionLifecycleStatus = "completed" | "in_progress" | "aborted" | "unknown";
export type VerificationClosure = "passed" | "failed" | "missing" | "not_applicable";

export type NormalizedSession = {
  /** Native metadata only; absence is unknown. Never inferred from tool output. */
  attribution?: {
    branches: string[];
    worktreePaths: string[];
    firstInstruction?: NormalizedTextEvidence;
    isSidechain?: boolean;
    agentId?: string;
    notes?: string[];
    inheritedEvents?: number;
    unresolvedInheritedEvents?: number | null;
    historyCoverage?: "complete" | "partial";
    usageCoverage?: "complete" | "partial";
    unknowns: string[];
  };
  sessionId: string;
  nativeSessionId?: string | null;
  parentSessionId?: string;
  agentPath?: string;
  source: SourceName;
  sourceFiles: string[];
  repoRoot?: string;
  repoMatch: "matched" | "excluded" | "ambiguous" | "unknown";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  lifecycleStatus: SessionLifecycleStatus;
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
  lifecycleStatus?: SessionLifecycleStatus;
  userMessages?: NormalizedTextEvidence[];
  assistantMessages: NormalizedAssistantMessage[];
  toolCalls: NormalizedToolCall[];
  hooks: NormalizedHookInvocation[];
};

export type NormalizedAssistantMessage = {
  cacheCreationTokens?: MetricValue;
  messageId?: string;
  kind?: "text" | "reasoning" | "token_usage" | "unknown";
  text?: string;
  contentFingerprint?: string;
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
  exitCode?: number;
  toolCallId: string;
  name: string;
  arguments?: unknown;
  intentionSummary?: string;
  requestedAt?: string;
  executionStartedAt?: string;
  executionEndedAt?: string;
  outputText?: string;
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
  reasoningItems: number;
  tokenSamples: number;
  modelRequests: number;
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
  editAttempts: number;
  editCalls: number;
  commandCalls: number;
  failedCommands: number;
  failedCommandRate: number;
  repeatedFailedCommandAttempts: number;
  sameMistakeRetryRate: number;
  verificationEvents: number;
  verificationPassed: number;
  verificationFailed: number;
  verificationPassRate: number;
  verificationClosure: VerificationClosure;
  taskStarts: number;
  taskCompletions: number;
  taskCompletionRate: number;
  toolRequestsPerTask: number;
  outputTokensPerTask: MetricValue;
  duplicateToolCalls: number;
  redundantToolCallRate: number;
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
