//! ProviderSpec registry (PRD §3.1/§3.2).
//! Adding a new OpenAI-compatible vendor = adding one entry, NOT an adapter.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolFamily {
    OpenAI,
    Anthropic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelListPolicy {
    /// GET {base_url}/models
    Api,
    /// Hard-coded known list + manual entry (Anthropic).
    Preset,
    /// User types the model name.
    Manual,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub family: ProtocolFamily,
    /// Empty string = user must fill it in.
    pub default_base_url: &'static str,
    pub model_list_policy: ModelListPolicy,
    pub supports_stream: bool,
}

pub const PROVIDER_SPECS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "openai",
        display_name: "OpenAI",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://api.openai.com/v1",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "anthropic",
        display_name: "Anthropic",
        family: ProtocolFamily::Anthropic,
        default_base_url: "https://api.anthropic.com",
        model_list_policy: ModelListPolicy::Preset,
        supports_stream: true,
    },
    ProviderSpec {
        id: "deepseek",
        display_name: "DeepSeek",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://api.deepseek.com",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "dashscope",
        display_name: "DashScope（Qwen）",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "zhipu",
        display_name: "智谱 GLM",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "moonshot",
        display_name: "Moonshot（Kimi）",
        family: ProtocolFamily::OpenAI,
        default_base_url: "",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "minimax",
        display_name: "MiniMax",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://api.minimax.io/v1",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "openrouter",
        display_name: "OpenRouter",
        family: ProtocolFamily::OpenAI,
        default_base_url: "https://openrouter.ai/api/v1",
        model_list_policy: ModelListPolicy::Api,
        supports_stream: true,
    },
    ProviderSpec {
        id: "custom",
        display_name: "自定义（OpenAI/Anthropic 兼容）",
        family: ProtocolFamily::OpenAI,
        default_base_url: "",
        model_list_policy: ModelListPolicy::Manual,
        supports_stream: true,
    },
];

pub fn spec_by_id(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDER_SPECS.iter().find(|s| s.id == id)
}

/// Anthropic preset models (no public /models endpoint — PRD §3.1).
pub const ANTHROPIC_PRESET_MODELS: &[&str] = &[
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-haiku-20241022",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_prd_providers_present() {
        let ids: Vec<&str> = PROVIDER_SPECS.iter().map(|s| s.id).collect();
        for want in [
            "openai",
            "anthropic",
            "deepseek",
            "dashscope",
            "zhipu",
            "moonshot",
            "minimax",
            "openrouter",
            "custom",
        ] {
            assert!(ids.contains(&want), "missing provider spec: {want}");
        }
    }

    #[test]
    fn base_urls_match_prd() {
        assert_eq!(
            spec_by_id("deepseek").unwrap().default_base_url,
            "https://api.deepseek.com"
        );
        assert_eq!(
            spec_by_id("zhipu").unwrap().default_base_url,
            "https://open.bigmodel.cn/api/coding/paas/v4"
        );
    }
}
