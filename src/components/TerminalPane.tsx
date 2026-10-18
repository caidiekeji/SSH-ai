import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
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
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(hostRef.current);
    termRegistry.set(sessionId, term);
    // Ctrl+F opens the in-terminal search bar (custom handler returns false
    // so the keystroke is consumed by us instead of being typed).
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && e.type === "keydown") {
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.select(), 30);
        return false;
      }
      if (e.key === "Escape" && e.type === "keydown") {
        setShowSearch(false);
      }
      return true;
    });
    // Ctrl+滚轮：字体缩放（8~32px），缩放后重新 fit。
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = term.options.fontSize ?? 13;
      const next = Math.min(32, Math.max(8, cur + (e.deltaY < 0 ? 1 : -1)));
      if (next !== cur) {
        term.options.fontSize = next;
        try {
          fitRef.current?.fit();
          ipc.terminalResize(sessionId, term.cols, term.rows);
        } catch {
          /* pane hidden */
        }
      }
    };
    hostRef.current.addEventListener("wheel", onWheel, { passive: false });
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
      // Quick-error chips belong to the ACTIVE session only; background
      // tabs keep their blocks in the backend pipeline for diagnosis.
      if (useStore.getState().activeTabId !== sessionId) return;
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
      searchRef.current = null;
      hostRef.current?.removeEventListener("wheel", onWheel);
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
      {showSearch && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (e.target.value) searchRef.current?.findNext(e.target.value, { caseSensitive: false });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (searchText) {
                  e.shiftKey
                    ? searchRef.current?.findPrevious(searchText, { caseSensitive: false })
                    : searchRef.current?.findNext(searchText, { caseSensitive: false });
                }
              } else if (e.key === "Escape") {
                setShowSearch(false);
                searchRef.current?.clearDecorations();
              }
            }}
            placeholder="在终端中查找"
            spellCheck={false}
          />
          <button
            className="icon-op"
            title="上一个 (Shift+Enter)"
            onClick={() => searchText && searchRef.current?.findPrevious(searchText, { caseSensitive: false })}
          >
            <Icon name="chevronUp" size={13} />
          </button>
          <button
            className="icon-op"
            title="下一个 (Enter)"
            onClick={() => searchText && searchRef.current?.findNext(searchText, { caseSensitive: false })}
          >
            <Icon name="chevronDown" size={13} />
          </button>
          <button
            className="icon-op"
            title="关闭 (Esc)"
            onClick={() => {
              setShowSearch(false);
              searchRef.current?.clearDecorations();
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
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
      </div>
    </div>
  );
}

function connStatusEmptyText(connError: string): string {
  if (connError) return `连接失败：${connError}`;
  return "";
}
