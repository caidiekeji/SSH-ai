//! Terminal output recognition pipeline (PRD §2.4).
//! Raw bytes -> ANSI normalization -> screen state -> error blocks.
//! The frontend renders raw bytes independently; the pipeline never blocks it.

use super::ansi::{AnsiNormalizer, LineAssembler};
use super::errors::{classify_line, looks_like_stack_frame, ErrorLevel};
use serde::Serialize;
use std::collections::VecDeque;

pub const MAX_SCREEN_LINES: usize = 10000;
const MAX_ACTIVE_BLOCK_LINES: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub kernel: String,
    pub shell: String,
    pub user: String,
    pub cwd: String,
    pub package_manager: String,
}

impl Default for SystemInfo {
    fn default() -> Self {
        Self {
            os: "unknown".into(),
            kernel: "unknown".into(),
            shell: "unknown".into(),
            user: "unknown".into(),
            cwd: "unknown".into(),
            package_manager: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBlock {
    pub id: String,
    pub start_line: usize,
    pub line_count: usize,
    pub level: ErrorLevel,
    pub rule: String,
    /// First line, for UI preview.
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineEvent {
    #[serde(flatten)]
    pub block: ErrorBlock,
    /// Absolute index of the last line of the block in the screen buffer.
    pub end_line: usize,
}

/// Screen state (PRD §2.4 stage 2): bounded line buffer with truncation flag.
pub struct ScreenBuffer {
    pub lines: VecDeque<String>,
    pub truncated: bool,
}

impl ScreenBuffer {
    pub fn new() -> Self {
        Self {
            lines: VecDeque::with_capacity(1024),
            truncated: false,
        }
    }

    pub fn push_line(&mut self, line: &str) {
        if self.lines.len() >= MAX_SCREEN_LINES {
            self.lines.pop_front();
            self.truncated = true;
        }
        self.lines.push_back(line.to_string());
    }

    pub fn as_vec(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

impl Default for ScreenBuffer {
    fn default() -> Self {
        Self::new()
    }
}

struct ActiveBlock {
    level: ErrorLevel,
    rule: String,
    lines: Vec<String>,
    start_line: usize,
}

/// Aggregated state machine for one SSH session.
pub struct Pipeline {
    normalizer: AnsiNormalizer,
    assembler: LineAssembler,
    pub screen: ScreenBuffer,
    active_block: Option<ActiveBlock>,
    pub blocks: Vec<ErrorBlock>,
    pub system_info: SystemInfo,
    /// True once the (single, connection-time) probe line has been consumed.
    pub system_info_probed: bool,
    /// PRD §2.4 stage 3: prompt segmentation is heuristic; we record whether
    /// a structured prompt was detected or we degraded to recent-N-lines.
    pub prompt_parse: &'static str,
    block_counter: u64,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl Pipeline {
    pub fn new() -> Self {
        Self {
            normalizer: AnsiNormalizer::new(),
            assembler: LineAssembler::new(),
            screen: ScreenBuffer::new(),
            active_block: None,
            blocks: Vec::new(),
            system_info: SystemInfo::default(),
            system_info_probed: false,
            prompt_parse: "fallback",
            block_counter: 0,
        }
    }

    /// Feed raw PTY bytes; returns finished error-block events.
    pub fn feed(&mut self, _host: &str, raw: &[u8]) -> Vec<PipelineEvent> {
        let plain = self.normalizer.feed(raw);
        let new_lines = self.assembler.feed(&plain);

        let mut events = Vec::new();
        for line in &new_lines {
            self.process_line(line, &mut events);
        }
        events
    }

    /// Called before building an LLM context so a partial trailing line
    /// (e.g. an error without trailing newline) is included.
    pub fn flush(&mut self) -> Vec<PipelineEvent> {
        let mut events = Vec::new();
        if let Some(partial) = self.assembler.flush_partial() {
            self.process_line(&partial, &mut events);
        }
        events
    }

    fn process_line(&mut self, line: &str, events: &mut Vec<PipelineEvent>) {
        // System probe line: parse and suppress from screen state.
        // Trust-boundary hardening: accept the probe ONLY once, right after
        // the connection (while system_info is still the default). Anything
        // a remote process prints later must NOT overwrite the host facts
        // that ground AI prompts (prompt-injection surface).
        if let Some(rest) = line.strip_prefix("__AISA_PROBE__") {
            if !self.system_info_probed {
                self.system_info_probed = true;
                self.parse_probe(rest);
            }
            return;
        }

        let idx = self.screen.lines.len();
        self.screen.push_line(line);

        // Error detection / block assembly.
        if let Some(feat) = classify_line(line) {
            // New block starts.
            if let Some(mut active) = self.active_block.take() {
                events.extend(self.finish_block(&mut active));
            }
            self.active_block = Some(ActiveBlock {
                level: feat.level,
                rule: feat.rule,
                lines: vec![line.to_string()],
                start_line: idx,
            });
        } else if self.active_block.is_some() {
            let extend = looks_like_stack_frame(line)
                || line.trim_start().starts_with(|c: char| {
                    // continuation lines of tracebacks/npm output etc.
                    c == '^' || c == ' '
                });
            if extend {
                let active = self.active_block.as_mut().unwrap();
                if active.lines.len() < MAX_ACTIVE_BLOCK_LINES {
                    active.lines.push(line.to_string());
                }
            } else {
                // One non-error, non-frame line ends the block.
                if let Some(mut active) = self.active_block.take() {
                    events.extend(self.finish_block(&mut active));
                }
            }
        }
    }

    fn finish_block(&mut self, active: &mut ActiveBlock) -> Option<PipelineEvent> {
        if active.lines.is_empty() {
            return None;
        }
        self.block_counter += 1;
        let block = ErrorBlock {
            id: format!("blk-{}", self.block_counter),
            start_line: active.start_line,
            line_count: active.lines.len(),
            level: active.level,
            rule: active.rule.clone(),
            preview: active.lines[0].chars().take(120).collect(),
        };
        self.blocks.push(block.clone());
        // Cap stored blocks to avoid unbounded growth.
        if self.blocks.len() > 500 {
            self.blocks.remove(0);
        }
        let end_line = active.start_line + active.lines.len().saturating_sub(1);
        Some(PipelineEvent {
            block,
            end_line,
        })
    }

    /// End of output burst: close any open block.
    pub fn seal_active(&mut self) -> Vec<PipelineEvent> {
        if let Some(mut active) = self.active_block.take() {
            return self.finish_block(&mut active).into_iter().collect();
        }
        Vec::new()
    }

    fn parse_probe(&mut self, rest: &str) {
        let rest = rest.trim();
        let mut info = SystemInfo::default();
        for part in rest.split_whitespace() {
            if let Some((k, v)) = part.split_once('=') {
                match k {
                    "os" => info.os = v.to_string(),
                    "kernel" => info.kernel = v.to_string(),
                    "shell" => info.shell = v.to_string(),
                    "user" => info.user = v.to_string(),
                    "cwd" => info.cwd = v.to_string(),
                    "pkgs" => info.package_manager = v.to_string(),
                    _ => {}
                }
            }
        }
        self.system_info = info;
    }

    /// Latest error block, or None.
    pub fn latest_block(&self) -> Option<&ErrorBlock> {
        self.blocks.last()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_buffer_bounded() {
        let mut sb = ScreenBuffer::new();
        for i in 0..(MAX_SCREEN_LINES + 50) {
            sb.push_line(&format!("l{i}"));
        }
        assert_eq!(sb.lines.len(), MAX_SCREEN_LINES);
        assert!(sb.truncated);
    }

    #[test]
    fn probe_parsed_and_hidden() {
        let mut p = Pipeline::new();
        p.feed("h", b"__AISA_PROBE__ os=Linux shell=/bin/bash user=root cwd=/root pkgs=apt\r\n");
        assert_eq!(p.system_info.os, "Linux");
        assert_eq!(p.system_info.package_manager, "apt");
        assert!(p.screen.lines.is_empty()); // suppressed from screen
    }

    #[test]
    fn error_block_with_frames() {
        let mut p = Pipeline::new();
        p.feed("h", b"ls /opt\r\n");
        p.feed("h", b"Traceback (most recent call last):\r\n");
        p.feed("h", b"  File \"x.py\", line 1\r\n");
        p.feed("h", b"    raise ValueError(\"boom\")\r\n");
        p.feed("h", b"ValueError: boom\r\n");
        p.feed("h", b"user@host:~$ ");
        p.seal_active();
        assert_eq!(p.blocks.len(), 1);
        let b = &p.blocks[0];
        assert_eq!(b.rule, "python-traceback");
        assert_eq!(b.line_count, 3); // traceback + file + raise lines
    }

    #[test]
    fn no_false_positive_on_listings() {
        let mut p = Pipeline::new();
        p.feed("h", b"total 42K\rndrwxr-xr-x 2 root root 4096 .\r\n");
        p.seal_active();
        assert!(p.blocks.is_empty());
    }
}
