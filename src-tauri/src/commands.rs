//! Tauri IPC commands. Rust owns the final say on security (PRD §10.3):
//! risk grading, prefill gating, keychain access, known-hosts — all here.

use crate::ai::{parse_response, run_chat, run_diagnosis, ChatTurn, DiagnosisRequest};
use crate::keyring_store as keyring;
use crate::provider::specs::PROVIDER_SPECS;
use crate::provider::{make_adapter, ProviderProfile};
use crate::safety::prefill::{prefill, sanitize_command};
use crate::safety::risk::RiskLevel;
use crate::ssh::known_hosts::KnownHosts;
use crate::ssh::session::{self, SshAuth, SshConnectRequest, PtyCmd};
use crate::state::{AppState, ConnectionConfig};
use serde::Deserialize;
use tauri::{Emitter, State};

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ConnectArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    /// If true, the password/passphrase is fetched from the keychain by
    /// connection_id; the caller never needs to know it.
    #[serde(default)]
    pub use_saved_password: bool,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    args: ConnectArgs,
) -> Result<serde_json::Value, String> {
    let mut auth = args.auth;
    if args.use_saved_password {
        let conn_id = args
            .connection_id
            .clone()
            .ok_or("缺少 connection_id")?;
        let secret = keyring::get_secret(&ssh_secret_key(&conn_id))?
            .ok_or("该连接未保存密码，请手动输入")?;
        auth = match auth {
            SshAuth::Password { .. } => SshAuth::Password { password: secret },
            SshAuth::PublicKey { key_path, .. } => SshAuth::PublicKey {
                key_path,
                passphrase: Some(secret),
            },
        };
    }

    let session_id = state.next_session();
    let req = SshConnectRequest {
        host: args.host,
        port: args.port,
        username: args.username,
        auth,
    };
    let session = session::connect(
        state.app.clone(),
        session_id,
        req,
        state.known_hosts_path.clone(),
    )
    .await?;

    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(session_id, session);
    Ok(serde_json::json!({ "sessionId": session_id }))
}

fn ssh_secret_key(conn_id: &str) -> String {
    format!("ssh:{conn_id}")
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, session_id: u64) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&session_id);
    if let Some(s) = session {
        session::disconnect(&s).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    session_id: u64,
    data_b64: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    // Clone the sender and drop the guard BEFORE awaiting: std MutexGuard
    // must never be held across an await (future would not be Send).
    let write_tx = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&session_id)
            .ok_or("会话不存在")?
            .write_tx
            .clone()
    };
    write_tx
        .send(PtyCmd::Data(bytes))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    session_id: u64,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let write_tx = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&session_id)
            .ok_or("会话不存在")?
            .write_tx
            .clone()
    };
    write_tx
        .send(PtyCmd::Resize { cols, rows })
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Connections (host bookkeeping; passwords in keychain)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionConfig> {
    state.connections.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    conn: ConnectionConfig,
    password: Option<String>,
) -> Result<(), String> {
    {
        let mut conns = state.connections.lock().unwrap_or_else(|e| e.into_inner());
        match conns.iter_mut().find(|c| c.id == conn.id) {
            Some(existing) => *existing = conn.clone(),
            None => conns.push(conn.clone()),
        }
    }
    state.save_connections()?;
    if let Some(p) = password {
        keyring::set_secret(&ssh_secret_key(&conn.id), &p)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    state
        .connections
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|c| c.id != conn_id);
    state.save_connections()?;
    keyring::delete_secret(&ssh_secret_key(&conn_id))
}

#[tauri::command]
pub fn has_saved_password(_state: State<'_, AppState>, conn_id: String) -> Result<bool, String> {
    Ok(keyring::get_secret(&ssh_secret_key(&conn_id))?.is_some())
}

/// Clear the stored SSH password/passphrase while keeping the connection
/// record (unified credential center: revoke without deleting the host).
#[tauri::command]
pub fn delete_saved_password(_state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    keyring::delete_secret(&ssh_secret_key(&conn_id))
}

// ---------------------------------------------------------------------------
// Known hosts (TOFU management)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_known_hosts(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    let hosts = KnownHosts::load(state.known_hosts_path.clone());
    hosts
        .list()
        .into_iter()
        .map(|e| serde_json::to_value(&e).unwrap_or_default())
        .collect()
}

#[tauri::command]
pub fn remove_known_host(state: State<'_, AppState>, addr: String) -> Result<bool, String> {
    let mut hosts = KnownHosts::load(state.known_hosts_path.clone());
    hosts.remove(&addr)
}

