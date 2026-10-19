//! Tauri IPC commands. Rust owns the final say on security (PRD §10.3):
//! risk grading, prefill gating, keychain access, known-hosts — all here.

use crate::ai::{
    parse_response, run_agent_step, run_chat, run_diagnosis, AgentStepIn, ChatTurn,
    DiagnosisRequest,
};
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
    profile_id: Option<String>,
) -> Result<serde_json::Value, String> {
    // Resolve the active profile + key inside a scoped block so the
    // std::sync::MutexGuard is provably gone before the first await.
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        // Honor the user's active-profile selection (UI switcher); fall back
        // to the most recent profile only when no id is provided/matched.
        let profile = match profile_id.as_deref() {
            Some(id) if !id.is_empty() => profiles.iter().find(|p| p.id == id).cloned(),
            _ => None,
        }
        .or_else(|| profiles.last().cloned())
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
                custom_prompt: state.diag_prompt(),
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
            "blocksSent": target_blocks.len(),
        }))
    })()
    .await;

    {
        let mut set = inflight.lock().unwrap_or_else(|e| e.into_inner());
        set.remove(&session_id);
    }

    outcome
}

// ---------------------------------------------------------------------------
// Agent mode: plan ONE next step. The model returns pure data; execution and
// risk gating happen in the frontend loop via assess_risk + exec_oneshot.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_step(
    state: State<'_, AppState>,
    session_id: u64,
    goal: String,
    steps: Vec<AgentStepIn>,
    require_verification: Option<bool>,
    profile_id: Option<String>,
) -> Result<crate::ai::AgentStepOut, String> {
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        // Honor the user's active-profile selection (UI switcher); fall back
        // to the most recent profile only when no id is provided/matched.
        let profile = match profile_id.as_deref() {
            Some(id) if !id.is_empty() => profiles.iter().find(|p| p.id == id).cloned(),
            _ => None,
        }
        .or_else(|| profiles.last().cloned())
        .ok_or("未配置 AI Provider：请先在设置中完成配置（S0）")?;
        let key = resolve_key(&state, &profile.id, None)?;
        (profile, key)
    };
    let pipeline_arc = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&session_id)
            .map(|s| s.pipeline.clone())
            .ok_or("会话不存在")?
    };
    let (sys_info, tail) = {
        let p = pipeline_arc.lock().await;
        let n = 20.min(p.screen.lines.len());
        let tail = p
            .screen
            .lines
            .iter()
            .skip(p.screen.lines.len() - n)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        (p.system_info.clone(), tail)
    };
    let sys_text = crate::pipeline::context::format_system_context(&sys_info);
    let adapter = make_adapter(&profile, &key).map_err(|e| e.to_string())?;
    run_agent_step(
        adapter.as_ref(),
        &goal,
        &steps,
        &sys_text,
        &tail,
        require_verification.unwrap_or(false),
        state.agent_prompt().as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Prompt library: multiple named prompts, each bound to 诊断/对话 modes.
// The legacy single system_prompt is migrated into one entry on first list.
// ---------------------------------------------------------------------------

fn new_prompt_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[tauri::command]
pub fn list_prompts(state: State<'_, AppState>) -> Result<Vec<crate::state::PromptEntry>, String> {
    let mut needs_save = false;
    let out = {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        if s.prompts.is_empty() && !s.system_prompt.trim().is_empty() {
            let legacy = crate::state::PromptEntry {
                id: new_prompt_id(),
                name: "默认提示词".into(),
                content: s.system_prompt.clone(),
                for_diag: s.prompt_for_diag,
                for_chat: s.prompt_for_chat,
                for_agent: false,
            };
            s.prompts.push(legacy);
            needs_save = true;
        }
        s.prompts.clone()
    };
    if needs_save {
        state.save_settings()?;
    }
    Ok(out)
}

#[tauri::command]
pub fn save_prompt(
    state: State<'_, AppState>,
    mut entry: crate::state::PromptEntry,
) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        if entry.id.is_empty() {
            entry.id = new_prompt_id();
        }
        entry.name = entry.name.trim().to_string();
        if entry.name.is_empty() {
            entry.name = "未命名提示词".into();
        }
        entry.content = entry.content.chars().take(2000).collect();
        match s.prompts.iter_mut().find(|p| p.id == entry.id) {
            Some(p) => *p = entry.clone(),
            None => s.prompts.push(entry.clone()),
        }
    }
    state.save_settings()
}

