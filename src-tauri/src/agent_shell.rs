//! Agent execution channel: ONE persistent remote shell reused across agent
//! steps, so state (`cd`, `export`, functions) survives between commands —
//! the industry-standard fix (OpenHands/SWE-ReX pattern) for multi-step
//! agents running on fresh shells.
//!
//! Protocol: every command is written as a small SCRIPT:
//!
//! ```text
//! __aisa_cmd=$(cat <<'DELIM'
//! <the user command, verbatim>
//! DELIM
//! )
//! eval "$__aisa_cmd" < /dev/null
//! __a=$?
//! printf '\n\001AISA_RC:%d\002\001AISA_PWD:%s\002\n' "$__a" "$PWD"
//! ```
//!
//! Why a heredoc + `eval` instead of `{ cmd ; }`:
//!
//! * The command text lands inside a QUOTED heredoc, so the remote parser
//!   never sees it as code — a `#` comment, an unbalanced quote or a stray
//!   brace cannot corrupt the protocol lines.
//! * `eval` runs the text in the CURRENT shell, so `cd`/`export` still
//!   persist (a subshell would lose them).
//! * A syntax error inside `eval` is a RUNTIME error: the shell prints it and
//!   stays alive. The old `{ cmd ; }` form made the shell itself die, which
//!   cost the agent its `cd` state and (worse) triggered a command REPLAY.
//! * `eval ... < /dev/null` gives the command an EOF on stdin, so interactive
//!   prompts fail fast instead of hanging until the wall-clock timeout.
//!
//! The reply frame carries the exit code AND the shell's current working
//! directory (the agent's real cwd — not the stale one probed at connect
//! time), so the planner can ground itself in reality.
//!
//! A timeout, a cancellation or a dead shell POISONS the channel: the driver
//! drops it so the caller re-opens a fresh one on the next use (state reset is
//! reported to the model instead of silently corrupting the next step).

use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};

const SENTINEL_HEAD: &[u8] = b"\x01AISA_RC:";
const PWD_HEAD: &[u8] = b"\x01AISA_PWD:";
const SENTINEL_TAIL: u8 = 0x02;
const READY_MARK: &[u8] = b"\x01AISA_READY\x02";
/// Hard cap per command: keep the TAIL when overflowing.
const MAX_OUT: usize = 256 * 1024;
/// Heredoc delimiter base. Extended until it no longer occurs in the command.
const DELIM_BASE: &str = "AISA_CMD_EOF";

/// Result of one agent command on the persistent shell.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResp {
    pub output: String,
    /// None when the shell died before reporting (or on timeout).
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// The remote shell exited (channel EOF/CLOSE); state is gone.
    pub shell_gone: bool,
    /// The command bytes were actually handed to the remote shell.
    pub written: bool,
    /// The command MAY have executed but no exit code was observed — the
    /// caller must NOT replay it (non-idempotent commands would run twice).
    pub maybe_executed: bool,
    /// The shell's cwd AFTER the command (live, not the connect-time probe).
    pub cwd: Option<String>,
}

pub enum ShellReq {
    Exec {
        command: String,
        timeout_secs: u64,
        resp: oneshot::Sender<ShellResp>,
    },
}

/// Handle to a live persistent shell: the command sender plus the cancel
/// switch that aborts an in-flight command.
#[derive(Clone)]
pub struct ShellHandle {
    pub tx: mpsc::Sender<ShellReq>,
    pub cancel: watch::Sender<bool>,
}

/// Pick a heredoc delimiter that cannot occur in the command text.
fn pick_delimiter(command: &str) -> String {
    let mut delim = DELIM_BASE.to_string();
    while command.contains(&delim) {
        delim.push('_');
    }
    delim
}

/// Wrap a raw command into the sentinel protocol (pure, unit-tested).
///
/// The command is placed verbatim inside a QUOTED heredoc, so the remote
/// shell's parser never interprets it: `#` comments, unbalanced quotes and
/// stray braces are impossible to smuggle into the protocol lines. `eval`
/// then executes it in the current shell (keeping `cd`/`export` state) and a
/// runtime syntax error can no longer kill the shell.
pub fn wrap_command(command: &str) -> String {
    let d = pick_delimiter(command);
    format!(
        "__aisa_cmd=$(cat <<'{d}'\n{c}\n{d}\n)\neval \"$__aisa_cmd\" < /dev/null\n__a=$?\nprintf '\\n\\001AISA_RC:%d\\002\\001AISA_PWD:%s\\002\\n' \"$__a\" \"$PWD\"\n",
        d = d,
        c = command
    )
}

