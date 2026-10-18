import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { ipc } from "../ipc";
import type { ThemeName } from "../types";
import { Icon } from "./Icon";

// Live registry of open xterm instances (sessionId -> Terminal) so the
// clear-screen button can reach the active terminal.
const termRegistry = new Map<number, Terminal>();

// xterm theme must match the CSS design tokens per color mode.
export function xtermThemeFor(theme: ThemeName) {
  switch (theme) {
    case "light":
      return {
        background: "#ffffff",
        foreground: "#1f2328",
        cursor: "#0969da",
        cursorAccent: "#ffffff",
        selectionBackground: "#b6d7ff",
      };
    case "ocean":
      return {
        background: "#0b1220",
        foreground: "#e2e8f0",
        cursor: "#38bdf8",
        cursorAccent: "#0b1220",
        selectionBackground: "#1e3a5f",
      };
    case "forest":
      return {
        background: "#0c1310",
        foreground: "#e3ece5",
        cursor: "#34d399",
        cursorAccent: "#0c1310",
        selectionBackground: "#1d4034",
      };
    case "sakura":
      return {
        background: "#171015",
        foreground: "#f2e6ec",
        cursor: "#f472b6",
        cursorAccent: "#171015",
        selectionBackground: "#4a2738",
      };
    default:
      return {
        background: "#0f1216",
        foreground: "#e6edf3",
        cursor: "#4c8dff",
        cursorAccent: "#0f1216",
        selectionBackground: "#264f78",
      };
  }
}

// One xterm instance per open tab. Hidden tabs keep their listeners and
// scrollback alive; only visibility toggles, so background sessions keep
// receiving output while the user works in another tab.
function TerminalHost({ sessionId, active }: { sessionId: number; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const tab = useStore((s) => s.tabs.find((t) => t.sessionId === sessionId));
  const status = tab?.status ?? "connected";
  const host = tab?.host ?? "";
  const addErrorBlock = useStore((s) => s.addErrorBlock);
  const setTabStatus = useStore((s) => s.setTabStatus);
  const theme = useStore((s) => s.theme);

  // Terminal lifecycle: create once per session id.
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: xtermThemeFor(useStore.getState().theme),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRegistry.set(sessionId, term);
    if (activeRef.current) {
      try {
        fit.fit();
        ipc.terminalResize(sessionId, term.cols, term.rows);
      } catch {
        /* pane hidden */
      }
    }
    termRef.current = term;
    fitRef.current = fit;

    const writeSub = listen<{ sessionId: number; data: string }>("terminal-data", (ev) => {
      if (ev.payload.sessionId !== sessionId) return;
      const bin = atob(ev.payload.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      term.write(bytes);
    });

    const blockSub = listen<{ sessionId: number; block: never }>("error-block", (ev) => {
      if (ev.payload.sessionId !== sessionId) return;
      addErrorBlock(ev.payload.block);
    });

    const statusSub = listen<{ sessionId: number; status: string }>("ssh-status", (ev) => {
      if (ev.payload.sessionId !== sessionId) return;
      if (ev.payload.status === "closed" || ev.payload.status === "exited") {
        setTabStatus(sessionId, "closed");
      }
    });

    // Keystrokes go straight to the PTY. The USER presses Enter physically.
    const dataSub = term.onData((data) => {
      ipc.terminalWrite(sessionId, new TextEncoder().encode(data));
    });

    const resize = () => {
      if (!activeRef.current) return; // hidden tab: skip fit/resize
      try {
        fit.fit();
        ipc.terminalResize(sessionId, term.cols, term.rows);
      } catch {
        /* pane hidden */
      }
    };
    const ro = new ResizeObserver(resize);
    if (hostRef.current) ro.observe(hostRef.current.parentElement ?? hostRef.current);

    return () => {
      ro.disconnect();
      writeSub.then((f) => f());
      blockSub.then((f) => f());
      statusSub.then((f) => f());
      dataSub.dispose();
      term.dispose();
      termRegistry.delete(sessionId);
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Refit when the tab becomes visible again.
  useEffect(() => {
    if (active && termRef.current && fitRef.current) {
      try {
        fitRef.current.fit();
        ipc.terminalResize(sessionId, termRef.current.cols, termRef.current.rows);
      } catch {
        /* ignore */
      }
    }
  }, [active, sessionId]);

  // Keep xterm colors in sync with the app color mode.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermThemeFor(theme);
  }, [theme]);

  return (
    <div className="term-host-inner" style={{ display: active ? "flex" : "none" }}>
      <div ref={hostRef} className="term-host" />
      {status !== "connected" && (
        <div className="terminal-empty terminal-empty-overlay">
          <div>
            {status === "connecting"
              ? `正在连接 ${host} …`
              : status === "closed"
                ? "会话已结束。可关闭此标签页，或从左侧重新连接。"
                : "连接未建立。"}
          </div>
        </div>
      )}
    </div>
  );
}

export function TerminalPane() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const connError = useStore((s) => s.connError);
  const switchTab = useStore((s) => s.switchTab);
  const closeTab = useStore((s) => s.closeTab);
  const startDiagnosis = useStore((s) => s.startDiagnosis);
  const diagState = useStore((s) => s.diagState);
  const activeTab = tabs.find((t) => t.sessionId === activeTabId);

  return (
    <div className="terminal-pane">
      {tabs.length > 0 && (
        <div className="term-tabs">
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className={`term-tab ${t.sessionId === activeTabId ? "active" : ""} ${t.status}`}
              onClick={() => switchTab(t.sessionId)}
              title={`${t.title}（${t.host}）`}
            >
              <span className={`host-dot ${t.status === "connected" ? "on" : ""}`} />
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                title="断开并关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.sessionId);
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          <button
            className="term-clear"
            title="清屏：清除当前终端显示内容"
            onClick={() => {
              const term = activeTabId != null ? termRegistry.get(activeTabId) : null;
              if (term) {
                term.clear();
                term.write("\x1b[3J");
                term.scrollToTop?.();
              }
            }}
          >
            <Icon name="eraser" size={12} /> 清屏
          </button>
        </div>
      )}
      <div className="term-host-wrap">
        {tabs.length === 0 ? (
          <div className="terminal-empty">
            <div>
              {connStatusEmptyText(connError) ||
                "尚未连接。\n选择左侧主机，或点击「+ 添加主机」。\n连接后可在右侧 AI 对话面板提问。"}
            </div>
          </div>
        ) : (
          tabs.map((t) => (
            <TerminalHost key={t.sessionId} sessionId={t.sessionId} active={t.sessionId === activeTabId} />
          ))
        )}
        {/* Floating diagnose button: docks as icon-only circle, expands on hover */}
        {activeTab?.status === "connected" && (
          <button
            className={`term-fab ${diagState === "T1_ANALYZING" ? "busy" : ""}`}
            disabled={diagState === "T1_ANALYZING"}
            onClick={() => startDiagnosis("")}
            title="一键诊断：发送最近命令的输出块 + 系统上下文给 AI 分析"
          >
            <Icon name="sparkles" size={15} className={diagState === "T1_ANALYZING" ? "spin" : ""} />
            <span className="fab-label">{diagState === "T1_ANALYZING" ? "分析中" : "一键诊断"}</span>
          </button>
        )}
      </div>
      <InputBar />
    </div>
  );
}

