//! LLMProvider trait + OpenAI / Anthropic adapters (PRD §3.1).
//! All requests go DIRECTLY from the client to the user-configured base_url
//! (HC-04). Streaming via SSE, parsed incrementally.

use super::error::ProviderError;
use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct ChatOptions {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// Token accounting for one model call.
///
/// Not every provider reports usage (some OpenAI-compatible gateways omit
/// it unless `stream_options.include_usage` is set), so the field is
/// optional. It exists so a task can be costed instead of merely counted:
/// without it, "the agent made 40 calls" says nothing about what it cost.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    // Serialized to the UI in camelCase (`promptTokens`), but parsed from
    // the provider's snake_case payload (`prompt_tokens`). `rename` sets the
    // canonical name, `alias` keeps the provider spelling accepted.
    #[serde(default, rename = "promptTokens", alias = "prompt_tokens")]
    pub prompt_tokens: u32,
    #[serde(default, rename = "completionTokens", alias = "completion_tokens")]
    pub completion_tokens: u32,
}

impl Usage {
    pub fn total(&self) -> u32 {
        // Saturating arithmetic: a wrapped u32 would make a huge bill look
        // tiny and let the task bypass the MAX_TOKENS ceiling.
        self.prompt_tokens.saturating_add(self.completion_tokens)
    }
}

/// The result of one model call.
#[derive(Debug, Clone, Default)]
pub struct ChatOutcome {
    /// Accumulated text.
    pub text: String,
    /// false on stream interruption; partial content is preserved.
    pub complete: bool,
    /// Token usage, when the provider reported it.
    pub usage: Option<Usage>,
}

#[async_trait]
pub trait LLMProvider: Send + Sync {
    /// List models. 404 => ProviderError::NoModelList (caller switches to
    /// manual input, PRD S3_MANUAL).
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;

    /// Streaming chat. Partial content is preserved on interruption
    /// (PRD §3.3).
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOptions,
        on_chunk: &mut (dyn for<'a> FnMut(&'a str) + Send),
    ) -> Result<ChatOutcome, ProviderError>;
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by both adapters
// ---------------------------------------------------------------------------

/// Short-request client (model listing, connectivity probe). Also a
/// singleton, so the TLS session is reused across calls.
static SHORT_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client(timeout: Duration) -> &'static reqwest::Client {
    SHORT_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(timeout)
            // HC-04: direct connection only — no system/env proxy (an API key
            // must never transit a proxy we don't control) and no redirects.
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("reqwest client")
    })
}

/// Streaming client: NO total deadline (reqwest's `timeout` covers the whole
/// body read and would kill long SSE generations with "error decoding
/// response body"). Instead: connect timeout + TCP keepalive here, and a
/// per-chunk idle watchdog + wall-clock cap enforced in read_sse.
///
/// The client is a PROCESS-WIDE SINGLETON: an Agent task issues up to 40
/// model calls, and a fresh `reqwest::Client` per call would mean a fresh
/// TCP connection plus a fresh TLS handshake every time — the dominant
/// per-call latency. Reusing one client keeps the connection pool alive, so
/// a task's second call reuses the already-negotiated TLS session.
static STREAM_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn stream_client() -> &'static reqwest::Client {
    STREAM_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .tcp_keepalive(Duration::from_secs(30))
            // Keep the pooled connection usable across calls; without this
            // the pool may drop it right after each response.
            .pool_idle_timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("reqwest client")
    })
}

async fn map_response_error(resp: reqwest::Response) -> ProviderError {
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await.unwrap_or_default();
    match status {
        401 | 403 => ProviderError::AuthInvalid,
        404 => ProviderError::NoModelList,
        429 => ProviderError::RateLimit { retry_after },
        _ => ProviderError::Http { status, body },
    }
}

