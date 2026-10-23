//! Agent execution channel: ONE persistent remote shell reused across agent
//! steps, so state (`cd`, `export`, functions) survives between commands —
//! the industry-standard fix (OpenHands/SWE-ReX pattern) for multi-step
//! agents running on fresh shells.
//!
//! Protocol: every command is written as ONE single line:
//!
//! ```text
//! __aisa_cmd='<the user command, single-quoted>'; eval "$__aisa_cmd" < /dev/null; __a=$?; printf '\n\001AISA_RC:%d\002\001AISA_PWD:%s\002\n' "$__a" "$PWD"
//! ```
//!
//! Why a single-quoted string instead of a heredoc:
//!
//! * ONE line means the interactive shell never has to buffer a multi-line
//!   construct. The previous heredoc form was split across several lines, and
//!   a shell that echoes / re-reads them (readline continuation handling)
//!   could lose the command body — the command then ran as an empty string
//!   and produced NO output, which surfaced as a bogus assertion failure.
//! * The command text lands inside SINGLE quotes, so the remote parser never
//!   sees it as code — a `#` comment, an unbalanced quote or a stray brace
//!   cannot corrupt the protocol lines. A literal `'` is escaped as `'\''`.
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
//! The handshake marker (`AISA_READY`) is consumed across SSH packet
//! boundaries — a chunk-local search misses it when the marker is split, and
//! the leftover marker would then leak into the FIRST command's payload.
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

/// Wrap a raw command into the sentinel protocol (pure, unit-tested).
///
/// The command is placed verbatim inside SINGLE quotes (a literal `'` is
/// escaped as `'\''`), so the remote shell's parser never interprets it: `#`
/// comments, unbalanced quotes and stray braces are impossible to smuggle in.
/// `eval` then executes it in the current shell (keeping `cd`/`export` state)
/// and a runtime syntax error can no longer kill the shell.
///
/// The whole wrapper is ONE line: an interactive shell must not have to
/// buffer a multi-line construct, which is where the command body used to
/// get lost (the command then ran as an empty string and produced no output).
pub fn wrap_command(command: &str) -> String {
    // A multi-line command cannot be carried by a single-quoted one-liner.
    let cmd = command.replace(['\r', '\n'], " ");
    let escaped = cmd.replace('\'', "'\\''");
    format!(
        "__aisa_cmd='{escaped}'; eval \"$__aisa_cmd\" < /dev/null; __a=$?; \
         printf '\\n\\001AISA_RC:%d\\002\\001AISA_PWD:%s\\002\\n' \"$__a\" \"$PWD\"\n"
    )
}

/// Locate the LAST COMPLETE sentinel frame in `buf`.
///
/// The reply frame is `\x01AISA_RC:<code>\x02\x01AISA_PWD:<cwd>\x02`. Both
/// halves must be present: SSH may split them across two data frames, and
/// truncating at a half-arrived frame would lose the cwd. So the scan only
/// accepts a head whose ENTIRE frame (code + cwd) is already buffered.
///
/// Returns `(exit_code, cwd, frame_start)` where `frame_start` is the byte
/// offset at which the frame BEGINS. The caller truncates the buffer THERE,
/// so the protocol frame never reaches the command payload — leaving it in
/// corrupts `contains` / `regex` assertions (the payload
/// "3\n\x01AISA_RC:0\x02…" fails the regex /^[0-9]+$/, because Rust's `$` is
/// end-of-text unless the `(?m)` flag is set).
/// Byte-wise scan so a sentinel split across two SSH data frames still parses.
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
            // keep looking for an older complete frame. Advance by ONE byte —
            // advancing past the whole head would let the same head match
            // again (its window still fits), spinning forever.
            search_from = start + 1;
            continue;
        };
        let after_code = &rest[code_end + 1..];
        if after_code.len() < PWD_HEAD.len() || &after_code[..PWD_HEAD.len()] != PWD_HEAD {
            // This head is not followed by a cwd frame — keep looking for an
            // older complete frame (same one-byte advance rule as above).
            search_from = start + 1;
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
        // Report where the frame STARTS, not where it ends: the caller
        // truncates there so the frame is stripped from the payload.
        return Some((code, cwd, start));
    }
    None
}

