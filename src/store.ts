// Global store: AI config state machine (S0-S5), diagnosis state machine
// (T0-T5), connection state. Every transition edge from PRD §2.2/§2.3 has an
// explicit branch here.

import { create } from "zustand";
import { ipc } from "./ipc";
import type {
  AiConfigState,
  ConnectionConfig,
  DiagState,
  DiagnosisCard,
  ErrorBlockEvent,
  FileEntry,
  ProviderProfile,
  ProviderSpec,
  RiskAssessment,
  ServerInfo,
  ThemeName,
} from "./types";

export type ConnStatus = "disconnected" | "connecting" | "connected" | "closed" | "error";

export interface TermTab {
  sessionId: number;
  title: string;
  host: string;
  status: ConnStatus;
}

interface PendingPrefill {
  command: string;
  aiRiskHint: string;
  assessment: RiskAssessment;
}

interface Store {
  // ---- connection ----
  sessionId: number | null;
  connStatus: ConnStatus;
  connError: string;
  activeHost: string;
  connections: ConnectionConfig[];
  setConn: (s: Partial<Pick<Store, "sessionId" | "connStatus" | "connError" | "activeHost">>) => void;
  loadConnections: () => Promise<void>;

  // ---- multi-host tabs ----
  tabs: TermTab[];
  activeTabId: number | null;
  openTab: (sessionId: number, title: string, host: string) => void;
  switchTab: (sessionId: number) => void;
  closeTab: (sessionId: number) => Promise<void>;
  setTabStatus: (sessionId: number, status: ConnStatus) => void;

  // ---- AI config (§2.2) ----
  aiState: AiConfigState;
  specs: ProviderSpec[];
  profiles: ProviderProfile[];
  activeProfileId: string | null;
  loadProviderData: () => Promise<void>;
  setAiState: (s: AiConfigState) => void;
  saveAndSelectProfile: (p: ProviderProfile, key: string | null) => Promise<void>;

  // ---- diagnosis (§2.3) ----
  diagState: DiagState;
  cards: DiagnosisCard[];
  errorBlocks: ErrorBlockEvent[];
  streamingCardId: string | null;
  diagError: string;
  pendingPrefill: PendingPrefill | null;
  lastPrefillNotice: string;
  startDiagnosis: (question: string) => Promise<void>;
  appendChunk: (text: string) => void;
  finishDiagnosis: (result: DiagnosisResultPayload) => void;
  failDiagnosis: (err: string) => void;
  closeCard: (id: string) => void;
  requestInsert: (cardId: string, command: string, hint: string) => Promise<void>;
  confirmPrefill: () => Promise<void>;
  cancelPrefill: () => void;
  addErrorBlock: (b: ErrorBlockEvent) => void;
  retryDiagnosis: () => Promise<void>;

  // ---- theme (multi color modes) ----
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;

  // ---- composer (AI panel): cmd | diag | chat ----
  composerMode: "cmd" | "diag" | "chat";
  setComposerMode: (m: "cmd" | "diag" | "chat") => void;

  // ---- chat mode (multi-turn conversation) ----
  chatHistory: { role: "user" | "assistant"; content: string }[];
  chatBusy: boolean;
  sendChat: (text: string) => Promise<void>;
  appendChatChunk: (text: string) => void;
  clearChat: () => void;

  // ---- server dashboard ----
  serverInfo: ServerInfo | null;
  serverError: string;
  files: { path: string; entries: FileEntry[] };
  fileError: string;
  refreshServer: () => Promise<void>;
  listDir: (path: string) => Promise<void>;
  runOp: (command: string) => Promise<string>;
}

export interface DiagnosisResultPayload {
  result: import("./types").DiagnosisResult;
  provider: string;
  model: string;
}

let cardSeq = 0;
const nextCardId = () => `card-${Date.now()}-${cardSeq++}`;
let lastQuestion = "";
let diagRunning = false;

