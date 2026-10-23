// Left panel: hosts + live server stats + file manager.
// All operations here are EXPLICIT user actions; destructive ops require a
// confirmation dialog. AI output never reaches these exec paths.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ConnectionConfig, FileEntry } from "../types";
import { Icon } from "./Icon";
import { HostFormFields, connFromForm, emptyHostForm, useKeyUpload, type HostFormValues } from "./HostForm";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * Number formatting for the server dashboard.
 *
 * One precision rule per unit tier, so the whole panel reads with a single
 * rhythm instead of every metric choosing its own decimals:
 *   - a value that rounds to zero prints as "0" — "0.00" carries no
 *     information but looks precise;
 *   - GB keeps one decimal (0.1 GB = 100 MB of headroom is worth showing);
 *   - MB / KB drop the decimal entirely — the extra digit is noise in a
 *     248 px column;
 *   - rates below 1 KB/s print as "0 B/s" (sub-KB rates are noise).
 */
const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB`;
  if (n >= MiB) return `${Math.round(n / MiB)} MB`;
  if (n >= KiB) return `${Math.round(n / KiB)} KB`;
  return `${Math.round(n)} B`;
};

const fmtRate = (n: number): string => {
  if (!Number.isFinite(n) || n < KiB) return "0 B/s";
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB/s`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MB/s`;
  return `${Math.round(n / KiB)} KB/s`;
};

/** Load average keeps its conventional two decimals — 0.01 vs 0.00 matters. */
const fmtLoad = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const s = n.toFixed(2);
  return parseFloat(s) === 0 ? "0" : s;
};

/** Uptime in Chinese, from raw seconds (no locale-dependent English string). */
const fmtUptime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return "-";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天${h > 0 ? ` ${h} 小时` : ""}`;
  if (h > 0) return `${h} 小时${m > 0 ? ` ${m} 分钟` : ""}`;
  if (m > 0) return `${m} 分钟${s % 60 > 0 ? ` ${s % 60} 秒` : ""}`;
  return `${s} 秒`;
};

