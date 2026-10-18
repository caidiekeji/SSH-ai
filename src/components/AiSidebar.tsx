// AI conversation panel: chat-style layout with its own composer (same width
// as the panel), question bubbles + diagnosis cards, quick error triggers.

import { useEffect, useRef } from "react";
import { useStore } from "../store";

export function AiSidebar() {
  const cards = useStore((s) => s.cards);
  const errorBlocks = useStore((s) => s.errorBlocks);
  const diagState = useStore((s) => s.diagState);
  const diagError = useStore((s) => s.diagError);
  const sessionId = useStore((s) => s.sessionId);
  const connStatus = useStore((s) => s.connStatus);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [cards, diagState]);

  const send = () => {
    const ta = taRef.current;
    const text = ta?.value.trim();
    if (!text) return;
    if (diagState === "T1_ANALYZING") return;
    useStore.setState({ diagError: "" });
    void useStore.getState().startDiagnosis(text);
    if (ta) {
      ta.value = "";
      ta.style.height = "auto";
      ta.focus();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const analyzing = diagState === "T1_ANALYZING";

  return (
    <div className="ai-sidebar chat">
      <div className="ai-head">
        <b>
          <span className="ai-gem" /> AI 对话
        </b>
        <ModelSwitcher />
      </div>

      <div className="chat-list" ref={listRef}>
        {cards.length === 0 && (
          <div className="chat-empty">
            <div className="ai-gem big" />
            <p>连接主机后，在这里向 AI 提问。</p>
            <p className="dim">例如："nginx 起不来怎么办？" · 或点击终端下方的「一键诊断」。</p>
          </div>
        )}

        {diagState === "T1_FAILED" && (
          <div className="diag-error-box">
            <div className="fail-title">诊断失败</div>
            <div className="fail-body">{diagError}</div>
            <div className="fail-actions">
              <button className="small primary" onClick={() => useStore.getState().retryDiagnosis()}>
                重试
              </button>
              <button className="small" onClick={() => useStore.setState({ diagState: "T0_IDLE" })}>
                关闭
              </button>
            </div>
          </div>
        )}

        {cards.map((c) => (
          <div className="chat-msg" key={c.id}>
            {c.question && <div className="bubble user">{c.question}</div>}
            <div className={`card ${!c.result?.structured && c.result && !c.error ? "degraded" : ""}`}>
              <div className="card-head">
                <span className="ai-gem tiny" />
                {c.streaming ? (
                  <span className="model-tag streaming">✦ 正在分析（首 token 可能需要数秒）…</span>
                ) : c.result?.structured && c.result.diagnosis ? (
                  <>
                    <span className="summary">{c.result.diagnosis.summary}</span>
                    <span className={`confidence confidence-${c.result.diagnosis.confidence}`}>
                      {c.result.diagnosis.confidence === "high"
                        ? "高置信"
                        : c.result.diagnosis.confidence === "medium"
                          ? "中置信"
                          : "低置信"}
                    </span>
                  </>
                ) : c.error ? (
                  <span className="error-text">{c.error}</span>
                ) : (
                  <span className="model-tag">未返回结构化结果</span>
                )}
                {!c.streaming && (
                  <button className="icon-op close" title="关闭" onClick={() => useStore.getState().closeCard(c.id)}>
                    ×
                  </button>
                )}
              </div>

              {c.streaming && <pre className="raw-text stream">{c.streamingText || "等待模型响应…"}</pre>}

              {!c.streaming && !c.error && c.result?.structured && (
                <>
                  {c.result.diagnosis?.root_cause && <div className="root-cause">根因：{c.result.diagnosis.root_cause}</div>}
                  {(c.result.steps ?? []).map((step, i) => (
                    <StepRow
                      key={i}
                      index={i + 1}
                      description={step.description}
                      command={step.command}
                      hint={step.risk_hint}
                      onInsert={() => useStore.getState().requestInsert(c.id, step.command, step.risk_hint)}
                    />
                  ))}
                  {c.result.alternative && <div className="root-cause">补充：{c.result.alternative}</div>}
                  <div className="card-foot">
                    <span className="model-tag">
                      {c.provider} · {c.model}
                    </span>
                    <span className="flex1" />
                    <button
                      className="small"
                      onClick={() =>
                        navigator.clipboard.writeText(c.result?.raw ?? JSON.stringify(c.result, null, 2))
                      }
                    >
                      复制全部
                    </button>
                    <button className="small" onClick={() => useStore.getState().retryDiagnosis()} title="可在顶部切换 Provider 后重试">
                      重新生成
                    </button>
                  </div>
                </>
              )}

              {!c.streaming && !c.error && c.result && !c.result.structured && (
                <>
                  <pre className="raw-text">{c.result.raw}</pre>
                  <div className="degraded-note">
                    当前模型未返回结构化结果，"插入输入行"已禁用。建议在 Provider 配置中切换支持结构化输出的模型。
                  </div>
                  <div className="card-foot">
                    <span className="model-tag">
                      {c.provider} · {c.model}
                    </span>
                    <span className="flex1" />
                    <button className="small" onClick={() => navigator.clipboard.writeText(c.result?.raw ?? "")}>
                      复制
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* quick error triggers */}
      {sessionId && connStatus === "connected" && errorBlocks.length > 0 && (
        <div className="err-chips">
          {errorBlocks.slice(-3).map((b) => (
            <button key={b.id} className={`err-chip ${b.level}`} title={`规则: ${b.rule} · 点击分析此错误`} onClick={() => useStore.getState().startDiagnosis("")}>
              <span className={`risk-dot risk-${b.level}`} />
              {b.preview.slice(0, 26)}
            </button>
          ))}
        </div>
      )}

      {/* composer: same width as the panel, taller, SVG send inside */}
      <div className={`composer ${analyzing ? "busy" : ""}`}>
        <textarea
          ref={taRef}
          rows={3}
          placeholder={analyzing ? "AI 正在分析…" : "向 AI 描述问题…（Enter 发送 · Shift+Enter 换行）"}
          disabled={analyzing}
          onChange={(e) => autoGrow(e.target)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="send-btn" onClick={send} disabled={analyzing} title="发送 (Enter)">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Compact in-panel model switcher: shows ONLY the model name, no vendor
// prefix or "custom" noise. Lives in the chat header (fused layout).
function ModelSwitcher() {
  const profiles = useStore((s) => s.profiles);
  const activeProfileId = useStore((s) => s.activeProfileId);
  if (!profiles.length) {
    return <span className="model-switch none" title="在顶栏「设置」中完成 AI 配置">未配置</span>;
  }
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[profiles.length - 1];
  return (
    <select
      className="model-switch"
      value={active.id}
      onChange={(e) => useStore.setState({ activeProfileId: e.target.value })}
      title="切换模型"
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.model || p.name}
        </option>
      ))}
    </select>
  );
}

function StepRow({
  index,
  description,
  command,
  hint,
  onInsert,
}: {
  index: number;
  description: string;
  command: string;
  hint: string;
  onInsert: () => void;
}) {
  const dotColor = hint === "destructive" ? "risk-red" : hint === "write" ? "risk-yellow" : "risk-green";
  return (
    <div className="step">
      <div className="step-head">
        <span className={`risk-dot ${dotColor}`} title={`AI 建议: ${hint}（本地分级以实际判定为准）`} />
        <span className="step-desc">
          {index}. {description}
        </span>
        <button className="ins" onClick={onInsert}>
          插入输入行
        </button>
      </div>
      <div className="step-cmd">
        <code>{command}</code>
      </div>
    </div>
  );
}
