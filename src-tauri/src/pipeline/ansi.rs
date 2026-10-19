//! ANSI normalization (PRD §2.4 stage 1).
//! Strips CSI/OSC/APC sequences, handles \r overwrite and backspace.
//! Unknown sequences are skipped and counted — never block rendering.

#[derive(Default)]
pub struct AnsiStats {
    pub csi_skipped: u64,
    pub osc_skipped: u64,
    pub unknown_skipped: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Csi,
    Osc,
    /// OSC terminated by BEL or ST (ESC \)
    OscEsc,
    Apc,
}

/// Incremental ANSI filter: feed raw bytes, get plain text out.
pub struct AnsiNormalizer {
    state: State,
    stats: AnsiStats,
    text: Vec<u8>,
}

impl Default for AnsiNormalizer {
    fn default() -> Self {
        Self::new()
    }
}

impl AnsiNormalizer {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            stats: AnsiStats::default(),
            text: Vec::new(),
        }
    }

    pub fn stats(&self) -> &AnsiStats {
        &self.stats
    }

    /// Feed raw bytes; returns plain-text bytes accumulated so far and resets
    /// the output buffer (streaming-friendly).
    pub fn feed(&mut self, data: &[u8]) -> Vec<u8> {
        for &b in data {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Escape,
                    b'\r' => {
                        // CR: caller (Pipeline) handles overwrite semantics;
                        // emit a CR marker byte for the line assembler.
                        self.text.push(b'\r');
                    }
                    b'\x08' => {
                        // Backspace: erase last char of current output.
                        self.text.pop();
                    }
                    0x07 => {} // BEL
                    _ => self.text.push(b),
                },
                State::Escape => match b {
                    b'[' => self.state = State::Csi,
                    b']' => self.state = State::Osc,
                    b'_' | b'P' | b'^' => self.state = State::Apc,
                    0x1b => {}
                    _ => {
                        self.stats.unknown_skipped += 1;
                        self.state = State::Ground;
                    }
                },
                State::Csi => match b {
                    // Final byte of a CSI sequence: 0x40..=0x7E
                    0x40..=0x7e => self.state = State::Ground,
                    _ => self.stats.csi_skipped += 1,
                },
                State::Osc => match b {
                    0x07 => self.state = State::Ground,
                    0x1b => self.state = State::OscEsc,
                    _ => self.stats.osc_skipped += 1,
                },
                State::OscEsc => match b {
                    b'\\' => self.state = State::Ground,
                    _ => {
                        self.stats.unknown_skipped += 1;
                        self.state = State::Ground;
                    }
                },
                State::Apc => match b {
                    0x1b => self.state = State::OscEsc, // ST terminator shared
                    _ => {}
                },
            }
        }
        std::mem::take(&mut self.text)
    }
}

/// Assemble plain text into lines, handling CR overwrite within a line and
/// CRLF (which must count as a single newline, not clear + newline).
/// Consuming design: `feed`/`flush_partial` RETURN completed lines; no
/// internal archive is kept (the old self.lines copy grew without bound
/// because nothing ever called take_lines — the screen buffer owns history).
pub struct LineAssembler {
    current: Vec<u8>,
    pending_cr: bool,
}

impl Default for LineAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl LineAssembler {
    pub fn new() -> Self {
        Self {
            current: Vec::new(),
            pending_cr: false,
        }
    }

    pub fn feed(&mut self, text: &[u8]) -> Vec<String> {
        let mut completed = Vec::new();
        for &b in text {
            match b {
                b'\r' => self.pending_cr = true,
                b'\n' => {
                    // CRLF or lone LF: commit the line as-is.
                    completed.push(String::from_utf8_lossy(&self.current).into_owned());
                    self.current.clear();
                    self.pending_cr = false;
                }
                _ => {
                    if self.pending_cr {
                        // Bare CR: terminal overwrite semantics — restart line.
                        self.current.clear();
                        self.pending_cr = false;
                    }
                    self.current.push(b);
                }
            }
        }
        completed
    }

    /// Flush any partial trailing line (no newline yet).
    pub fn flush_partial(&mut self) -> Option<String> {
        if self.current.is_empty() {
            None
        } else {
            let s = String::from_utf8_lossy(&self.current).into_owned();
            self.current.clear();
            Some(s)
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_csi_and_osc() {
        let mut n = AnsiNormalizer::new();
        let out = n.feed(b"\x1b[31mERROR\x1b[0m: boom\x1b]0;title\x07 done\r\n");
        let s = String::from_utf8_lossy(&out).into_owned();
        assert!(s.contains("ERROR"));
        assert!(s.contains(": boom"));
        assert!(!s.contains('\x1b'));
        assert!(!s.contains("0;title"));
    }

    #[test]
    fn handles_cr_overwrite_and_backspace() {
        let mut n = AnsiNormalizer::new();
        let out = n.feed(b"progress 10%\rprogress 50%\r\nab\x08c\n");
        let mut la = LineAssembler::new();
        let lines = la.feed(&out);
        assert_eq!(lines, vec!["progress 50%", "ac"]);
    }

    #[test]
    fn unknown_sequences_counted_not_blocking() {
        let mut n = AnsiNormalizer::new();
        let out = n.feed(b"\x1bQweird\x1b[1;2Hok");
        assert!(n.stats().unknown_skipped >= 1);
        let s = String::from_utf8_lossy(&out).into_owned();
        assert!(s.contains("ok"));
    }
}
