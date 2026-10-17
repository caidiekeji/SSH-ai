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

#[async_trait]
pub trait LLMProvider: Send + Sync {
    /// List models. 404 => ProviderError::NoModelList (caller switches to
    /// manual input, PRD S3_MANUAL).
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;

    /// Streaming chat. Returns (accumulated_text, complete?) — complete=false
    /// on stream interruption; partial content is preserved (PRD §3.3).
    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOptions,
        on_chunk: &mut (dyn for<'a> FnMut(&'a str) + Send),
    ) -> Result<(String, bool), ProviderError>;
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by both adapters
// ---------------------------------------------------------------------------

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        // HC-04: direct connection only. No proxy env overrides, no redirects
        // to foreign hosts are followed beyond default (reqwest default: 10).
        .build()
        .expect("reqwest client")
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
async fn read_sse(
    stream: impl futures::Stream<Item = reqwest::Result<bytes::Bytes>>,
    mut on_event: impl FnMut(&str),
) -> Result<(), ProviderError> {
    let mut buffer = String::new();
    let mut stream = Box::pin(stream);
    loop {
        match stream.as_mut().next().await {
            Some(Ok(chunk)) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk));
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
            Some(Err(e)) => {
                return Err(ProviderError::StreamInterrupted(e.to_string()));
            }
            None => break,
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
    choices: Vec<OpenAiChunkChoice>,
}

#[derive(serde::Deserialize)]
struct OpenAiChunkChoice {
    delta: OpenAiDelta,
}

#[derive(serde::Deserialize)]
struct OpenAiDelta {
    content: Option<String>,
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
    ) -> Result<(String, bool), ProviderError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            "temperature": opts.temperature.unwrap_or(0.2),
            "max_tokens": opts.max_tokens.unwrap_or(2048),
        });
        let resp = client(Duration::from_secs(60))
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
        let stream = resp.bytes_stream();
        let acc = &mut accumulated;
        read_sse(stream, |data| {
            if data == "[DONE]" {
                return;
            }
            if let Ok(chunk) = serde_json::from_str::<OpenAiChunk>(data) {
                if let Some(c) = chunk.choices.first().and_then(|c| c.delta.content.clone()) {
                    on_chunk(&c);
                    acc.push_str(&c);
                }
            }
        })
        .await?;
        Ok((accumulated, true))
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
    ) -> Result<(String, bool), ProviderError> {
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
        let resp = client(Duration::from_secs(60))
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
        let stream = resp.bytes_stream();
        let acc = &mut accumulated;
        read_sse(stream, |data| {
            if let Ok(chunk) = serde_json::from_str::<AnthropicChunk>(data) {
                if chunk.kind == "content_block_delta" {
                    if let Some(text) = chunk.delta.and_then(|d| d.text) {
                        on_chunk(&text);
                        acc.push_str(&text);
                    }
                }
            }
        })
        .await?;
        Ok((accumulated, true))
    }
}