/// Locate the LAST COMPLETE sentinel frame in `buf`.
///
/// The reply frame is `\x01AISA_RC:<code>\x02\x01AISA_PWD:<cwd>\x02`. Both
/// halves must be present: SSH may split them across two data frames, and
/// truncating at a half-arrived frame would lose the cwd. So the scan only
/// accepts a head whose ENTIRE frame (code + cwd) is already buffered.
///
/// Returns `(exit_code, cwd, cut_pos)` where `cut_pos` is the byte offset
/// just past the frame. Byte-wise scan so a sentinel split across two SSH
/// data frames still parses.
fn find_sentinel(buf: &[u8]) -> Option<(i32, Option<String>, usize)> {
    let mut search_from = buf.len();
    while let Some(start) = buf[..search_from]
        .windows(SENTINEL_HEAD.len())
        .rposition(|w| w == SENTINEL_HEAD)
    {
        let rest = &buf[start + SENTINEL_HEAD.len()..];
        let Some(code_end) = rest.iter().position(|&b| b == SENTINEL_TAIL) else {
            // Head present but no terminator yet → the frame is still
            // arriving; wait for more data instead of scanning backwards.
            return None;
        };
        let parsed = std::str::from_utf8(&rest[..code_end])
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok());
        let Some(code) = parsed else {
            // Not a numeric frame (e.g. program output mimicking the marker):
            // keep looking for an older complete frame.
            search_from = start + SENTINEL_HEAD.len();
            continue;
        };
        let after_code = &rest[code_end + 1..];
        if after_code.len() < PWD_HEAD.len() || &after_code[..PWD_HEAD.len()] != PWD_HEAD {
            // This head is not followed by a cwd frame — keep looking for an
            // older complete frame.
            search_from = start + SENTINEL_HEAD.len();
            continue;
        }
        let pwd_body = &after_code[PWD_HEAD.len()..];
        let pwd_end = match pwd_body.iter().position(|&b| b == SENTINEL_TAIL) {
            Some(p) => p,
            None => {
                // Frame not complete yet — wait for more data.
                return None;
            }
        };
        let cwd = std::str::from_utf8(&pwd_body[..pwd_end])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let cut = start + SENTINEL_HEAD.len() + code_end + 1 + PWD_HEAD.len() + pwd_end + 1;
        return Some((code, cwd, cut));
    }
    None
}

