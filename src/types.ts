// Shared types mirroring the Rust backend (PRD §2/§3/§4/§5).

export type RiskLevel = "green" | "yellow" | "red";

export interface RiskAssessment {
  level: RiskLevel;
  rule: string;
  reason: string;
}

export interface ProviderSpec {
  id: string;
  display_name: string;
  family: "openai" | "anthropic";
  default_base_url: string;
  model_list_policy: "api" | "preset" | "manual";
  supports_stream: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  provider_id: string;
  base_url: string;
  model: string;
  model_source: string;
  created_at?: string;
}

export interface DiagnosisInfo {
  summary: string;
  confidence: string;
  root_cause: string;
}

export interface DiagnosisStep {
  description: string;
  command: string;
  risk_hint: string;
}

export interface DiagnosisResult {
  structured: boolean;
  diagnosis?: DiagnosisInfo;
  steps?: DiagnosisStep[];
  alternative?: string | null;
  raw?: string;
  incomplete?: boolean;
}

export interface DiagnosisCard {
  id: string;
  createdAt: number;
  question: string;
  provider: string;
  model: string;
  streaming: boolean;
  streamingText: string;
  result?: DiagnosisResult;
  error?: string;
  /** How many recent terminal output blocks were sent to the AI. */
  blocksSent?: number;
}

export interface ErrorBlockEvent {
  id: string;
  start_line: number;
  line_count: number;
  level: "red" | "yellow";
  rule: string;
  preview: string;
  end_line: number;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: "password" | "publickey";
  key_path?: string | null;
  group?: string;
}

// ---- State machines (PRD §2.2 / §2.3) ----

export type AiConfigState =
  | "S0_UNCONFIGURED"
  | "S1_KEY_ENTERED"
  | "S2_FETCHING_MODELS"
  | "S3_MODELS_READY"
  | "S3_MANUAL"
  | "S4_TESTING"
  | "S5_READY";

export type DiagState =
  | "T0_IDLE"
  | "T1_ANALYZING"
  | "T1_FAILED"
  | "T2_RESULT"
  | "T3_CONFIRM_YELLOW"
  | "T3_CONFIRM_RED"
  | "T4_PREFILLED"
  | "T5_EXECUTING";

// ---- Server dashboard / file manager ----

export interface ServerInfo {
  memTotal: number;
  memUsed: number;
  /** free -b available column (RAM available for new processes). */
  memAvailable: number;
  swapTotal: number;
  swapUsed: number;
  diskTotal: number;
  diskUsed: number;
  /** Computed rates between polls (bytes/s), 0 on first sample. */
  diskReadRate: number;
  diskWriteRate: number;
  netRxRate: number;
  netTxRate: number;
  load1: number;
  load5: number;
  cores: number;
  /** Seconds since boot (raw /proc/uptime value). */
  uptimeSec: number;
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: string;
}

export type ThemeName = "dark" | "light" | "ocean" | "forest" | "sakura";

// ---- Agent automation: Plan / Policy / Verify / State ----

/**
 * One executed step, as reported by the backend controller.
 *
 * The backend owns the run; the frontend renders this verbatim.
 */
export interface AgentStepRecord {
  no: number;
  command: string;
  description: string;
  output: string;
  risk: string;
  kind: "exec" | "verify" | "pty";
  /** Verifier verdict for this step (undefined = not asserted). */
  verified?: boolean;
  /** Why the assertions failed. */
  verifyFailures?: string[];
  /** Process exit code observed for this step. */
  exitCode?: number | null;
}

/** The approval the backend is blocked on. */
export interface AgentApproval {
  command: string;
  description: string;
  level: string;
  /** Full payload for a pty write (never truncated). */
  fullText?: string;
  /** Host the command will run on — the approval must say WHERE. */
  host?: string;
}

/** Structured work memory fed back to the planner on every step. */
export interface AgentMemory {
  /** Live cwd of the agent's own shell. */
  cwd: string;
  /** Facts confirmed by a passing assertion. */
  facts: string[];
  /** Hypotheses that were ruled out (with the reason). */
  hypotheses: string[];
  /** Attempts that failed (command + why). */
  failedAttempts: string[];
}

/** Lifecycle state of a backend-side agent run. */
export type AgentRunStatus = "running" | "waiting" | "done" | "failed" | "stopped";

/**
 * The full state of a run, as pushed by the backend.
 *
 * The controller runs in the Rust backend, so this snapshot survives a
 * window reload — the UI reattaches to it instead of restarting the task.
 */
export interface AgentRunSnapshot {
  runId: number;
  sessionId: number;
  goal: string;
  status: AgentRunStatus;
  plan?: AgentPlan | null;
  steps: AgentStepRecord[];
  memory: AgentMemory;
  error: string;
  notice: string;
  approval?: AgentApproval | null;
  /**
   * Tokens consumed so far, when the provider reports usage. The call
   * count alone does not say what a task cost.
   */
  usage?: AgentUsage | null;
}

/** Token accounting for one task. */
export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
}

/** The event payload the backend emits on every state change. */
export interface AgentEvent {
  runId: number;
  sessionId: number;
  snapshot: AgentRunSnapshot;
}

/** Machine-checkable expectation for one plan step (all present fields must hold). */
export interface ExpectSpec {
  exitCode?: number | null;
  contains?: string[];
  notContains?: string[];
  regex?: string | null;
}

export interface PlanStep {
  id: number;
  intent: string;
  command: string;
  expect: ExpectSpec;
  riskHint: string;
  dependsOn: number[];
  /**
   * Acceptance criterion. "Task done" requires EVERY required step's
   * assertions to pass — a step that merely succeeded is not proof that the
   * goal was achieved.
   */
  required?: boolean;
}

export interface AgentPlan {
  steps: PlanStep[];
}

/** Verifier verdict — decided by Rust, never by the model. */
export interface VerifyOutcome {
  passed: boolean;
  failures: string[];
  checked: number;
}

/** Authorization scope for write operations. */
export type AgentPolicy = "readonly" | "plan" | "step";

/** One executed step fed back to the model (kind/expectation included). */
export interface AgentStepHistory {
  command: string;
  output: string;
  kind: string;
  description: string;
  expect: string;
  verified?: boolean | null;
  exitCode?: number | null;
  /** Why the assertions failed — fed back so the model can fix the ASSERTION. */
  failures?: string[];
}
