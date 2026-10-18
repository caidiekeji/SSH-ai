// Typed Tauri IPC wrappers. The frontend collects user intent; every
// security decision happens on the Rust side (PRD §10.3).

import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  DiagnosisResult,
  ProviderProfile,
  ProviderSpec,
  RiskAssessment,
} from "./types";

export const ipc = {
  // ---- SSH ----
  sshConnect: (args: {
    host: string;
    port: number;
    username: string;
    auth: { kind: "password"; password: string } | { kind: "publickey"; key_path: string; passphrase: string | null };
    use_saved_password?: boolean;
    connection_id?: string;
  }) => invoke<{ sessionId: number }>("ssh_connect", { args }),

  sshDisconnect: (sessionId: number) => invoke<void>("ssh_disconnect", { sessionId }),

  terminalWrite: (sessionId: number, bytes: Uint8Array) => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const dataB64 = btoa(bin);
    return invoke<void>("terminal_write", { sessionId, dataB64 });
  },

  terminalResize: (sessionId: number, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),

  // ---- Connections ----
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (conn: ConnectionConfig, password: string | null) =>
    invoke<void>("save_connection", { conn, password }),
  deleteConnection: (connId: string) => invoke<void>("delete_connection", { connId }),
  hasSavedPassword: (connId: string) => invoke<boolean>("has_saved_password", { connId }),

  // ---- Known hosts ----
  listKnownHosts: () =>
    invoke<{ addr: string; algo: string; fingerprint: string; added_at: string }[]>("list_known_hosts"),
  removeKnownHost: (addr: string) => invoke<boolean>("remove_known_host", { addr }),
  hostKeyRespond: (addr: string, fingerprint: string, trust: boolean) =>
    invoke<void>("host_key_respond", { addr, fingerprint, trust }),

  // ---- Providers ----
  listProviderSpecs: () => invoke<ProviderSpec[]>("list_provider_specs"),
  listProfiles: () => invoke<ProviderProfile[]>("list_profiles"),
  saveProfile: (profile: ProviderProfile, apiKey: string | null) =>
    invoke<void>("save_profile", { profile, apiKey }),
  deleteProfile: (profileId: string) => invoke<void>("delete_profile", { profileId }),
  hasApiKey: (profileId: string) => invoke<boolean>("has_api_key", { profileId }),
  deleteApiKey: (profileId: string) => invoke<void>("delete_api_key", { profileId }),
  // ---- Unified credential center: SSH secrets (password / passphrase) ----
  deleteSavedPassword: (connId: string) => invoke<void>("delete_saved_password", { connId }),
  fetchModels: (profile: ProviderProfile, apiKey: string | null) =>
    invoke<{ id: string }[]>("fetch_models", { profile, apiKey }),
  testProvider: (profile: ProviderProfile, apiKey: string | null) =>
    invoke<{ ok: boolean; model: string; reply: string }>("test_provider", { profile, apiKey }),

  // ---- Safety ----
  assessRisk: (command: string, aiRiskHint: string) =>
    invoke<RiskAssessment>("assess_risk", { command, aiRiskHint }),
  prefillCommand: (args: {
    sessionId: number;
    command: string;
    aiRiskHint: string;
    userAck: RiskAssessment["level"];
  }) => invoke<RiskAssessment>("prefill_command", { args }),
  listWhitelist: () => invoke<string[]>("list_whitelist"),
  addWhitelist: (command: string) => invoke<void>("add_whitelist", { command }),
  removeWhitelist: (command: string) => invoke<void>("remove_whitelist", { command }),

  // ---- Diagnosis ----
  aiDiagnose: (sessionId: number, question: string) =>
    invoke<{ result: DiagnosisResult; provider: string; model: string }>("ai_diagnose", {
      sessionId,
      question,
    }),

  // ---- AI system prompt (global, optional) ----
  getSystemPrompt: () => invoke<string>("get_system_prompt"),
  setSystemPrompt: (prompt: string) => invoke<void>("set_system_prompt", { prompt }),
  getDiagnosisDepth: () => invoke<number>("get_diagnosis_depth"),
  setDiagnosisDepth: (depth: number) => invoke<void>("set_diagnosis_depth", { depth }),

  // ---- Server dashboard (user-initiated exec on a separate channel) ----
  execOneshot: (sessionId: number, command: string) =>
    invoke<string>("exec_oneshot", { sessionId, command }),

  // ---- Private key upload ----
  saveUploadedKey: (name: string, content: string) =>
    invoke<string>("save_uploaded_key", { name, content }),
};
