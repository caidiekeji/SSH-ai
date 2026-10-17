//! Error feature extraction (PRD §2.4 stage 4).
//! Regex + heuristics. False positives never block: error blocks are UI
//! highlights only; whether to send them to the AI is the user's decision.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorLevel {
    Red,
    Yellow,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorFeature {
    pub level: ErrorLevel,
    /// Short reason (rule name) for tooltip.
    pub rule: String,
}

struct Rule {
    level: ErrorLevel,
    name: &'static str,
    re: Regex,
}

fn rules() -> &'static Vec<Rule> {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mk = |level: ErrorLevel, name: &'static str, pat: &str| Rule {
            level,
            name,
            re: Regex::new(pat).expect("valid rule regex"),
        };
        vec![
            mk(ErrorLevel::Red, "python-traceback", r"Traceback \(most recent call last\)"),
            mk(ErrorLevel::Red, "npm-err", r"npm ERR!"),
            mk(ErrorLevel::Red, "permission-denied", r"(?i)permission denied"),
            mk(ErrorLevel::Red, "command-not-found", r"(?i)command not found"),
            mk(ErrorLevel::Red, "no-such-file", r"(?i)no such file or directory"),
            mk(ErrorLevel::Red, "explicit-error", r"(?i)^\s*error:"),
            mk(ErrorLevel::Red, "explicit-error-caps", r"^\s*ERROR:"),
            mk(ErrorLevel::Red, "apt-error", r"^E: "),
            mk(ErrorLevel::Red, "panic", r"(?i)\bpanic:\s"),
            mk(ErrorLevel::Red, "fatal", r"(?i)^\s*fatal:"),
            mk(ErrorLevel::Red, "failed-to", r"(?i)\bfailed to (start|load|bind|connect|resolve|open|create)\b"),
            mk(ErrorLevel::Red, "segfault", r"(?i)segmentation fault"),
            mk(ErrorLevel::Red, "core-dumped", r"(?i)\(core dumped\)"),
            mk(ErrorLevel::Red, "k8s-error", r"(?i)^Error from server"),
            mk(ErrorLevel::Red, "systemd-failed", r"(?i)\.service: Failed|Failed with result"),
            mk(ErrorLevel::Red, "connection-refused", r"(?i)connection refused"),
            mk(ErrorLevel::Red, "docker-error", r"(?i)^error response from daemon"),
            mk(ErrorLevel::Yellow, "warning", r"(?i)^\s*warn(ing)?:"),
            mk(ErrorLevel::Yellow, "deprecated", r"(?i)deprecated"),
            mk(ErrorLevel::Yellow, "apt-warning", r"^W: "),
            mk(ErrorLevel::Yellow, "cannot", r"(?i)^\s*cannot "),
        ]
    })
}

/// Classify a single line. Returns the first matching rule.
pub fn classify_line(line: &str) -> Option<ErrorFeature> {
    let t = line.trim_end();
    if t.is_empty() {
        return None;
    }
    for r in rules() {
        if r.re.is_match(t) {
            return Some(ErrorFeature {
                level: r.level,
                rule: r.name.to_string(),
            });
        }
    }
    // Heuristic: many consecutive stack-frame lines belong to a trace block,
    // handled by the pipeline (block assembly), not here.
    None
}

/// Stack-frame heuristic: lines like "  at ..." / "File \"...\", line ..." /
/// "  ..." rust/python/java frames extend an existing error block.
pub fn looks_like_stack_frame(line: &str) -> bool {
    let t = line.trim_start();
    if t.is_empty() {
        return false;
    }
    (t.starts_with("at ") && line.starts_with(' '))
        || t.starts_with("File \"")
        || t.starts_with("...")
        || t.starts_with("^")
        || t.starts_with("During handling")
        || t.starts_with("The above exception")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prd_required_patterns() {
        // PRD M3 acceptance: apt error, systemctl failure, npm ERR!, Traceback.
        assert_eq!(classify_line("E: Unable to locate package foo").unwrap().rule, "apt-error");
        assert!(classify_line("npm ERR! code ELIFECYCLE").unwrap().level == ErrorLevel::Red);
        assert!(classify_line("Traceback (most recent call last):").unwrap().level == ErrorLevel::Red);
        assert!(classify_line("Failed to start nginx.service").unwrap().level == ErrorLevel::Red);
    }

    #[test]
    fn levels() {
        assert!(classify_line("W: some apt warning").unwrap().level == ErrorLevel::Yellow);
        assert!(classify_line("Permission denied").unwrap().level == ErrorLevel::Red);
        assert!(classify_line("-bash: frobnicate: command not found").unwrap().level == ErrorLevel::Red);
        assert!(classify_line("total 42K").is_none());
        assert!(classify_line("drwxr-xr-x 2 root root 4096 etc").is_none());
    }
}