/// Parse an SSE byte stream, invoking `on_event` per data line payload.
/// Bounded by TWO watchdogs (C5): `idle` = max gap between chunks (long
/// model thinking pauses are normal), `total` = whole-stream wall clock.
///
/// `on_event` returns `false` to STOP reading immediately (e.g. on the
/// `[DONE]` / `message_stop` sentinel). Previously only the closure
/// returned and `read_sse` kept waiting for more bytes forever.
/// The returned bool says whether the stream ended on a clean EOF
/// (`Ok(None)`); callers use it to flag a truncated response.
async fn read_sse(
    stream: impl futures::Stream<Item = reqwest::Result<bytes::Bytes>>,
    mut on_event: impl FnMut(&str) -> bool,
) -> Result<bool, ProviderError> {
    let idle = Duration::from_secs(180); // 3 min between chunks
    let total = Duration::from_secs(600); // 10 min whole stream
    let started = std::time::Instant::now();
    let mut buffer = String::new();
    let mut stream = Box::pin(stream);
    let mut clean_eof = false; // 是否以对端干净关闭（Ok(None)）结束
    loop {
        match tokio::time::timeout(idle, stream.as_mut().next()).await {
            // Idle watchdog: connection alive but silent too long.
            Err(_) => {
                return Err(ProviderError::StreamInterrupted(format!(
                    "读取超时：{idle_secs} 秒内未收到任何新数据（模型长时间无响应或连接被中断）",
                    idle_secs = idle.as_secs()
                )));
            }
            Ok(Some(Ok(chunk))) => {
                if started.elapsed() > total {
                    return Err(ProviderError::StreamInterrupted(
                        "流式响应总时长超过 10 分钟上限，已中止".into(),
                    ));
                }
                // Normalize CRLF → LF: some vendors split SSE events with
                // \r\n\r\n, which the "\n\n" separator match would never hit.
                let text = String::from_utf8_lossy(&chunk)
                    .replace("\r\n", "\n")
                    .replace('\r', "\n");
                buffer.push_str(&text);
                // SSE events separated by blank lines.
                while let Some(pos) = buffer.find("\n\n") {
                    let event_text: String = buffer.drain(..pos + 2).collect();
                    for line in event_text.lines() {
                        if let Some(data) = line.strip_prefix("data:") {
                            let data = data.trim();
                            if !data.is_empty() && !on_event(data) {
                                // 回调要求终止：真正停止读取，不再等待后续字节
                                return Ok(false);
                            }
                        }
                    }
                }
            }
            Ok(Some(Err(e))) => {
                let detail = if e.is_timeout() {
                    "连接超时".to_string()
                } else {
                    e.to_string()
                };
                return Err(ProviderError::StreamInterrupted(detail));
            }
            Ok(None) => {
                clean_eof = true; // 对端干净关闭
                break;
            }
        }
    }
    // 尾部残留：循环结束时 buffer 可能还剩未以空行结尾的完整 data: 行
    //（对端关闭前最后一条事件没补空行）。逐行处理，避免丢掉最后一个 delta。
    if clean_eof {
        for line in buffer.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() && !on_event(data) {
                    break; // 见到终止哨兵，停止处理尾部残留
                }
            }
        }
    }
    Ok(clean_eof)
}

// ---------------------------------------------------------------------------
// OpenAI adapter (covers all OpenAI-compatible vendors)
// ---------------------------------------------------------------------------

pub struct OpenAIAdapter {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(serde::Deserialize)]
struct OpenAiModelsResp {
    data: Vec<OpenAiModelRef>,
}

#[derive(serde::Deserialize)]
struct OpenAiModelRef {
    id: String,
}

