//! Built-in MCP (Model Context Protocol) server, Streamable-HTTP transport.
//!
//! Lets external IDE agents (Trae, Cursor, Claude Code, ...) call this app's
//! SSH capabilities as tools:
//!   list_hosts / connect_host / exec_command / screen_tail / diagnose / disconnect
//!
//! Security: binds 127.0.0.1 ONLY and requires `Authorization: Bearer <token>`
//! (token shown in 设置 › MCP 集成). Configuring the IDE with the token is the
//! user's explicit authorization for command execution via this channel.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::Manager;
use tiny_http::{Header, Method, Response};

const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_OUTPUT_CHARS: usize = 8000;

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || run_server(app));
}

fn run_server(app: tauri::AppHandle) {
    let port = {
        let st = app.state::<AppState>();
        let s = st.settings.lock().unwrap_or_else(|e| e.into_inner());
        if s.mcp_port == 0 { 8615 } else { s.mcp_port }
    };
    let server = match tiny_http::Server::http(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[mcp] 绑定 127.0.0.1:{port} 失败: {e}");
            return;
        }
    };
    eprintln!("[mcp] listening on 127.0.0.1:{port}");
    for request in server.incoming_requests() {
        let _ = handle_request(request, &app);
    }
}

fn respond_json(request: tiny_http::Request, status: u16, body: String) {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let resp = Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(resp);
}

fn rpc_result(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn rpc_error(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        .to_string()
}

fn tool_text(text: String) -> Value {
    let text = if text.chars().count() > MAX_OUTPUT_CHARS {
        let tail: String = text
            .chars()
            .rev()
            .take(MAX_OUTPUT_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("…(截断)…\n{tail}")
    } else {
        text
    };
    json!({ "content": [ { "type": "text", "text": text } ], "isError": false })
}

fn handle_request(mut request: tiny_http::Request, app: &tauri::AppHandle) -> Result<(), std::io::Error> {
    let st = app.state::<AppState>();

    // ---- auth ----
    let token = {
        let s = st.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.mcp_token.clone()
    };
    let authorized = !token.is_empty()
        && request.headers().iter().any(|h| {
            h.field.as_str().as_str().eq_ignore_ascii_case("authorization")
                && h.value.as_str() == format!("Bearer {token}")
        });
    if !authorized {
        respond_json(
            request,
            401,
            json!({ "error": "unauthorized: 在 设置 › MCP 集成 中复制 token 配置到 IDE" }).to_string(),
        );
        return Ok(());
    }

    // ---- enabled check ----
    let enabled = {
        let s = st.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.mcp_enabled
    };
    if !enabled {
        respond_json(request, 503, json!({ "error": "MCP 服务未启用" }).to_string());
        return Ok(());
    }

    // ---- only POST /mcp ----
    if request.method() != &Method::Post || request.url() != "/mcp" {
        respond_json(request, 405, json!({ "error": "method not allowed" }).to_string());
        return Ok(());
    }

    let mut body = String::new();
    request.as_reader().read_to_string(&mut body)?;
    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            respond_json(request, 400, rpc_error(Value::Null, -32700, &format!("parse error: {e}")));
            return Ok(());
        }
    };
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();

    // Notifications (no id): acknowledge without body.
    if id.is_null() {
        respond_json(request, 202, String::new());
        return Ok(());
    }

    match method.as_str() {
        "initialize" => {
            let result = json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "ai-ssh-assistant", "version": "0.1.0" }
            });
            respond_json(request, 200, rpc_result(id, result));
        }
        "tools/list" => {
            let result = json!({ "tools": tools_json() });
            respond_json(request, 200, rpc_result(id, result));
        }
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = dispatch_tool(app, &name, &args);
            respond_json(request, 200, rpc_result(id, result));
        }
        other => {
            respond_json(request, 200, rpc_error(id, -32601, &format!("method not found: {other}")));
        }
    }
    Ok(())
}

fn tools_json() -> Value {
    json!([
    {
        "name": "list_hosts",
        "description": "列出本应用已保存的 SSH 主机（含 connection_id，可配合 connect_host 使用保存的密码）",
        "inputSchema": { "type": "object", "properties": {} }
    },
    {
        "name": "connect_host",
        "description": "连接一台 SSH 主机，返回 sessionId。优先传 connection_id（使用已保存密码）；否则需 host/port/username + password 或 key_path",
        "inputSchema": {
            "type": "object",
            "properties": {
                "connection_id": { "type": "string", "description": "list_hosts 返回的连接 ID（使用保存的密码）" },
                "host": { "type": "string" },
                "port": { "type": "integer", "description": "默认 22" },
                "username": { "type": "string" },
                "password": { "type": "string", "description": "密码认证时提供" },
                "key_path": { "type": "string", "description": "私钥认证时提供" },
                "passphrase": { "type": "string" }
            }
        }
    },
    {
        "name": "exec_command",
        "description": "在指定会话上执行一条命令（独立 exec 通道，不干扰交互终端），返回完整输出。注意：这会真实执行命令，请在征得用户同意后调用",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": { "type": "integer" },
                "command": { "type": "string" }
            },
            "required": ["session_id", "command"]
        }
    },
    {
        "name": "screen_tail",
        "description": "读取指定会话交互终端的最近输出（尾部 N 行）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": { "type": "integer" },
                "lines": { "type": "integer", "description": "默认 40" }
            },
            "required": ["session_id"]
        }
    },
    {
        "name": "diagnose",
        "description": "对指定会话运行 AI 诊断（分析最近的错误输出），返回结构化诊断 JSON",
        "inputSchema": {
            "type": "object",
            "properties": { "session_id": { "type": "integer" } },
            "required": ["session_id"]
        }
    },
    {
        "name": "disconnect",
        "description": "断开指定会话",
        "inputSchema": {
            "type": "object",
            "properties": { "session_id": { "type": "integer" } },
            "required": ["session_id"]
        }
    },
    {
        "name": "upload_file",
        "description": "上传数据到远端文件（data_base64 为文件内容的 Base64 编码，≤60MB），将覆盖目标文件",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": { "type": "integer" },
                "remote_path": { "type": "string" },
                "data_base64": { "type": "string" }
            },
            "required": ["session_id", "remote_path", "data_base64"]
        }
    },
    {
        "name": "download_file",
        "description": "读取远端文件，返回 Base64 编码的内容（≤1MB）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": { "type": "integer" },
                "remote_path": { "type": "string" }
            },
            "required": ["session_id", "remote_path"]
        }
    }
    ])
}

