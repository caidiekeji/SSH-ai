//! OS Keychain credential storage (PRD §5.3).
//! HARD RULE: no plaintext fallback. If the system credential store is
//! unavailable, secrets are simply not persisted.

use keyring::Entry;

const SERVICE: &str = "ai-ssh-assistant";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("系统凭据库不可用: {e}"))
}

/// Store a secret. Returns Err (never degrades to plaintext) on failure.
pub fn set_secret(key: &str, secret: &str) -> Result<(), String> {
    let e = entry(key)?;
    e.set_password(secret)
        .map_err(|e| format!("写入系统凭据库失败: {e}"))
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let e = entry(key)?;
    match e.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取系统凭据库失败: {e}")),
    }
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    let e = entry(key)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除系统凭据库条目失败: {e}")),
    }
}

/// Log sanitizer (PRD §5.3): replace API-key-looking strings with [REDACTED].
pub fn sanitize_log(input: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static SK: OnceLock<Regex> = OnceLock::new();
    static HEX: OnceLock<Regex> = OnceLock::new();
    let sk = SK.get_or_init(|| Regex::new(r"sk-[A-Za-z0-9_\-]{8,}").expect("valid regex"));
    let hex = HEX.get_or_init(|| Regex::new(r"\b[a-fA-F0-9]{32,}\b").expect("valid regex"));
    let s = sk.replace_all(input, "[REDACTED]");
    hex.replace_all(&s, "[REDACTED]").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_not_in_logs() {
        let log = r#"request to https://api.deepseek.com/v1/models with key sk-abc123def456ghi789jk" done"#;
        let s = sanitize_log(log);
        assert!(!s.contains("sk-abc123def456ghi789jk"));
        assert!(s.contains("[REDACTED]"));

        let hex_log = "token aaaa1111bbbb2222cccc3333dddd4444 sent";
        assert!(!sanitize_log(hex_log).contains("aaaa1111bbbb2222cccc3333dddd4444"));

        // Normal log lines pass through untouched.
        let normal = "GET /models 200 OK in 123ms";
        assert_eq!(sanitize_log(normal), normal);
    }
}