export function ServerPanel() {
  const connections = useStore((s) => s.connections);
  const connStatus = useStore((s) => s.connStatus);
  const connError = useStore((s) => s.connError);
  const sessionId = useStore((s) => s.sessionId);
  const tabs = useStore((s) => s.tabs);
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
  const [filesOpen, setFilesOpen] = useState(false);
  const [editFile, setEditFile] = useState<{ path: string; name: string } | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState("");
  const [fmMsg, setFmMsg] = useState("");
  const [form, setForm] = useState<HostFormValues>(emptyHostForm);
  const [err, setErr] = useState("");
  const { keyBusy, onKeyFile } = useKeyUpload(setForm, setErr);
  const [pathInput, setPathInput] = useState("~");
  const [op, setOp] = useState<{ title: string; danger: boolean; detail: string; run: () => Promise<void> } | null>(null);
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  // Text-input dialog state (WebView2 does NOT support window.prompt —
  // a custom modal is required for mkdir / rename name entry).
  const [ask, setAsk] = useState<{ title: string; label: string; value: string; onOk: (v: string) => void } | null>(null);
  // Per-host connection state. Establishing a SECOND session must never
  // disturb the tab the user is currently working in, so this is tracked
  // per host instead of through the global `connStatus`.
  const [pendingHosts, setPendingHosts] = useState<Record<string, boolean>>({});
  const [hostErrs, setHostErrs] = useState<Record<string, string>>({});
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

  /**
   * Open (or focus) a session for a saved host.
   *
   * The app is multi-session by design: every connection gets its own
   * session id in the backend and its own tab in the terminal pane. Clicking
   * a host therefore NEVER replaces the current session — it either focuses
   * the tab that already holds that host, or opens a new one.
   *
   * `force` opens an ADDITIONAL session to the same host (a legit ops need:
   * a second account / a second shell), instead of focusing the existing tab.
   */
  const openHost = async (conn: ConnectionConfig, force = false) => {
    const st = useStore.getState();
    const addr = `${conn.host}:${conn.port}`;

    if (!force) {
      // Focus the live tab for this host. A tab whose session already died
      // is skipped — clicking the host should establish a FRESH session
      // instead of revealing a dead terminal.
      const open = st.tabs.find((t) => t.host === addr && t.status === "connected");
      if (open) {
        st.switchTab(open.sessionId);
        return;
      }
    }

    // Only claim the GLOBAL status when no session is active yet — otherwise
    // the tab the user is working in would flip to "connecting" while a
    // second host is being established.
    const hasActive = st.activeTabId != null;
    if (!hasActive) {
      st.setConn({ connStatus: "connecting", connError: "", activeHost: addr });
    }
    setPendingHosts((p) => ({ ...p, [conn.id]: true }));
    setHostErrs((e) => ({ ...e, [conn.id]: "" }));
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
      st.openTab(
        res.sessionId,
        conn.name,
        addr,
        has
          ? {
              host: conn.host,
              port: conn.port,
              username: conn.username,
              auth:
                conn.auth_method === "password"
                  ? { kind: "password", password: "" }
                  : { kind: "publickey", key_path: conn.key_path || "", passphrase: null },
              use_saved_password: true,
              connection_id: conn.id,
            }
          : undefined,
      );
    } catch (e) {
      const msg = String(e);
      if (useStore.getState().activeTabId == null) {
        st.setConn({ connStatus: "error", connError: msg });
      } else {
        // Keep the active session's status untouched; report next to the host.
        setHostErrs((prev) => ({ ...prev, [conn.id]: msg }));
      }
    } finally {
      setPendingHosts((p) => {
        const n = { ...p };
        delete n[conn.id];
        return n;
      });
    }
  };

  const quickConnect = async () => {
    const st = useStore.getState();
    const addr = `${form.host}:${Number(form.port)}`;
    // The host may already be open in a live tab — focus it instead of
    // opening a duplicate session.
    const open = st.tabs.find((t) => t.host === addr && t.status === "connected");
    if (open) {
      st.switchTab(open.sessionId);
      setShowAdd(false);
      setErr("");
      return;
    }
    // Same rule as openHost: only claim the global status when nothing is
    // connected yet.
    if (st.activeTabId == null) {
      st.setConn({ connStatus: "connecting", connError: "", activeHost: addr });
    }
    try {
      const res = await ipc.sshConnect({
        host: form.host,
        port: Number(form.port),
        username: form.username,
        auth:
          form.authMethod === "password"
            ? { kind: "password", password: form.password }
            : { kind: "publickey", key_path: form.keyPath, passphrase: form.password || null },
      });
      // password = SSH password for password auth, key passphrase for pubkey.
      const conn = connFromForm(form, `conn-${Date.now()}`);
      await ipc.saveConnection(conn, form.password || null);
      await loadConnections();
      st.openTab(res.sessionId, conn.name, addr);
      setShowAdd(false);
      setErr("");
    } catch (e) {
      setErr(String(e));
      if (useStore.getState().activeTabId == null) {
        st.setConn({ connStatus: "error", connError: String(e) });
      }
    }
  };

  const disconnect = async () => {
    const st = useStore.getState();
    if (st.activeTabId != null) await st.closeTab(st.activeTabId);
  };

  const connected = connStatus === "connected";
  const memPct = serverInfo?.memTotal ? (serverInfo.memUsed / serverInfo.memTotal) * 100 : 0;
  const diskPct = serverInfo?.diskTotal ? (serverInfo.diskUsed / serverInfo.diskTotal) * 100 : 0;
  const loadPct = serverInfo ? Math.min(100, (serverInfo.load1 / Math.max(1, serverInfo.cores)) * 100) : 0;
  // Load is a RATIO, not a fill level: 100% means every core is busy, and
  // only beyond that is the box actually oversubscribed — so its thresholds
  // sit one notch higher than the capacity bars.
  const loadLevel = !serverInfo
    ? "green"
    : serverInfo.load1 >= serverInfo.cores
      ? "red"
      : serverInfo.load1 >= serverInfo.cores * 0.7
        ? "yellow"
        : "green";

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

  const mkdir = () => {
    setAsk({
      title: "新建文件夹",
      label: "新文件夹名称（位于当前目录）",
      value: "",
      onOk: (name) =>
        setOp({
          title: "新建文件夹",
          danger: false,
          detail: `mkdir -p ${q(name)} （位于 ${files.path}）`,
          run: async () => {
            await runOp(`cd ${q(files.path)} && mkdir -p ${q(name)}`);
            await listDir(files.path);
          },
        }),
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
    setAsk({
      title: "重命名",
      label: `将「${e.name}」重命名为`,
      value: e.name,
      onOk: (next) => {
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

  // ---- remote file edit (text files ≤ 100 KB, base64 round-trip) ----
  const b64ToText = (b64: string) => {
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  const textToB64 = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  const doEdit = async (e: FileEntry) => {
    setEditErr("");
    try {
      const b64 = await runOp(`cd ${q(files.path)} && head -c 100000 -- ${q(e.name)} | base64`);
      setEditFile({ path: `${files.path.replace(/\/+$/, "")}/${e.name}`, name: e.name });
      setEditText(b64ToText(b64));
    } catch (err) {
      setEditErr(`读取失败：${String(err)}`);
    }
  };

  const saveEdit = async () => {
    if (!editFile) return;
    setEditBusy(true);
    setEditErr("");
    try {
      await runOp(`printf %s '${textToB64(editText)}' | base64 -d > ${q(editFile.path)}`);
      setEditFile(null);
      listDir(files.path);
    } catch (err) {
      setEditErr(`保存失败：${String(err)}`);
    } finally {
      setEditBusy(false);
    }
  };

  // ---- SFTP upload (webview bytes → base64 → remote write) ----
  const uploadFiles = async (list: FileList | null) => {
    if (!list || !sessionId) return;
    for (const f of Array.from(list)) {
      if (f.size > 60 * 1024 * 1024) {
        setFmMsg(`跳过 ${f.name}：超过 60MB 上限`);
        continue;
      }
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        const CH = 0x8000; // avoid call-stack overflow on spread
        for (let i = 0; i < buf.length; i += CH) {
          bin += String.fromCharCode(...buf.subarray(i, i + CH));
        }
        const remote = `${files.path.replace(/\/+$/, "")}/${f.name}`;
        setFmMsg(await ipc.sftpUploadData(sessionId, remote, btoa(bin)));
      } catch (err) {
        setFmMsg(`上传 ${f.name} 失败：${String(err)}`);
      }
    }
    listDir(files.path);
  };

  const doDownload = async (e: FileEntry) => {
    if (!sessionId) return;
    try {
      setFmMsg(
        await ipc.sftpDownload(sessionId, `${files.path.replace(/\/+$/, "")}/${e.name}`),
      );
    } catch (err) {
      setFmMsg(`下载失败：${String(err)}`);
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
        const addr = `${c.host}:${c.port}`;
        const isActive = connected && activeHost === addr;
        const tabOf = tabs.find((t) => t.host === addr);
        const hasLive = tabOf?.status === "connected";
        const pending = !!pendingHosts[c.id];
        return (
          <div
            key={c.id}
            className={`host-item ${isActive ? "active" : ""} ${pending ? "pending" : ""}`}
            onClick={() => !pending && void openHost(c)}
            title={hasLive ? "已打开标签页，点击切换到该会话" : "点击连接并打开新标签页"}
          >
            <div className="host-line">
              <span className={`host-dot ${isActive ? "on" : ""} ${pending ? "spin" : ""}`} />
              <div className="host-meta">
                <div className="host-name">{c.name}</div>
                <div className="host-addr">
                  {c.username}@{c.host}
                </div>
              </div>
              {tabOf && !pending && (
                <button
                  className="host-dup"
                  title="在同一主机上再开一个会话"
                  aria-label={`在 ${c.name} 上新建会话`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openHost(c, true);
                  }}
                >
                  <Icon name="plus" size={11} />
                </button>
              )}
            </div>
            {hostErrs[c.id] && <div className="error-text small-err host-err">{hostErrs[c.id]}</div>}
          </div>
        );
      })}
      <button className="host-add" onClick={() => setShowAdd(true)}>
        <Icon name="plus" size={14} /> 添加主机
      </button>
      {connected && (
        <button className="small host-add disconnect" onClick={disconnect}>
          关闭当前会话{tabs.length > 1 ? `（共 ${tabs.length} 个）` : ""}
        </button>
      )}
      {connStatus === "error" && <div className="error-text small-err">{connError}</div>}

      {/* ---- server stats ---- */}
      {connected && (
        <>
          <h3>服务器状态</h3>
          {serverError && <div className="error-text small-err">{serverError}</div>}
          {serverInfo && (
            <div className="stats">
              {/* Level metrics: memory / swap / disk / load — each is
                  "used out of a total", so each gets the same shape:
                  label + value + a bar the eye can compare at a glance. */}
              <Stat
                icon="cpu"
                label="内存"
                pct={memPct}
                text={`${fmtBytes(serverInfo.memUsed)} / ${fmtBytes(serverInfo.memTotal)}`}
                title="物理内存已用 / 总量"
              />
              {serverInfo.swapTotal > 0 && (
                <Stat
                  icon="memoryStick"
                  label="交换分区"
                  pct={serverInfo.swapTotal ? (serverInfo.swapUsed / serverInfo.swapTotal) * 100 : 0}
                  text={`${fmtBytes(serverInfo.swapUsed)} / ${fmtBytes(serverInfo.swapTotal)}`}
                  title="Swap 已用 / 总量（为 0 说明系统未配置交换）"
                />
              )}
              <Stat
                icon="hardDrive"
                label="磁盘 /"
                pct={diskPct}
                text={`${fmtBytes(serverInfo.diskUsed)} / ${fmtBytes(serverInfo.diskTotal)}`}
                title="根分区已用 / 总量"
              />
              <Stat
                icon="gauge"
                label="负载"
                pct={loadPct}
                level={loadLevel}
                text={`${fmtLoad(serverInfo.load1)} / ${serverInfo.cores} 核`}
                title="1 分钟平均负载 / 核心数，满核即为 100%"
              />
              {/* Flow metrics: what is moving RIGHT NOW. No card chrome —
                  the bars above already own the "card" reading. */}
              <div className="io-grid">
                <IOMetric icon="arrowDown" iconCls="ico-down" label="下行" value={fmtRate(serverInfo.netRxRate)} title="所有网卡合计下载速率（不含本机回环）" />
                <IOMetric icon="arrowUp" iconCls="ico-up" label="上行" value={fmtRate(serverInfo.netTxRate)} title="所有网卡合计上传速率（不含本机回环）" />
                <IOMetric icon="arrowDown" iconCls="ico-disk" label="磁盘读" value={fmtRate(serverInfo.diskReadRate)} title="根分区每秒读取（/proc/diskstats）" />
                <IOMetric icon="arrowUp" iconCls="ico-disk" label="磁盘写" value={fmtRate(serverInfo.diskWriteRate)} title="根分区每秒写入（/proc/diskstats）" />
                {serverInfo.memAvailable > 0 && (
                  <IOMetric label="可用内存" value={fmtBytes(serverInfo.memAvailable)} title="当前可供新进程使用的物理内存" />
                )}
                <IOMetric label="5 分钟负载" value={fmtLoad(serverInfo.load5)} title="5 分钟平均负载" />
              </div>
        <div className="uptime">
          <Icon name="clock" size={12} /> 已运行 {fmtUptime(serverInfo.uptimeSec)}
        </div>
            </div>
          )}
          {!serverInfo && !serverError && <div className="dim-note">读取中…</div>}

          {/* ---- file manager launcher (content opens in a modal) ---- */}
          <button
            className="small fm-open"
            title="浏览与管理远端文件"
            onClick={() => {
              setFilesOpen(true);
              listDir(useStore.getState().files.path || "~");
            }}
          >
            <Icon name="folder" size={13} /> 文件管理
          </button>
        </>
      )}

      {/* ---- file manager modal ---- */}
      {filesOpen && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setFilesOpen(false)}>
          <div className="modal modal-file">
            <button className="modal-x" title="关闭 (Esc)" onClick={() => setFilesOpen(false)}>
              <Icon name="x" size={16} />
            </button>
            <h2 className="confirm-title">
              <Icon name="folder" size={16} className="ico-accent" /> 文件管理
            </h2>
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
            <button
              className="small"
              title="上传文件到当前目录"
              onClick={() => document.getElementById("fm-upload-input")?.click()}
            >
              <Icon name="upload" size={12} />
            </button>
            <input
              id="fm-upload-input"
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {fmMsg && <div className="ok-text small-err">{fmMsg}</div>}
            {fileError && <div className="error-text small-err">{fileError}</div>}
            <div
              className="file-list fm-list"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                uploadFiles(e.dataTransfer.files);
              }}
            >
              {files.entries.length === 0 && <div className="dim-note">空目录</div>}
              {files.entries.map((e) => (
                <div key={e.name} className={`file-row ${e.dir ? "is-dir" : ""}`}>
                  <span className="file-icon" onClick={() => (e.dir ? goDir(e.name) : doPreview(e))}>
                    <Icon name={e.dir ? "folder" : "file"} size={14} className={e.dir ? "ico-dir" : "ico-file"} />
                  </span>
                  <span className="file-name" title={`${e.name} · ${e.mtime}`} onClick={() => (e.dir ? goDir(e.name) : doPreview(e))}>
                    {e.name}
                    {!e.dir && <em>{fmtBytes(e.size)}</em>}
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
                    {!e.dir && e.size <= 100000 && (
                      <button className="icon-op" title="编辑文本" onClick={() => doEdit(e)}><Icon name="squarePen" size={13} /></button>
                    )}
                    {!e.dir && (
                      <button className="icon-op" title="下载（保存到应用数据目录/downloads）" onClick={() => doDownload(e)}>
                        <Icon name="download" size={13} />
                      </button>
                    )}
                    <button className="icon-op" title="重命名" onClick={() => doRename(e)}><Icon name="pencil" size={13} /></button>
                    <button className="icon-op danger" title="删除" onClick={() => doDelete(e)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---- file edit modal ---- */}
      {editFile && (
        <div className="modal-backdrop">
          <div className="modal modal-file">
            <button className="modal-x" title="关闭" onClick={() => setEditFile(null)}>
              <Icon name="x" size={16} />
            </button>
            <h2 className="confirm-title">
              <Icon name="squarePen" size={16} className="ico-accent" /> 编辑 {editFile.name}
            </h2>
            <div className="sub">以 UTF-8 文本编辑（≤100KB），保存将覆盖远端文件</div>
            <textarea
              className="sys-prompt-input"
              rows={18}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 12 }}
            />
            {editErr && <div className="error-text" style={{ marginTop: 8 }}>{editErr}</div>}
            <div className="modal-foot">
              <button onClick={() => setEditFile(null)}>取消</button>
              <button className="primary" disabled={editBusy} onClick={saveEdit}>
                {editBusy ? "保存中…" : "保存到服务器"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- add host modal (unchanged behavior) ---- */}
      {showAdd && (
        <div className="modal-backdrop">
          <div className="modal modal-sm">
            <h2>连接主机</h2>
            <div className="sub">首次连接将展示主机指纹，需要你确认信任（TOFU）。</div>
            <HostFormFields form={form} setForm={setForm} keyBusy={keyBusy} onKeyFile={onKeyFile} />
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

      {/* ---- text input dialog (mkdir / rename; WebView2 has no window.prompt) ---- */}
      {ask && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setAsk(null)}>
          <div className="modal modal-sm">
            <h2>{ask.title}</h2>
            <div className="sub">{ask.label}</div>
            <input
              autoFocus
              value={ask.value}
              onChange={(e) => setAsk({ ...ask, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ask.value.trim()) {
                  const ok = ask.onOk;
                  setAsk(null);
                  ok(ask.value.trim());
                } else if (e.key === "Escape") {
                  setAsk(null);
                }
              }}
              spellCheck={false}
            />
            <div className="modal-foot">
              <button onClick={() => setAsk(null)}>取消</button>
              <button
                className="primary"
                disabled={!ask.value.trim()}
                onClick={() => {
                  const ok = ask.onOk;
                  setAsk(null);
                  ok(ask.value.trim());
                }}
              >
                确定
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

// One IO metric cell: label left, value right — single metric per cell so
// narrow panels never truncate values.
function IOMetric({
  label,
  value,
  title,
  icon,
  iconCls,
}: {
  label: string;
  value: string;
  title: string;
  icon?: string;
  iconCls?: string;
}) {
  return (
    <div className="io-item" title={title}>
      <span className="io-k">
        {icon && <Icon name={icon} size={11} className={iconCls} />}
        {label}
      </span>
      <span className="io-v">{value}</span>
    </div>
  );
}

// One level metric: label left, value right, bar underneath. The value uses
// the mono face so the numbers of neighbouring rows line up and can be
// compared without reading them.
function Stat({
  icon,
  label,
  pct,
  text,
  title,
  level,
}: {
  icon: string;
  label: string;
  pct: number;
  text: string;
  title?: string;
  level?: "green" | "yellow" | "red";
}) {
  const lv = level ?? (pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green");
  return (
    <div className="stat" title={title}>
      <div className="stat-head">
        <span className="stat-label">
          <Icon name={icon} size={12} /> {label}
        </span>
        <span className="stat-text">{text}</span>
      </div>
      <div className="stat-bar">
        <div className={`stat-fill ${lv}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}
