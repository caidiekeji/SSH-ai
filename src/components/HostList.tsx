import { useEffect, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ConnectionConfig } from "../types";

export function HostList() {
  const connections = useStore((s) => s.connections);
  const connStatus = useStore((s) => s.connStatus);
  const loadConnections = useStore((s) => s.loadConnections);
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

  useEffect(() => {
    loadConnections();
  }, []);

  const connect = async (conn: ConnectionConfig) => {
    const st = useStore.getState();
    st.setConn({ connStatus: "connecting", connError: "", activeHost: `${conn.host}:${conn.port}` });
    try {
      const useSaved = conn.auth_method === "password" || conn.auth_method === "publickey";
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
      void useSaved;
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
      // Save the connection (password into the OS keychain).
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

  return (
    <div className="hostlist">
      <h3>主机</h3>
      {connections.map((c) => (
        <div
          key={c.id}
          className={`host-item ${connStatus === "connected" && c.host === useStore.getState().activeHost?.split(":")[0] ? "active" : ""}`}
          onClick={() => connStatus === "disconnected" && connect(c)}
        >
          <div className="host-name">{c.name}</div>
          <div className="host-addr">
            {c.username}@{c.host}:{c.port}
          </div>
        </div>
      ))}
      <button className="small" onClick={() => setShowAdd(true)}>
        + 添加主机
      </button>
      {connStatus === "connected" && (
        <button className="small" style={{ marginTop: 10 }} onClick={disconnect}>
          断开连接
        </button>
      )}
      {connStatus === "error" && (
        <div className="error-text">{useStore.getState().connError}</div>
      )}

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
    </div>
  );
}
