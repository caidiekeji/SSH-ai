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