/// Resolve a parked TOFU decision (PRD §5.2: explicit user trust required).
#[tauri::command]
pub async fn host_key_respond(
    state: State<'_, AppState>,
    addr: String,
    fingerprint: String,
    trust: bool,
) -> Result<(), String> {
    let mut pending = state.pending_hostkey.lock().await;
    let matches = pending
        .as_ref()
        .map(|p| p.addr == addr && p.fingerprint == fingerprint)
        .unwrap_or(false);
    if matches {
        if let Some(p) = pending.take() {
            let _ = p.tx.send(trust);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// AI providers (M2 closed loop)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_provider_specs() -> Vec<serde_json::Value> {
    PROVIDER_SPECS
        .iter()
        .map(|s| serde_json::to_value(s).unwrap_or_default())
        .collect()
}

fn profile_key_id(profile_id: &str) -> String {
    format!("profile:{profile_id}")
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Vec<ProviderProfile> {
    state.profiles.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: ProviderProfile,
    api_key: Option<String>,
) -> Result<(), String> {
    {
        let mut profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        match profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => profiles.push(profile.clone()),
        }
    }
    state.save_profiles()?;
    if let Some(key) = api_key {
        if !key.trim().is_empty() {
            keyring::set_secret(&profile_key_id(&profile.id), key.trim())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), String> {
    state
        .profiles
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|p| p.id != profile_id);
    state.save_profiles()?;
    keyring::delete_secret(&profile_key_id(&profile_id))
}

#[tauri::command]
pub fn has_api_key(_state: State<'_, AppState>, profile_id: String) -> Result<bool, String> {
    Ok(keyring::get_secret(&profile_key_id(&profile_id))?.is_some())
}

/// Remove the stored API key (token management: revoke without deleting the profile).
#[tauri::command]
pub fn delete_api_key(_state: State<'_, AppState>, profile_id: String) -> Result<(), String> {
    keyring::delete_secret(&profile_key_id(&profile_id))
}

/// Resolve an API key: explicit (typed in the form, not yet saved) takes
/// precedence; otherwise load from the keychain.
fn resolve_key(
    _state: &AppState,
    profile_id: &str,
    explicit: Option<String>,
) -> Result<String, String> {
    if let Some(k) = explicit {
        if !k.trim().is_empty() {
            return Ok(k.trim().to_string());
        }
    }
    keyring::get_secret(&profile_key_id(profile_id))?
        .ok_or_else(|| "API Key 未配置".to_string())
}

#[tauri::command]
pub async fn fetch_models(
    state: State<'_, AppState>,
    profile: ProviderProfile,
    api_key: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let key = resolve_key(&state, &profile.id, api_key)?;
    let adapter = make_adapter(&profile, &key).map_err(|e| e.to_string())?;
    let models = adapter.list_models().await.map_err(|e| e.to_string())?;
    Ok(models
        .into_iter()
        .map(|m| serde_json::json!({ "id": m.id }))
        .collect())
}

#[tauri::command]
pub async fn test_provider(
    state: State<'_, AppState>,
    profile: ProviderProfile,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = resolve_key(&state, &profile.id, api_key)?;
    let adapter = make_adapter(&profile, &key).map_err(|e| e.to_string())?;
    let messages = vec![crate::provider::adapters::ChatMessage {
        role: "user".into(),
        content: "回复一个字：好".into(),
    }];
    let mut collected = String::new();
    let (text, _complete) = adapter
        .chat_stream(messages, Default::default(), &mut |c| collected.push_str(c))
        .await
        .map_err(|e| e.to_string())?;
    let reply = if text.is_empty() { &collected } else { &text };
    Ok(serde_json::json!({
        "ok": true,
        "model": profile.model,
        "reply": reply.chars().take(50).collect::<String>(),
    }))
}

// ---------------------------------------------------------------------------
// Risk grading & prefill (M4)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn assess_risk(
    state: State<'_, AppState>,
    command: String,
    ai_risk_hint: String,
) -> serde_json::Value {
    let a = state.risk.assess(&command, &ai_risk_hint);
    serde_json::to_value(&a).unwrap_or_default()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefillArgs {
    pub session_id: u64,
    pub command: String,
    #[serde(default)]
    pub ai_risk_hint: String,
    /// Highest consent level the user has given: "green"|"yellow"|"red".
    pub user_ack: String,
}

#[tauri::command]
pub async fn prefill_command(
    state: State<'_, AppState>,
    args: PrefillArgs,
) -> Result<serde_json::Value, String> {
    let ack = match args.user_ack.as_str() {
        "yellow" => RiskLevel::Yellow,
        "red" => RiskLevel::Red,
        _ => RiskLevel::Green,
    };
    // Clone the sender inside a scoped block so the MutexGuard is provably
    // dropped before any await (required for the command future to be Send).
    let write_tx = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&args.session_id)
            .ok_or("会话不存在")?
            .write_tx
            .clone()
    };

    match prefill(&state.risk, &write_tx, &args.command, &args.ai_risk_hint, ack).await {
        Ok(a) => serde_json::to_value(&a).map_err(|e| e.to_string()),
        Err(e) => Err(serde_json::json!({
            "level": e.level,
            "message": e.message,
        })
        .to_string()),
    }
}

#[tauri::command]
pub fn list_whitelist(state: State<'_, AppState>) -> Vec<String> {
    state
        .risk
        .whitelist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
pub fn add_whitelist(state: State<'_, AppState>, command: String) -> Result<(), String> {
    let cmd = sanitize_command(&command);
    if cmd.is_empty() {
        return Err("命令为空".into());
    }
    {
        let mut wl = state.risk.whitelist.lock().unwrap_or_else(|e| e.into_inner());
        if !wl.contains(&cmd) {
            wl.push(cmd);
        }
    }
    state.save_whitelist()
}

#[tauri::command]
pub fn remove_whitelist(state: State<'_, AppState>, command: String) -> Result<(), String> {
    state
        .risk
        .whitelist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|c| *c != command);
    state.save_whitelist()
}

// ---------------------------------------------------------------------------
// AI diagnosis (M3): streams via events, returns the final result
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_diagnose(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: u64,
    question: String,
) -> Result<serde_json::Value, String> {
    // Resolve the active profile + key inside a scoped block so the
    // std::sync::MutexGuard is provably gone before the first await.
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        let profile = profiles
            .last()
            .cloned()
            .ok_or("未配置 AI Provider：请先在设置中完成配置（S0）")?;
        let key = resolve_key(&state, &profile.id, None)?;
        (profile, key)
    };

    let (pipeline_arc, host) = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions.get(&session_id).ok_or("会话不存在")?;
        (session.pipeline.clone(), session.host.clone())
    };

    // Seal any open error block from the trailing partial line.
    {
        let mut p = pipeline_arc.lock().await;
        let sealed = p.seal_active();
        for ev in sealed {
            state.emit("error-block", serde_json::json!({
                "sessionId": session_id, "block": ev,
            }));
        }
    }

    let (blocks, sys_info) = {
        let p = pipeline_arc.lock().await;
        (p.blocks.clone(), p.system_info.clone())
    };
    // Default: only the most recent command output. The configurable depth
    // (Settings > AI) lets users include a few previous blocks for context.
    let depth = state.diagnosis_depth() as usize;
    let target_blocks: Vec<crate::pipeline::pipeline::ErrorBlock> = blocks
        .iter()
        .rev()
        .take(depth)
        .rev()
        .cloned()
        .collect();

    let _ = host; // reserved for per-host context display
    let _ = &sys_info;

    // Guard against concurrent diagnoses per session.
    static DIAG_INFLIGHT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u64>>> =
        std::sync::OnceLock::new();
    let inflight = DIAG_INFLIGHT
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    let inserted = {
        let mut set = inflight.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(session_id)
    };
    if !inserted {
        return Err("已有诊断正在进行".into());
    }

    // Run everything fallibly first; always release the slot afterwards.
    let outcome = (|| async {
        let adapter = make_adapter(&profile, &key).map_err(|e| e.to_string())?;

        // run_diagnosis borrows the pipeline; do it inside a scope.
        let result = {
            let p = pipeline_arc.lock().await;
            let req = DiagnosisRequest {
                pipeline: &p,
                blocks: &target_blocks,
                user_question: &question,
                custom_prompt: {
                    let sp = state.system_prompt();
                    if sp.is_empty() { None } else { Some(sp) }
                },
            };
            let app_for_chunks = app.clone();
            run_diagnosis(adapter.as_ref(), &req, &mut move |chunk| {
                let _ = app_for_chunks.emit("ai-chunk", chunk);
            })
            .await
            .map_err(|e| e.to_string())?
        };
        let payload = serde_json::to_value(&result).map_err(|e| e.to_string())?;
        Ok::<serde_json::Value, String>(serde_json::json!({
            "result": payload,
            "provider": profile.name,
            "model": profile.model,
        }))
    })()
    .await;

    {
        let mut set = inflight.lock().unwrap_or_else(|e| e.into_inner());
        set.remove(&session_id);
    }

    outcome
}

