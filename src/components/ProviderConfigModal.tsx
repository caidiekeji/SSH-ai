// Provider configuration closed loop (PRD §2.2): S0 → S1 → S2 → S3(_MANUAL)
// → S4 → S5, with every failure edge handled.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ProviderProfile, ProviderSpec } from "../types";
import { aiStateLabel } from "./App";

export function ProviderConfigModal({ onClose }: { onClose: () => void }) {
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

  // Current machine state, derived from inputs (S0–S5).
  const state: string = useMemo(() => {
    if (busy === "fetch") return "S2_FETCHING_MODELS";
    if (busy === "test") return "S4_TESTING";
    if (!selectedSpec) return "S0_UNCONFIGURED";
    if (!apiKey && !editingProfile) return "S1_UNENTERED";
    if (models.length > 0 && model) return "S3_MODELS_READY";
    if (model) return "S3_MANUAL";
    return "S1_KEY_ENTERED";
  }, [busy, selectedSpec, apiKey, editingProfile, models, model]);

  useEffect(() => {
    if (selectedSpec) setBaseUrl(selectedSpec.default_base_url);
  }, [selectedSpec]);

  const reset = () => {
    setSelectedSpec(null);
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
    const has = await ipc.hasApiKey(p.id).catch(() => false);
    if (!has) setNotice("该 Profile 未保存 API Key，请输入");
  };

  const newProfile = () => {
    reset();
    setSelectedSpec(null);
  };

  // S2: fetch models — handles 401/404/timeout semantics (PRD §3.3).
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
      setOkMsg(`已获取 ${ids.length} 个模型`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("不支持模型列表")) {
        // 404 → S3_MANUAL (PRD §2.2).
        setModels([]);
        setNotice("该 Provider 不支持模型列表，请手动输入模型名");
      } else {
        setError(msg);
      }
    } finally {
      setBusy("");
    }
  };

  // S4: connectivity test — shows status + first 200 chars of body on fail.
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

  // S5: save. Keychain failure MUST NOT degrade to plaintext (PRD §2.2).
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
      reset();
      setOkMsg("已保存");
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeProfile = async (id: string) => {
    await ipc.deleteProfile(id);
    await loadProviderData();
    if (editingProfile?.id === id) reset();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: "min(880px, 94vw)" }}>
        <h2>AI Provider 配置</h2>
        <div className="sub">
          当前状态：<span className="state-pill">{stateLabel(state)}</span>
          {" · "}API Key 存储于系统凭据库，绝不落盘
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16 }}>
          {/* Left: profile list + spec picker */}
          <div>
            <h3 style={{ margin: "4px 0 8px", color: "var(--text-dim)", fontSize: 12 }}>已保存 Profile</h3>
            {profiles.map((p) => (
              <div key={p.id} className="host-item" onClick={() => editProfile(p)}>
                <div className="host-name">{p.name}</div>
                <div className="host-addr">{p.model || "未选模型"}</div>
                <button
                  className="small danger"
                  style={{ marginTop: 4 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeProfile(p.id);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
            <button className="small" onClick={newProfile} style={{ marginTop: 6 }}>
              + 新建
            </button>

            <h3 style={{ margin: "14px 0 8px", color: "var(--text-dim)", fontSize: 12 }}>选择 Provider</h3>
            <div className="provider-pick" style={{ gridTemplateColumns: "1fr" }}>
              {specs.map((s) => (
                <div
                  key={s.id}
                  className={`spec ${selectedSpec?.id === s.id ? "selected" : ""}`}
                  onClick={() => {
                    reset();
                    setSelectedSpec(s);
                    setEditingProfile(null);
                  }}
                >
                  {s.display_name}
                </div>
              ))}
            </div>
          </div>

          {/* Right: form */}
          <div>
            {!selectedSpec ? (
              <div style={{ color: "var(--text-dim)", padding: 30, textAlign: "center" }}>
                左侧选择一个 Provider 开始配置
              </div>
            ) : (
              <div className="form-grid">
                <label>显示名</label>
                <input
                  value={editingProfile?.name ?? ""}
                  placeholder={selectedSpec.display_name}
                  onChange={(e) =>
                    setEditingProfile(
                      editingProfile ? { ...editingProfile, name: e.target.value } : null,
                    )
                  }
                  disabled={!editingProfile}
                />
                <label>API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editingProfile ? "留空 = 保留已保存的 Key" : "sk-…"}
                />
                <label>Base URL</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selectedSpec.default_base_url || "https://…"} />
                <label>模型</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="手动输入或从列表选择" />
                <div />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="small"
                    disabled={!apiKey && !editingProfile || busy !== ""}
                    onClick={fetchModels}
                    title={selectedSpec.model_list_policy === "preset" ? "Anthropic 使用预置列表" : "GET {base_url}/models"}
                  >
                    {busy === "fetch" ? "获取中…" : "获取模型列表"}
                  </button>
                  <button
                    className="small"
                    disabled={!model || busy !== ""}
                    onClick={testConnection}
                  >
                    {busy === "test" ? "测试中…" : "测试连通性"}
                  </button>
                  <button className="small primary" disabled={!model} onClick={save}>
                    保存 Profile
                  </button>
                </div>
                {models.length > 0 && (
                  <>
                    <div />
                    <div className="model-list">
                      {models.map((m) => (
                        <div
                          key={m}
                          className={`model-opt ${m === model ? "selected" : ""}`}
                          onClick={() => setModel(m)}
                        >
                          {m}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="full">
                  {error && <div className="error-text">{error}</div>}
                  {notice && <div className="ok-text" style={{ color: "var(--yellow)" }}>{notice}</div>}
                  {okMsg && <div className="ok-text">{okMsg}</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function stateLabel(s: string): string {
  if (s === "S1_UNENTERED") return "S1_KEY_ENTERED";
  return aiStateLabel(s) === s ? s : `${s} · ${aiStateLabel(s)}`;
}
