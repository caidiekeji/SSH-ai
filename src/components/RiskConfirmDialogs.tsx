// Risk confirmation dialogs (PRD §5.5 interaction spec).
// YELLOW: confirm insert. RED: checkbox + insert; one-click EXECUTE is
// never offered at any level.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function RiskConfirmDialogs() {
  const diagState = useStore((s) => s.diagState);
  const pending = useStore((s) => s.pendingPrefill);
  const confirm = useStore((s) => s.confirmPrefill);
  const cancel = useStore((s) => s.cancelPrefill);
  const [checked, setChecked] = useState(false);

  // Reset the red-level ack whenever a NEW pending command arrives (or the
  // dialog closes): a checkbox ticked for command A must never authorize
  // command B after a cancel.
  useEffect(() => {
    setChecked(false);
  }, [pending]);

  if (!pending || !["T3_CONFIRM_YELLOW", "T3_CONFIRM_RED"].includes(diagState)) return null;

  const isRed = diagState === "T3_CONFIRM_RED";

  return (
    <div className="modal-backdrop">
      <div className={`modal confirm-box ${isRed ? "critical" : "warn"}`}>
        <h2 className="confirm-title">
          <Icon name={isRed ? "ban" : "alertTriangle"} size={16} className={isRed ? "ico-red" : "ico-yellow"} />
          {isRed ? "高危命令" : "确认命令"}
        </h2>
        <div className="sub">
          命中将写入 <b>{useStore.getState().activeHost || "目标主机"}</b> 的输入行。
          <br />
          命中规则：{pending.assessment.rule} — {pending.assessment.reason}
        </div>
        <div className="confirm-cmd">{pending.command}</div>
        {isRed && (
          <label className="checkbox-row">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>我理解此操作的影响，并确认要将该命令插入输入行</span>
          </label>
        )}
        <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
          命令只会写入输入行，不会自动执行。执行与否由你在终端按 Enter 决定。
        </div>
        <div className="modal-foot">
          <button onClick={cancel}>取消</button>
          <button
            className={isRed ? "danger" : "primary"}
            disabled={isRed && !checked}
            onClick={() => {
              setChecked(false);
              confirm();
            }}
          >
            确认插入
          </button>
        </div>
      </div>
    </div>
  );
}
