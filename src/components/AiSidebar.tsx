// AI conversation panel: chat-style layout with its own composer (same width
// as the panel). Composer has three modes: 命令 (send to PTY) / 诊断 (AI +
// terminal context) / 对话 (multi-turn chat without terminal context).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { DiagnosisCard as Card } from "../types";
import { Icon } from "./Icon";

export function AiSidebar() {
  const cards = useStore((s) => s.cards);
  const errorBlocks = useStore((s) => s.errorBlocks);
  const diagState = useStore((s) => s.diagState);
  const diagError = useStore((s) => s.diagError);
  const sessionId = useStore((s) => s.sessionId);
  const connStatus = useStore((s) => s.connStatus);
  const chatHistory = useStore((s) => s.chatHistory);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [cards, diagState, chatHistory]);

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
        {cards.length === 0 && chatHistory.length === 0 && (
          <div className="chat-empty">
            <Icon name="sparkles" size={30} className="ai-ico big" />
            <p>在这里向 AI 提问。</p>
            <p className="dim">「诊断」结合终端输出分析 · 「对话」自由多轮问答 · 「命令」直接执行。</p>
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

        <AgentCard />

        {chatHistory.length > 0 && (
          <>
            <div className="chat-sep">
              <span>对话</span>
              <button className="mini" title="清空对话记录" onClick={() => useStore.getState().clearChat()}>
                清空
              </button>
            </div>
            {chatHistory.map((m, i) => (
              <div key={i} className="chat-msg">
                {m.role === "user" ? (
                  <div className="bubble user">{m.content}</div>
                ) : (
                  <div className="bubble ai">
                    {m.content || (i === chatHistory.length - 1 ? "…" : "")}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
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

      {analyzing && (
        <div className="analyzing-strip">
          <Icon name="sparkles" size={13} className="ai-ico spin" /> 正在分析，结果将显示在这里
        </div>
      )}

      {/* Composer: mode chips (命令/诊断/对话) + send, per panel layout */}
      <Composer />
    </div>
  );
}

// Composer lives at the bottom of the AI panel: tall textarea, mode chips
// bottom-left, send button bottom-right (per approved sketch).
function Composer() {
  const mode = useStore((s) => s.composerMode);
  const setMode = useStore((s) => s.setComposerMode);
  const chatBusy = useStore((s) => s.chatBusy);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(160, Math.max(64, ta.scrollHeight))}px`;
  };

  const placeholder =
    mode === "cmd"
      ? "输入命令，Enter 直接执行"
      : mode === "diag"
        ? "描述问题，AI 将结合当前终端输出进行分析"
        : mode === "agent"
          ? "描述运维目标，Agent 将自动规划并逐步执行（黄/红命令仍需你确认）"
          : "与 AI 自由对话（多轮），不读取终端输出";

  const send = () => {
    const t = text.trim();
    if (!t) return;
    const st = useStore.getState();
    setErr("");
    if (mode === "cmd") {
      if (!st.sessionId) {
        setErr("请先连接主机再发送命令");
        return;
      }
      ipc.terminalWrite(st.sessionId, new TextEncoder().encode(t + "\n"));
    } else if (mode === "diag") {
      if (!st.sessionId) {
        setErr("请先连接主机再进行诊断");
        return;
      }
      st.startDiagnosis(t);
    } else if (mode === "agent") {
      if (!st.sessionId) {
        setErr("请先连接主机再启动 Agent");
        return;
      }
      st.startAgent(t);
      setText("");
      if (taRef.current) taRef.current.style.height = "64px";
      return;
    } else {
      st.sendChat(t);
    }
    setText("");
    if (taRef.current) taRef.current.style.height = "64px";
  };

  return (
    <div className={`composer ${mode}`}>
      <textarea
        ref={taRef}
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
      />
      <div className="composer-foot">
        <div className="composer-modes">
          <button
            className={`mode-chip ${mode === "cmd" ? "active" : ""}`}
            onClick={() => setMode("cmd")}
            title="直接把文本作为命令发送到终端执行"
          >
            <Icon name="terminal" size={12} /> 命令
          </button>
          <button
            className={`mode-chip ${mode === "diag" ? "active" : ""}`}
            onClick={() => setMode("diag")}
            title="结合当前终端输出进行 AI 诊断"
          >
            <Icon name="sparkles" size={12} /> 诊断
          </button>
          <button
            className={`mode-chip ${mode === "agent" ? "active" : ""}`}
            onClick={() => setMode("agent")}
            title="AI 自动化运维：规划→分级→执行→观察 循环"
          >
            <Icon name="zap" size={12} /> Agent
          </button>
          <button
            className={`mode-chip ${mode === "chat" ? "active" : ""}`}
            onClick={() => setMode("chat")}
            title="与 AI 多轮自由对话（不读取终端输出）"
          >
            <Icon name="pencil" size={12} /> 对话
          </button>
        </div>
        <button className="composer-send" onClick={send} disabled={!text.trim() || (mode === "chat" && chatBusy)}>
          发送
        </button>
      </div>
      {err && <div className="composer-err">{err}</div>}
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
          {card.blocksSent != null && (
            <span className="blocks-note" title="本次诊断发送给 AI 的最近命令输出块数量（可在 设置 › AI 高级 调整）">
              已分析最近 {card.blocksSent} 个输出块
            </span>
          )}
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

// Agent task card: goal, executed steps, approval gate, stop control.
function AgentCard() {
  const status = useStore((s) => s.agentStatus);
  const goal = useStore((s) => s.agentGoal);
  const steps = useStore((s) => s.agentSteps);
  const approval = useStore((s) => s.agentApproval);
  const error = useStore((s) => s.agentError);
  if (status === "idle") return null;

  const statusText =
    status === "running"
      ? "执行中"
      : status === "waiting"
        ? "等待确认"
        : status === "done"
          ? "已完成"
          : status === "failed"
            ? "失败"
            : "已停止";

  return (
    <div className="chat-msg">
      <div className={`agent-card st-${status}`}>
        <div className="agent-head">
          <Icon name="zap" size={14} className="ico-accent" />
          <span className="agent-title">Agent 任务</span>
          <span className={`agent-status st-${status}`}>{statusText}</span>
          <span className="flex1" />
          {(status === "running" || status === "waiting") && (
            <button className="mini close" onClick={() => useStore.getState().stopAgent()}>
              停止
            </button>
          )}
          {(status === "done" || status === "failed" || status === "stopped") && (
            <button
              className="mini close"
              onClick={() => useStore.setState({ agentStatus: "idle", agentSteps: [], agentGoal: "", agentError: "", agentApproval: null })}
            >
              关闭
            </button>
          )}
        </div>
        <div className="agent-goal">{goal}</div>
        <div className="agent-steps">
          {steps.map((s) => (
            <div key={s.no} className="agent-step">
              <div className="agent-step-top">
                <span className={`risk-dot risk-${s.risk === "destructive" ? "red" : s.risk === "write" ? "yellow" : "green"}`} />
                <span className="agent-step-no">{s.no}.</span>
                <code className="agent-step-cmd">{s.command}</code>
                {s.kind === "verify" && <span className="verify-badge">验证</span>}
              </div>
              {s.description && <div className="agent-step-desc">{s.description}</div>}
              {s.output && <pre className="agent-step-out">{s.output.split("\n").slice(-4).join("\n")}</pre>}
            </div>
          ))}
        </div>
        {status === "running" && <div className="agent-note"><Icon name="sparkles" size={12} className="ai-ico spin" /> AI 正在规划下一步…</div>}
        {approval && status === "waiting" && (
          <div className="agent-approval">
            <div className="agent-appr-title">
              <Icon name="alertTriangle" size={13} className="ico-yellow" />
              {approval.level === "red" ? "高危命令，需要你确认" : "写操作命令，需要你确认"}
            </div>
            <code className="agent-appr-cmd">{approval.command}</code>
            {approval.description && <div className="agent-step-desc">{approval.description}</div>}
            <div className="agent-appr-actions">
              <button className="primary small" onClick={() => useStore.getState().resolveAgent(true)}>批准执行</button>
              <button className="small" onClick={() => useStore.getState().resolveAgent(false)}>拒绝</button>
            </div>
          </div>
        )}
        {status === "done" && steps.length >= 0 && <div className="agent-note ok">任务完成</div>}
        {error && status !== "running" && status !== "waiting" && <div className="agent-note err">{error}</div>}
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
