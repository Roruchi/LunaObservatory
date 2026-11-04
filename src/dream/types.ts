import type { SessionLifecycleStatus, SessionMetrics, VerificationClosure } from "../normalize/types.js";
import type { ReasonCode } from "../scoring/reasonCodes.js";

export type DreamSeverity = "info" | "low" | "medium" | "high" | "critical";
export type DreamConfidence = "low" | "medium" | "high";
export type DreamInstructionStatus = "followed" | "partially_followed" | "violated" | "unknown";
export type DreamSelectionRole = "efficient_success" | "inefficient_success" | "failed_or_risky";
export type DreamChangeType =
  | "product_code"
  | "tests"
  | "documentation"
  | "repository_metadata"
  | "automation_memory"
  | "external_system"
  | "generated_asset"
  | "local_file_organization"
  | "read_only"
  | "unknown";
export type DreamVerificationType =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "document_build"
  | "read_back"
  | "persistence_check"
  | "external_confirmation"
  | "asset_inspection"
  | "filesystem_check"
  | "diff_check"
  | "unknown";
export type DreamFindingDisposition = "reliable" | "possible_false_positive" | "insufficient_evidence";
export type DreamApplyActionClass =
  | "safe_guidance_update"
  | "analyzer_improvement"
  | "repository_specific_investigation"
  | "no_action"
  | "human_review_required";

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
  lane?: string;
  verificationType?: DreamVerificationType;
  actionIndex?: number;
  target?: string;
  fresh?: boolean;
  status: "passed" | "failed" | "missing" | "unknown";
  evidenceRefs?: DreamEvidenceRef[];
};

export type DreamChangeClassification = {
  changeId: string;
  actionIndex: number;
  changeType: DreamChangeType;
  target?: string;
  stateChanging: boolean;
  verificationRequired: boolean | null;
  acceptableVerificationTypes: DreamVerificationType[];
  repositoryTestsRelevant: boolean;
  confidence: DreamConfidence;
  evidence: string[];
  evidenceRefs: DreamEvidenceRef[];
};

export type DreamTaskWindow = {
  taskId: string;
  label: string;
  intent?: string;
  startedAt?: string;
  endedAt?: string;
  segmentationConfidence: DreamConfidence;
  turnIds: string[];
  changes: DreamChangeClassification[];
  verificationChecks: VerificationCheck[];
  finalAnswer?: string;
  finalClaims: ClaimCheck[];
  evidenceRefs: DreamEvidenceRef[];
};

export type DreamSession = {
  sessionId: string;
  parentSessionId?: string;
  agentPath?: string;
  source: string;
  repoRoot?: string;
  repoMatch?: string;
  startedAt?: string;
  endedAt?: string;
  lifecycleStatus?: SessionLifecycleStatus;
  verificationClosure?: VerificationClosure;
  sourceFiles: string[];
  role?: DreamSelectionRole;
  selectionReason?: string;
  classification?: string;
  inefficiencyScore?: number | null;
  outcomeScore?: number | null;
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
  tasks?: DreamTaskWindow[];
};

export type DreamPacket = {
  schemaVersion: 1 | 2;
  generatedAt: string;
  sourceScanPaths: string[];
  evidenceBoundary: string;
  selectedSessions: DreamSession[];
  omittedSessions: Array<{
    sessionId: string;
    classification?: string;
    inefficiencyScore?: number | null;
    outcomeScore?: number | null;
  }>;
};

export type DreamScore = {
  category: "Intent adherence" | "Instruction adherence" | "Evidence grounding" | "Verification quality" | "Efficiency";
  score: number | null;
  confidence: DreamConfidence;
  rationale: string;
};

export type DreamFinding = {
  findingId: string;
  patternKey: string;
  sessionId?: string;
  taskId?: string;
  severity: DreamSeverity;
  category: string;
  title: string;
  disposition: DreamFindingDisposition;
  observation: string;
  interpretation: string;
  alternativeExplanation: string;
  recommendedAction: string;
  applyTarget: string;
  explanation: string;
  evidenceRefs: DreamEvidenceRef[];
  confidence: DreamConfidence;
  suggestedImprovement: string;
};

export type DreamApplyPlanFinding = {
  findingId: string;
  sessionId?: string;
  taskId?: string;
  changeType?: DreamChangeType;
  verificationRequired?: boolean | null;
  verificationObserved?: boolean;
  confidence: DreamConfidence;
  actionClass: DreamApplyActionClass;
  recommendedTarget: string;
  recommendedAction: string;
  evidenceRefs: DreamEvidenceRef[];
};

export type DreamApplyPlan = {
  schemaVersion: 1;
  generatedAt: string;
  sample: {
    selectedSessions: number;
    affectedSessions: number;
    affectedRepositories: number;
    representative: boolean;
    note: string;
  };
  findings: DreamApplyPlanFinding[];
};

export type DreamReport = {
  scores: DreamScore[];
  findings: DreamFinding[];
  ignoredInstructions: InstructionCheck[];
  unsupportedClaims: ClaimCheck[];
  missingEvidence: string[];
  overallConfidence: DreamConfidence;
  applyPlan: DreamApplyPlan;
  markdown: string;
  detailsMarkdown: string;
  html: string;
};
