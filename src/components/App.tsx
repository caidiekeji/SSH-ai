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
        <div className="spacer" />
        <ConnStatusChip />
        <button className="small" onClick={() => setConfigOpen(true)}>
          设置
        </button>
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
