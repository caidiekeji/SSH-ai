import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { ipc } from "../ipc";

export function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = useStore((s) => s.sessionId);
  const connStatus = useStore((s) => s.connStatus);
  const activeHost = useStore((s) => s.activeHost);
  const addErrorBlock = useStore((s) => s.addErrorBlock);
  const setConn = useStore((s) => s.setConn);
  const startDiagnosis = useStore((s) => s.startDiagnosis);
  const diagState = useStore((s) => s.diagState);

  // Terminal lifecycle: recreate whenever a session id appears.
  useEffect(() => {
    if (!sessionId || !hostRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: {
        background: "#0f1216",
        foreground: "#e6edf3",
        cursor: "#4c8dff",
        cursorAccent: "#0f1216",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    fit.fit();
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
        setConn({ connStatus: "closed" });
      }
    });

    // Keystrokes go straight to the PTY. The USER presses Enter physically.
    const dataSub = term.onData((data) => {
      ipc.terminalWrite(sessionId, new TextEncoder().encode(data));
    });

    const resize = () => {
      try {
        fit.fit();
        ipc.terminalResize(sessionId, term.cols, term.rows);
      } catch {
        /* pane hidden */
      }
    };
    const ro = new ResizeObserver(resize);
    if (hostRef.current) ro.observe(hostRef.current);
    resize();

    return () => {
      ro.disconnect();
      writeSub.then((f) => f());
      blockSub.then((f) => f());
      statusSub.then((f) => f());
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="terminal-pane">
      {connStatus === "connected" ? (
        <div ref={hostRef} className="term-host" />
      ) : (
        <div className="terminal-empty">
          <div>
            {connStatus === "connecting"
              ? `正在连接 ${activeHost} …`
              : connStatus === "closed"
                ? "会话已结束。从左侧选择主机重新连接。"
                : "尚未连接。\n选择左侧主机，或点击「+ 添加主机」。\n连接后可使用底部 # 提问，或点击「一键诊断」。"}
          </div>
        </div>
      )}
      <div className="term-toolbar">
        <button
          className="primary"
          disabled={connStatus !== "connected" || diagState === "T1_ANALYZING"}
          onClick={() => startDiagnosis("")}
          title="发送最近命令的输出块 + 系统上下文给 AI 分析"
        >
          一键诊断
        </button>
        <span style={{ color: "var(--text-dim)" }}>
          输入行以 # 开头 = AI 分析模式 · AI 生成命令只会写入输入行，Enter 由你按下
        </span>
      </div>
    </div>
  );
}