// Composer under the terminal output: '#' prefix → AI, otherwise the text is
// sent to the PTY as a typed command. Enter sends, Shift+Enter adds a line.
function InputBar() {
  const [inputText, setInputText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const aiMode = inputText.startsWith("#");

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(140, Math.max(44, ta.scrollHeight))}px`;
  };

  const sendInput = () => {
    const text = inputText.trim();
    if (!text) return;
    const st = useStore.getState();
    if (aiMode) {
      st.startDiagnosis(text.slice(1));
    } else if (st.sessionId) {
      ipc.terminalWrite(st.sessionId, new TextEncoder().encode(text + "\n"));
    }
    setInputText("");
    if (taRef.current) taRef.current.style.height = "44px";
    taRef.current?.focus();
  };

  return (
    <div className={`inputbar ${aiMode ? "ai-mode" : ""}`}>
      <span className="mode-ico" title={aiMode ? "AI 模式" : "命令模式"}>
        <Icon name={aiMode ? "sparkles" : "terminal"} size={14} />
      </span>
      <textarea
        ref={taRef}
        rows={1}
        value={inputText}
        onChange={(e) => {
          setInputText(e.target.value);
          autoGrow();
        }}
        placeholder={aiMode ? "向 AI 描述问题，Enter 发送分析当前终端" : "输入命令，Enter 直接执行（# 开头发给 AI）"}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendInput();
          }
        }}
      />
      <button className="send-btn" onClick={sendInput} disabled={!inputText.trim()} title={aiMode ? "发送给 AI (Enter)" : "执行命令 (Enter)"}>
        <Icon name={aiMode ? "sparkles" : "arrowUpRight"} size={15} />
      </button>
    </div>
  );
}

function connStatusEmptyText(connError: string): string {
  if (connError) return `连接失败：${connError}`;
  return "";
}