/// Take ownership of a freshly opened `shell` channel and drive it from a
/// dedicated task. Generic over the channel payload so this module never
/// names client/server handle types.
pub fn spawn_shell<S>(ch: russh::Channel<S>) -> ShellHandle
where
    // `Channel` requires From<(ChannelId, ChannelMsg)>; `data`/`wait` also
    // require Sync (bounds demanded by russh 0.45's impl blocks).
    S: Send + Sync + 'static + From<(russh::ChannelId, russh::ChannelMsg)>,
{
    let (tx, mut rx) = mpsc::channel::<ShellReq>(4);
    // Cancel switch: the holder can flip it to abort the in-flight command.
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let driver_cancel = cancel_tx.clone();
    tokio::spawn(async move {
        let mut ch: Option<russh::Channel<S>> = Some(ch);
        let mut last_cwd: Option<String> = None;
        if let Some(c) = ch.as_mut() {
            run_init(c).await;
        }
        while let Some(req) = rx.recv().await {
            let ShellReq::Exec {
                command,
                timeout_secs,
                resp,
            } = req;
            let Some(c) = ch.as_mut() else {
                let _ = resp.send(ShellResp {
                    output: String::new(),
                    exit_code: None,
                    timed_out: false,
                    shell_gone: true,
                    written: false,
                    maybe_executed: false,
                    cwd: None,
                });
                continue;
            };

            let mut out: Vec<u8> = Vec::new();
            let mut exit_code: Option<i32> = None;
            let mut timed_out = false;
            let mut shell_gone = false;
            let mut written = false;
            let mut cancelled = false;

            // `data<R: AsyncRead + Unpin>` takes bytes, not an owned buffer.
            let payload = wrap_command(&command);
            if c.data(payload.as_bytes()).await.is_err() {
                shell_gone = true;
            } else {
                written = true;
            }
            let deadline = tokio::time::Instant::now()
                + std::time::Duration::from_secs(timeout_secs.max(1));
            while !shell_gone && exit_code.is_none() {
                let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remain.is_zero() {
                    timed_out = true;
                    break;
                }
                // A cancel request aborts the in-flight command immediately:
                // the channel is closed, which tears the remote command down.
                if *cancel_rx.borrow() {
                    cancelled = true;
                    shell_gone = true;
                    break;
                }
                let wait = c.wait();
                tokio::select! {
                    _ = cancel_rx.changed() => {
                        cancelled = true;
                        shell_gone = true;
                        break;
                    }
                    res = tokio::time::timeout(remain, wait) => {
                        match res {
                            Ok(Some(russh::ChannelMsg::Data { data }))
                            | Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                                out.extend_from_slice(&data);
                                if out.len() > MAX_OUT {
                                    let tail = out.split_off(out.len() - MAX_OUT);
                                    out = tail;
                                }
                                if let Some((code, cwd, cut)) = find_sentinel(&out) {
                                    out.truncate(cut);
                                    exit_code = Some(code);
                                    if let Some(c) = cwd {
                                        last_cwd = Some(c);
                                    }
                                }
                            }
                            Ok(Some(russh::ChannelMsg::Eof))
                            | Ok(Some(russh::ChannelMsg::Close))
                            | Ok(None) => shell_gone = true,
                            Ok(Some(_)) => {}
                            Err(_) => {
                                timed_out = true;
                                break;
                            }
                        }
                    }
                }
            }

            // Drop leading/trailing blank lines (printf adds one before the frame).
            let output = String::from_utf8_lossy(&out)
                .trim_matches('\n')
                .to_string();
            // The command may have run even though we never saw its exit code:
            // the caller must not replay it.
            let maybe_executed = written && exit_code.is_none();
            let _ = resp.send(ShellResp {
                output,
                exit_code,
                timed_out,
                shell_gone,
                written,
                maybe_executed,
                cwd: last_cwd.clone(),
            });

            if cancelled {
                let _ = driver_cancel.send(true);
            }
            // Timeout / death / cancellation poisons this channel: drop it so
            // the caller re-opens fresh instead of writing into a stuck stream.
            if timed_out || shell_gone {
                ch = None;
                last_cwd = None;
            }
        }
    });
    ShellHandle {
        tx,
        cancel: cancel_tx,
    }
}