/// Is the command's fate UNKNOWN — i.e. did it maybe run remotely while we
/// were not watching?
///
/// This is the flag that makes the caller ABORT instead of retrying, so it
/// must be precise:
///
/// * the bytes were handed over (`written`) — otherwise nothing ran;
/// * no exit code came back (`exit_code.is_none()`) — otherwise we know how
///   it ended;
/// * it was NOT a timeout — a timeout means *we* stopped waiting, which is
///   a different situation. Conflating the two made every timed-out
///   READ-ONLY command abort the whole agent task with a scary
///   "可能已执行" message, while a write command that timed out (and may
///   still be running) must still abort.
pub fn is_ambiguous_execution(written: bool, exit_code: Option<i32>, timed_out: bool) -> bool {
    written && exit_code.is_none() && !timed_out
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
                                if let Some((code, cwd, frame_start)) = find_sentinel(&out) {
                                    // Strip the protocol frame: everything
                                    // from the frame's first byte onwards is
                                    // metadata, not command output. Leaving it
                                    // in the payload corrupts the assertions.
                                    out.truncate(frame_start);
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

            // Drop leading/trailing blank lines (printf adds one before the
            // frame) and any leftover handshake marker — protocol noise must
            // never reach the command payload.
            let out = strip_ready_mark(&out);
            let output = String::from_utf8_lossy(&out)
                .trim_matches('\n')
                .to_string();
            // The command may have run even though we never saw its exit code:
            // the caller must not replay it.
            //
            // A TIMEOUT is a DIFFERENT case: we simply stopped waiting, so the
            // command's fate is still unknown — but the caller must be able
            // to tell the two apart. Conflating them made every timed-out
            // READ-ONLY command abort the whole agent task with a scary
            // "可能已执行" message. Timeouts travel through `timed_out`; this
            // flag is reserved for "the channel died after the bytes were
            // handed over", where replaying a write command is genuinely
            // unsafe.
            let maybe_executed = is_ambiguous_execution(written, exit_code, timed_out);
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
    // `stty -echo` is best effort: when the server allocates a PTY for the
    // shell request, the terminal driver echoes everything we write — our own
    // protocol line would then land in the command payload and pollute every
    // assertion. Harmless without a tty (stderr is discarded).
    const INIT: &str = "export PAGER=cat GIT_PAGER=cat AWS_PAGER='' TF_INPUT=0 DEBIAN_FRONTEND=noninteractive NO_COLOR=1; { . \"$HOME/.profile\"; . \"$HOME/.bashrc\"; } < /dev/null 2>/dev/null || true; set +e; stty -echo 2>/dev/null || true; printf '\\n\\001AISA_READY\\002\\n'";
    if c.data(INIT.as_bytes()).await.is_err() {
        return;
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    // Accumulate across SSH packets: the marker can be split by a packet
    // boundary, and a chunk-local search would miss it. The handshake would
    // then time out and the marker would leak into the FIRST command's
    // payload — the stray "AISA_READY" the user saw in a command output.
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            break;
        }
        match tokio::time::timeout(remain, c.wait()).await {
            Ok(Some(russh::ChannelMsg::Data { data }))
            | Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                buf.extend_from_slice(&data);
                if buf.windows(READY_MARK.len()).any(|w| w == READY_MARK) {
                    // Everything up to and including the marker is init noise.
                    break;
                }
                // The marker never arrived: the init output is being dropped
                // anyway, so keep the buffer small.
                if buf.len() > 64 * 1024 {
                    buf.clear();
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

/// Remove every handshake marker from a payload.
///
/// Defensive net for the case where the handshake timed out (the marker then
/// stays in the channel and would surface as noise in the next output).
fn strip_ready_mark(buf: &[u8]) -> Vec<u8> {
    if !buf.windows(READY_MARK.len()).any(|w| w == READY_MARK) {
        return buf.to_vec();
    }
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0usize;
    while i < buf.len() {
        if buf[i..].starts_with(READY_MARK) {
            i += READY_MARK.len();
            continue;
        }
        out.push(buf[i]);
        i += 1;
    }
    out
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
    fn wrap_is_single_line() {
        // ONE line: an interactive shell must never have to buffer a
        // multi-line construct — that is exactly where the command body used
        // to get lost (the command then ran as an empty string and produced
        // no output, surfacing as a bogus assertion failure).
        let w = wrap_command("echo hi");
        assert_eq!(w.matches('\n').count(), 1, "wrapper must be one line");
        assert!(w.starts_with("__aisa_cmd='echo hi';"));
        assert!(w.ends_with('\n'));
    }

    #[test]
    fn wrap_quotes_the_command() {
        // The command lands inside single quotes: the remote parser never
        // sees it as code.
        let w = wrap_command("echo hi");
        assert!(w.contains("__aisa_cmd='echo hi';"));
    }

    #[test]
    fn wrap_escapes_single_quote() {
        // A literal ' inside the command must not break out of the quoting.
        let w = wrap_command("echo \"it's\"");
        assert!(w.contains("__aisa_cmd='echo \"it'\\''s\"';"));
    }

    #[test]
    fn wrap_flattens_newlines() {
        // A multi-line command cannot travel inside a one-liner.
        let w = wrap_command("for i in 1 2; do\n  echo $i\ndone");
        assert_eq!(w.matches('\n').count(), 1, "wrapper must stay one line");
        assert!(w.contains("for i in 1 2; do"));
        assert!(w.contains("echo $i"));
        assert!(w.contains("done"));
    }

    #[test]
    fn wrap_comment_cannot_eat_protocol() {
        // A `#` inside the command must not comment out the protocol lines:
        // the single-quoted string keeps it verbatim.
        let w = wrap_command("echo hi # rm -rf /");
        assert!(w.contains("echo hi # rm -rf /"));
        assert!(w.contains("printf '\\n\\001AISA_RC"));
    }

    #[test]
    fn ready_mark_never_reaches_the_payload() {
        // A leftover handshake marker is protocol noise, never output.
        assert!(strip_ready_mark(b"\x01AISA_READY\x02").is_empty());
        assert_eq!(
            strip_ready_mark(b"\x01AISA_READY\x02/usr/bin/apt\n"),
            b"/usr/bin/apt\n".to_vec()
        );
        assert_eq!(strip_ready_mark(b"plain output"), b"plain output".to_vec());
    }

    #[test]
    fn sentinel_roundtrip() {
        let buf = b"some output\n\x01AISA_RC:0\x02\x01AISA_PWD:/root\x02\n";
        let (code, cwd, frame_start) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(cwd.as_deref(), Some("/root"));
        // The frame starts right after the command output.
        assert_eq!(&buf[..frame_start], b"some output\n");
    }

    #[test]
    fn sentinel_with_cwd() {
        let buf = b"out\n\x01AISA_RC:0\x02\x01AISA_PWD:/var/log\x02\n";
        let (code, cwd, frame_start) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(cwd.as_deref(), Some("/var/log"));
        assert_eq!(&buf[..frame_start], b"out\n");
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
        let (code, cwd, frame_start) = find_sentinel(&acc).expect("after tail");
        assert_eq!(code, 3);
        assert_eq!(cwd.as_deref(), Some("/etc"));
        assert_eq!(&acc[..frame_start], b"out\n");
    }

    #[test]
    fn payload_never_contains_the_sentinel_frame() {
        // Regression (user-visible): the reply frame is PROTOCOL metadata and
        // must never reach the command payload. Leaving it in corrupted the
        // assertions — the payload "3\n\x01AISA_RC:0\x02\x01AISA_PWD:/h\x02"
        // fails the regex /^[0-9]+$/ (Rust's `$` is end-of-text without the
        // `(?m)` flag) and "输出包含 docker" failed for the same reason.
        let buf = b"3\n\x01AISA_RC:0\x02\x01AISA_PWD:/home/jie\x02\n";
        let (code, cwd, frame_start) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(cwd.as_deref(), Some("/home/jie"));
        let payload = &buf[..frame_start];
        assert_eq!(payload, b"3\n");
        // No protocol bytes survive into the payload.
        assert!(!payload.windows(SENTINEL_HEAD.len()).any(|w| w == SENTINEL_HEAD));
        assert!(!payload.windows(PWD_HEAD.len()).any(|w| w == PWD_HEAD));
    }

    #[test]
    fn clean_payload_satisfies_numeric_regex_assertion() {
        // The exact shape of the reported failure: after the frame is
        // stripped, "3" must satisfy the plan assertion /^[0-9]+$/, while the
        // old (polluted) payload must NOT.
        use regex::Regex;
        let buf = b"3\n\x01AISA_RC:0\x02\x01AISA_PWD:/home/jie\x02\n";
        let (_, _, frame_start) = find_sentinel(buf).expect("sentinel found");
        let payload = String::from_utf8_lossy(&buf[..frame_start])
            .trim_matches('\n')
            .to_string();
        assert_eq!(payload, "3");
        let re = Regex::new(r"^[0-9]+$").expect("valid regex");
        assert!(re.is_match(&payload), "clean payload must match");
        // The polluted payload (old behaviour) must fail — this is exactly
        // the regression this test guards.
        let polluted = String::from_utf8_lossy(buf).trim_matches('\n').to_string();
        assert!(!re.is_match(&polluted), "polluted payload must not match");
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

    // ---- regression: a timeout is NOT an ambiguous execution --------------

    #[test]
    fn timeout_is_not_ambiguous_execution() {
        // The bytes were handed over and no exit code came back — but we
        // stopped waiting on PURPOSE. A read-only command that timed out may
        // be run again; aborting the whole task here (as the old code did)
        // turned every slow read into a fatal "可能已执行" incident.
        assert!(!is_ambiguous_execution(true, None, true));
    }

    #[test]
    fn channel_death_after_write_is_ambiguous_execution() {
        // The real ambiguous case: the channel died after the bytes were
        // handed over, so the command MAY have run. Replaying a write
        // command would run it twice.
        assert!(is_ambiguous_execution(true, None, false));
    }

    #[test]
    fn known_outcome_is_never_ambiguous() {
        // We know how it ended → nothing is ambiguous.
        assert!(!is_ambiguous_execution(true, Some(0), false));
        assert!(!is_ambiguous_execution(true, Some(1), false));
        // Nothing was ever written → nothing ran.
        assert!(!is_ambiguous_execution(false, None, false));
    }
}
