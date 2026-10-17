import { useStore } from "../store";

export function AiSidebar() {
  const cards = useStore((s) => s.cards);
  const errorBlocks = useStore((s) => s.errorBlocks);
  const diagState = useStore((s) => s.diagState);
  const diagError = useStore((s) => s.diagError);
  const retryDiagnosis = useStore((s) => s.retryDiagnosis);
  const closeCard = useStore((s) => s.closeCard);
  const requestInsert = useStore((s) => s.requestInsert);
  const sessionId = useStore((s) => s.sessionId);
  const connStatus = useStore((s) => s.connStatus);

  return (
    <div className="ai-sidebar">
      <h3>AI 诊断</h3>

      {/* T1_FAILED → retry / switch provider exits (PRD §2.3) */}
      {diagState === "T1_FAILED" && (
        <div className="diag-error-box">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>诊断失败</div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{diagError}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="small primary" onClick={retryDiagnosis}>
              重试
            </button>
            <button className="small" onClick={() => useStore.setState({ diagState: "T0_IDLE" })}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* T1_ANALYZING spinner */}
      {diagState === "T1_ANALYZING" && (
        <div className="card">
          <div className="card-head">
            <span className="model-tag">分析中…（首个响应可能需要数秒）</span>
          </div>
          {cards
            .filter((c) => c.streaming)
            .map((c) => (
              <pre key={c.id} className="raw-text" style={{ maxHeight: 160 }}>
                {c.streamingText || "等待模型响应…"}
              </pre>
            ))}
        </div>
      )}

      {/* Result cards (T2_RESULT) */}
      {cards
        .filter((c) => !c.streaming)
        .map((c) => (
          <div className="card" key={c.id}>
            <div className="card-head">
              {c.result?.structured && c.result.diagnosis && (
                <>
                  <span className="summary">{c.result.diagnosis.summary}</span>
                  <span className={`confidence confidence-${c.result.diagnosis.confidence}`}>
                    {c.result.diagnosis.confidence}
                  </span>
                </>
              )}
              <span style={{ flex: 1 }} />
              <span className="model-tag">
                {c.provider} · {c.model}
              </span>
              <button className="small" onClick={() => closeCard(c.id)}>
                ×
              </button>
            </div>

            {c.error ? (
              <div className="error-text">{c.error}</div>
            ) : c.result?.structured ? (
              <>
                {c.result.diagnosis?.root_cause && (
                  <div className="root-cause">根因：{c.result.diagnosis.root_cause}</div>
                )}
                {(c.result.steps ?? []).map((step, i) => (
                  <StepRow
                    key={i}
                    description={step.description}
                    command={step.command}
                    hint={step.risk_hint}
                    onInsert={() => requestInsert(c.id, step.command, step.risk_hint)}
                  />
                ))}
                {c.result.alternative && <div className="root-cause">补充：{c.result.alternative}</div>}
                <div className="card-foot">
                  <button
                    className="small"
                    onClick={() => navigator.clipboard.writeText(c.result?.raw ?? JSON.stringify(c.result, null, 2))}
                  >
                    复制全部
                  </button>
                  <button
                    className="small"
                    onClick={() => useStore.getState().retryDiagnosis()}
                    title="重新生成（可在顶部切换 Provider/模型后重试）"
                  >
                    重新生成
                  </button>
                </div>
              </>
            ) : (
              // Degraded card (PRD §4.2): raw text, NO insert buttons.
              <>
                <pre className="raw-text">{c.result?.raw}</pre>
                <div className="degraded-note">
                  当前模型未返回结构化结果，无法提供"插入输入行"。建议在 Provider
                  配置中切换支持结构化输出的模型。
                </div>
                <div className="card-foot">
                  <button
                    className="small"
                    onClick={() => navigator.clipboard.writeText(c.result?.raw ?? "")}
                  >
                    复制
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

      <h3 style={{ marginTop: 14 }}>检测到的错误块</h3>
      {!sessionId && <div style={{ color: "var(--text-dim)" }}>连接后显示</div>}
      {errorBlocks.length === 0 && sessionId && connStatus === "connected" && (
        <div style={{ color: "var(--text-dim)" }}>暂无错误特征</div>
      )}
      {errorBlocks
        .slice()
        .reverse()
        .map((b) => (
          <div
            key={b.id}
            className={`error-block-item ${b.level === "yellow" ? "warn" : ""}`}
            title={`规则: ${b.rule} · 点击分析此错误`}
            onClick={() => useStore.getState().startDiagnosis("")}
          >
            <span className={`risk-dot risk-${b.level}`} />
            <span className="preview">{b.preview}</span>
            <span className="model-tag">×{b.line_count}</span>
          </div>
        ))}
    </div>
  );
}

function StepRow({
  description,
  command,
  hint,
  onInsert,
}: {
  description: string;
  command: string;
  hint: string;
  onInsert: () => void;
}) {
  const dotColor =
    hint === "destructive" ? "risk-red" : hint === "write" ? "risk-yellow" : "risk-green";
  return (
    <div className="step">
      <div className="step-desc">
        {description}
        <span
          className={`risk-dot ${dotColor}`}
          style={{ marginLeft: 6, display: "inline-block", verticalAlign: "middle" }}
          title={`AI 建议: ${hint}（本地分级以实际判定为准）`}
        />
      </div>
      <div className="step-cmd">
        <code>{command}</code>
        <button className="small primary" onClick={onInsert}>
          插入输入行
        </button>
      </div>
    </div>
  );
}
