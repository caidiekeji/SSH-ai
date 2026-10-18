import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { SettingsModal } from "./SettingsModal";
import { HostKeyDialogs } from "./HostKeyDialogs";
import { RiskConfirmDialogs } from "./RiskConfirmDialogs";
import { AiSidebar } from "./AiSidebar";
import { ServerPanel } from "./ServerPanel";
import { TerminalPane } from "./TerminalPane";

export function App() {
  const aiState = useStore((s) => s.aiState);
  const profiles = useStore((s) => s.profiles);
  const activeProfileId = useStore((s) => s.activeProfileId);
  const loadProviderData = useStore((s) => s.loadProviderData);
  const lastPrefillNotice = useStore((s) => s.lastPrefillNotice);
  const theme = useStore((s) => s.theme);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    loadProviderData();
    const sub = listen<string>("ai-chunk", (ev) => useStore.getState().appendChunk(ev.payload));
    return () => {
      sub.then((f) => f());
    };
  }, []);

  // Apply the selected color mode to <html data-theme="...">.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">AI SSH Assistant</span>
        <select
          value={activeProfileId ?? ""}
          onChange={(e) => useStore.setState({ activeProfileId: e.target.value })}
          disabled={!profiles.length}
          title="切换 Provider Profile"
        >
          {profiles.length === 0 && <option value="">未配置 AI（点击设置）</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model || "未选模型"}
            </option>
          ))}
        </select>
        <button className="small" onClick={() => setConfigOpen(true)}>
          AI 设置
        </button>
        <span className="state-pill">{aiStateLabel(aiState)}</span>
        <div className="spacer" />
        <ConnStatusChip />
      </div>

      <div className="main">
        <ServerPanel />
        <TerminalPane />
        <AiSidebar />
      </div>

      {lastPrefillNotice && <NoticeToast text={lastPrefillNotice} />}
      <HostKeyDialogs />
      <RiskConfirmDialogs />
      {configOpen && <SettingsModal onClose={() => setConfigOpen(false)} />}
    </div>
  );
}

function ConnStatusChip() {
  const connStatus = useStore((s) => s.connStatus);
  const activeHost = useStore((s) => s.activeHost);
  return (
    <span className="conn-chip">
      <span className={`status-dot status-${connStatus}`} />
      {activeHost || "未连接"}
    </span>
  );
}

function NoticeToast({ text }: { text: string }) {
  const diagState = useStore((s) => s.diagState);
  if (diagState !== "T4_PREFILLED") return null;
  return <div className="notice-toast">{text}</div>;
}

export function aiStateLabel(s: string): string {
  switch (s) {
    case "S0_UNCONFIGURED": return "AI: 未配置";
    case "S1_KEY_ENTERED": return "AI: 已输入 Key";
    case "S2_FETCHING_MODELS": return "AI: 获取模型中";
    case "S3_MODELS_READY": return "AI: 模型已就绪";
    case "S3_MANUAL": return "AI: 手动模型";
    case "S4_TESTING": return "AI: 测试中";
    case "S5_READY": return "AI: 就绪";
    default: return s;
  }
}