/// Best-effort environment alignment at channel start: disable pagers and
/// interactive package prompts, then source the login profiles (guarded by
/// stdin EOF + `|| true` so a noisy profile cannot hang the handshake).
/// Consumed silently — the first agent command never sees this noise.
async fn run_init<S>(c: &mut russh::Channel<S>)
where
    S: Send + Sync + 'static + From<(russh::ChannelId, russh::ChannelMsg)>,
{
    const INIT: &str = "export PAGER=cat GIT_PAGER=cat AWS_PAGER='' TF_INPUT=0 DEBIAN_FRONTEND=noninteractive NO_COLOR=1; { . \"$HOME/.profile\"; . \"$HOME/.bashrc\"; } < /dev/null 2>/dev/null || true; set +e; printf '\\n\\001AISA_READY\\002\\n'";
    if c.data(INIT.as_bytes()).await.is_err() {
        return;
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        match tokio::time::timeout(remain, c.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { data }))
            | Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                if data.windows(READY_MARK.len()).any(|w| w == READY_MARK) {
                    break;
                }
            }
            Ok(Some(russh::ChannelMsg::Eof))
            | Ok(Some(russh::ChannelMsg::Close))
            | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_contains_protocol() {
        let w = wrap_command("ls -la");
        assert!(w.contains("eval \"$__aisa_cmd\" < /dev/null"));
        assert!(w.contains("__a=$?"));
        assert!(w.contains("AISA_RC:%d"));
        assert!(w.contains("AISA_PWD:%s"));
    }

    #[test]
    fn wrap_uses_quoted_heredoc() {
        // The command must land inside a quoted heredoc so the remote parser
        // never sees it as code.
        let w = wrap_command("echo hi");
        assert!(w.contains("<<'AISA_CMD_EOF'"));
        assert!(w.contains("\necho hi\n"));
    }

    #[test]
    fn wrap_comment_cannot_eat_protocol() {
        // A `#` inside the command must not comment out the protocol lines:
        // the heredoc keeps it verbatim.
        let w = wrap_command("echo hi # rm -rf /");
        assert!(w.contains("echo hi # rm -rf /"));
        assert!(w.contains("printf '\\n\\001AISA_RC"));
    }

    #[test]
    fn delimiter_avoids_collision() {
        let cmd = "echo AISA_CMD_EOF";
        let w = wrap_command(cmd);
        assert!(w.contains("<<'AISA_CMD_EOF_'"));
        // The delimiter in the command text must not equal the real one.
        assert!(w.contains("\necho AISA_CMD_EOF\n"));
    }

    #[test]
    fn sentinel_roundtrip() {
        let buf = b"some output\n\x01AISA_RC:0\x02\x01AISA_PWD:/root\x02\n";
        let (code, cwd, cut) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(cwd.as_deref(), Some("/root"));
        assert_eq!(
            &buf[..cut],
            b"some output\n\x01AISA_RC:0\x02\x01AISA_PWD:/root\x02"
        );
    }

    #[test]
    fn sentinel_with_cwd() {
        let buf = b"out\n\x01AISA_RC:0\x02\x01AISA_PWD:/var/log\x02\n";
        let (code, cwd, cut) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(cwd.as_deref(), Some("/var/log"));
        assert_eq!(
            &buf[..cut],
            b"out\n\x01AISA_RC:0\x02\x01AISA_PWD:/var/log\x02"
        );
    }

    #[test]
    fn incomplete_frame_is_not_accepted() {
        // The cwd frame has not arrived yet — the caller must keep reading
        // instead of truncating at a half-frame (which would lose the cwd).
        let buf = b"out\n\x01AISA_RC:0\x02\x01AISA_PWD:/var";
        assert!(find_sentinel(buf).is_none());
    }

    #[test]
    fn sentinel_nonzero_and_last_wins() {
        // Two frames (e.g. a program echoing the marker pattern + real one):
        // the LAST is authoritative.
        let buf = b"\x01AISA_RC:7\x02\x01AISA_PWD:/\x02\nreal out\x01AISA_RC:42\x02\x01AISA_PWD:/tmp\x02\n";
        let (code, cwd, _) = find_sentinel(buf).expect("found");
        assert_eq!(code, 42);
        assert_eq!(cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn sentinel_split_across_frames() {
        // Frame boundary lands in the middle of the sentinel head: the
        // accumulated buffer must still parse once the tail arrives.
        let mut acc: Vec<u8> = Vec::new();
        acc.extend_from_slice(b"out\n\x01AIS");
        assert!(find_sentinel(&acc).is_none());
        acc.extend_from_slice(b"A_RC:3\x02\x01AISA_PWD:/etc\x02\n");
        let (code, cwd, cut) = find_sentinel(&acc).expect("after tail");
        assert_eq!(code, 3);
        assert_eq!(cwd.as_deref(), Some("/etc"));
        assert_eq!(&acc[..cut], b"out\n\x01AISA_RC:3\x02\x01AISA_PWD:/etc\x02");
    }

    #[test]
    fn sentinel_absent_or_garbage_is_none() {
        assert!(find_sentinel(b"plain output").is_none());
        assert!(find_sentinel(b"\x01AISA_RC:notanumber\x02").is_none());
    }

    #[test]
    fn control_bytes_never_in_normal_text() {
        // The sentinel relies on \x01/\x02 not appearing in program output —
        // sanity: wrap_command emits them only inside printf escapes.
        let w = wrap_command("echo hi");
        assert!(!w.contains('\u{1}'));
        assert!(w.contains("\\001"));
    }
}