#[tauri::command]
pub fn parse_preview(raw: String) -> serde_json::Value {
    serde_json::to_value(parse_response(&raw, false)).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// AI chat mode: multi-turn conversation without terminal context. Streams
// via "chat-chunk" events (separate from the diagnosis "ai-chunk" stream).
// Pure data path (HC-03): the response is text only, never executed.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    history: Vec<ChatTurn>,
    question: String,
) -> Result<String, String> {
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        let profile = profiles
            .last()
            .cloned()
            .ok_or("未配置 AI Provider：请先在设置中完成配置（S0）")?;
        let key = resolve_key(&state, &profile.id, None)?;
        (profile, key)
    };

    // Guard against concurrent chats (per app, not per session). AtomicBool
    // avoids holding a non-Send std guard across the await.
    static CHAT_INFLIGHT: std::sync::OnceLock<std::sync::atomic::AtomicBool> =
        std::sync::OnceLock::new();
    let flag = CHAT_INFLIGHT.get_or_init(|| std::sync::atomic::AtomicBool::new(false));
    if flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("已有对话正在进行".into());
    }

    let chat_result = async {
        let adapter = make_adapter(&profile, &key).map_err(|e| e.to_string())?;
        let custom = {
            let sp = state.system_prompt();
            if sp.is_empty() { None } else { Some(sp) }
        };
        let app_for_chunks = app.clone();
        run_chat(
            adapter.as_ref(),
            &history,
            &question,
            custom.as_deref(),
            &mut move |chunk| {
                let _ = app_for_chunks.emit("chat-chunk", chunk);
            },
        )
        .await
        .map_err(|e| e.to_string())
    }
    .await;
    flag.store(false, std::sync::atomic::Ordering::SeqCst);
    chat_result
}

