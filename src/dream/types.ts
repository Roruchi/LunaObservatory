import type { SessionMetrics } from "../normalize/types.js";
import type { ReasonCode } from "../scoring/reasonCodes.js";

export type DreamSeverity = "info" | "low" | "medium" | "high" | "critical";
export type DreamConfidence = "low" | "medium" | "high";
export type DreamInstructionStatus = "followed" | "partially_followed" | "violated" | "unknown";
export type DreamSelectionRole = "efficient_success" | "inefficient_success" | "failed_or_risky";

export type DreamEvidenceRef = {
  id: string;
  sessionId?: string;
  sourceFile?: string;
  lineNumber?: number;
  eventId?: string;
  eventType?: string;
  fieldPath?: string;
  metric?: string;
  summary: string;
};

export type InstructionCheck = {
  text: string;
  status?: DreamInstructionStatus;
  evidenceRefs?: DreamEvidenceRef[];
};

export type IntentCheck = {
  requested?: string;
  observed?: string;
  status?: "matched" | "partial" | "missing" | "contradicted" | "unknown";
  evidenceRefs?: DreamEvidenceRef[];
};

export type ClaimCheck = {
  text: string;
  supported?: boolean;
  evidenceRefs?: DreamEvidenceRef[];
};

export type VerificationCheck = {
  command?: string;
  status: "passed" | "failed" | "missing" | "unknown";
  evidenceRefs?: DreamEvidenceRef[];
};

export type DreamSession = {
  sessionId: string;
  source: string;
  repoMatch?: string;
  sourceFiles: string[];
  role?: DreamSelectionRole;
  selectionReason?: string;
  classification?: string;
  inefficiencyScore?: number;
  outcomeScore?: number;
  reasonCodes: ReasonCode[];
  metrics: Partial<SessionMetrics>;
  declaredIntents: string[];
  userIntent?: string;
  intentCheck?: IntentCheck;
  instructionChecks: InstructionCheck[];
  finalAnswer?: string;
  finalClaims: ClaimCheck[];
  verificationChecks: VerificationCheck[];
  commands: string[];
  evidenceRefs: DreamEvidenceRef[];
  missingEvidence: string[];
};

export type DreamPacket = {
  schemaVersion: 1;
  generatedAt: string;
  sourceScanPaths: string[];
  evidenceBoundary: string;
  selectedSessions: DreamSession[];
  omittedSessions: Array<{
    sessionId: string;
    classification?: string;
    inefficiencyScore?: number;
    outcomeScore?: number;
  }>;
};

export type DreamScore = {
  category: "Intent adherence" | "Instruction adherence" | "Evidence grounding" | "Verification quality" | "Efficiency";
  score: number;
  confidence: DreamConfidence;
  rationale: string;
};

export type DreamFinding = {
  severity: DreamSeverity;
  category: string;
  title: string;
  explanation: string;
  evidenceRefs: DreamEvidenceRef[];
  confidence: DreamConfidence;
  suggestedImprovement: string;
};

export type DreamReport = {
  scores: DreamScore[];
  findings: DreamFinding[];
  ignoredInstructions: InstructionCheck[];
  unsupportedClaims: ClaimCheck[];
  missingEvidence: string[];
  markdown: string;
  html: string;
};
