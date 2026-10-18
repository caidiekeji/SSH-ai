// Modern settings modal: left navigation + three sections.
//   - AI 设置: vendor dropdown → API key → fetch models → select → test → save
//   - SSH 主机管理: list / add / delete saved connections
//   - 外观: color theme picker (moved out of the left panel)
// All PRD §2.2 state-machine edges (S0–S5) are preserved.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ConnectionConfig, ProviderProfile, ProviderSpec, ThemeName } from "../types";
import { Icon } from "./Icon";

type Tab = "ai" | "ssh" | "ui";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("ai");
  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <div className="settings-nav">
          <div className="settings-brand">
            <span className="brand-mark">{">_"}</span>
            <div>
              <div className="brand-title">设置</div>
              <div className="brand-sub">API Key 存于系统凭据库，绝不落盘</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "ai" ? "active" : ""}`} onClick={() => setTab("ai")}>
            <span className="nav-ico"><Icon name="sparkles" size={15} /></span>
            <div>
              <div className="nav-t">AI 设置</div>
              <div className="nav-d">厂商 · 模型 · 连通测试</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "ssh" ? "active" : ""}`} onClick={() => setTab("ssh")}>
            <span className="nav-ico"><Icon name="server" size={15} /></span>
            <div>
              <div className="nav-t">SSH 主机管理</div>
              <div className="nav-d">已保存连接的增删</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "ui" ? "active" : ""}`} onClick={() => setTab("ui")}>
            <span className="nav-ico"><Icon name="palette" size={15} /></span>
            <div>
              <div className="nav-t">外观</div>
              <div className="nav-d">配色主题</div>
            </div>
          </div>
          <div className="settings-nav-foot">
            <button onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="settings-body">
          {tab === "ai" && <AiSettings onClose={onClose} />}
          {tab === "ssh" && <SshManager />}
          {tab === "ui" && <Appearance />}
        </div>
      </div>
    </div>
  );
}

/* ================= AI 设置 ================= */

function AiSettings({ onClose }: { onClose: () => void }) {
  const specs = useStore((s) => s.specs);
  const profiles = useStore((s) => s.profiles);
  const loadProviderData = useStore((s) => s.loadProviderData);

  const [selectedSpec, setSelectedSpec] = useState<ProviderSpec | null>(null);
  const [editingProfile, setEditingProfile] = useState<ProviderProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "fetch" | "test">("");
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [notice, setNotice] = useState("");

  const state: string = useMemo(() => {
    if (busy === "fetch") return "S2_FETCHING_MODELS";
    if (busy === "test") return "S4_TESTING";
    if (!selectedSpec) return "S0_UNCONFIGURED";
    if (!apiKey && !editingProfile) return "S1_KEY_ENTERED";
    if (models.length > 0 && model) return "S3_MODELS_READY";
    if (model) return "S3_MANUAL";
    return "S1_KEY_ENTERED";
  }, [busy, selectedSpec, apiKey, editingProfile, models, model]);

  useEffect(() => {
    if (selectedSpec) setBaseUrl(selectedSpec.default_base_url);
  }, [selectedSpec]);

  const pickSpec = (s: ProviderSpec) => {
    setSelectedSpec(s);
    setEditingProfile(null);
    setApiKey("");
    setModel("");
    setModels([]);
    setError("");
    setOkMsg("");
    setNotice("");
  };

  const editProfile = async (p: ProviderProfile) => {
    setEditingProfile(p);
    const spec = specs.find((s) => s.id === p.provider_id) ?? null;
    setSelectedSpec(spec);
    setBaseUrl(p.base_url || spec?.default_base_url || "");
    setModel(p.model);
    setModels([]);
    setApiKey("");
    setError("");
    setOkMsg("");
    setNotice("");
    const has = await ipc.hasApiKey(p.id).catch(() => false);
    if (!has) setNotice("该 Profile 未保存 API Key，请输入");
  };

  const fetchModels = async () => {
    if (!selectedSpec) return;
    setBusy("fetch");
    setError("");
    setOkMsg("");
    setNotice("");
    const probe: ProviderProfile = {
      id: editingProfile?.id || `pending-${Date.now()}`,
      name: editingProfile?.name || "draft",
      provider_id: selectedSpec.id,
      base_url: baseUrl || selectedSpec.default_base_url,
      model: "",
      model_source: "api",
    };
    try {
      const list = await ipc.fetchModels(probe, apiKey || null);
      const ids = list.map((m) => m.id);
      setModels(ids);
      if (ids.length && !ids.includes(model)) setModel(ids[0]);
      setOkMsg(`已获取 ${ids.length} 个模型，请在下方选择`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("不支持模型列表")) {
        setModels([]);
        setNotice("该 Provider 不支持模型列表，请手动输入模型名");
      } else {
        setError(msg);
      }
    } finally {
      setBusy("");
    }
  };

  const testConnection = async () => {
    if (!selectedSpec || !model) return;
    setBusy("test");
    setError("");
    setOkMsg("");
    const probe: ProviderProfile = {
      id: editingProfile?.id || `pending-${Date.now()}`,
      name: editingProfile?.name || "draft",
      provider_id: selectedSpec.id,
      base_url: baseUrl || selectedSpec.default_base_url,
      model,
      model_source: models.length ? "api" : "manual",
    };
    try {
      const r = await ipc.testProvider(probe, apiKey || null);
      setOkMsg(`连通成功：${r.model} → "${r.reply}"`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!selectedSpec || !model) return;
    const p: ProviderProfile = {
      id: editingProfile?.id || `profile-${Date.now()}`,
      name: editingProfile?.name || `${selectedSpec.display_name}`,
      provider_id: selectedSpec.id,
      base_url: baseUrl || selectedSpec.default_base_url,
      model,
      model_source: models.length ? "api" : "manual",
      created_at: new Date().toISOString(),
    };
    try {
      await useStore.getState().saveAndSelectProfile(p, apiKey || null);
      await loadProviderData();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeProfile = async (id: string) => {
    await ipc.deleteProfile(id);
    await loadProviderData();
    if (editingProfile?.id === id) {
      setSelectedSpec(null);
      setEditingProfile(null);
    }
  };

  const stepDone = {
    vendor: !!selectedSpec,
    key: !!apiKey || !!editingProfile,
    model: !!model,
  };

  return (
    <>
      {/* saved profiles */}
      <section className="set-section">
        <h3 className="set-title">已保存 Profile</h3>
        {profiles.length === 0 && <div className="dim-note">暂无，先在下方完成配置并保存。</div>}
        <div className="profile-grid">
          {profiles.map((p) => (
            <div key={p.id} className={`profile-card ${editingProfile?.id === p.id ? "active" : ""}`}>
              <div className="profile-main" onClick={() => editProfile(p)}>
                <div className="profile-name">{p.name}</div>
                <div className="profile-model">{p.model || "未选模型"}</div>
              </div>
              <button className="icon-op danger" title="删除" onClick={() => removeProfile(p.id)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* config wizard */}
      <section className="set-section">
        <h3 className="set-title">
          配置新 Provider
          <span className="state-pill">{state}</span>
        </h3>

        <div className="wizard">
          {/* step 1: vendor dropdown */}
          <div className="w-step">
            <div className="w-head">
              <span className={`w-num ${stepDone.vendor ? "done" : ""}`}>1</span>
              选择厂商
            </div>
            <select
              className="w-select"
              value={selectedSpec?.id ?? ""}
              onChange={(e) => {
                const s = specs.find((x) => x.id === e.target.value);
                if (s) pickSpec(s);
              }}
            >
              <option value="" disabled>
                — 请选择厂商 —
              </option>
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
            {selectedSpec && (
              <div className="field-row">
                <label>接口地址（自动带出，可修改）</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selectedSpec.default_base_url} spellCheck={false} />
              </div>
            )}
          </div>

          {/* step 2: api key */}
          {selectedSpec && (
            <div className="w-step">
              <div className="w-head">
                <span className={`w-num ${stepDone.key ? "done" : ""}`}>2</span>
                填入 API Key
                <em className="w-hint">仅存入系统凭据库</em>
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editingProfile ? "留空 = 保留已保存的 Key" : "sk-…"}
                spellCheck={false}
              />
            </div>
          )}

          {/* step 3: models */}
          {selectedSpec && (
            <div className="w-step">
              <div className="w-head">
                <span className={`w-num ${stepDone.model ? "done" : ""}`}>3</span>
                获取并选择模型
              </div>
              <div className="w-row">
                <button
                  disabled={(!apiKey && !editingProfile) || busy !== ""}
                  onClick={fetchModels}
                  title={selectedSpec.model_list_policy === "preset" ? "Anthropic 使用预置列表" : "GET {base_url}/models"}
                >
                  <Icon name="refresh" size={12} /> {busy === "fetch" ? "获取中…" : "获取模型"}
                </button>
                {models.length > 0 ? (
                  <select className="w-select flex1" value={model} onChange={(e) => setModel(e.target.value)}>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="flex1"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="手动输入模型名（列表不可用时）"
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          )}

          {/* step 4: test & save */}
          {selectedSpec && (
            <div className="w-step">
              <div className="w-head">
                <span className={`w-num ${okMsg.startsWith("连通成功") ? "done" : ""}`}>4</span>
                测试连通并保存
              </div>
              <div className="w-row">
                <button disabled={!model || busy !== ""} onClick={testConnection}>
                  <Icon name="zap" size={12} /> {busy === "test" ? "测试中…" : "测试连通性"}
                </button>
                <button className="primary" disabled={!model} onClick={save}>
                  <Icon name="check" size={12} /> 保存 Profile
                </button>
              </div>
              {error && <div className="error-text">{error}</div>}
              {notice && <div className="degraded-note" style={{ marginTop: 8 }}>{notice}</div>}
              {okMsg && <div className="ok-text">{okMsg}</div>}
            </div>
          )}

          {!selectedSpec && (
            <div className="wizard-empty">从上方下拉框选择厂商开始 — 接口地址会自动带出。</div>
          )}
        </div>
      </section>
    </>
  );
}

/* ================= SSH 主机管理 ================= */

function SshManager() {
  const connections = useStore((s) => s.connections);
  const loadConnections = useStore((s) => s.loadConnections);
  const connStatus = useStore((s) => s.connStatus);
  const activeHost = useStore((s) => s.activeHost);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 22,
    username: "root",
    authMethod: "password" as "password" | "publickey",
    password: "",
    keyPath: "",
    keyFileName: "",
  });
  const [keyBusy, setKeyBusy] = useState(false);

  const onKeyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setKeyBusy(true);
    setErr("");
    try {
      const content = await f.text();
      const path = await ipc.saveUploadedKey(`key-${Date.now()}`, content);
      setForm((prev) => ({ ...prev, keyPath: path, keyFileName: f.name }));
    } catch (err) {
      setErr(String(err));
    } finally {
      setKeyBusy(false);
      e.target.value = "";
    }
  };
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  const add = async () => {
    if (!form.host || !form.username) return;
    setBusy(true);
    setErr("");
    try {
      const conn: ConnectionConfig = {
        id: `conn-${Date.now()}`,
        name: form.name || form.host,
        host: form.host,
        port: Number(form.port) || 22,
        username: form.username,
        auth_method: form.authMethod,
        key_path: form.authMethod === "publickey" ? form.keyPath : null,
      };
      await ipc.saveConnection(conn, form.password || null);
      await loadConnections();
      setShowAdd(false);
      setForm({ name: "", host: "", port: 22, username: "root", authMethod: "password", password: "", keyPath: "", keyFileName: "" });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("确定删除该主机记录？（密码将从系统凭据库一并移除）")) return;
    await ipc.deleteConnection(id);
    await loadConnections();
  };

  return (
    <>
      <section className="set-section">
        <div className="set-title-row">
          <h3 className="set-title">已保存主机（{connections.length}）</h3>
          <button className="primary small" onClick={() => setShowAdd(!showAdd)}>
            <Icon name="plus" size={12} /> {showAdd ? "收起" : "添加主机"}
          </button>
        </div>

        <div className="ssh-list">
          {connections.length === 0 && <div className="dim-note">暂无保存的主机。</div>}
          {connections.map((c) => {
            const isActive = connStatus === "connected" && activeHost?.startsWith(`${c.host}:`);
            return (
              <div key={c.id} className={`ssh-card ${isActive ? "active" : ""}`}>
                <span className={`host-dot ${isActive ? "on" : ""}`} />
                <div className="ssh-main">
                  <div className="ssh-name">{c.name}</div>
                  <div className="ssh-addr">
                    {c.username}@{c.host}:{c.port}
                  </div>
                </div>
                <span className="auth-badge">{c.auth_method === "password" ? "密码" : "私钥"}</span>
                <button className="icon-op danger" title="删除" onClick={() => remove(c.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {showAdd && (
        <section className="set-section">
          <h3 className="set-title">添加主机</h3>
          <div className="ssh-form">
            <div className="ssh-form-grid">
              <label>名称</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="可选，默认用主机名" />
              <label>主机</label>
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10" spellCheck={false} />
              <label>端口</label>
              <input value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })} />
              <label>用户名</label>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} spellCheck={false} />
              <label>认证方式</label>
              <select value={form.authMethod} onChange={(e) => setForm({ ...form, authMethod: e.target.value as "password" | "publickey" })}>
                <option value="password">密码</option>
                <option value="publickey">私钥</option>
              </select>
              {form.authMethod === "password" ? (
                <>
                  <label>密码</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="存入系统凭据库" />
                </>
              ) : (
                <>
                  <label>私钥文件</label>
                  <div className="key-upload">
                    <label className={`upload-btn ${keyBusy ? "busy" : ""}`}>
                      <Icon name="file" size={13} /> {keyBusy ? "上传中…" : "选择文件上传"}
                      <input type="file" style={{ display: "none" }} onChange={onKeyFile} accept=".pem,.key,.ppk,id_rsa,id_ed25519,id_ecdsa" />
                    </label>
                    <span className="key-file-name" title={form.keyPath}>
                      {form.keyFileName || "未选择（也可手动填路径）"}
                    </span>
                  </div>
                  <label>私钥路径</label>
                  <input value={form.keyPath} onChange={(e) => setForm({ ...form, keyPath: e.target.value })} placeholder="C:\Users\you\.ssh\id_ed25519" spellCheck={false} />
                  <label>私钥口令</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="无则留空，存入系统凭据库" />
                </>
              )}
            </div>
            {err && <div className="error-text">{err}</div>}
            <div className="modal-foot">
              <button onClick={() => setShowAdd(false)}>取消</button>
              <button className="primary" disabled={!form.host || !form.username || busy} onClick={add}>
                {busy ? "保存中…" : "保存到凭据库"}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

/* ================= 外观 ================= */

const THEME_CARDS: { id: ThemeName; name: string; sw: [string, string, string] }[] = [
  { id: "dark", name: "深色", sw: ["#0f1216", "#1c2128", "#4c8dff"] },
  { id: "light", name: "日间", sw: ["#ffffff", "#f6f8fa", "#0969da"] },
  { id: "ocean", name: "海洋", sw: ["#0b1220", "#152238", "#38bdf8"] },
  { id: "forest", name: "森林", sw: ["#0c1310", "#17251c", "#34d399"] },
  { id: "sakura", name: "樱花", sw: ["#171015", "#271c23", "#f472b6"] },
];

function Appearance() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <section className="set-section">
      <h3 className="set-title">配色主题</h3>
      <div className="theme-grid">
        {THEME_CARDS.map((t) => (
          <div
            key={t.id}
            className={`theme-card ${theme === t.id ? "active" : ""}`}
            onClick={() => setTheme(t.id)}
          >
            <div className="theme-preview">
              <span style={{ background: t.sw[0] }} />
              <span style={{ background: t.sw[1] }} />
              <span style={{ background: t.sw[2] }} />
            </div>
            <span className="theme-name">
              {t.name}
              {theme === t.id && <Icon name="check" size={12} className="ico-accent" />}
            </span>
          </div>
        ))}
      </div>
      <div className="dim-note" style={{ marginTop: 10 }}>
        切换即时生效并自动保存；终端配色会跟随主题同步变化。
      </div>
    </section>
  );
}
