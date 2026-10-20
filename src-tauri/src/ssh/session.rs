//! SSH session lifecycle built on russh: connect -> TOFU -> auth -> PTY shell.
//!
//! Data flow: one task owns the russh Channel and `select!`s between PTY
//! output (forwarded to the frontend + recognition pipeline) and write
//! commands from an mpsc queue (user keystrokes, resize, AI pre-fill).

use super::known_hosts::{KnownHosts, TofuVerdict};
use crate::pipeline::pipeline::Pipeline;
use russh::client::{self, Handle};
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub enum SshAuth {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "publickey")]
    PublicKey {
        key_path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct SshConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

/// Messages sent INTO the PTY writer task.
pub enum PtyCmd {
    /// Raw bytes typed by the user (or pre-filled by AI). NEVER auto-terminated.
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Shared TOFU handshake state between the russh Handler and the UI.
pub struct TofuBridge {
    pub app: tauri::AppHandle,
    pub known_hosts_path: PathBuf,
    pub addr: String,
}

pub struct ClientHandler {
    pub tofu: Arc<TofuBridge>,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// PRD §5.2: TOFU decision. Mismatch = hard error, no bypass.
    /// Unknown key = ask the user through the UI and wait for the verdict.
    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let (algo, b64) = serialize_public_key(server_public_key);
        let fingerprint = super::known_hosts::fingerprint_from_key_blob(&algo, &b64)
            .map_err(|_| russh::Error::UnknownKey)?;
        let addr = self.tofu.addr.clone();
        let mut hosts = KnownHosts::load(self.tofu.known_hosts_path.clone());

        match hosts.verdict(&addr, &fingerprint) {
            TofuVerdict::Match => Ok(true),
            TofuVerdict::Mismatch(m) => {
                let _ = self.tofu.app.emit("hostkey-mismatch", &m);
                Err(russh::Error::UnknownKey)
            }
            TofuVerdict::Unknown => {
                let (tx, rx) = oneshot::channel::<bool>();
                // Park the decision in app state; the host_key_respond IPC
                // command resolves it from the trust dialog.
                {
                    let st = self
                        .tofu
                        .app
                        .state::<crate::state::AppState>();
                    let mut pending = st.pending_hostkey.lock().await;
                    if pending.is_some() {
                        // Another decision is already on screen; fail fast.
                        return Err(russh::Error::UnknownKey);
                    }
                    *pending = Some(crate::state::PendingHostKey {
                        addr: addr.clone(),
                        fingerprint: fingerprint.clone(),
                        tx,
                    });
                }
                let payload = serde_json::json!({
                    "addr": addr,
                    "algo": algo,
                    "fingerprint": fingerprint,
                });
                let _ = self.tofu.app.emit("hostkey-unknown", &payload);
                // Wait up to 5 minutes for the user's explicit decision.
                let decision = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
                // Always clear the pending slot.
                {
                    let st = self
                        .tofu
                        .app
                        .state::<crate::state::AppState>();
                    let mut pending = st.pending_hostkey.lock().await;
                    if pending
                        .as_ref()
                        .map(|p| p.addr == addr)
                        .unwrap_or(false)
                    {
                        *pending = None;
                    }
                }
                match decision {
                    Ok(Ok(true)) => {
                        hosts.learn(&addr, &algo, &fingerprint)
                            .map_err(|_| russh::Error::UnknownKey)?;
                        Ok(true)
                    }
                    _ => Err(russh::Error::UnknownKey),
                }
            }
        }
    }
}

/// Extract (algorithm, base64 body) from a russh public key via its
/// OpenSSH single-line representation.
fn serialize_public_key(k: &russh_keys::key::PublicKey) -> (String, String) {
    use russh_keys::PublicKeyBase64;
    let algo = k.name().to_string();
    let b64 = k.public_key_base64();
    (algo, b64)
}

pub struct Session {
    pub id: u64,
    pub host: String,
    pub username: String,
    pub write_tx: mpsc::Sender<PtyCmd>,
    pub handle: Arc<Mutex<Option<Handle<ClientHandler>>>>,
    pub pipeline: Arc<Mutex<Pipeline>>,
    /// Persistent agent shell (one remote shell reused across agent steps so
    /// cd/export survive). Slot holds the driver task's command sender; it is
    /// cleared whenever the channel is poisoned (timeout / shell death).
    pub agent_shell: Arc<Mutex<Option<mpsc::Sender<crate::agent_shell::ShellReq>>>>,
}

/// Connect and spawn the PTY bridge task. Returns the session record.
pub async fn connect(
    app: tauri::AppHandle,
    session_id: u64,
    req: SshConnectRequest,
    known_hosts_path: PathBuf,
) -> Result<Session, String> {
    let addr = format!("{}:{}", req.host, req.port);

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let tofu = Arc::new(TofuBridge {
        app: app.clone(),
        known_hosts_path,
        addr: addr.clone(),
    });
    let handler = ClientHandler { tofu };
    let mut handle: Handle<ClientHandler> =
        client::connect(config, (req.host.as_str(), req.port), handler)
            .await
            .map_err(|e| format!("连接失败: {e}"))?;

    let authed = authenticate(&mut handle, &req.username, &req.auth).await?;
    if !authed {
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
        return Err("认证失败：用户名或凭据不正确".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话通道失败: {e}"))?;

    let (cols, rows) = (80u32, 24u32);
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("请求 PTY 失败: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("启动 shell 失败: {e}"))?;

    let (write_tx, mut write_rx) = mpsc::channel::<PtyCmd>(64);
    let pipeline = Arc::new(Mutex::new(Pipeline::new()));

    // System probe: one line, parsed by the pipeline for LLM context.
    // Written by us at shell start — this is infrastructure, not an AI command.
    let probe = b"echo \"__AISA_PROBE__ os=$(uname -s 2>/dev/null) kernel=$(uname -r 2>/dev/null) shell=$SHELL user=$(whoami) cwd=$PWD pkgs=$(for c in apt apt-get dnf yum pacman apk zypper brew; do command -v $c >/dev/null 2>&1 && { echo $c; break; }; done)\"\n";
    let _ = write_tx.send(PtyCmd::Data(probe.to_vec())).await;

    let session = Session {
        id: session_id,
        host: req.host.clone(),
        username: req.username.clone(),
        write_tx: write_tx.clone(),
        handle: Arc::new(Mutex::new(Some(handle))),
        pipeline: pipeline.clone(),
        agent_shell: Arc::new(Mutex::new(None)),
    };

    // PTY bridge task: types fully inferred from channel_open_session.
    let app2 = app.clone();
    let host2 = req.host.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            forward_output(&app2, session_id, &host2, &pipeline, data.as_ref()).await;
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            forward_output(&app2, session_id, &host2, &pipeline, data.as_ref()).await;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            let _ = app2.emit("ssh-status", serde_json::json!({
                                "sessionId": session_id, "status": "exited", "code": exit_status,
                            }));
                        }
                        Some(ChannelMsg::Eof) => {}
                        None => {
                            let _ = app2.emit("ssh-status", serde_json::json!({
                                "sessionId": session_id, "status": "closed",
                            }));
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = write_rx.recv() => {
                    match cmd {
                        Some(PtyCmd::Data(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(PtyCmd::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(PtyCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }
    });

    let _ = app.emit("ssh-status", serde_json::json!({
        "sessionId": session_id, "status": "connected", "host": req.host,
    }));

    Ok(session)
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    auth: &SshAuth,
) -> Result<bool, String> {
    match auth {
        SshAuth::Password { password } => handle
            .authenticate_password(username, password)
            .await
            .map_err(|e| format!("认证错误: {e}")),
        SshAuth::PublicKey { key_path, passphrase } => {
            let key = russh_keys::load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| format!("读取私钥失败: {e}"))?;
            handle
                .authenticate_publickey(username, Arc::new(key))
                .await
                .map_err(|e| format!("认证错误: {e}"))
        }
    }
}

/// Forward raw bytes to the renderer AND into the recognition pipeline.
/// (Raw bytes never reach the LLM — PRD HC-05: pipeline normalizes first.)
async fn forward_output(
    app: &tauri::AppHandle,
    session_id: u64,
    host: &str,
    pipeline: &Arc<Mutex<Pipeline>>,
    data: &[u8],
) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    let _ = app.emit("terminal-data", serde_json::json!({
        "sessionId": session_id,
        "data": b64,
    }));

    let mut p = pipeline.lock().await;
    let events = p.feed(host, data);
    drop(p);
    for ev in events {
        let _ = app.emit("error-block", serde_json::json!({
            "sessionId": session_id,
            "block": ev,
        }));
    }
}

/// Disconnect a session and clean up.
pub async fn disconnect(session: &Session) {
    if let Some(h) = session.handle.lock().await.take() {
        let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    let _ = session.write_tx.send(PtyCmd::Close).await;
}
