//! Application state: sessions, profiles, connections, whitelist.
//! Secrets live ONLY in the OS keychain (HC-02). JSON files hold
//! non-sensitive configuration only.

use crate::provider::ProviderProfile;
use crate::safety::risk::RiskEngine;
use crate::ssh::session::Session;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "publickey"
    pub auth_method: String,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Optional group label for the session list (e.g. "生产环境").
    #[serde(default)]
    pub group: String,
}

/// One named prompt in the prompt library. A prompt can target the
/// diagnosis mode, the chat mode, or both; all prompts enabled for a mode
/// are joined as that mode's custom directive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEntry {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub for_diag: bool,
    #[serde(default)]
    pub for_chat: bool,
    #[serde(default)]
    pub for_agent: bool,
}

/// Global app settings (non-sensitive). `prompts` is the prompt library;
/// `system_prompt`/`prompt_for_*` are legacy fields kept only to migrate the
/// pre-library single prompt on first read. `diagnosis_depth`: how many
/// recent command-output blocks one-click diagnosis feeds to the AI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default = "default_diagnosis_depth")]
    pub diagnosis_depth: u32,
    #[serde(default = "default_true")]
    pub prompt_for_diag: bool,
    #[serde(default = "default_true")]
    pub prompt_for_chat: bool,
    #[serde(default)]
    pub prompts: Vec<PromptEntry>,
    /// Agent mode: auto-execute green (low-risk) commands without approval.
    #[serde(default = "default_true")]
    pub agent_auto_green: bool,
    /// Agent mode: per-command exec timeout in seconds (5..=300).
    #[serde(default = "default_agent_exec_timeout")]
    pub agent_exec_timeout: u64,
    /// MCP server (for external IDEs): enable flag, bind port, bearer token.
    #[serde(default)]
    pub mcp_enabled: bool,
    #[serde(default = "default_mcp_port")]
    pub mcp_port: u16,
    #[serde(default)]
    pub mcp_token: String,
}

fn default_diagnosis_depth() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

fn default_agent_exec_timeout() -> u64 {
    60
}

fn default_mcp_port() -> u16 {
    8615
}

pub struct AppState {
    pub app: tauri::AppHandle,
    pub data_dir: PathBuf,
    pub known_hosts_path: PathBuf,
    pub sessions: Mutex<HashMap<u64, Session>>,
    next_session_id: AtomicU64,
    pub profiles: Mutex<Vec<ProviderProfile>>,
    pub connections: Mutex<Vec<ConnectionConfig>>,
    pub whitelist_file: PathBuf,
    pub risk: RiskEngine,
    /// Pending TOFU decision: the russh handler parks here while the UI asks
    /// the user to trust an unknown host key. Resolved by host_key_respond.
    pub pending_hostkey: tokio::sync::Mutex<Option<PendingHostKey>>,
    pub settings: Mutex<AppSettings>,
}

pub struct PendingHostKey {
    pub addr: String,
    pub fingerprint: String,
    pub tx: tokio::sync::oneshot::Sender<bool>,
}

impl AppState {
    pub fn new(app: tauri::AppHandle, data_dir: PathBuf) -> Self {
        let known_hosts_path = data_dir.join("known_hosts.json");
        let whitelist_file = data_dir.join("command_whitelist.json");
        let profiles = load_json_or(&data_dir.join("profiles.json"), Vec::new());
        let connections = load_json_or(&data_dir.join("connections.json"), Vec::new());
        let settings = load_json_or(&data_dir.join("settings.json"), AppSettings::default());

        // Load user whitelist into the risk engine.
        let risk = RiskEngine::default();
        let wl_list: Vec<String> = load_json_or(&whitelist_file, Vec::new());
        *risk.whitelist.lock().unwrap_or_else(|e| e.into_inner()) = wl_list;

        Self {
            app,
            data_dir,
            known_hosts_path,
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            profiles: Mutex::new(profiles),
            connections: Mutex::new(connections),
            whitelist_file,
            risk,
            pending_hostkey: tokio::sync::Mutex::new(None),
            settings: Mutex::new(settings),
        }
    }

    pub fn next_session(&self) -> u64 {
        self.next_session_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn save_profiles(&self) -> Result<(), String> {
        let profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.data_dir.join("profiles.json"), &*profiles)
    }

    pub fn save_connections(&self) -> Result<(), String> {
        let conns = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.data_dir.join("connections.json"), &*conns)
    }

    pub fn save_whitelist(&self) -> Result<(), String> {
        let wl = self.risk.whitelist.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.whitelist_file, &*wl)
    }

    pub fn save_settings(&self) -> Result<(), String> {
        let settings = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.data_dir.join("settings.json"), &*settings)
    }

    /// Trimmed custom system prompt; empty string means "use default only".
    pub fn system_prompt(&self) -> String {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.system_prompt.trim().to_string()
    }

    /// Number of recent output blocks diagnosis sends to the AI (1..=10).
    pub fn diagnosis_depth(&self) -> u32 {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.diagnosis_depth.clamp(1, 10)
    }

    /// Custom prompt for diagnosis mode: all library prompts enabled for
    /// 诊断 joined (None when empty). Legacy single prompt is migrated by
    /// the list_prompts command, so this only reads the library.
    pub fn diag_prompt(&self) -> Option<String> {
        Self::join_prompts(&self.settings.lock().unwrap_or_else(|e| e.into_inner()).prompts, true)
    }

    /// Custom prompt for chat mode (same join rule, 对话 flag).
    pub fn chat_prompt(&self) -> Option<String> {
        Self::join_prompts(&self.settings.lock().unwrap_or_else(|e| e.into_inner()).prompts, false)
    }

    /// Custom style directive for Agent mode (joined onto the built-in
    /// agent schema prompt as 用户偏好; the JSON schema stays authoritative).
    pub fn agent_prompt(&self) -> Option<String> {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner());
        let joined: Vec<&str> = s
            .prompts
            .iter()
            .filter(|p| p.for_agent)
            .map(|p| p.content.trim())
            .filter(|c| !c.is_empty())
            .collect();
        if joined.is_empty() {
            None
        } else {
            Some(joined.join("\n\n").chars().take(1000).collect())
        }
    }

    fn join_prompts(prompts: &[PromptEntry], for_diag: bool) -> Option<String> {
        let joined: Vec<&str> = prompts
            .iter()
            .filter(|p| if for_diag { p.for_diag } else { p.for_chat })
            .map(|p| p.content.trim())
            .filter(|c| !c.is_empty())
            .collect();
        if joined.is_empty() {
            None
        } else {
            Some(joined.join("\n\n").chars().take(4000).collect())
        }
    }

    pub fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        let _ = self.app.emit(event, payload);
    }
}

fn load_json_or<T: serde::de::DeserializeOwned>(path: &PathBuf, default: T) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(default)
}

pub fn save_json<T: serde::Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
