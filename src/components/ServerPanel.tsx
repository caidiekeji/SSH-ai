// Left panel: hosts + live server stats + file manager.
// All operations here are EXPLICIT user actions; destructive ops require a
// confirmation dialog. AI output never reaches these exec paths.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ConnectionConfig, FileEntry } from "../types";
import { Icon } from "./Icon";

const fmtSize = (n: number) => {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
};

export function ServerPanel() {
  const connections = useStore((s) => s.connections);
  const connStatus = useStore((s) => s.connStatus);
  const sessionId = useStore((s) => s.sessionId);
  const activeHost = useStore((s) => s.activeHost);
  const serverInfo = useStore((s) => s.serverInfo);
  const serverError = useStore((s) => s.serverError);
  const files = useStore((s) => s.files);
  const fileError = useStore((s) => s.fileError);
  const loadConnections = useStore((s) => s.loadConnections);
  const refreshServer = useStore((s) => s.refreshServer);
  const listDir = useStore((s) => s.listDir);
  const runOp = useStore((s) => s.runOp);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 22,
    username: "root",
    authMethod: "password" as "password" | "publickey",
    password: "",
    keyPath: "",
  });
  const [err, setErr] = useState("");
  const [pathInput, setPathInput] = useState("~");
  const [op, setOp] = useState<{ title: string; danger: boolean; detail: string; run: () => Promise<void> } | null>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  // Poll stats + refresh directory while connected (10s).
  useEffect(() => {
    if (connStatus !== "connected" || !sessionId) return;
    refreshServer();
    listDir(useStore.getState().files.path);
    pollRef.current = window.setInterval(() => {
      const st = useStore.getState();
      if (st.connStatus !== "connected") return;
      st.refreshServer();
    }, 10000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      useStore.setState({ serverInfo: null, files: { path: "~", entries: [] }, fileError: "" });
    };
  }, [connStatus, sessionId]);

  const connect = async (conn: ConnectionConfig) => {
    const st = useStore.getState();
    st.setConn({ connStatus: "connecting", connError: "", activeHost: `${conn.host}:${conn.port}` });
    try {
      const has = await ipc.hasSavedPassword(conn.id).catch(() => false);
      const res = await ipc.sshConnect({
        host: conn.host,
        port: conn.port,
        username: conn.username,
        auth:
          conn.auth_method === "password"
            ? { kind: "password", password: "" }
            : { kind: "publickey", key_path: conn.key_path || "", passphrase: null },
        use_saved_password: has,
        connection_id: conn.id,
      });
      st.setConn({ sessionId: res.sessionId, connStatus: "connected" });
    } catch (e) {
      st.setConn({ connStatus: "error", connError: String(e) });
    }
  };

  const quickConnect = async () => {
    const st = useStore.getState();
    st.setConn({ connStatus: "connecting", connError: "", activeHost: `${form.host}:${form.port}` });
    try {
      const res = await ipc.sshConnect({
        host: form.host,
        port: Number(form.port),
        username: form.username,
        auth:
          form.authMethod === "password"
            ? { kind: "password", password: form.password }
            : { kind: "publickey", key_path: form.keyPath, passphrase: null },
      });
      const conn: ConnectionConfig = {
        id: `conn-${Date.now()}`,
        name: form.name || form.host,
        host: form.host,
        port: Number(form.port),
        username: form.username,
        auth_method: form.authMethod,
        key_path: form.authMethod === "publickey" ? form.keyPath : null,
      };
      await ipc.saveConnection(conn, form.authMethod === "password" ? form.password : null);
      await loadConnections();
      st.setConn({ sessionId: res.sessionId, connStatus: "connected" });
      setShowAdd(false);
      setErr("");
    } catch (e) {
      setErr(String(e));
      st.setConn({ connStatus: "error", connError: String(e) });
    }
  };

  const disconnect = async () => {
    const st = useStore.getState();
    if (st.sessionId) await ipc.sshDisconnect(st.sessionId);
    st.setConn({ sessionId: null, connStatus: "disconnected" });
  };

  const connected = connStatus === "connected";
  const memPct = serverInfo?.memTotal ? (serverInfo.memUsed / serverInfo.memTotal) * 100 : 0;
  const diskPct = serverInfo?.diskTotal ? (serverInfo.diskUsed / serverInfo.diskTotal) * 100 : 0;
  const loadPct = serverInfo ? Math.min(100, (serverInfo.load1 / Math.max(1, serverInfo.cores)) * 100) : 0;

  const goDir = (name: string) => {
    const base = files.path;
    const next = base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
    listDir(next);
    setPathInput(next);
  };
  const upDir = () => {
    const base = files.path.replace(/\/+$/, "");
    if (base === "/" || base === "~") return;
    const idx = base.lastIndexOf("/");
    const next = idx <= 0 ? "/" : base.slice(0, idx);
    listDir(next || "/");
    setPathInput(next || "/");
  };
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  const mkdir = async () => {
    const name = window.prompt("新文件夹名称：");
    if (!name) return;
    setOp({
      title: "新建文件夹",
      danger: false,
      detail: `mkdir -p ${q(name)} （位于 ${files.path}）`,
      run: async () => {
        await runOp(`cd ${q(files.path)} && mkdir -p ${q(name)}`);
        await listDir(files.path);
      },
    });
  };

  const doDelete = (e: FileEntry) =>
    setOp({
      title: "删除",
      danger: true,
      detail: `rm -rf -- ${q(e.name)}（位于 ${files.path}）· 此操作不可恢复`,
      run: async () => {
        await runOp(`cd ${q(files.path)} && rm -rf -- ${q(e.name)}`);
        await listDir(files.path);
      },
    });

  const doRename = (e: FileEntry) => {
    const next = window.prompt("重命名为：", e.name);
    if (!next || next === e.name) return;
    setOp({
      title: "重命名",
      danger: false,
      detail: `mv -- ${q(e.name)} ${q(next)}（位于 ${files.path}）`,
      run: async () => {
        await runOp(`cd ${q(files.path)} && mv -- ${q(e.name)} ${q(next)}`);
        await listDir(files.path);
      },
    });
  };

  const doPreview = async (e: FileEntry) => {
    try {
      const text = await runOp(`cd ${q(files.path)} && head -c 4000 -- ${q(e.name)}`);
      setPreview({ name: e.name, text: text || "（空文件或二进制内容）" });
    } catch (err) {
      setPreview({ name: e.name, text: `读取失败：${String(err)}` });
    }
  };

  const execEntry = (e: FileEntry) =>
    setOp({
      title: "执行确认",
      danger: true,
      detail: `${q(e.name)}（位于 ${files.path}）· 将在远端执行该脚本`,
      run: async () => {
        await runOp(`cd ${q(files.path)} && sh ${q(e.name)}`);
      },
    });

  return (
    <div className="server-panel">
      {/* ---- hosts ---- */}
      <h3>主机</h3>
      {connections.map((c) => {
        const isActive = connected && activeHost?.startsWith(`${c.host}:`);
        return (
          <div key={c.id} className={`host-item ${isActive ? "active" : ""}`} onClick={() => !connected && connect(c)}>
            <div className="host-line">
              <span className={`host-dot ${isActive ? "on" : ""}`} />
              <div className="host-meta">
                <div className="host-name">{c.name}</div>
                <div className="host-addr">
                  {c.username}@{c.host}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <button className="small host-add" onClick={() => setShowAdd(true)}>
        <Icon name="plus" size={12} /> 添加主机
      </button>
      {connected && (
        <button className="small host-add disconnect" onClick={disconnect}>
          断开当前连接
        </button>
      )}
      {connStatus === "error" && <div className="error-text small-err">{useStore.getState().connError}</div>}

      {/* ---- server stats ---- */}
      {connected && (
        <>
          <h3>服务器状态</h3>
          {serverError && <div className="error-text small-err">{serverError}</div>}
          {serverInfo && (
            <div className="stats">
              <Stat icon="activity" label="内存" pct={memPct} text={`${fmtSize(serverInfo.memUsed)} / ${fmtSize(serverInfo.memTotal)}`} />
              <Stat icon="gauge" label="负载" pct={loadPct} text={`${serverInfo.load1.toFixed(2)} / ${serverInfo.cores} 核`} />
              <Stat icon="hardDrive" label="磁盘 /" pct={diskPct} text={`${fmtSize(serverInfo.diskUsed)} / ${fmtSize(serverInfo.diskTotal)}`} />
              <div className="uptime">
                <Icon name="clock" size={12} /> 已运行 {serverInfo.uptime}
              </div>
            </div>
          )}
          {!serverInfo && !serverError && <div className="dim-note">读取中…</div>}

          {/* ---- file manager ---- */}
          <h3>文件</h3>
          <div className="file-path">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && listDir(pathInput || "~")}
              spellCheck={false}
            />
            <button className="small" title="上级目录" onClick={upDir}><Icon name="chevronUp" size={12} /></button>
            <button className="small" title="刷新" onClick={() => listDir(files.path)}><Icon name="refresh" size={12} /></button>
            <button className="small" title="新建文件夹" onClick={mkdir}><Icon name="plus" size={12} /></button>
          </div>
          {fileError && <div className="error-text small-err">{fileError}</div>}
          <div className="file-list">
            {files.entries.length === 0 && <div className="dim-note">空目录</div>}
            {files.entries.map((e) => (
              <div key={e.name} className={`file-row ${e.dir ? "is-dir" : ""}`}>
                <span className="file-icon" onClick={() => (e.dir ? goDir(e.name) : doPreview(e))}>
                  <Icon name={e.dir ? "folder" : "file"} size={14} className={e.dir ? "ico-dir" : "ico-file"} />
                </span>
                <span className="file-name" title={`${e.name} · ${e.mtime}`} onClick={() => (e.dir ? goDir(e.name) : doPreview(e))}>
                  {e.name}
                  {!e.dir && <em>{fmtSize(e.size)}</em>}
                </span>
                <span className="file-ops">
                  <button className="icon-op" title={e.dir ? "打开" : "预览"} onClick={() => (e.dir ? goDir(e.name) : doPreview(e))}>
                    <Icon name={e.dir ? "arrowUpRight" : "eye"} size={13} />
                  </button>
                  {e.dir && (
                    <button className="icon-op" title="在终端打开（cd）" onClick={() => ipc.terminalWrite(sessionId!, new TextEncoder().encode(`cd ${q(e.name)} && ls -A\n`))}>
                      <Icon name="terminal" size={13} />
                    </button>
                  )}
                  {e.name.endsWith(".sh") && (
                    <button className="icon-op" title="执行脚本" onClick={() => execEntry(e)}><Icon name="play" size={13} /></button>
                  )}
                  <button className="icon-op" title="重命名" onClick={() => doRename(e)}><Icon name="pencil" size={13} /></button>
                  <button className="icon-op danger" title="删除" onClick={() => doDelete(e)}><Icon name="trash" size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ---- add host modal (unchanged behavior) ---- */}
      {showAdd && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>连接主机</h2>
            <div className="sub">首次连接将展示主机指纹，需要你确认信任（TOFU）。</div>
            <div className="form-grid">
              <label>名称</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="可选" />
              <label>主机</label>
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10" />
              <label>端口</label>
              <input value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })} />
              <label>用户名</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              <label>认证方式</label>
              <select value={form.authMethod} onChange={(e) => setForm({ ...form, authMethod: e.target.value as "password" | "publickey" })}>
                <option value="password">密码</option>
                <option value="publickey">私钥</option>
              </select>
              {form.authMethod === "password" ? (
                <>
                  <label>密码</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </>
              ) : (
                <>
                  <label>私钥路径</label>
                  <input value={form.keyPath} onChange={(e) => setForm({ ...form, keyPath: e.target.value })} placeholder="C:\Users\you\.ssh\id_ed25519" />
                  <label>私钥口令</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="无则留空" />
                </>
              )}
            </div>
            {err && <div className="error-text">{err}</div>}
            <div className="modal-foot">
              <button onClick={() => setShowAdd(false)}>取消</button>
              <button className="primary" disabled={!form.host || !form.username} onClick={quickConnect}>
                连接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- op confirm dialog ---- */}
      {op && (
        <div className="modal-backdrop">
          <div className={`modal confirm-box ${op.danger ? "critical" : "warn"}`}>
            <h2 className="confirm-title">
              <Icon name={op.danger ? "ban" : "info"} size={16} className={op.danger ? "ico-red" : "ico-accent"} />
              {op.title}
            </h2>
            <div className="confirm-cmd">{op.detail}</div>
            {op.danger && <div className="degraded-note">该操作为用户主动发起，将在远端服务器执行，请确认路径正确。</div>}
            <div className="modal-foot">
              <button onClick={() => setOp(null)}>取消</button>
              <button
                className={op.danger ? "danger" : "primary"}
                disabled={opBusy}
                onClick={async () => {
                  setOpBusy(true);
                  try {
                    await op.run();
                    setOp(null);
                  } catch (e) {
                    alert(`操作失败：${String(e)}`);
                  } finally {
                    setOpBusy(false);
                  }
                }}
              >
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- file preview ---- */}
      {preview && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2 className="confirm-title">
              <Icon name="file" size={16} className="ico-accent" />
              {preview.name}
            </h2>
            <div className="sub">前 4000 字节预览</div>
            <pre className="raw-text" style={{ maxHeight: 420 }}>
              {preview.text}
            </pre>
            <div className="modal-foot">
              <button onClick={() => navigator.clipboard.writeText(preview.text)}>复制</button>
              <button className="primary" onClick={() => setPreview(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, pct, text }: { icon: string; label: string; pct: number; text: string }) {
  const level = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-label">
          <Icon name={icon} size={12} /> {label}
        </span>
        <span className="stat-text">{text}</span>
      </div>
      <div className="stat-bar">
        <div className={`stat-fill ${level}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}
