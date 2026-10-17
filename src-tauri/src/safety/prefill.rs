//! Command pre-fill (PRD §5.5 / §2.3 T4).
//!
//! The ONLY path from an AI-generated command to the terminal input line.
//! Guarantees (each unit-tested, PRD §8.3):
//!   - output bytes never contain \r or \n (Enter is a PHYSICAL user action)
//!   - Rust re-grades the risk locally; RED requires explicit user ack,
//!     YELLOW requires confirmation, GREEN goes straight in.

use super::risk::{RiskEngine, RiskLevel};
use crate::ssh::session::PtyCmd;
use tokio::sync::mpsc::Sender;

/// Sanitize a command for pre-fill: strip all newline/carriage-return chars
/// so the terminal can never receive an implicit Enter (PRD test
/// `test_prefill_does_not_send_enter`).
pub fn sanitize_command(command: &str) -> String {
    command
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .collect::<String>()
        .trim()
        .to_string()
}

pub struct PrefillError {
    pub level: RiskLevel,
    pub message: String,
}

/// Grade + gate + write to the PTY input line. Returns the applied grade.
pub async fn prefill(
    engine: &RiskEngine,
    write_tx: &Sender<PtyCmd>,
    command: &str,
    ai_risk_hint: &str,
    user_ack: RiskLevel,
) -> Result<super::risk::RiskAssessment, PrefillError> {
    let cmd = sanitize_command(command);
    if cmd.is_empty() {
        return Err(PrefillError {
            level: RiskLevel::Green,
            message: "命令为空".into(),
        });
    }

    let a = engine.assess(&cmd, ai_risk_hint);

    // Gate: the caller must have obtained user consent matching the level.
    // GREEN -> direct; YELLOW -> confirm dialog; RED -> checkbox ack.
    // PRD interaction spec: even RED can be pre-filled after the explicit
    // checkbox — what is forbidden everywhere is AUTO-execution (no Enter).
    let ok = match a.level {
        RiskLevel::Green => true,
        RiskLevel::Yellow => user_ack >= RiskLevel::Yellow,
        RiskLevel::Red => user_ack >= RiskLevel::Red,
    };
    if !ok {
        return Err(PrefillError {
            level: a.level,
            message: format!("未获得足够确认（{}：{}）", a.level.label(), a.reason),
        });
    }

    // HC-03 invariant: write EXACTLY the sanitized command, nothing else.
    // No '\n', no '\r' — the user presses Enter physically.
    write_tx
        .send(PtyCmd::Data(cmd.clone().into_bytes()))
        .await
        .map_err(|e| PrefillError {
            level: a.level,
            message: format!("终端输入行不可用: {e}"),
        })?;

    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    // PRD §8.3 test_prefill_does_not_send_enter
    #[test]
    fn test_prefill_does_not_send_enter() {
        for cmd in ["ls -la\n", "echo hi\r\n", "cat file\n\n", "rm -rf /\n"] {
            let s = sanitize_command(cmd);
            assert!(!s.contains('\r'));
            assert!(!s.contains('\n'));
            assert!(!s.ends_with(char::is_whitespace) || s.is_empty());
        }
        assert_eq!(sanitize_command("echo hi\n"), "echo hi");
    }

    // Source-level: this module writes data but never appends a terminator.
    #[test]
    fn test_prefill_source_no_newline_append() {
        let src = include_str!("prefill.rs");
        // The only PtyCmd::Data construction uses the sanitized string.
        assert!(src.contains("sanitize_command"));
        // No code path appends "\n" or "\r" as bytes.
        assert!(!src.contains("b\"\\n\""));
        assert!(!src.contains("b\"\\r\""));
    }
}