// ---------------------------------------------------------------------------
// AI system prompt (global, optional). Custom text is PREPENDED to the
// built-in diagnosis prompt; the built-in schema + safety rules always apply.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_system_prompt(state: State<'_, AppState>) -> String {
    state.system_prompt()
}

#[tauri::command]
pub fn set_system_prompt(state: State<'_, AppState>, prompt: String) -> Result<(), String> {
    let trimmed = prompt.trim().to_string();
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.system_prompt = trimmed;
    }
    state.save_settings()
}

#[tauri::command]
pub fn get_diagnosis_depth(state: State<'_, AppState>) -> u32 {
    state.diagnosis_depth()
}

#[tauri::command]
pub fn set_diagnosis_depth(state: State<'_, AppState>, depth: u32) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.diagnosis_depth = depth.clamp(1, 10);
    }
    state.save_settings()
}

/// Save an uploaded private key into the app-private keys directory and
/// return the path to use as `key_path`. Private keys are file-type secrets
/// (the keyring stores the passphrase, not the key body).
#[tauri::command]
pub fn save_uploaded_key(
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = state.data_dir.join("keys");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建密钥目录失败: {e}"))?;
    let path = dir.join(format!("{safe}.key"));
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入私钥失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Run a one-shot command on a fresh exec channel (NOT the PTY). Powers the
/// server dashboard probe and explicit user-initiated file operations.
/// This path is USER-triggered only — AI output never reaches it (HC-03).
#[tauri::command]
pub async fn exec_oneshot(
    state: State<'_, AppState>,
    session_id: u64,
    command: String,
) -> Result<String, String> {
    use russh::ChannelMsg;
    // Clone the Arc'd cell out of the map, then drop the std guard BEFORE
    // any await so the future stays Send.
    let handle_cell = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&session_id)
            .map(|s| s.handle.clone())
            .ok_or("会话不存在")?
    };
    // russh Handle is not Clone: open the exec channel while holding the
    // guard, then release it before the (potentially slow) read loop.
    let mut ch = {
        let mut guard = handle_cell.lock().await;
        let handle = guard.as_mut().ok_or("会话已断开")?;
        let mut ch = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开执行通道失败: {e}"))?;
        ch.exec(true, command.as_str())
            .await
            .map_err(|e| format!("执行失败: {e}"))?;
        ch
    };

    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(15), ch.wait()).await {
            Ok(Some(ChannelMsg::Data { ref data })) => out.extend_from_slice(data),
            Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => out.extend_from_slice(data),
            // ExitStatus/Eof/Close/None: output complete.
            Ok(Some(ChannelMsg::Eof))
            | Ok(Some(ChannelMsg::ExitStatus { .. }))
            | Ok(Some(ChannelMsg::Close))
            | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => break, // 15s timeout guard
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}
