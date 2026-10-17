import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { ipc } from "../ipc";
import { ProviderConfigModal } from "./ProviderConfigModal";
import { HostKeyDialogs } from "./HostKeyDialogs";
import { RiskConfirmDialogs } from "./RiskConfirmDialogs";
import { AiSidebar } from "./AiSidebar";
import { HostList } from "./HostList";
import { TerminalPane } from "./TerminalPane";

export function App() {
  const aiState = useStore((s) => s.aiState);
  const profiles = useStore((s) => s.profiles);
  const activeProfileId = useStore((s) => s.activeProfileId);
  const loadProviderData = useStore((s) => s.loadProviderData);
  const startDiagnosis = useStore((s) => s.startDiagnosis);
  const lastPrefillNotice = useStore((s) => s.lastPrefillNotice);
  const [configOpen, setConfigOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const questionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadProviderData();
    // Streaming chunks from the Rust diagnosis run.
    const sub = listen<string>("ai-chunk", (ev) => useStore.getState().appendChunk(ev.payload));
    return () => {
      sub.then((f) => f());
    };
  }, []);

  const aiMode = inputText.startsWith("#");

  const sendInput = () => {
    const text = inputText.trim();
    if (!text) return;
    if (text.startsWith("#")) {
      // '#' AI mode (PRD §6.2): ask with current terminal state as context.
      startDiagnosis(text.slice(1));
    } else {
      const sid = useStore.getState().sessionId;
      if (sid) {
        // The user typed this and pressed Enter: a user action, not an AI
        // action. AI-generated text can never reach this path (HC-03).
        ipc.terminalWrite(sid, new TextEncoder().encode(text + "\n"));
      }
    }
    setInputText("");
    questionRef.current?.focus();
  };

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
        <span className="state-pill">AI: {aiStateLabel(aiState)}</span>
        <div className="spacer" />
        <ConnStatusChip />
      </div>

      <div className="main">
        <HostList />
        <TerminalPane />
        <AiSidebar />
      </div>

      <div className={`inputbar ${aiMode ? "ai-mode" : ""}`}>
        <span className="ai-badge">AI</span>
        <input
          ref={questionRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="输入命令后按 Enter 执行；以 # 开头则交给 AI 分析当前终端"
          onKeyDown={(e) => {
            if (e.key === "Enter") sendInput();
          }}
        />
        <button className="primary" onClick={sendInput} disabled={!inputText.trim()}>
          发送
        </button>
      </div>

      {lastPrefillNotice && <NoticeToast text={lastPrefillNotice} />}
      <HostKeyDialogs />
      <RiskConfirmDialogs />
      {configOpen && <ProviderConfigModal onClose={() => setConfigOpen(false)} />}
    </div>
  );
}

function ConnStatusChip() {
  const connStatus = useStore((s) => s.connStatus);
  const activeHost = useStore((s) => s.activeHost);
  return (
    <span>
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
    case "S0_UNCONFIGURED": return "未配置";
    case "S1_KEY_ENTERED": return "已输入 Key";
    case "S2_FETCHING_MODELS": return "获取模型中";
    case "S3_MODELS_READY": return "模型已就绪";
    case "S3_MANUAL": return "手动模型";
    case "S4_TESTING": return "测试中";
    case "S5_READY": return "就绪";
    default: return s;
  }
}