#[derive(serde::Deserialize)]
struct OpenAiChunk {
    #[serde(default)]
    choices: Vec<OpenAiChunkChoice>,
    /// Present only on the final chunk when `stream_options.include_usage`
    /// is set. OpenAI's field names match `Usage` exactly.
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(serde::Deserialize)]
struct OpenAiChunkChoice {
    delta: OpenAiDelta,
    /// 仅最后一个 chunk 携带；`length` / `content_filter` 表示被截断，
    /// 据此把 `ChatOutcome.complete` 置为 false。多数 chunk 没有该字段，
    /// 故用 `#[serde(default)]` 容错。
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpenAiDelta {
    content: Option<String>,
    /// Reasoning models (DeepSeek-R1, QwQ, o1/o3, …) emit the actual answer
    /// in a reasoning field rather than `content`. Capturing it — but only
    /// into the parsed text, never into the streamed UI text — prevents the
    /// planner/step JSON from being lost when such a model is the Agent
    /// backend (which otherwise surfaces as "未返回可解析的 JSON").
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
}

#[async_trait]
impl LLMProvider for OpenAIAdapter {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let url = format!("{}/models", self.base_url.trim_end_matches('/'));
        let resp = client(Duration::from_secs(15))
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::Network(e.to_string())
                }
            })?;
        if !resp.status().is_success() {
            return Err(map_response_error(resp).await);
        }
        let parsed: OpenAiModelsResp = resp
            .json()
            .await
            .map_err(|e| ProviderError::Http { status: 200, body: e.to_string() })?;
        Ok(parsed
            .data
            .into_iter()
            .map(|m| ModelInfo { id: m.id })
            .collect())
    }

    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOptions,
        on_chunk: &mut (dyn for<'a> FnMut(&'a str) + Send),
    ) -> Result<ChatOutcome, ProviderError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            "temperature": opts.temperature.unwrap_or(0.2),
            "max_tokens": opts.max_tokens.unwrap_or(2048),
            // Ask for token accounting. Gateways that do not support the
            // field ignore it; the ones that do now let us cost a task.
            "stream_options": { "include_usage": true },
        });
        let resp = stream_client()
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::Network(e.to_string())
                }
            })?;
        if !resp.status().is_success() {
            return Err(map_response_error(resp).await);
        }

        // 1) content 与 reasoning 用两个独立缓冲区，绝不混在一起：
        //    acc 只收 delta.content（并推给流式 UI），reasoning 只收推理字段。
        //    这样 find('{')/rfind('}') 不会误取思考过程里的伪 JSON 计划。
        let mut acc = String::new();
        let mut reasoning = String::new();
        let mut usage: Option<Usage> = None;
        let mut finish_reason: Option<String> = None; // 2) 最后一个非 null 的 finish_reason
        let mut saw_done = false; // 3) 是否见到 [DONE] 终止哨兵
        let stream = resp.bytes_stream();
        let acc_ref = &mut acc;
        let reasoning_ref = &mut reasoning;
        let usage_slot = &mut usage;
        let finish_slot = &mut finish_reason;
        let done_ref = &mut saw_done;
        let clean_eof = read_sse(stream, |data| {
            if data == "[DONE]" {
                *done_ref = true;
                return false; // 3) 真正终止 read_sse，不再空等后续字节
            }
            if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                if let Some(choice) = chunk.choices.first() {
                    // 2) 记录最后一个非 null 的 finish_reason
                    if choice.finish_reason.is_some() {
                        *finish_slot = choice.finish_reason.clone();
                    }
                    // 正式 content：进 acc，并推给流式 UI
                    if let Some(c) = &choice.delta.content {
                        on_chunk(c.as_str());
                        acc_ref.push_str(c);
                    }
                    // 推理文本：只进独立缓冲区，绝不进 on_chunk、也不进 acc
                    if let Some(r) = choice
                        .delta
                        .reasoning_content
                        .as_ref()
                        .or(choice.delta.reasoning.as_ref())
                    {
                        reasoning_ref.push_str(r);
                    }
                }
                // 7) 仅当新的 usage.total() > 0 时覆盖，避免被全 0 的 usage 抹掉
                if let Some(u) = chunk.usage {
                    if u.total() > 0 {
                        *usage_slot = Some(u);
                    }
                }
            }
            true
        })
        .await?;

        // 1) acc 非空则只用 acc；否则才回退用 reasoning（纯推理模型）
        let text = if !acc.is_empty() { acc } else { reasoning };

        let mut complete = true;
        // 2) finish_reason == length / content_filter 表示被截断
        if matches!(finish_reason.as_deref(), Some("length") | Some("content_filter")) {
            complete = false;
        }
        // 3) 既没见到 [DONE]、又不是对端干净关闭 → 视为中断
        if !saw_done && !clean_eof {
            complete = false;
        }
        // 6) 空回复且无错误 → 视为未完成
        if text.is_empty() {
            complete = false;
        }
        Ok(ChatOutcome {
            text,
            complete,
            usage,
        })
    }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