fn dispatch_tool(app: &tauri::AppHandle, name: &str, args: &Value) -> Value {
    let result: Result<String, String> = tauri::async_runtime::block_on(run_tool(app, name, args));
    match result {
        Ok(text) => tool_text(text),
        Err(e) => json!({ "content": [ { "type": "text", "text": e } ], "isError": true }),
    }
}

async fn run_tool(app: &tauri::AppHandle, name: &str, args: &Value) -> Result<String, String> {
    // A fresh State handle per call keeps borrows inside this future.
    let st = app.state::<AppState>();
    match name {
        "list_hosts" => {
            let conns = st.connections.lock().unwrap_or_else(|e| e.into_inner());
            let list: Vec<Value> = conns
                .iter()
                .map(|c| {
                    json!({
                        "connection_id": c.id,
                        "name": c.name,
                        "host": c.host,
                        "port": c.port,
                        "username": c.username,
                        "auth_method": c.auth_method,
                    })
                })
                .collect();
            Ok(serde_json::to_string_pretty(&list).unwrap_or_default())
        }
        "connect_host" => {
            let conn_id = args.get("connection_id").and_then(|v| v.as_str()).map(String::from);
            let auth = if let Some(kp) = args.get("key_path").and_then(|v| v.as_str()) {
                crate::ssh::session::SshAuth::PublicKey {
                    key_path: kp.to_string(),
                    passphrase: args.get("passphrase").and_then(|v| v.as_str()).map(String::from),
                }
            } else {
                crate::ssh::session::SshAuth::Password {
                    password: args.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                }
            };
            let (host, port, username, use_saved) = if let Some(cid) = &conn_id {
                let conns = st.connections.lock().unwrap_or_else(|e| e.into_inner());
                let c = conns
                    .iter()
                    .find(|c| &c.id == cid)
                    .ok_or_else(|| format!("connection_id {cid} 不存在（先调用 list_hosts）"))?;
                (c.host.clone(), c.port, c.username.clone(), true)
            } else {
                let host = args.get("host").and_then(|v| v.as_str()).ok_or("缺少 host")?.to_string();
                let port = args.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
                let username = args.get("username").and_then(|v| v.as_str()).unwrap_or("root").to_string();
                (host, port, username, false)
            };
            let conn_args = crate::commands::ConnectArgs {
                host,
                port,
                username,
                auth,
                use_saved_password: use_saved,
                connection_id: conn_id,
            };
            let res = crate::commands::ssh_connect(st, conn_args).await?;
            Ok(serde_json::to_string_pretty(&res).unwrap_or_default())
        }
        "exec_command" => {
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            let command = args.get("command").and_then(|v| v.as_str()).ok_or("缺少 command")?.to_string();
            crate::commands::exec_oneshot(st, session_id, command, None).await
        }
        "screen_tail" => {
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
            let pipeline_arc = {
                let sessions = st.sessions.lock().unwrap_or_else(|e| e.into_inner());
                sessions
                    .get(&session_id)
                    .map(|s| s.pipeline.clone())
                    .ok_or("会话不存在")?
            };
            let p = pipeline_arc.lock().await;
            let n = lines.min(p.screen.lines.len());
            let text = p
                .screen
                .lines
                .iter()
                .skip(p.screen.lines.len() - n)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            Ok(text)
        }
        "diagnose" => {
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            let payload = crate::commands::ai_diagnose(st, app.clone(), session_id, String::new()).await?;
            Ok(serde_json::to_string_pretty(&payload).unwrap_or_default())
        }
        "disconnect" => {
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            crate::commands::ssh_disconnect(st, session_id).await?;
            Ok("已断开".to_string())
        }
        "upload_file" => {
            use base64::Engine;
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            let remote_path = args.get("remote_path").and_then(|v| v.as_str()).ok_or("缺少 remote_path")?.to_string();
            let data_b64 = args.get("data_base64").and_then(|v| v.as_str()).ok_or("缺少 data_base64")?.to_string();
            crate::commands::sftp_upload_data(st, session_id, remote_path, data_b64).await
        }
        "download_file" => {
            use base64::Engine;
            const MAX_DL: usize = 1024 * 1024;
            let session_id = args.get("session_id").and_then(|v| v.as_u64()).ok_or("缺少 session_id")?;
            let remote_path = args.get("remote_path").and_then(|v| v.as_str()).ok_or("缺少 remote_path")?.to_string();
            let sftp = crate::commands::open_sftp(&st, session_id).await?;
            let data = sftp.read(&remote_path).await.map_err(|e| format!("读取失败: {e}"))?;
            if data.len() > MAX_DL {
                return Err(format!("文件 {} 字节，超过 1MB 限制；请用 exec_command 分段读取", data.len()));
            }
            Ok(base64::engine::general_purpose::STANDARD.encode(data))
        }
        other => Err(format!("未知工具: {other}")),
    }
}
