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

        // Load user whitelist into the risk engine.
        let risk = RiskEngine::default();
        if let Some(list) = load_json_or::<Vec<String>, _>(&whitelist_file, Vec::new()).into() {
            *risk.whitelist.lock().unwrap_or_else(|e| e.into_inner()) = list;
        }

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
        }
    }

    pub fn next_session(&self) -> u64 {
        self.next_session_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn save_profiles(&self) -> Result<(), String> {
        let profiles = self.profiles.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.data_dir.join("profiles.json"), &profiles)
    }

    pub fn save_connections(&self) -> Result<(), String> {
        let conns = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.data_dir.join("connections.json"), &conns)
    }

    pub fn save_whitelist(&self) -> Result<(), String> {
        let wl = self.risk.whitelist.lock().unwrap_or_else(|e| e.into_inner());
        save_json(&self.whitelist_file, &*wl)
    }

    pub fn emit(&self, event: &str, payload: impl serde::Serialize) {
        let _ = self.app.emit(event, payload);
    }
}

fn load_json_or<T, P>(path: &PathBuf, default: T) -> T
where
    T: serde::de::DeserializeOwned,
    P: std::fmt::Debug,
{
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
