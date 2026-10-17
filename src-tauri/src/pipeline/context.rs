//! Context assembly and token-budget trimming (PRD §2.4 stage 5).
//! Single LLM context <= 6000 tokens (estimated).

use crate::pipeline::pipeline::{ErrorBlock, ScreenBuffer, SystemInfo};

pub const MAX_CONTEXT_TOKENS: usize = 6000;
pub const CONTEXT_MARGIN_LINES: usize = 20;

/// Rough token estimate: ASCII ~4 chars/token, CJK ~1 char/token.
pub fn estimate_tokens(text: &str) -> usize {
    let ascii = text.bytes().filter(|b| b.is_ascii()).count();
    let non_ascii = text.len() - ascii;
    ascii / 4 + non_ascii
}

pub struct BuiltContext {
    pub text: String,
    pub truncated: bool,
    pub fallback: bool,
    pub estimated_tokens: usize,
}

/// Build the LLM-ready terminal context around error blocks, honoring the
/// token budget. When nothing was flagged, falls back to the most recent
/// lines (PRD: "最近 N 行" degradation with prompt_parse=fallback).
pub fn build_context(
    screen: &ScreenBuffer,
    error_blocks: &[ErrorBlock],
    system_info: &SystemInfo,
    user_question: &str,
) -> BuiltContext {
    let mut truncated = false;
    let mut selected: Vec<String>;

    if error_blocks.is_empty() && user_question.trim().is_empty() {
        // No explicit error and no question: use the tail of the screen.
        let n = 30.min(screen.lines.len());
        selected = screen.lines.iter().skip(screen.lines.len() - n).cloned().collect();
    } else if error_blocks.is_empty() {
        // User asked a question: recent context around the end.
        let n = 40.min(screen.lines.len());
        selected = screen.lines.iter().skip(screen.lines.len() - n).cloned().collect();
    } else {
        // Error-focused: keep CONTEXT_MARGIN_LINES before/after each block.
        let mut keep = vec![false; screen.lines.len()];
        for b in error_blocks {
            let start = b.start_line.saturating_sub(CONTEXT_MARGIN_LINES);
            let end = (b.start_line + b.line_count + CONTEXT_MARGIN_LINES)
                .min(screen.lines.len());
            for k in keep.iter_mut().take(end).skip(start) {
                *k = true;
            }
        }
        selected = screen            .lines
            .iter()
            .zip(keep.iter())
            .filter(|(_, k)| **k)
            .map(|(l, _)| l.clone())
            .collect();
    }

    if selected.is_empty() {
        return BuiltContext {
            text: "（当前终端无输出）".to_string(),
            truncated: false,
            fallback: true,
            estimated_tokens: estimate_tokens("（当前终端无输出）"),
        };
    }

    // Token budget: trim from head and tail, marking the cut.
    let mut budget = MAX_CONTEXT_TOKENS.saturating_sub(
        estimate_tokens(&format_system_context(system_info))
            + estimate_tokens(user_question)
            + 200,
    );

    // Drop whole lines from the middle first when way over budget.
    while estimate_tokens(&selected.join("\n")) > budget * 2 && selected.len() > 40 {
        selected.remove(0);
        selected.pop();
        truncated = true;
    }

    // Line-level tail truncation.
    let mut out_lines: Vec<String> = Vec::new();
    for line in &selected {
        let t = estimate_tokens(line);
        if t > budget {
            out_lines.push("[... N lines truncated ...]".to_string());
            truncated = true;
            break;
        }
        budget -= t;
        out_lines.push(line.clone());
    }

    let text = out_lines.join("\n");
    let estimated_tokens = estimate_tokens(&text);
    BuiltContext {
        text,
        truncated,
        fallback: false,
        estimated_tokens,
    }
}

pub fn format_system_context(info: &SystemInfo) -> String {
    let mut s = String::from("[系统上下文（来自终端探测，可信）]\n");
    s.push_str(&format!("OS: {}\n", info.os));
    s.push_str(&format!("Kernel: {}\n", info.kernel));
    s.push_str(&format!("Shell: {}\n", info.shell));
    s.push_str(&format!("User: {}\n", info.user));
    s.push_str(&format!("CWD: {}\n", info.cwd));
    if !info.package_manager.is_empty() {
        s.push_str(&format!("PackageManager: {}\n", info.package_manager));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_estimate() {
        assert_eq!(estimate_tokens("abcdefgh"), 2); // 8 ascii / 4
        assert_eq!(estimate_tokens("你好世界"), 4); // 4 CJK = 4
    }

    #[test]
    fn empty_context_placeholder() {
        let screen = ScreenBuffer::new();
        let info = SystemInfo::default();
        let c = build_context(&screen, &[], &info, "");
        assert!(c.fallback);
        assert!(c.text.contains("无输出"));
    }

    #[test]
    fn error_focus_keeps_margin() {
        use crate::pipeline::errors::ErrorLevel;
        let mut screen = ScreenBuffer::new();
        for i in 0..100 {
            screen.push_line(&format!("line {i}"));
        }
        screen.push_line("E: broken package");
        for i in 0..10 {
            screen.push_line(&format!("tail {i}"));
        }
        // Error block starting at line 100 (the "E:" line), 1 line long.
        let blocks = vec![ErrorBlock {
            id: "t1".into(),
            start_line: 100,
            line_count: 1,
            level: ErrorLevel::Red,
            rule: "apt-error".into(),
            preview: "E: broken package".into(),
        }];
        let info = SystemInfo::default();
        let c = build_context(&screen, &blocks, &info, "");
        assert!(c.text.contains("E: broken package"));
        assert!(!c.text.contains("line 5"));
    }
}
