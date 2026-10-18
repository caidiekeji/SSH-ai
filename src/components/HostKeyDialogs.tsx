// TOFU dialogs (PRD §5.2): unknown key -> explicit trust;
// mismatch -> HARD FAIL with no bypass button.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../ipc";
import { Icon } from "./Icon";

interface UnknownKey {
  addr: string;
  algo: string;
  fingerprint: string;
}
interface MismatchKey {
  addr: string;
  old_fingerprint: string;
  new_fingerprint: string;
}

export function HostKeyDialogs() {
  const [unknown, setUnknown] = useState<UnknownKey | null>(null);
  const [mismatch, setMismatch] = useState<MismatchKey | null>(null);

  useEffect(() => {
    const u = listen<UnknownKey>("hostkey-unknown", (ev) => setUnknown(ev.payload));
    const m = listen<MismatchKey>("hostkey-mismatch", (ev) => setMismatch(ev.payload));
    return () => {
      u.then((f) => f());
      m.then((f) => f());
    };
  }, []);

  if (unknown) {
    const respond = (trust: boolean) => {
      ipc.hostKeyRespond(unknown.addr, unknown.fingerprint, trust);
      setUnknown(null);
    };
    return (
      <div className="modal-backdrop">
        <div className="modal confirm-box">
          <h2>信任此主机？</h2>
          <div className="sub">首次连接 {unknown.addr}，请核验主机指纹（TOFU）。</div>
          <div className="hostkey-fp">
            {unknown.algo}
            <br />
            {unknown.fingerprint}
          </div>
          <div className="modal-foot">
            <button onClick={() => respond(false)}>拒绝</button>
            <button className="primary" onClick={() => respond(true)}>
              信任并连接
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mismatch) {
    return (
      <div className="modal-backdrop">
        <div className="modal confirm-box critical">
          <h2 className="confirm-title">
            <Icon name="alertTriangle" size={16} className="ico-red" />
            主机密钥已变化 — 连接已中止
          </h2>
          <div className="sub">
            {mismatch.addr} 的主机密钥与已记录的不一致。可能存在中间人攻击，也可能是主机重装了系统。
          </div>
          <div className="hostkey-fp mismatch-old">已记录: {mismatch.old_fingerprint}</div>
          <div className="hostkey-fp mismatch-new">当前: {mismatch.new_fingerprint}</div>
          <div style={{ color: "var(--text-dim)" }}>
            出于安全考虑，本对话框不提供"忽略并继续"。若你确认主机变更安全，请到「主机管理」中删除该主机的已知记录后重新连接。
          </div>
          <div className="modal-foot">
            <button className="primary" onClick={() => setMismatch(null)}>
              我知道了
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