#[tauri::command]
pub fn delete_prompt(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.prompts.retain(|p| p.id != id);
    }
    state.save_settings()
}

// ---------------------------------------------------------------------------
// SFTP: upload (bytes from the webview) / download (to app-data/downloads).
// USER-initiated file transfer only — the AI path never touches these.
// ---------------------------------------------------------------------------

pub(crate) async fn open_sftp(state: &State<'_, AppState>, session_id: u64) -> Result<russh_sftp::client::SftpSession, String> {
    let handle_cell = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(&session_id)
            .map(|s| s.handle.clone())
            .ok_or("会话不存在")?
    };
    let ch = {
        let mut guard = handle_cell.lock().await;
        let handle = guard.as_mut().ok_or("会话已断开")?;
        let mut ch = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        ch
    };
    russh_sftp::client::SftpSession::new(ch.into_stream())
        .await
        .map_err(|e| format!("SFTP 初始化失败: {e}"))
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: u64,
    remote_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    let sftp = open_sftp(&state, session_id).await?;
    let meta = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| format!("读取远端文件信息失败: {e}"))?;
    if meta.is_dir() {
        return Err("目标是一个目录，仅支持下载文件".into());
    }
    let name = remote_path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("file").to_string();
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    tokio::fs::create_dir_all(&local_dir).await.map_err(|e| e.to_string())?;
    let local_path = local_dir.join(&name);
    let mut out = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("创建本地文件失败: {e}"))?;
    use tokio::io::AsyncWriteExt;
    let data = sftp
        .read(&remote_path)
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    out.write_all(&data).await.map_err(|e| e.to_string())?;
    out.flush().await.map_err(|e| e.to_string())?;
    Ok(format!(
        "已下载 {name}（{} 字节）→ {}",
        data.len(),
        local_path.display()
    ))
}

#[tauri::command]
pub async fn sftp_upload_data(
    state: State<'_, AppState>,
    session_id: u64,
    remote_path: String,
    data_b64: String,
) -> Result<String, String> {
    use base64::Engine;
    if data_b64.len() > 80_000_000 {
        return Err("文件过大（上限约 60MB），请用命令行传输".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("数据解码失败: {e}"))?;
    let sftp = open_sftp(&state, session_id).await?;
    sftp.write(&remote_path, &data)
        .await
        .map_err(|e| format!("写入失败: {e}"))?;
    Ok(format!("已上传 {} 字节 → {}", data.len(), remote_path))
}

// ---------------------------------------------------------------------------
// Agent audit log: persist every agent task (goal/steps/status) to
// data_dir/agent_logs/ so ops history is reviewable after the fact.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_agent_log(
    state: State<'_, AppState>,
    goal: String,
    status: String,
    steps: serde_json::Value,
) -> Result<String, String> {
    let dir = state.data_dir.join("agent_logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = chrono_like_timestamp();
    let file = dir.join(format!("agent-{ts}.json"));
    let payload = serde_json::json!({
        "finishedAt": ts,
        "status": status,
        "goal": goal,
        "steps": steps,
    });
    // HC-02: on-disk logs are sanitized (Bearer/PEM/key-like strings
    // redacted) — step outputs can echo environment content with secrets.
    let body = crate::keyring_store::sanitize_log(
        &serde_json::to_string_pretty(&payload).unwrap_or_default(),
    );
    std::fs::write(&file, body).map_err(|e| e.to_string())?;
    Ok(file.display().to_string())
}

/// Millisecond timestamp filename (no chrono dep).
fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub auto_green: bool,
    pub agent_exec_timeout: u64,
}

#[tauri::command]
pub fn get_agent_config(state: State<'_, AppState>) -> AgentConfig {
    let s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    AgentConfig {
        auto_green: s.agent_auto_green,
        agent_exec_timeout: s.agent_exec_timeout,
    }
}

#[tauri::command]
pub fn set_agent_config(
    state: State<'_, AppState>,
    auto_green: bool,
    agent_exec_timeout: u64,
) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.agent_auto_green = auto_green;
        s.agent_exec_timeout = agent_exec_timeout.clamp(5, 300);
    }
    state.save_settings()
}

