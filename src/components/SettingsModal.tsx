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

type Tab = "ai" | "aiadv" | "prompts" | "ssh" | "sec" | "ui" | "mcp";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("ai");

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
              <div className="nav-t">AI 配置</div>
              <div className="nav-d">厂商 · 模型 · 连通测试</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "aiadv" ? "active" : ""}`} onClick={() => setTab("aiadv")}>
            <span className="nav-ico"><Icon name="pencil" size={15} /></span>
            <div>
              <div className="nav-t">AI 高级</div>
              <div className="nav-d">提示词 · 诊断上下文</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "prompts" ? "active" : ""}`} onClick={() => setTab("prompts")}>
            <span className="nav-ico"><Icon name="pencil" size={15} /></span>
            <div>
              <div className="nav-t">提示词库</div>
              <div className="nav-d">新增 · 编辑 · 按模式绑定</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "ssh" ? "active" : ""}`} onClick={() => setTab("ssh")}>
            <span className="nav-ico"><Icon name="server" size={15} /></span>
            <div>
              <div className="nav-t">SSH 主机管理</div>
              <div className="nav-d">已保存连接的增删</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "sec" ? "active" : ""}`} onClick={() => setTab("sec")}>
            <span className="nav-ico"><Icon name="key" size={15} /></span>
            <div>
              <div className="nav-t">凭据管理</div>
              <div className="nav-d">全项目 Token 统一管理</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "ui" ? "active" : ""}`} onClick={() => setTab("ui")}>
            <span className="nav-ico"><Icon name="palette" size={15} /></span>
            <div>
              <div className="nav-t">外观</div>
              <div className="nav-d">配色主题</div>
            </div>
          </div>
          <div className={`settings-nav-item ${tab === "mcp" ? "active" : ""}`} onClick={() => setTab("mcp")}>
            <span className="nav-ico"><Icon name="zap" size={15} /></span>
            <div>
              <div className="nav-t">MCP 集成</div>
              <div className="nav-d">供 Trae / Cursor 等 IDE 调用</div>
            </div>
          </div>
          <div className="settings-nav-foot">
            <div className="nav-version">AI SSH Assistant · v0.1.0</div>
          </div>
        </div>
        <div className="settings-body">
          {tab === "ai" && <AiSettings onClose={onClose} />}
          {tab === "aiadv" && <AiAdvanced />}
          {tab === "prompts" && <PromptsPage />}
          {tab === "ssh" && <SshManager />}
          {tab === "sec" && <SecurityCenter />}
          {tab === "ui" && <Appearance />}
          {tab === "mcp" && <McpSettings />}
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

      {/* AI tab keeps provider config only; tokens live in the 凭据中心 tab */}

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

/* ================= AI 高级（诊断上下文 / Agent） ================= */

function AiAdvanced() {
  const [error, setError] = useState("");

  // ---- diagnosis context depth (how many recent output blocks to feed AI) ----
  const [depth, setDepth] = useState(1);
  const [depthSaved, setDepthSaved] = useState(false);
  useEffect(() => {
    ipc.getDiagnosisDepth().then((d) => setDepth(d || 1)).catch(() => {});
  }, []);
  const changeDepth = async (v: number) => {
    const clamped = Math.min(10, Math.max(1, Math.round(v) || 1));
    setDepth(clamped);
    try {
      await ipc.setDiagnosisDepth(clamped);
      setDepthSaved(true);
      setTimeout(() => setDepthSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  // ---- agent auto-green + exec timeout ----
  const [agentAutoGreen, setAgentAutoGreen] = useState(true);
  const [agentTimeout, setAgentTimeout] = useState(60);
  const [agentSaved, setAgentSaved] = useState(false);
  useEffect(() => {
    ipc
      .getAgentConfig()
      .then((c) => {
        setAgentAutoGreen(c.autoGreen);
        setAgentTimeout(c.agentExecTimeout);
      })
      .catch(() => {});
  }, []);

  const saveAgentConfig = (autoGreen: boolean, timeout: number) => {
    const t = Math.min(300, Math.max(5, Math.round(timeout) || 60));
    setAgentTimeout(t);
    ipc
      .setAgentConfig(autoGreen, t)
      .then(() => {
        setAgentSaved(true);
        setTimeout(() => setAgentSaved(false), 2000);
      })
      .catch((err) => setError(String(err)));
  };

  return (
    <>
      {/* diagnosis context depth */}
      <section className="set-section">
        <h3 className="set-title">诊断上下文</h3>
        <div className="depth-row">
          <span className="depth-label">追查前几步输出</span>
          <div className="depth-stepper">
            <button
              className="depth-btn"
              disabled={depth <= 1}
              onClick={() => changeDepth(depth - 1)}
              title="减少"
            >
              −
            </button>
            <span className="depth-value">{depth}</span>
            <button
              className="depth-btn"
              disabled={depth >= 10}
              onClick={() => changeDepth(depth + 1)}
              title="增加"
            >
              +
            </button>
          </div>
          <span className={`depth-saved ${depthSaved ? "show" : ""}`}>已保存</span>
        </div>
        <div className="dim-note" style={{ marginTop: 7 }}>
          一键诊断默认只抓取<strong>最近一次</strong>命令输出进行分析；若问题可能与前几步操作有关，可增大此值，让 AI 一起查看更早的输出（最多 10 步，消耗更多 Token）。
        </div>
      </section>

      {/* agent mode */}
      <section className="set-section">
        <h3 className="set-title">Agent 自动化运维</h3>
        <label className="check-chip">
          <input
            type="checkbox"
            checked={agentAutoGreen}
            onChange={(e) => {
              setAgentAutoGreen(e.target.checked);
              saveAgentConfig(e.target.checked, agentTimeout);
            }}
          />
          自动执行低风险（绿色）命令，黄色/红色始终需要确认
        </label>
        <div className="depth-row">
          <span className="depth-label">单条命令超时</span>
          <div className="depth-stepper">
            <button
              className="depth-btn"
              disabled={agentTimeout <= 5}
              onClick={() => saveAgentConfig(agentAutoGreen, agentTimeout - 5)}
              title="减少 5 秒"
            >
              −
            </button>
            <span className="depth-value">{agentTimeout}s</span>
            <button
              className="depth-btn"
              disabled={agentTimeout >= 300}
              onClick={() => saveAgentConfig(agentAutoGreen, agentTimeout + 5)}
              title="增加 5 秒"
            >
              +
            </button>
          </div>
          <span className={`depth-saved ${agentSaved ? "show" : ""}`}>已保存</span>
        </div>
        <div className="dim-note" style={{ marginTop: 7 }}>
          Agent 模式下 AI 逐步规划命令并自动观察输出；所有命令先经本地风险分级，高危操作永远弹出确认。关闭后每条命令都要手动批准。单条命令超时范围 5~300 秒（默认 60 秒）。
        </div>
      </section>

      {error && <div className="error-text">{error}</div>}
    </>
  );
}

/* ================= 提示词库（新增 / 编辑 / 删除 / 按模式绑定） ================= */

interface PromptEntry {
  id: string;
  name: string;
  content: string;
  forDiag: boolean;
  forChat: boolean;
  forAgent: boolean;
}

const emptyPrompt: PromptEntry = { id: "", name: "", content: "", forDiag: true, forChat: false, forAgent: false };

function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [editing, setEditing] = useState<PromptEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const flash = (text: string) => {
    setOkMsg(text);
    setTimeout(() => setOkMsg(""), 2200);
  };

  const refresh = () => {
    ipc.listPrompts().then(setPrompts).catch((e) => setError(String(e)));
  };
  useEffect(refresh, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await ipc.savePrompt(editing);
      setEditing(null);
      refresh();
      flash("提示词已保存");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PromptEntry) => {
    if (!window.confirm(`确定删除提示词「${p.name}」？`)) return;
    try {
      await ipc.deletePrompt(p.id);
      refresh();
      flash("已删除");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <section className="set-section">
        <div className="set-title-row">
          <h3 className="set-title">提示词库（{prompts.length}）</h3>
          <button className="primary small" onClick={() => setEditing({ ...emptyPrompt })}>
            <Icon name="plus" size={12} /> 新增提示词
          </button>
        </div>
        <div className="dim-note" style={{ marginBottom: 10 }}>
          每条提示词可绑定到「诊断」「对话」「Agent」模式；同一模式启用多条时按列表顺序合并生效。内置的输出格式与安全规则始终优先。
        </div>

        {editing && (
          <div className="prompt-form">
            <div className="form-grid">
              <label>名称</label>
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="例：运维新手风格"
                maxLength={30}
              />
              <label>内容</label>
              <textarea
                className="sys-prompt-input"
                rows={5}
                maxLength={2000}
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                placeholder="例：我是运维新手，请把我的大白话描述转成专业的排查命令，并逐步解释每条命令的作用。"
                spellCheck={false}
              />
              <label>应用模式</label>
              <div className="prompt-mode-checks">
                <label className="check-chip">
                  <input
                    type="checkbox"
                    checked={editing.forDiag}
                    onChange={(e) => setEditing({ ...editing, forDiag: e.target.checked })}
                  />
                  诊断
                </label>
                <label className="check-chip">
                  <input
                    type="checkbox"
                    checked={editing.forChat}
                    onChange={(e) => setEditing({ ...editing, forChat: e.target.checked })}
                  />
                  对话
                </label>
                <label className="check-chip">
                  <input
                    type="checkbox"
                    checked={editing.forAgent}
                    onChange={(e) => setEditing({ ...editing, forAgent: e.target.checked })}
                  />
                  Agent
                </label>
              </div>
            </div>
            <div className="modal-foot">
              <button onClick={() => setEditing(null)}>取消</button>
              <button
                className="primary"
                disabled={busy || !editing.content.trim() || (!editing.forDiag && !editing.forChat && !editing.forAgent)}
                onClick={save}
              >
                {busy ? "保存中…" : editing.id ? "保存修改" : "创建"}
              </button>
            </div>
          </div>
        )}

        {!editing && (
          <div className="prompt-list">
            {prompts.length === 0 && <div className="dim-note">暂无提示词，点击「新增提示词」创建。</div>}
            {prompts.map((p) => (
              <div key={p.id} className="prompt-card">
                <div className="prompt-card-head">
                  <span className="prompt-name">{p.name}</span>
                  <div className="prompt-badges">
                    {p.forDiag && <span className="auth-badge">诊断</span>}
                    {p.forChat && <span className="auth-badge">对话</span>}
                    {p.forAgent && <span className="auth-badge">Agent</span>}
                  </div>
                </div>
                <div className="prompt-preview">{p.content}</div>
                <div className="prompt-card-foot">
                  <button className="small" onClick={() => setEditing({ ...p })}>
                    <Icon name="pencil" size={12} /> 编辑
                  </button>
                  <button className="small" onClick={() => remove(p)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {okMsg && <div className="ok-text" style={{ marginTop: 8 }}>{okMsg}</div>}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </section>
    </>
  );
}

/* ================= 凭据中心（全项目 Token 统一管理） ================= */

interface CredRow {
  kind: "ai" | "ssh";
  id: string;
  name: string;
  sub: string;
  kindLabel: string;
  has: boolean;
}

function SecurityCenter() {
  const profiles = useStore((s) => s.profiles);
  const connections = useStore((s) => s.connections);
  const loadConnections = useStore((s) => s.loadConnections);
  const [state, setState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const sig = profiles.map((p) => p.id).join(",") + "|" + connections.map((c) => c.id).join(",");
  const refresh = async () => {
    const entries: [string, boolean][] = [];
    for (const p of profiles) entries.push([`ai:${p.id}`, await ipc.hasApiKey(p.id).catch(() => false)]);
    for (const c of connections) entries.push([`ssh:${c.id}`, await ipc.hasSavedPassword(c.id).catch(() => false)]);
    setState(Object.fromEntries(entries));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const rows: CredRow[] = [
    ...profiles.map((p) => ({
      kind: "ai" as const,
      id: p.id,
      name: p.name,
      sub: `${p.provider_id} · ${p.model || "未选模型"}`,
      kindLabel: "AI API Key",
      has: !!state[`ai:${p.id}`],
    })),
    ...connections.map((c) => ({
      kind: "ssh" as const,
      id: c.id,
      name: c.name,
      sub: `${c.username}@${c.host}:${c.port}`,
      kindLabel: c.auth_method === "password" ? "SSH 密码" : "私钥口令",
      has: !!state[`ssh:${c.id}`],
    })),
  ];

  const saveSecret = async (row: CredRow) => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      if (row.kind === "ai") {
        const p = profiles.find((x) => x.id === row.id);
        if (p) await ipc.saveProfile(p, draft.trim());
      } else {
        const c = connections.find((x) => x.id === row.id);
        if (c) await ipc.saveConnection(c, draft.trim());
      }
      setEditing(null);
      setDraft("");
      setMsg(`已更新「${row.name}」的${row.kindLabel}`);
      await refresh();
      if (row.kind === "ssh") await loadConnections();
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (row: CredRow) => {
    if (!window.confirm(`确定清除「${row.name}」的${row.kindLabel}？（记录保留，需要时重新填写）`)) return;
    setBusy(true);
    try {
      if (row.kind === "ai") await ipc.deleteApiKey(row.id);
      else await ipc.deleteSavedPassword(row.id);
      setMsg(`已清除「${row.name}」的${row.kindLabel}`);
      await refresh();
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const aiCount = rows.filter((r) => r.kind === "ai").length;
  const sshCount = rows.filter((r) => r.kind === "ssh").length;

  return (
    <section className="set-section">
      <h3 className="set-title">凭据中心（全项目统一管理）</h3>
      <div className="dim-note" style={{ marginBottom: 8 }}>
        所有凭据（AI API Key、SSH 密码/私钥口令）统一存于系统凭据库：不落盘、不进入日志。在此集中查看、更换或清除。
      </div>
      <div className="cred-stats">
        <span><Icon name="sparkles" size={12} className="ai-ico" /> AI 密钥 {aiCount} 项</span>
        <span><Icon name="server" size={12} className="ico-accent" /> SSH 凭据 {sshCount} 项</span>
      </div>
      <div className="token-list">
        {rows.length === 0 && <div className="dim-note">暂无任何凭据。配置 AI Provider 或添加主机后显示在这里。</div>}
        {rows.map((row) => (
          <div key={`${row.kind}:${row.id}`} className="token-row">
            <span className={`key-dot ${row.has ? "on" : "off"}`} />
            <div className="token-main">
              <div className="token-name">
                {row.name}
                <em className="cred-kind">{row.kindLabel}</em>
              </div>
              <div className="token-sub">{row.sub}</div>
            </div>
            <span className={`auth-badge ${row.has ? "" : "missing"}`}>{row.has ? "已配置" : "未配置"}</span>
            {editing === `${row.kind}:${row.id}` ? (
              <div className="token-edit">
                <input
                  type="password"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`输入新的${row.kindLabel}`}
                  spellCheck={false}
                />
                <button className="primary small" disabled={!draft.trim() || busy} onClick={() => saveSecret(row)}>保存</button>
                <button className="small" onClick={() => { setEditing(null); setDraft(""); }}>取消</button>
              </div>
            ) : (
              <div className="token-actions">
                <button className="small" onClick={() => { setEditing(`${row.kind}:${row.id}`); setDraft(""); setMsg(""); }}>
                  <Icon name="pencil" size={12} /> {row.has ? "更换" : "填写"}
                </button>
                {row.has && (
                  <button className="small" disabled={busy} onClick={() => clearSecret(row)}>
                    清除
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {msg && <div className="ok-text" style={{ marginTop: 8 }}>{msg}</div>}
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
  const [okMsg, setOkMsg] = useState("");
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

  // ---- 会话分组 / 导入导出 ----
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const grouped = useMemo(() => {
    const map: Record<string, ConnectionConfig[]> = {};
    for (const c of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
      const g = (c.group || "").trim();
      (map[g] ??= []).push(c);
    }
    // 未分组排最后
    return Object.fromEntries(
      Object.entries(map).sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))),
    );
  }, [connections]);

  const exportConns = () => {
    navigator.clipboard
      .writeText(JSON.stringify(connections, null, 2))
      .then(() => setErr(""))
      .catch((e) => setErr(`导出失败：${String(e)}`));
    setOkMsg("已复制到剪贴板");
    setTimeout(() => setOkMsg(""), 2000);
  };

  const importConns = async () => {
    setBusy(true);
    setErr("");
    try {
      const list = JSON.parse(importText) as ConnectionConfig[];
      if (!Array.isArray(list)) throw new Error("格式不是数组");
      const existing = new Set(connections.map((c) => c.id));
      let added = 0;
      for (const c of list) {
        if (!c || !c.host || !c.username) continue;
        const id = existing.has(c.id) ? `conn-${Date.now()}-${added}` : c.id;
        await ipc.saveConnection({ ...c, id }, null);
        existing.add(id);
        added++;
      }
      await loadConnections();
      setShowImport(false);
      setImportText("");
      setOkMsg(`已导入 ${added} 台主机（密码需重新输入或连接时保存）`);
      setTimeout(() => setOkMsg(""), 4000);
    } catch (e) {
      setErr(`导入失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
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
          <div style={{ display: "flex", gap: 7 }}>
            <button className="small" title="把所有主机复制为 JSON（用于迁移/备份）" onClick={exportConns}>
              导出
            </button>
            <button className="small" title="粘贴 JSON 恢复主机列表" onClick={() => setShowImport((v) => !v)}>
              导入
            </button>
            <button className="primary small" onClick={openAdd}>
              <Icon name="plus" size={12} /> 添加主机
            </button>
          </div>
        </div>

        {showImport && (
          <div className="prompt-form">
            <div className="dim-note" style={{ marginBottom: 8 }}>
              粘贴此前导出的 JSON（导入会跳过已存在的 ID，不会覆盖现有主机）。
            </div>
            <textarea
              className="sys-prompt-input"
              rows={6}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='[{"id":"...","name":"web-1","host":"1.2.3.4",...}]'
              spellCheck={false}
              style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}
            />
            <div className="modal-foot">
              <button onClick={() => setShowImport(false)}>取消</button>
              <button className="primary" disabled={busy} onClick={importConns}>
                {busy ? "导入中…" : "导入"}
              </button>
            </div>
          </div>
        )}

        <div className="ssh-list">
          {connections.length === 0 && <div className="dim-note">暂无保存的主机。</div>}
          {Object.entries(grouped).map(([group, list]) => (
            <div key={group} className="ssh-group">
              {group !== "" && <div className="ssh-group-title">{group}（{list.length}）</div>}
              {list.map((c) => {
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
          ))}
        </div>
      </section>

      {okMsg && <div className="ok-text" style={{ marginTop: 8 }}>{okMsg}</div>}
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

/* ================= MCP 集成 ================= */

function McpSettings() {
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState(8615);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    ipc
      .getMcpConfig()
      .then((c) => {
        setEnabled(c.enabled);
        setPort(c.port);
        setToken(c.token);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const save = async () => {
    setBusy(true);
    setOkMsg("");
    try {
      await ipc.setMcpConfig(enabled, port);
      setOkMsg(enabled ? "已保存。重启应用后服务在 127.0.0.1:" + port + " 生效" : "已保存，MCP 服务关闭");
      setTimeout(() => setOkMsg(""), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sampleConfig = JSON.stringify(
    {
      mcpServers: {
        "ai-ssh-assistant": {
          type: "streamable-http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token || "<你的Token>"}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <>
      <section className="set-section">
        <h3 className="set-title">MCP 服务（Model Context Protocol）</h3>
        <div className="dim-note" style={{ marginBottom: 10 }}>
          开启后，本机运行的 IDE（Trae、Cursor、Claude Code 等）可通过 MCP 协议调用本应用的能力：列出主机、连接 SSH、执行命令、读取终端输出、AI 诊断。
          服务仅监听 127.0.0.1，并要求 Bearer Token 认证。
        </div>
        <div className="form-grid">
          <label>启用服务</label>
          <label className="check-chip">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            在本机开放 MCP 端点（重启应用后生效）
          </label>
          <label>端口</label>
          <input
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 8615)}
            placeholder="8615"
            spellCheck={false}
          />
          <label>Token</label>
          <div className="key-upload">
            <input value={token} readOnly spellCheck={false} style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5 }} />
            <button
              className="small"
              onClick={() => {
                navigator.clipboard.writeText(token);
                setOkMsg("Token 已复制");
                setTimeout(() => setOkMsg(""), 2000);
              }}
            >
              <Icon name="copy" size={12} /> 复制
            </button>
          </div>
        </div>
        {okMsg && <div className="ok-text" style={{ marginTop: 8 }}>{okMsg}</div>}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
        <div className="modal-foot">
          <button className="primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </section>

      <section className="set-section">
        <h3 className="set-title">IDE 配置示例</h3>
        <div className="dim-note" style={{ marginBottom: 8 }}>
          将下面 JSON 加入 IDE 的 MCP 配置（Trae：设置 › MCP › 添加；Cursor：~/.cursor/mcp.json）。
        </div>
        <textarea
          className="sys-prompt-input"
          rows={9}
          readOnly
          value={sampleConfig}
          spellCheck={false}
          style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}
        />
        <div className="sys-prompt-foot">
          <span className="dim-note">工具：list_hosts / connect_host / exec_command / screen_tail / diagnose / disconnect</span>
          <button className="small" onClick={() => navigator.clipboard.writeText(sampleConfig)}>
            <Icon name="copy" size={12} /> 复制配置
          </button>
        </div>
      </section>
    </>
  );
}

/* ================= 外观 ================= */

// 预览色与 styles.css 主题 v2 token 保持一致（GitHub/Nord/Everforest/Rosé Pine）
const THEME_CARDS: { id: ThemeName; name: string; sw: [string, string, string] }[] = [
  { id: "dark", name: "深色", sw: ["#0d1117", "#21262d", "#58a6ff"] },
  { id: "light", name: "日间", sw: ["#ffffff", "#f6f8fa", "#0969da"] },
  { id: "ocean", name: "海洋", sw: ["#2e3440", "#434c5e", "#88c0d0"] },
  { id: "forest", name: "森林", sw: ["#2f383e", "#414b50", "#a7c080"] },
  { id: "sakura", name: "樱花", sw: ["#faf4ed", "#f4ede8", "#b4637a"] },
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