pub struct AnthropicAdapter {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(serde::Deserialize)]
struct AnthropicChunk {
    #[serde(rename = "type")]
    kind: String,
    delta: Option<AnthropicDelta>,
    /// Anthropic reports input tokens in `message_start` and output tokens
    /// in `message_delta`.
    #[serde(default)]
    message: Option<AnthropicMessageStart>,
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(serde::Deserialize)]
struct AnthropicMessageStart {
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(serde::Deserialize)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

#[derive(serde::Deserialize)]
struct AnthropicDelta {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    /// 扩展思考（thinking_delta）的文本，只进独立 reasoning 缓冲区，
    /// 绝不混进正式 content，避免污染 JSON 解析。
    #[serde(default)]
    thinking: Option<String>,
    /// message_delta 里的 stop_reason（等价 OpenAI 的 finish_reason）。
    #[serde(default)]
    stop_reason: Option<String>,
}

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[async_trait]
impl LLMProvider for AnthropicAdapter {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // No public /models endpoint: preset list (PRD §3.1/§3.2).
        Ok(super::specs::ANTHROPIC_PRESET_MODELS
            .iter()
            .map(|m| ModelInfo { id: m.to_string() })
            .collect())
    }

    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOptions,
        on_chunk: &mut (dyn for<'a> FnMut(&'a str) + Send),
    ) -> Result<ChatOutcome, ProviderError> {
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        // Anthropic requires system as a top-level field.
        let (system, rest): (Vec<_>, Vec<_>) = messages
            .iter()
            .partition(|m| m.role == "system");
        let body = serde_json::json!({
            "model": self.model,
            "system": system.iter().map(|m| m.content.clone()).collect::<Vec<_>>().join("\n"),
            "messages": rest,
            "stream": true,
            "max_tokens": opts.max_tokens.unwrap_or(2048),
            "temperature": opts.temperature.unwrap_or(0.2),
        });
        let resp = stream_client()
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProviderError::Timeout
                } else {
                    ProviderError::Network(e.to_string())
                }
            })?;
        if !resp.status().is_success() {
            return Err(map_response_error(resp).await);
        }

        // 1) content 与 reasoning 分离：acc 只收正式 text，reasoning 只收
        //    扩展思考文本；思考文本绝不进 on_chunk / acc。
        let mut acc = String::new();
        let mut reasoning = String::new();
        let mut prompt_tokens: u32 = 0;
        let mut completion_tokens: u32 = 0;
        let mut stop_reason: Option<String> = None; // 2) 最后一个非 null 的 stop_reason
        let mut saw_done = false; // 3) 是否见到 message_stop 终止哨兵
        let mut error_body: Option<String> = None; // 5) 流内 error 事件
        let stream = resp.bytes_stream();
        let acc_ref = &mut acc;
        let reasoning_ref = &mut reasoning;
        let pt = &mut prompt_tokens;
        let ct = &mut completion_tokens;
        let stop_slot = &mut stop_reason;
        let done_ref = &mut saw_done;
        let error_slot = &mut error_body;
        let clean_eof = read_sse(stream, |data| {
            // 5) 先用 Value 识别控制类事件，兼容各网关的 error / message_stop
            //    结构差异（例如顶层 type 直接是 overloaded_error）。
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if kind == "error" || kind == "overloaded_error" {
                    let msg = v
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .or_else(|| {
                            v.get("error")
                                .and_then(|e| e.get("type"))
                                .and_then(|t| t.as_str())
                        })
                        .or_else(|| v.get("message").and_then(|m| m.as_str()))
                        .unwrap_or(kind)
                        .to_string();
                    *error_slot = Some(msg);
                    return false; // 终止读取，随后由 chat_stream 返回 Err
                }
                if kind == "message_stop" {
                    *done_ref = true; // 3) 正常终止哨兵
                    return false;
                }
            }
            // 正常数据事件用强类型解析
            if let Ok(chunk) = serde_json::from_str::<AnthropicChunk>(data) {
                match chunk.kind.as_str() {
                    "content_block_delta" => {
                        if let Some(d) = &chunk.delta {
                            // 1) 正式 content 进 acc / UI；思考文本只进 reasoning
                            if d.kind.as_deref() != Some("thinking_delta") {
                                if let Some(text) = &d.text {
                                    on_chunk(text.as_str());
                                    acc_ref.push_str(text);
                                }
                            }
                            if let Some(t) = &d.thinking {
                                reasoning_ref.push_str(t);
                            }
                        }
                    }
                    "message_start" => {
                        // 7) 仅在 usage.total() > 0 时覆盖，避免被全 0 抹掉
                        if let Some(u) = chunk.message.as_ref().and_then(|m| m.usage.as_ref()) {
                            if u.input_tokens + u.output_tokens > 0 {
                                *pt = u.input_tokens;
                                *ct = u.output_tokens;
                            }
                        }
                    }
                    "message_delta" => {
                        // 2) 记录最后一个非 null 的 stop_reason
                        if let Some(sr) = chunk.delta.as_ref().and_then(|d| d.stop_reason.as_ref()) {
                            *stop_slot = Some(sr.clone());
                        }
                        // 7) 仅在 usage.total() > 0 时覆盖
                        if let Some(u) = chunk.usage.as_ref() {
                            if u.input_tokens + u.output_tokens > 0 {
                                *ct = u.output_tokens;
                            }
                        }
                    }
                    _ => {}
                }
            }
            true
        })
        .await?;

        // 5) 流内错误事件 → 返回 Err（复用现有 Http 变体，不新增变体）
        if let Some(body) = error_body {
            return Err(ProviderError::Http { status: 200, body });
        }

        // 1) acc 非空则只用 acc；否则才回退用 reasoning
        let text = if !acc.is_empty() { acc } else { reasoning };
        let usage = if prompt_tokens == 0 && completion_tokens == 0 {
            None
        } else {
            Some(Usage {
                prompt_tokens,
                completion_tokens,
            })
        };

        let mut complete = true;
        // 2) stop_reason == max_tokens 表示被截断（等价 OpenAI 的 length）
        if matches!(stop_reason.as_deref(), Some("max_tokens")) {
            complete = false;
        }
        // 3) 既没见到 message_stop、又不是对端干净关闭 → 视为中断
        if !saw_done && !clean_eof {
            complete = false;
        }
        // 6) 空回复且无错误 → 视为未完成
        if text.is_empty() {
            complete = false;
        }
        Ok(ChatOutcome {
            text,
            complete,
            usage,
        })
    }
}
