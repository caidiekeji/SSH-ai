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
        self.prompt_tokens + self.completion_tokens
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
async fn read_sse(
    stream: impl futures::Stream<Item = reqwest::Result<bytes::Bytes>>,
    mut on_event: impl FnMut(&str),
) -> Result<(), ProviderError> {
    let idle = Duration::from_secs(180); // 3 min between chunks
    let total = Duration::from_secs(600); // 10 min whole stream
    let started = std::time::Instant::now();
    let mut buffer = String::new();
    let mut stream = Box::pin(stream);
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
                            if !data.is_empty() {
                                on_event(data);
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
            Ok(None) => break,
        }
    }
    Ok(())
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

        let mut accumulated = String::new();
        let mut usage: Option<Usage> = None;
        let stream = resp.bytes_stream();
        let acc = &mut accumulated;
        let usage_slot = &mut usage;
        read_sse(stream, |data| {
            if data == "[DONE]" {
                return;
            }
            if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                if let Some(c) = chunk.choices.first().and_then(|c| c.delta.content.clone()) {
                    on_chunk(&c);
                    acc.push_str(&c);
                }
                // Reasoning models: fold the thinking trace into the parsed
                // text so a JSON plan hiding inside it is still found.
                if let Some(r) = chunk
                    .choices
                    .first()
                    .and_then(|c| c.delta.reasoning_content.clone())
                    .or_else(|| {
                        chunk
                            .choices
                            .first()
                            .and_then(|c| c.delta.reasoning.clone())
                    })
                {
                    acc.push_str(&r);
                }
                if let Some(u) = chunk.usage {
                    *usage_slot = Some(u);
                }
            }
        })
        .await?;
        Ok(ChatOutcome {
            text: accumulated,
            complete: true,
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

        let mut accumulated = String::new();
        let mut prompt_tokens: u32 = 0;
        let mut completion_tokens: u32 = 0;
        let stream = resp.bytes_stream();
        let acc = &mut accumulated;
        let pt = &mut prompt_tokens;
        let ct = &mut completion_tokens;
        read_sse(stream, |data| {
            if let Ok(chunk) = serde_json::from_str::<AnthropicChunk>(data) {
                if chunk.kind == "content_block_delta" {
                    if let Some(text) = chunk.delta.and_then(|d| d.text) {
                        on_chunk(&text);
                        acc.push_str(&text);
                    }
                }
                // `message_start` carries the input token count.
                if let Some(u) = chunk.message.and_then(|m| m.usage) {
                    *pt = u.input_tokens;
                    *ct = u.output_tokens;
                }
                // `message_delta` carries the final output token count.
                if let Some(u) = chunk.usage {
                    *ct = u.output_tokens;
                }
            }
        })
        .await?;
        let usage = if prompt_tokens == 0 && completion_tokens == 0 {
            None
        } else {
            Some(Usage {
                prompt_tokens,
                completion_tokens,
            })
        };
        Ok(ChatOutcome {
            text: accumulated,
            complete: true,
            usage,
        })
    }
}
