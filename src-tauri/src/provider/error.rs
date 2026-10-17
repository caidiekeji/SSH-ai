//! Provider error semantics (PRD §3.3).

use std::fmt;

#[derive(Debug)]
pub enum ProviderError {
    /// 401 — never retried; user must fix the key.
    AuthInvalid,
    /// 404 on /models — provider has no model-list endpoint.
    NoModelList,
    /// 429 — show Retry-After if present.
    RateLimit { retry_after: Option<String> },
    Timeout,
    Network(String),
    /// Non-2xx with status + first 200 chars of body.
    Http { status: u16, body: String },
    /// Stream broke mid-response; partial content is preserved by the caller.
    StreamInterrupted(String),
    Config(String),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // PRD §3.3 user-visible messages.
            ProviderError::AuthInvalid => write!(f, "API Key 无效或已过期"),
            ProviderError::NoModelList => write!(f, "该 Provider 不支持模型列表，请手动输入模型名"),
            ProviderError::RateLimit { retry_after } => match retry_after {
                Some(secs) => write!(f, "请求频率超限，请 {secs} 秒后重试"),
                None => write!(f, "请求频率超限，请稍后重试"),
            },
            ProviderError::Timeout => write!(f, "连接超时，请检查网络或 base_url"),
            ProviderError::Network(d) => write!(f, "网络错误：{d}"),
            ProviderError::Http { status, body } => {
                write!(f, "HTTP {status}：{}", truncate_body(body))
            }
            ProviderError::StreamInterrupted(d) => {
                write!(f, "响应中断，已生成的部分保留在卡片中（{d}）")
            }
            ProviderError::Config(d) => write!(f, "配置错误：{d}"),
        }
    }
}

fn truncate_body(body: &str) -> String {
    let t = body.trim();
    let mut out: String = t.chars().take(200).collect();
    if out.len() < t.len() {
        out.push('…');
    }
    out
}

impl std::error::Error for ProviderError {}