// ---------------------------------------------------------------------------
// MCP server config (for external IDEs: Trae / Cursor / Claude ...). The
// server binds 127.0.0.1 only and requires the bearer token.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub fn get_mcp_config(state: State<'_, AppState>) -> Result<McpConfig, String> {
    let mut needs_save = false;
    let cfg = {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        if s.mcp_token.is_empty() {
            s.mcp_token = uuid::Uuid::new_v4().simple().to_string();
            needs_save = true;
        }
        McpConfig {
            enabled: s.mcp_enabled,
            port: if s.mcp_port == 0 { 8615 } else { s.mcp_port },
            token: s.mcp_token.clone(),
        }
    };
    if needs_save {
        state.save_settings()?;
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_mcp_config(state: State<'_, AppState>, enabled: bool, port: u16) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.mcp_enabled = enabled;
        if (1024..=65535).contains(&port) {
            s.mcp_port = port;
        }
    }
    state.save_settings()
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
    profile_id: Option<String>,
) -> Result<String, String> {
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        // Honor the user's active-profile selection (UI switcher); fall back
        // to the most recent profile only when no id is provided/matched.
        let profile = match profile_id.as_deref() {
            Some(id) if !id.is_empty() => profiles.iter().find(|p| p.id == id).cloned(),
            _ => None,
        }
        .or_else(|| profiles.last().cloned())
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
        let custom = state.chat_prompt();
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

// (The legacy get/set_system_prompt pair was replaced by the prompt library:
//  list_prompts / save_prompt / delete_prompt above.)

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
    // Optional per-call timeout (5..=300 s). Default 15 s for dashboard
    // probes; the Agent loop passes the configured exec timeout.
    timeout_secs: Option<u64>,
    // None (or "green") => only GREEN commands may run. "yellow" => the
    // caller has user authorization for a YELLOW (write) command.
    user_ack: Option<String>,
) -> Result<String, String> {
    use crate::safety::risk::RiskLevel;
    use russh::ChannelMsg;

    // ---- execution-layer gate: the SINGLE choke point for every non-PTY
    // exec (dashboard probes, file ops, agent steps, MCP exec_command).
    // Every command is re-graded HERE regardless of what the caller checked.
    let ack = user_ack.as_deref().unwrap_or("none");
    let assessment = state.risk.assess(&command, "");
    match assessment.level {
        RiskLevel::Red => {
            return Err(format!(
                "已拒绝执行：命中黑名单规则「{}」——{}。该命令风险过高，如确需执行请在终端中手动输入。",
                assessment.rule, assessment.reason
            ))
        }
        RiskLevel::Yellow if ack != "yellow" => {
            return Err(format!(
                "已拒绝执行：该命令为写操作（{}）。请通过 Agent 确认流程执行，或检查命令是否应包含写操作。",
                assessment.reason
            ))
        }
        _ => {}
    }

    let timeout = timeout_secs.unwrap_or(15).clamp(5, 300);
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

    // Wall-clock timeout (a streaming `tail -f` must NOT reset the timer on
    // every frame) and a hard output cap (unbounded growth protection).
    const MAX_OUT: usize = 512 * 1024;
    let started = std::time::Instant::now();
    let mut out: Vec<u8> = Vec::new();
    let mut hit_limit = false;
    loop {
        let elapsed = started.elapsed().as_secs();
        if elapsed >= timeout || out.len() >= MAX_OUT {
            hit_limit = true;
            break;
        }
        let remain = timeout - elapsed;
        match tokio::time::timeout(std::time::Duration::from_secs(remain), ch.wait()).await {
            Ok(Some(ChannelMsg::Data { ref data })) => out.extend_from_slice(data),
            Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => out.extend_from_slice(data),
            // ExitStatus/Eof/Close/None: output complete.
            Ok(Some(ChannelMsg::Eof))
            | Ok(Some(ChannelMsg::ExitStatus { .. }))
            | Ok(Some(ChannelMsg::Close))
            | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => {
                // Wall-clock timeout: close the channel, don't leak it.
                hit_limit = true;
                break;
            }
        }
    }
    if hit_limit {
        let _ = ch.close().await;
    }
    if out.len() >= MAX_OUT {
        out.truncate(MAX_OUT);
    }
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if hit_limit {
        text.push_str("\n…（输出已截断：超过 512KB 或超时）");
    }
    Ok(text)
}
