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
    const chatSub = listen<string>("chat-chunk", (ev) => useStore.getState().appendChatChunk(ev.payload));
    return () => {
      sub.then((f) => f());
      chatSub.then((f) => f());
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
        <span className="ai-badge"># AI</span>
        <input
          ref={inputRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="输入命令按 Enter 执行；以 # 开头则发给 AI 分析当前终端"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendInput();
          }}
        />
        <button className={aiMode ? "primary" : ""} onClick={sendInput} disabled={!inputText.trim()} title={aiMode ? "发送给 AI (Enter)" : "执行命令 (Enter)"}>
          {aiMode ? <Icon name="sparkles" size={13} /> : <Icon name="terminal" size={13} />} {aiMode ? "AI 分析" : "执行"}
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
