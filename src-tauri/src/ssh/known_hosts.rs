//! TOFU (Trust On First Use) known-hosts store.
//!
//! Application-private store; never touches the user's ~/.ssh/known_hosts.
//! Semantics per PRD §5.2 (StrictHostKeyChecking=accept-new):
//!   - unknown host  -> surface fingerprint, require explicit user trust
//!   - known + match -> connect
//!   - known + mismatch -> HARD FAIL (no bypass), MITM warning

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostEntry {
    /// "host:port"
    pub addr: String,
    /// SSH key algorithm name, e.g. "ssh-ed25519"
    pub algo: String,
    /// SHA256 fingerprint, "SHA256:<base64-nopad>"
    pub fingerprint: String,
    #[serde(default)]
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostKeyMismatch {
    pub addr: String,
    pub old_fingerprint: String,
    pub new_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TofuVerdict {
    /// Known and matching -> proceed.
    Match,
    /// Not in store -> caller must ask the user; on explicit trust, call `learn`.
    Unknown,
    /// Known but DIFFERENT key -> hard fail. No bypass possible.
    Mismatch(HostKeyMismatch),
}

pub struct KnownHosts {
    path: PathBuf,
    entries: HashMap<String, KnownHostEntry>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read(&path)
            .ok()
            .and_then(|bytes| {
                serde_json::from_slice::<Vec<KnownHostEntry>>(&bytes)
                    .ok()
                    .map(|list| {
                        list.into_iter()
                            .map(|e| (e.addr.clone(), e))
                            .collect::<HashMap<_, _>>()
                    })
            })
            .unwrap_or_default();
        Self { path, entries }
    }

    pub fn verdict(&self, addr: &str, fingerprint: &str) -> TofuVerdict {
        match self.entries.get(addr) {
            None => TofuVerdict::Unknown,
            Some(e) if e.fingerprint == fingerprint => TofuVerdict::Match,
            Some(e) => TofuVerdict::Mismatch(HostKeyMismatch {
                addr: addr.to_string(),
                old_fingerprint: e.fingerprint.clone(),
                new_fingerprint: fingerprint.to_string(),
            }),
        }
    }

    /// Record a host key after the user explicitly clicked "trust & connect".
    pub fn learn(&mut self, addr: &str, algo: &str, fingerprint: &str) -> Result<(), String> {
        self.entries.insert(
            addr.to_string(),
            KnownHostEntry {
                addr: addr.to_string(),
                algo: algo.to_string(),
                fingerprint: fingerprint.to_string(),
                added_at: iso_now(),
            },
        );
        self.flush()
    }

    /// Manual removal is the ONLY recovery path for a mismatch (PRD §5.2).
    pub fn remove(&mut self, addr: &str) -> Result<bool, String> {
        let removed = self.entries.remove(addr).is_some();
        if removed {
            self.flush()?;
        }
        Ok(removed)
    }

    pub fn list(&self) -> Vec<KnownHostEntry> {
        let mut v: Vec<_> = self.entries.values().cloned().collect();
        v.sort_by(|a, b| a.addr.cmp(&b.addr));
        v
    }

    fn flush(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let list: Vec<&KnownHostEntry> = self.entries.values().collect();
        let json = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

/// Compute an OpenSSH-style SHA256 fingerprint from a public key blob.
pub fn fingerprint_from_key_blob(algo: &str, b64_body: &str) -> Result<String, String> {
    use base64::Engine;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64_body.trim())
        .map_err(|e| format!("bad key blob: {e}"))?;
    let digest = Sha256::digest(&blob);
    let fp = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    Ok(format!("SHA256:{algo}:{fp}"))
}

fn iso_now() -> String {
    // Best-effort UTC timestamp without pulling chrono (binary size budget).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tofu_flow() {
        let dir = std::env::temp_dir().join(format!("aissh-tofu-{}", std::process::id()));
        let path = dir.join("known_hosts.json");
        let _ = std::fs::remove_file(&path);
        let mut kh = KnownHosts::load(path.clone());

        // First contact -> unknown, requires explicit trust.
        assert_eq!(kh.verdict("h1:22", "SHA256:aaa"), TofuVerdict::Unknown);
        kh.learn("h1:22", "ssh-ed25519", "SHA256:aaa").unwrap();

        // Second contact, same key -> match.
        assert_eq!(kh.verdict("h1:22", "SHA256:aaa"), TofuVerdict::Match);

        // Key changed -> MISMATCH with details, hard fail.
        match kh.verdict("h1:22", "SHA256:bbb") {
            TofuVerdict::Mismatch(m) => {
                assert_eq!(m.old_fingerprint, "SHA256:aaa");
                assert_eq!(m.new_fingerprint, "SHA256:bbb");
            }
            _ => panic!("expected mismatch"),
        }

        // Manual removal is the only exit; after removal it's unknown again.
        assert!(kh.remove("h1:22").unwrap());
        assert_eq!(kh.verdict("h1:22", "SHA256:bbb"), TofuVerdict::Unknown);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_fingerprint_format() {
        // OpenSSH ed25519 example blob.
        let b64 = "AAAAC3NzaC1lZDI1NTE5AAAAIB4/1N5vFm6UJyNMYGcxNQ3gRqXSNiM7XvqZLGK5Tm8H";
        let fp = fingerprint_from_key_blob("ssh-ed25519", b64).unwrap();
        assert!(fp.starts_with("SHA256:ssh-ed25519:"));
        assert!(!fp.contains('='));
        assert!(fingerprint_from_key_blob("ssh-ed25519", "not-base64!!!").is_err());
    }
}