export const useStore = create<Store>((set, get) => ({
  sessionId: null,
  connStatus: "disconnected",
  connError: "",
  activeHost: "",
  connections: [],
  setConn: (s) => set(s),
  loadConnections: async () => {
    const connections = await ipc.listConnections();
    set({ connections });
  },

  // ---- multi-host tabs ----
  tabs: [],
  activeTabId: null,
  openTab: (sessionId, title, host) =>
    set((s) => ({
      // If this session already has a tab, just focus it (reconnect case).
      tabs: s.tabs.some((t) => t.sessionId === sessionId)
        ? s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status: "connected" as ConnStatus } : t))
        : [...s.tabs, { sessionId, title, host, status: "connected" as ConnStatus }],
      activeTabId: sessionId,
      sessionId,
      connStatus: "connected" as ConnStatus,
      connError: "",
      activeHost: host,
      // Reset dashboard so the poll effect refetches for the new active tab.
      serverInfo: null,
      files: { path: "~", entries: [] },
      fileError: "",
      // Quick-error chips are per-session: drop blocks from other sessions.
      errorBlocks: [],
    })),
  switchTab: (sessionId) => {
    const t = get().tabs.find((x) => x.sessionId === sessionId);
    if (!t) return;
    set({
      activeTabId: sessionId,
      sessionId,
      connStatus: t.status,
      connError: "",
      activeHost: t.host,
      serverInfo: null,
      files: { path: "~", entries: [] },
      fileError: "",
      errorBlocks: [],
    });
  },
  closeTab: async (sessionId) => {
    const { tabs, activeTabId } = get();
    await ipc.sshDisconnect(sessionId).catch(() => {});
    const rest = tabs.filter((t) => t.sessionId !== sessionId);
    if (rest.length === 0) {
      set({
        tabs: [],
        activeTabId: null,
        sessionId: null,
        connStatus: "disconnected",
        connError: "",
        activeHost: "",
        serverInfo: null,
        files: { path: "~", entries: [] },
        errorBlocks: [],
      });
      return;
    }
    if (activeTabId === sessionId) {
      const next = rest[rest.length - 1];
      get().switchTab(next.sessionId);
    }
    set({ tabs: rest });
  },
  setTabStatus: (sessionId, status) =>
    set((s) => {
      const tabs = s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status } : t));
      const isActive = s.activeTabId === sessionId;
      return {
        tabs,
        ...(isActive ? { connStatus: status } : {}),
      };
    }),

  // ---- AI config ----
  aiState: "S0_UNCONFIGURED",
  specs: [],
  profiles: [],
  activeProfileId: null,
  loadProviderData: async () => {
    const specs = await ipc.listProviderSpecs();
    const profiles = await ipc.listProfiles();
    const activeProfileId = profiles.length ? profiles[profiles.length - 1].id : null;
    const aiState = profiles.length ? "S5_READY" : "S0_UNCONFIGURED";
    set({ specs, profiles, activeProfileId, aiState });
  },
  setAiState: (aiState) => set({ aiState }),
  saveAndSelectProfile: async (p, key) => {
    await ipc.saveProfile(p, key);
    const profiles = await ipc.listProfiles();
    set({ profiles, activeProfileId: p.id, aiState: "S5_READY" });
  },

  // ---- diagnosis ----
  diagState: "T0_IDLE",
  cards: [],
  errorBlocks: [],
  streamingCardId: null,
  diagError: "",
  pendingPrefill: null,
  lastPrefillNotice: "",

  startDiagnosis: async (question) => {
    const { sessionId } = get();
    if (!sessionId) return set({ diagError: "请先连接主机" });
    if (diagRunning) return set({ diagError: "已有诊断正在进行" });
    diagRunning = true;
    lastQuestion = question;
    const card: DiagnosisCard = {
      id: nextCardId(),
      createdAt: Date.now(),
      question,
      provider: "",
      model: "",
      streaming: true,
      streamingText: "",
    };
    set((s) => ({
      diagState: "T1_ANALYZING",
      // Chat flows top-down: newest message appends at the bottom.
      cards: [...s.cards, card],
      streamingCardId: card.id,
      diagError: "",
    }));
    try {
      const payload = await ipc.aiDiagnose(sessionId, question);
      get().finishDiagnosis(payload);
    } catch (e) {
      get().failDiagnosis(String(e));
    } finally {
      diagRunning = false;
    }
  },

  appendChunk: (text) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === s.streamingCardId ? { ...c, streamingText: c.streamingText + text } : c,
      ),
    })),

  finishDiagnosis: (payload) =>
    set((s) => ({
      diagState: "T2_RESULT",
      cards: s.cards.map((c) =>
        c.id === s.streamingCardId
          ? {
              ...c,
              streaming: false,
              result: payload.result,
              provider: payload.provider,
              model: payload.model,
              blocksSent: (payload as { blocksSent?: number }).blocksSent,
            }
          : c,
      ),
      streamingCardId: null,
    })),

  failDiagnosis: (err) => {
    // T1_FAILED → error shown with retry / switch provider exits (PRD §2.3).
    set((s) => ({
      diagState: "T1_FAILED",
      diagError: err,
      cards: s.cards.map((c) => (c.id === s.streamingCardId ? { ...c, streaming: false, error: err } : c)),
      streamingCardId: null,
    }));
  },

  retryDiagnosis: async () => {
    await get().startDiagnosis(lastQuestion);
  },

  closeCard: (id) => {
    set((s) => ({ cards: s.cards.filter((c) => c.id !== id) }));
    // Closing the result card returns to idle (T2 → T0).
    set({ diagState: "T0_IDLE" });
  },

  requestInsert: async (_cardId, command, hint) => {
    // T2 → T3: local risk grading happens synchronously on the Rust side;
    // the AI hint is NOT trusted (PRD §5.5).
    const assessment = await ipc.assessRisk(command, hint);
    if (assessment.level === "green") {
      // Green: prefill directly (user still presses Enter).
      set({ pendingPrefill: { command, aiRiskHint: hint, assessment } });
      await get().confirmPrefill();
      return;
    }
    if (assessment.level === "yellow") {
      set({ diagState: "T3_CONFIRM_YELLOW", pendingPrefill: { command, aiRiskHint: hint, assessment } });
      return;
    }
    set({ diagState: "T3_CONFIRM_RED", pendingPrefill: { command, aiRiskHint: hint, assessment } });
  },

  confirmPrefill: async () => {
    const { pendingPrefill, sessionId } = get();
    if (!pendingPrefill || !sessionId) return;
    try {
      await ipc.prefillCommand({
        sessionId,
        command: pendingPrefill.command,
        aiRiskHint: pendingPrefill.aiRiskHint,
        userAck: pendingPrefill.assessment.level,
      });
      // T4_PREFILLED: bytes are in the input line; the USER presses Enter.
      set({
        diagState: "T4_PREFILLED",
        lastPrefillNotice: `已写入输入行（${pendingPrefill.assessment.level === "green" ? "绿" : pendingPrefill.assessment.level === "yellow" ? "黄" : "红"}）：请在终端中按 Enter 执行`,
        pendingPrefill: null,
      });
      setTimeout(() => set({ diagState: "T0_IDLE" }), 1200);
    } catch (e) {
      set({ diagError: String(e), pendingPrefill: null, diagState: "T0_IDLE" });
    }
  },

  cancelPrefill: () => {
    // Refused → back to the result card (T3 → T2).
    set({ pendingPrefill: null, diagState: "T2_RESULT" });
  },

  addErrorBlock: (b) =>
    set((s) => {
      const exists = s.errorBlocks.some((e) => e.id === b.id);
      if (exists) return {};
      return { errorBlocks: [...s.errorBlocks.slice(-50), b] };
    }),

  // ---- theme ----
  theme: (localStorage.getItem("theme") as ThemeName) || "dark",
  setTheme: (t) => {
    localStorage.setItem("theme", t);
    set({ theme: t });
  },

  // ---- composer modes ----
  composerMode: "diag",
  setComposerMode: (composerMode) => set({ composerMode }),

  // ---- chat mode ----
  chatHistory: [],
  chatBusy: false,
  sendChat: async (text) => {
    if (!text.trim() || get().chatBusy) return;
    const history = get().chatHistory.map((m) => ({ role: m.role, content: m.content }));
    set((s) => ({
      chatBusy: true,
      chatHistory: [
        ...s.chatHistory,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: "" },
      ],
    }));
    try {
      const reply = await ipc.aiChat(history, text);
      // Set the final text (streaming chunks already filled it; this is the
      // authoritative complete version).
      set((s) => ({
        chatBusy: false,
        chatHistory: s.chatHistory.map((m, i) =>
          i === s.chatHistory.length - 1 ? { ...m, content: reply || m.content } : m,
        ),
      }));
    } catch (e) {
      set((s) => ({
        chatBusy: false,
        chatHistory: s.chatHistory.map((m, i) =>
          i === s.chatHistory.length - 1 ? { ...m, content: m.content || `⚠ ${String(e)}` } : m,
        ),
      }));
    }
  },
  appendChatChunk: (text) =>
    set((s) => ({
      chatHistory: s.chatHistory.map((m, i) =>
        i === s.chatHistory.length - 1 && m.role === "assistant"
          ? { ...m, content: m.content + text }
          : m,
      ),
    })),
  clearChat: () => set({ chatHistory: [] }),

  // ---- server dashboard ----
  serverInfo: null,
  serverError: "",
  files: { path: "~", entries: [] },
  fileError: "",

  refreshServer: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    // Single POSIX probe: memory / disk / load / cores / uptime.
    const probe =
      "echo @MEM; free -b | awk 'NR==2{print $2\" \"$3}'; " +
      "echo @DISK; df -B1 / | awk 'NR==2{print $2\" \"$3}'; " +
      "echo @LOAD; cut -d' ' -f1-3 /proc/loadavg; " +
      "echo @CORES; nproc 2>/dev/null || echo 1; " +
      "echo @UPTIME; uptime -p 2>/dev/null | sed 's/^up //'";
    try {
      const out = await ipc.execOneshot(sessionId, probe);
      const sec = (tag: string) => {
        const m = out.match(new RegExp(`@${tag}\\n([^\\n]*)`));
        return m ? m[1].trim() : "";
      };
      const [memT, memU] = sec("MEM").split(" ").map(Number);
      const [dskT, dskU] = sec("DISK").split(" ").map(Number);
      const [l1, l5] = sec("LOAD").split(" ").map(Number);
      const cores = Number(sec("CORES")) || 1;
      set({
        serverInfo: {
          memTotal: memT || 0,
          memUsed: memU || 0,
          diskTotal: dskT || 0,
          diskUsed: dskU || 0,
          load1: l1 || 0,
          load5: l5 || 0,
          cores,
          uptime: sec("UPTIME") || "-",
        },
        serverError: "",
      });
    } catch (e) {
      set({ serverError: String(e) });
    }
  },

  listDir: async (path) => {
    const { sessionId } = get();
    if (!sessionId) return;
    // `~` is NOT expanded inside single quotes — expand it to $HOME explicitly.
    // (String concat: "${...}" in a JS template would trigger interpolation.)
    const rest = path.slice(1).replace(/'/g, "'\\''");
    const qdir =
      path === "~" ? '"$HOME"' : path.startsWith("~/") ? '"$HOME' + rest + '"' : "'" + path.replace(/'/g, "'\\''") + "'";
    // -A all-but-dotfiles, -p dir suffix, long-iso time, size + name only.
    const probe =
      `cd -- ${qdir} 2>/dev/null || { echo @ERR; exit 0; }; echo "@CWD\n$(pwd)"; ` +
      `echo "@LS"; ls -A -p --time-style=long-iso -l 2>/dev/null | grep -v '^total'`;
    try {
      const out = await ipc.execOneshot(sessionId, probe);
      if (out.startsWith("@ERR")) {
        set({ fileError: "无法访问该目录（可能不存在或无权限），已保留当前目录" });
        // Keep showing the previous (still valid) directory listing.
        return;
      }
      const cwdM = out.match(/@CWD\n([^\n]*)/);
      const lsM = out.match(/@LS\n([\s\S]*)/);
      const entries: FileEntry[] = [];
      for (const line of (lsM?.[1] ?? "").split("\n")) {
        const m = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+)\s+(.*)$/);
        if (!m) continue;
        const rawName = m[4];
        const dir = rawName.endsWith("/");
        entries.push({
          name: dir ? rawName.slice(0, -1) : rawName.replace(/^["']|["']$/g, ""),
          dir,
          size: Number(m[2]),
          mtime: m[3],
        });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      set({ files: { path: cwdM?.[1]?.trim() || path, entries }, fileError: "" });
      // Sync the path box to the resolved absolute path.
      const resolved = cwdM?.[1]?.trim();
      if (resolved) useStore.setState({ files: { path: resolved, entries } });
    } catch (e) {
      set({ fileError: String(e) });
    }
  },

  runOp: async (command) => {
    const { sessionId } = get();
    if (!sessionId) throw new Error("未连接主机");
    return ipc.execOneshot(sessionId, command);
  },
}));
