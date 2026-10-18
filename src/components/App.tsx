import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { ipc } from "../ipc";
import { Icon } from "./Icon";
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
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  // '#' prefix → AI analysis; otherwise the text goes to the PTY as a typed
  // command (user-initiated, Enter included — HC-03 untouched).
  const aiMode = inputText.startsWith("#");

  const sendInput = () => {
    const text = inputText.trim();
    if (!text) return;
    const st = useStore.getState();
    if (aiMode) {
      st.startDiagnosis(text.slice(1));
    } else {
      if (st.sessionId) {
        ipc.terminalWrite(st.sessionId, new TextEncoder().encode(text + "\n"));
      }
    }
    setInputText("");
    inputRef.current?.focus();
  };

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

      <div className={`inputbar ${aiMode ? "ai-mode" : ""}`}>
        <span className="mode-ico" title={aiMode ? "AI 模式" : "命令模式"}>
          <Icon name={aiMode ? "sparkles" : "terminal"} size={14} />
        </span>
        <input
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={aiMode ? "向 AI 描述问题，Enter 发送分析当前终端" : "输入命令，Enter 直接执行（# 开头发给 AI）"}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendInput();
          }}
        />
        <button className="send-btn" onClick={sendInput} disabled={!inputText.trim()} title={aiMode ? "发送给 AI (Enter)" : "执行命令 (Enter)"}>
          <Icon name={aiMode ? "sparkles" : "arrowUpRight"} size={15} />
        </button>
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
