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
import {
  HostFormFields,
  connFromForm,
  emptyHostForm,
  formFromConn,
  useKeyUpload,
  type HostFormValues,
} from "./HostForm";

type Tab = "ai" | "ssh" | "ui";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("ai");
  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <button className="modal-x" title="关闭 (Esc)" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
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
            <div className="nav-version">AI SSH Assistant · v0.1.0</div>
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

  // ---- global system prompt (optional, applies to all providers) ----
  const [sysPrompt, setSysPrompt] = useState("");
  const [sysSaved, setSysSaved] = useState(false);
  const [sysBusy, setSysBusy] = useState(false);
  useEffect(() => {
    ipc.getSystemPrompt().then(setSysPrompt).catch(() => {});
  }, []);
  const saveSysPrompt = async () => {
    setSysBusy(true);
    setSysSaved(false);
    try {
      await ipc.setSystemPrompt(sysPrompt);
      setSysSaved(true);
      setTimeout(() => setSysSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSysBusy(false);
    }
  };

  return (
    <>
      {/* global system prompt */}
      <section className="set-section">
        <h3 className="set-title">系统提示词（可选）</h3>
        <div className="dim-note" style={{ marginBottom: 8 }}>
          自定义 AI 的回答风格，例如「把我的大白话转成专业命令并解释」。它会叠加在内置诊断规则之前，内置的输出格式与安全规则始终生效。留空使用默认。
        </div>
        <textarea
          className="sys-prompt-input"
          rows={4}
          maxLength={2000}
          value={sysPrompt}
          onChange={(e) => setSysPrompt(e.target.value)}
          placeholder="例：我是运维新手，请把我的大白话描述转成专业的排查命令，并逐步解释每条命令的作用。"
          spellCheck={false}
        />
        <div className="sys-prompt-foot">
          <span className="dim-note">{sysPrompt.length}/2000{sysSaved ? " · 已保存" : ""}</span>
          <button className="primary small" disabled={sysBusy} onClick={saveSysPrompt}>
            {sysBusy ? "保存中…" : "保存提示词"}
          </button>
        </div>
      </section>

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

      {/* unified token management */}
      <TokenManager />

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

/* ================= Token 统一管理 ================= */

function TokenManager() {
  const profiles = useStore((s) => s.profiles);
  const [keyState, setKeyState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const ids = profiles.map((p) => p.id).join(",");
  const refreshKeys = async () => {
    const entries = await Promise.all(
      profiles.map(async (p) => [p.id, await ipc.hasApiKey(p.id).catch(() => false)] as const),
    );
    setKeyState(Object.fromEntries(entries));
  };
  useEffect(() => {
    refreshKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  const saveKey = async (p: ProviderProfile) => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await ipc.saveProfile(p, draft.trim());
      setEditing(null);
      setDraft("");
      setMsg(`已更新「${p.name}」的 API Key`);
      await refreshKeys();
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (p: ProviderProfile) => {
    if (!window.confirm(`确定清除「${p.name}」已保存的 API Key？（Profile 保留，诊断前需重新填写）`)) return;
    setBusy(true);
    try {
      await ipc.deleteApiKey(p.id);
      setMsg(`已清除「${p.name}」的 API Key`);
      await refreshKeys();
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (profiles.length === 0) return null;
  return (
    <section className="set-section">
      <h3 className="set-title">API 密钥（Token）统一管理</h3>
      <div className="dim-note" style={{ marginBottom: 8 }}>
        所有密钥仅存于系统凭据库，不落盘、不进入日志。在此集中更换或清除。
      </div>
      <div className="token-list">
        {profiles.map((p) => {
          const has = !!keyState[p.id];
          return (
            <div key={p.id} className="token-row">
              <span className={`key-dot ${has ? "on" : "off"}`} />
              <div className="token-main">
                <div className="token-name">{p.name}</div>
                <div className="token-sub">{p.provider_id} · {p.model || "未选模型"}</div>
              </div>
              <span className={`auth-badge ${has ? "" : "missing"}`}>{has ? "已配置" : "未配置"}</span>
              {editing === p.id ? (
                <div className="token-edit">
                  <input
                    type="password"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="粘贴新的 API Key"
                    spellCheck={false}
                  />
                  <button className="primary small" disabled={!draft.trim() || busy} onClick={() => saveKey(p)}>保存</button>
                  <button className="small" onClick={() => { setEditing(null); setDraft(""); }}>取消</button>
                </div>
              ) : (
                <div className="token-actions">
                  <button className="small" onClick={() => { setEditing(p.id); setDraft(""); setMsg(""); }}>
                    <Icon name="pencil" size={12} /> {has ? "更换" : "填写"}
                  </button>
                  {has && (
                    <button className="small" disabled={busy} onClick={() => clearKey(p)}>
                      清除
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {msg && <div className="ok-text" style={{ marginTop: 8 }}>{msg}</div>}
      <div className="dim-note" style={{ marginTop: 6 }}>共 {profiles.length} 个 Profile，密钥状态实时读取自系统凭据库。</div>
    </section>
  );
}

/* ================= SSH 主机管理 ================= */
function SshManager() {
  const connections = useStore((s) => s.connections);
  const loadConnections = useStore((s) => s.loadConnections);
  const connStatus = useStore((s) => s.connStatus);
  const activeHost = useStore((s) => s.activeHost);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<HostFormValues>(emptyHostForm);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { keyBusy, onKeyFile } = useKeyUpload(setForm, setErr);

  useEffect(() => {
    loadConnections();
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyHostForm());
    setErr("");
    setShowAdd(true);
  };

  const openEdit = (c: ConnectionConfig) => {
    setEditingId(c.id);
    setForm(formFromConn(c));
    setErr("");
    setShowAdd(true);
  };

  const save = async () => {
    if (!form.host || !form.username) return;
    setBusy(true);
    setErr("");
    try {
      const conn = connFromForm(form, editingId ?? `conn-${Date.now()}`);
      // Empty password in edit mode → the stored keychain secret is kept.
      await ipc.saveConnection(conn, form.password || null);
      await loadConnections();
      setShowAdd(false);
      setEditingId(null);
      setForm(emptyHostForm());
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
          <button className="primary small" onClick={openAdd}>
            <Icon name="plus" size={12} /> 添加主机
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
                <button className="icon-op" title="编辑" onClick={() => openEdit(c)}>
                  <Icon name="pencil" size={13} />
                </button>
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
          <h3 className="set-title">{editingId ? "编辑主机" : "添加主机"}</h3>
          <div className="ssh-form">
            <HostFormFields form={form} setForm={setForm} keyBusy={keyBusy} onKeyFile={onKeyFile} />
            {err && <div className="error-text">{err}</div>}
            <div className="modal-foot">
              <button onClick={() => { setShowAdd(false); setEditingId(null); }}>取消</button>
              <button className="primary" disabled={!form.host || !form.username || busy} onClick={save}>
                {busy ? "保存中…" : editingId ? "保存修改" : "保存到凭据库"}
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
