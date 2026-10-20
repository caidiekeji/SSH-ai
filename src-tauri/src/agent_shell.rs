//! Agent execution channel: ONE persistent remote shell reused across agent
//! steps, so state (`cd`, `export`, functions) survives between commands —
//! the industry-standard fix (OpenHands/SWE-ReX pattern) for multi-step
//! agents running on fresh shells.
//!
//! Protocol: every command is wrapped as
//!   `{ <cmd> ; } < /dev/null; __a=$?; printf '\n\001AISA_RC:%d\002\n' "$__a"`
//! — the per-command stdin EOF stops interactive prompts from hanging the
//! channel, and a control-byte sentinel (never emitted by normal programs)
//! marks both the command boundary and the exit code in the unframed stream.
//!
//! A timeout or a dead shell POISONS the channel: the driver drops it so the
//! caller re-opens a fresh one on the next use (state reset is reported to
//! the model instead of silently corrupting the next step).

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

const SENTINEL_HEAD: &[u8] = b"\x01AISA_RC:";
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
}

pub enum ShellReq {
    Exec {
        command: String,
        timeout_secs: u64,
        resp: oneshot::Sender<ShellResp>,
    },
}

/// Wrap a raw command into the sentinel protocol (pure, unit-tested).
///
/// TWO lines in one write:
///   line 1 `{ cmd ; } < /dev/null` — the group keeps `cd`/`export` state
///     (no subshell) while forcing stdin EOF so prompts fail fast instead of
///     eating the sentinel line below;
///   line 2 captures `$?` and prints the frame — it still runs when line 1
///     has a SYNTAX error (the old single-line wrap hung until timeout there).
pub fn wrap_command(command: &str) -> String {
    format!(
        "{{ {} ; }} < /dev/null\n__a=$?; printf '\\n\\001AISA_RC:%d\\002\\n' \"$__a\"\n",
        command
    )
}

/// Locate the LAST sentinel frame in `buf`. Returns `(exit_code, cut_pos)`
/// where `cut_pos` is the byte offset just past the frame. Byte-wise scan so
/// a sentinel split across two SSH data frames still parses.
fn find_sentinel(buf: &[u8]) -> Option<(i32, usize)> {
    let start = buf
        .windows(SENTINEL_HEAD.len())
        .rposition(|w| w == SENTINEL_HEAD)?;
    let rest = &buf[start + SENTINEL_HEAD.len()..];
    let end_rel = rest.iter().position(|&b| b == SENTINEL_TAIL)?;
    let code: i32 = std::str::from_utf8(&rest[..end_rel]).ok()?.trim().parse().ok()?;
    Some((code, start + SENTINEL_HEAD.len() + end_rel + 1))
}

/// Take ownership of a freshly opened `shell` channel and drive it from a
/// dedicated task. Generic over the channel payload so this module never
/// names client/server handle types.
pub fn spawn_shell<S>(ch: russh::Channel<S>) -> mpsc::Sender<ShellReq>
where
    // `Channel` requires From<(ChannelId, ChannelMsg)>; `data`/`wait` also
    // require Sync (bounds demanded by russh 0.45's impl blocks).
    S: Send + Sync + 'static + From<(russh::ChannelId, russh::ChannelMsg)>,
{
    let (tx, mut rx) = mpsc::channel::<ShellReq>(4);
    tokio::spawn(async move {
        let mut ch: Option<russh::Channel<S>> = Some(ch);
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
                });
                continue;
            };

            let mut out: Vec<u8> = Vec::new();
            let mut exit_code: Option<i32> = None;
            let mut timed_out = false;
            let mut shell_gone = false;

            // `data<R: AsyncRead + Unpin>` takes bytes, not an owned buffer.
            let payload = wrap_command(&command);
            if c.data(payload.as_bytes()).await.is_err() {
                shell_gone = true;
            }
            let deadline = tokio::time::Instant::now()
                + std::time::Duration::from_secs(timeout_secs.max(1));
            while !shell_gone && exit_code.is_none() {
                let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remain.is_zero() {
                    timed_out = true;
                    break;
                }
                match tokio::time::timeout(remain, c.wait()).await {
                    Ok(Some(russh::ChannelMsg::Data { data }))
                    | Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => {
                        out.extend_from_slice(&data);
                        if out.len() > MAX_OUT {
                            let tail = out.split_off(out.len() - MAX_OUT);
                            out = tail;
                        }
                        if let Some((code, cut)) = find_sentinel(&out) {
                            out.truncate(cut);
                            exit_code = Some(code);
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

            // Drop leading/trailing blank lines (printf adds one before the frame).
            let output = String::from_utf8_lossy(&out)
                .trim_matches('\n')
                .to_string();
            let _ = resp.send(ShellResp {
                output,
                exit_code,
                timed_out,
                shell_gone,
            });

            // Timeout / death poisons this channel: drop it so the caller
            // re-opens fresh instead of writing into a stuck stream.
            if timed_out || shell_gone {
                ch = None;
            }
        }
    });
    tx
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
        assert!(w.starts_with("{ ls -la ; }"));
        assert!(w.contains("< /dev/null"));
        assert!(w.contains("\n__a=$?;"));
        assert!(w.contains("AISA_RC:%d"));
        assert!(w.contains("$__a"));
    }

    #[test]
    fn sentinel_roundtrip() {
        let buf = b"some output\n\x01AISA_RC:0\x02\n";
        let (code, cut) = find_sentinel(buf).expect("sentinel found");
        assert_eq!(code, 0);
        assert_eq!(&buf[..cut], b"some output\n\x01AISA_RC:0\x02");
    }

    #[test]
    fn sentinel_nonzero_and_last_wins() {
        // Two frames (e.g. a program echoing the marker pattern + real one):
        // the LAST is authoritative.
        let buf = b"\x01AISA_RC:7\x02\nreal out\x01AISA_RC:42\x02\n";
        let (code, _) = find_sentinel(buf).expect("found");
        assert_eq!(code, 42);
    }

    #[test]
    fn sentinel_split_across_frames() {
        // Frame boundary lands in the middle of the sentinel head: the
        // accumulated buffer must still parse once the tail arrives.
        let mut acc: Vec<u8> = Vec::new();
        acc.extend_from_slice(b"out\n\x01AIS");
        assert!(find_sentinel(&acc).is_none());
        acc.extend_from_slice(b"A_RC:3\x02\n");
        let (code, cut) = find_sentinel(&acc).expect("after tail");
        assert_eq!(code, 3);
        assert_eq!(&acc[..cut], b"out\n\x01AISA_RC:3\x02");
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
