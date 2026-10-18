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
  diskTotal: number;
  diskUsed: number;
  load1: number;
  load5: number;
  cores: number;
  uptime: string;
}

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: string;
}

export type ThemeName = "dark" | "light" | "ocean" | "forest" | "sakura";
