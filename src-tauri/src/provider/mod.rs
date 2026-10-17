//! Provider module: trait, adapters, specs, profiles.

pub mod adapters;
pub mod error;
pub mod specs;

use adapters::{AnthropicAdapter, LLMProvider, OpenAIAdapter};
use error::ProviderError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub id: String,
    /// Display name (user-editable, e.g. "我的 DeepSeek").
    pub name: String,
    pub provider_id: String,
    pub base_url: String,
    /// Default model id; may be empty until configured.
    pub model: String,
    /// Whether `model` came from the API list or manual input.
    pub model_source: String,
    #[serde(default)]
    pub created_at: String,
}

/// Build a provider adapter from a profile + transient API key.
/// The key is NEVER persisted here (HC-02); callers pass it from the Keychain.
pub fn make_adapter(
    profile: &ProviderProfile,
    api_key: &str,
) -> Result<Box<dyn LLMProvider>, ProviderError> {
    let spec = specs::spec_by_id(&profile.provider_id)
        .ok_or_else(|| ProviderError::Config(format!("未知 Provider: {}", profile.provider_id)))?;
    let base_url = if profile.base_url.trim().is_empty() {
        spec.default_base_url.to_string()
    } else {
        profile.base_url.trim().to_string()
    };
    if base_url.is_empty() {
        return Err(ProviderError::Config("base_url 未配置".into()));
    }
    // HC-04 + HC-06: only https, downgrade impossible.
    if !base_url.starts_with("https://") {
        return Err(ProviderError::Config(
            "base_url 必须为 https://（禁止明文传输 API Key）".into(),
        ));
    }
    match spec.family {
        specs::ProtocolFamily::OpenAI => Ok(Box::new(OpenAIAdapter {
            base_url,
            api_key: api_key.to_string(),
            model: profile.model.clone(),
        })),
        specs::ProtocolFamily::Anthropic => Ok(Box::new(AnthropicAdapter {
            base_url,
            api_key: api_key.to_string(),
            model: profile.model.clone(),
        })),
    }
}
