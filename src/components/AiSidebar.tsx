// AI conversation panel: chat-style layout with its own composer (same width
// as the panel). Diagnosis cards follow a strict three-block skeleton:
// 总结 → 根因 → 解决方法 (numbered steps + command + insert). No model noise.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import type { DiagnosisCard as Card } from "../types";
import { Icon } from "./Icon";

export function AiSidebar() {
  const cards = useStore((s) => s.cards);
  const errorBlocks = useStore((s) => s.errorBlocks);
  const diagState = useStore((s) => s.diagState);
  const diagError = useStore((s) => s.diagError);
  const sessionId = useStore((s) => s.sessionId);
  const connStatus = useStore((s) => s.connStatus);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [cards, diagState]);

  const analyzing = diagState === "T1_ANALYZING";

  return (
    <div className="ai-sidebar chat">
      <div className="ai-head">
        <b>
          <Icon name="sparkles" size={15} className="ai-ico" /> AI 对话
        </b>
        <ModelSwitcher />
      </div>

      <div className="chat-list" ref={listRef}>
        {cards.length === 0 && (
          <div className="chat-empty">
            <Icon name="sparkles" size={30} className="ai-ico big" />
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
          <ChatMessage key={c.id} card={c} />
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

      {/* Input lives in the single bottom bar (# = AI, plain = command). */}
      {analyzing && (
        <div className="analyzing-strip">
          <Icon name="sparkles" size={13} className="ai-ico spin" /> 正在分析，结果将显示在这里
        </div>
      )}
    </div>
  );
}

function ChatMessage({ card }: { card: Card }) {
  if (card.streaming) {
    return (
      <div className="chat-msg">
        {card.question && <div className="bubble user">{card.question}</div>}
        <div className="dcard streaming">
          <div className="dcard-title analyzing">
            <Icon name="sparkles" size={14} className="ai-ico" /> 正在分析<span className="dots">…</span>
          </div>
          <pre className="raw-text stream">{card.streamingText || "等待模型响应…"}</pre>
        </div>
      </div>
    );
  }
  if (card.error) {
    return (
      <div className="chat-msg">
        {card.question && <div className="bubble user">{card.question}</div>}
        <div className="dcard error">
          <div className="dcard-title title-row">
            <Icon name="alertTriangle" size={15} className="ico-yellow" /> 分析失败
          </div>
          <div className="fail-body">{card.error}</div>
          <div className="dcard-foot">
            <button className="mini" onClick={() => useStore.getState().retryDiagnosis()}><Icon name="refresh" size={11} /> 重试</button>
            <button className="mini" onClick={() => useStore.getState().closeCard(card.id)}>关闭</button>
          </div>
        </div>
      </div>
    );
  }
  const r = card.result;
  if (!r) return null;

  // Degraded (non-structured) reply: plain text, copy only.
  if (!r.structured) {
    return (
      <div className="chat-msg">
        {card.question && <div className="bubble user">{card.question}</div>}
        <div className="dcard degraded">
          <div className="dcard-title">回复原文</div>
          <pre className="raw-text">{r.raw}</pre>
          <div className="note-warn">模型未返回结构化结果，无法提供"插入"。建议在设置中更换模型。</div>
          <div className="dcard-foot">
            <button className="mini" onClick={() => navigator.clipboard.writeText(r.raw ?? "")}><Icon name="copy" size={11} /> 复制</button>
            <button className="mini" onClick={() => useStore.getState().retryDiagnosis()}><Icon name="refresh" size={11} /> 重新生成</button>
            <button className="mini close" onClick={() => useStore.getState().closeCard(card.id)}>关闭</button>
          </div>
        </div>
      </div>
    );
  }

  const d = r.diagnosis;
  const steps = r.steps ?? [];
  return (
    <div className="chat-msg">
      {card.question && <div className="bubble user">{card.question}</div>}
      <div className="dcard">
        {/* ① 问题总结 */}
        <div className="dcard-block head">
          <span className="dcard-label">问题</span>
          <div className="dcard-title-row">
            <span className="dcard-title">{d?.summary || "诊断完成"}</span>
            {d?.confidence && (
              <span className={`confidence confidence-${d.confidence}`}>
                {d.confidence === "high" ? "高置信" : d.confidence === "medium" ? "中置信" : "低置信"}
              </span>
            )}
          </div>
          {d?.root_cause && <div className="dcard-cause">{d.root_cause}</div>}
        </div>

        {/* ② 解决方法 */}
        {steps.length > 0 && (
          <div className="dcard-block">
            <span className="dcard-label">解决方法</span>
            <div className="dsteps">
              {steps.map((s, i) => (
                <StepRow
                  key={i}
                  index={i + 1}
                  description={s.description}
                  command={s.command}
                  hint={s.risk_hint}
                  onInsert={() => useStore.getState().requestInsert(card.id, s.command, s.risk_hint)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ③ 补充说明 */}
        {r.alternative && (
          <div className="dcard-block alt">
            <span className="dcard-label">补充</span>
            <div className="dcard-cause">{r.alternative}</div>
          </div>
        )}

        <div className="dcard-foot">
          <button className="mini" onClick={() => useStore.getState().retryDiagnosis()}><Icon name="refresh" size={11} /> 重新生成</button>
          <button
            className="mini"
            onClick={() => navigator.clipboard.writeText(r.raw ?? JSON.stringify(r, null, 2))}
          >
            <Icon name="copy" size={11} /> 复制全部
          </button>
          <span className="flex1" />
          <button className="mini close" onClick={() => useStore.getState().closeCard(card.id)}>关闭</button>
        </div>
      </div>
    </div>
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
  const riskLabel = hint === "destructive" ? "高危" : hint === "write" ? "需确认" : "安全";
  return (
    <div className="dstep">
      <div className="dstep-top">
        <span className={`risk-dot ${dotColor}`} title={`AI 建议: ${hint}（实际以本地分级为准）`} />
        <span className="dstep-no">{index}.</span>
        <span className="dstep-desc">{description}</span>
        <span className={`dstep-risk ${dotColor.replace("risk-", "")}`}>{riskLabel}</span>
        <button className="ins" onClick={onInsert} title="写入终端输入行，由你按 Enter 执行">
          插入
        </button>
      </div>
      <code className="dstep-cmd">{command}</code>
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
