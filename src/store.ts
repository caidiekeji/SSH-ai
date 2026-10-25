// Global store: AI config state machine (S0-S5), diagnosis state machine
// (T0-T5), connection state. Every transition edge from PRD §2.2/§2.3 has an
// explicit branch here.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { EMPTY_MEMORY, toView } from "./agentSnapshot";
import type {
  AgentApproval,
  AgentEvent,
  AgentMemory,
  AgentRunSnapshot,
  AgentStepRecord,
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
  /** Saved-connection args enabling auto-reconnect (connection_id required). */
  connectArgs?: {
    host: string;
    port: number;
    username: string;
    auth: { kind: "password"; password: string } | { kind: "publickey"; key_path: string; passphrase: string | null };
    use_saved_password?: boolean;
    connection_id?: string;
  };
  reconnects?: number;
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
  /** Rebuild the tab strip from the backend's live sessions (after a reload). */
  restoreSessions: () => Promise<void>;

  // ---- multi-host tabs ----
  tabs: TermTab[];
  activeTabId: number | null;
  openTab: (sessionId: number, title: string, host: string, connectArgs?: TermTab["connectArgs"]) => void;
  switchTab: (sessionId: number) => void;
  closeTab: (sessionId: number) => Promise<void>;
  setTabStatus: (sessionId: number, status: ConnStatus) => void;
  /** Auto-reconnect a closed tab (saved-password connections, ≤3 attempts). */
  maybeReconnect: (oldSessionId: number) => Promise<void>;

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

  // ---- composer (AI panel): cmd | diag | agent | chat ----
  composerMode: "cmd" | "diag" | "agent" | "chat";
  setComposerMode: (m: "cmd" | "diag" | "agent" | "chat") => void;

  // ---- chat mode (multi-turn conversation) ----
  chatHistory: { role: "user" | "assistant"; content: string }[];
  chatBusy: boolean;
  sendChat: (text: string) => Promise<void>;
  appendChatChunk: (text: string) => void;
  clearChat: () => void;

  // ---- agent mode (automated ops loop) ----
  agentStatus: "idle" | "running" | "waiting" | "done" | "failed" | "stopped";
  agentGoal: string;
  agentSteps: AgentStepRecord[];
  agentApproval: AgentApproval | null;
  agentError: string;
  /** The plan produced by the Planner layer (null before planning). */
  agentPlan: import("./types").AgentPlan | null;
  /** Structured work memory: cwd / facts / hypotheses / failed attempts. */
  agentMemory: AgentMemory;
  /** Neutral note shown next to the result (skipped steps, budget warnings). */
  agentNotice: string;
  /** The backend run id (0 = no run). */
  agentRunId: number;
  /**
   * The run whose card the user closed (null = nothing dismissed).
   *
   * Closing the card only hides it: the task keeps running in the backend.
   * A pending approval or a finished result brings the card back — see
   * `isCardVisible` in agentSnapshot.ts.
   */
  agentDismissedRunId: number | null;
  /** Subscribe to backend state changes. Returns an unsubscribe function. */
  subscribeAgent: () => Promise<() => void>;
  startAgent: (goal: string) => Promise<void>;
  stopAgent: () => Promise<void>;
  resolveAgent: (ok: boolean) => Promise<void>;

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

/** One executed step as shown in the Agent card. */
export type { AgentStepRecord, AgentApproval, AgentMemory };

let cardSeq = 0;
const nextCardId = () => `card-${Date.now()}-${cardSeq++}`;
let lastQuestion = "";
let diagRunning = false;

/**
 * Apply a backend run snapshot to the store.
 *
 * The snapshot is the SINGLE source of truth for the agent card: the backend
 * decides the status, the steps and the acceptance verdict, and the UI just
 * renders them. This is what makes a window reload harmless — the UI can be
 * thrown away and rebuilt from a fresh snapshot at any time.
 */
const applyAgentSnapshot = (snap: AgentRunSnapshot) => {
  const view = toView(snap);
  useStore.setState({
    agentStatus: view.status,
    agentGoal: view.goal,
    agentSteps: view.steps,
    agentApproval: view.approval,
    agentError: view.error,
    agentNotice: view.notice,
    agentPlan: view.plan,
    agentMemory: view.memory,
    agentRunId: view.runId,
  });
};

/**
 * Reattach the UI to the agent task the backend is running for the current
 * session.
 *
 * This is what makes a window reload harmless: the task keeps running in the
 * backend, and the UI just re-reads its state. Called on startup and
 * whenever the user switches to another session.
 */
const reattachAgent = async () => {
  const sid = useStore.getState().sessionId;
  if (sid === null) return;
  try {
    const snap = await ipc.agentRunForSession(sid);
    if (snap) {
      applyAgentSnapshot(snap);
    } else {
      // No live task for this session: clear whatever the previous session
      // left on screen.
      useStore.setState({
        agentStatus: "idle",
        agentSteps: [],
        agentGoal: "",
        agentError: "",
        agentApproval: null,
        agentPlan: null,
        agentNotice: "",
        agentMemory: EMPTY_MEMORY,
        agentRunId: 0,
        agentDismissedRunId: null,
      });
    }
  } catch {
    // The backend is unreachable — leave the UI as it is.
  }
};

// Previous raw byte/sector counters (for computing per-second rates).
let lastIoRaw: { sessionId: number; rx: number; tx: number; dr: number; dw: number; t: number } | null = null;

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

  /**
   * Rebuild the tab strip from the backend's live sessions.
   *
   * The session table lives in the backend, so a reloaded window can recover
   * its connections instead of showing an empty app. Without this the UI
   * would not even know which host it was talking to — and could not
   * reattach to an agent task that is still running.
   */
  restoreSessions: async () => {
    let live: { sessionId: number; host: string; username: string }[] = [];
    try {
      live = await ipc.listSessions();
    } catch {
      return;
    }
    if (!live.length) return;
    set((s) => {
      // Keep any tab the UI already knows about; add the backend's.
      const known = new Set(s.tabs.map((t) => t.sessionId));
      const extra = live
        .filter((l) => !known.has(l.sessionId))
        .map((l) => ({
          sessionId: l.sessionId,
          title: `${l.username}@${l.host}`,
          host: l.host,
          status: "connected" as ConnStatus,
          connectArgs: undefined,
        }));
      if (!extra.length) return s;
      const tabs = [...s.tabs, ...extra];
      const activeTabId = s.activeTabId ?? extra[0].sessionId;
      return {
        tabs,
        activeTabId,
        // The restored session becomes the active one, so the UI shows a
        // live terminal instead of an empty pane.
        ...(s.sessionId === null && activeTabId !== null
          ? {
              sessionId: activeTabId,
              connStatus: "connected" as ConnStatus,
              connError: "",
              activeHost:
                extra.find((l) => l.sessionId === activeTabId)?.host ?? s.activeHost,
            }
          : {}),
      };
    });
    // The restored session may already have an agent task running.
    void reattachAgent();
  },

  // ---- multi-host tabs ----
  tabs: [],
  activeTabId: null,
  openTab: (sessionId, title, host, connectArgs) =>
    set((s) => ({
      // If this session already has a tab, just focus it (reconnect case).
      tabs: s.tabs.some((t) => t.sessionId === sessionId)
        ? s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status: "connected" as ConnStatus } : t))
        : [...s.tabs, { sessionId, title, host, status: "connected" as ConnStatus, connectArgs }],
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
    // Each session can have its own agent task; show the one belonging to
    // the session the user just switched to.
    void reattachAgent();
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
  setTabStatus: (sessionId, status) => {
    set((s) => {
      const tabs = s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status } : t));
      const isActive = s.activeTabId === sessionId;
      return {
        tabs,
        ...(isActive ? { connStatus: status } : {}),
      };
    });
    if (status === "closed") void get().maybeReconnect(sessionId);
  },

  // Auto-reconnect with exponential-ish backoff: only saved-password
  // connections (connection_id + use_saved_password) can be re-established
  // without user interaction. Max 3 attempts, 2s/4s/6s.
  maybeReconnect: async (oldSessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === oldSessionId);
    if (!tab?.connectArgs?.connection_id) return;
    const n = tab.reconnects ?? 0;
    if (n >= 3) return;
    await new Promise((r) => setTimeout(r, 2000 * (n + 1)));
    // The user may have reconnected manually while waiting.
    const cur = get().tabs.find((t) => t.sessionId === oldSessionId);
    if (!cur || cur.status !== "closed") return;
    try {
      const res = await ipc.sshConnect(tab.connectArgs);
      ipc.sshDisconnect(oldSessionId).catch(() => {});
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.sessionId === oldSessionId
            // Success resets the backoff counter: the limit is per-streak of
            // failures, NOT cumulative across the tab's lifetime.
            ? { ...t, sessionId: res.sessionId, status: "connected" as ConnStatus, reconnects: 0 }
            : t,
        ),
        activeTabId: s.activeTabId === oldSessionId ? res.sessionId : s.activeTabId,
        sessionId: s.sessionId === oldSessionId ? res.sessionId : s.sessionId,
        ...(s.activeTabId === oldSessionId ? { activeHost: tab.host, connStatus: "connected" as ConnStatus } : {}),
      }));
    } catch {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.sessionId === oldSessionId ? { ...t, reconnects: n + 1 } : t)),
      }));
      void get().maybeReconnect(oldSessionId);
    }
  },

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
    // Dismissing an old card must not clobber the state machine (a streaming
    // or active result may still be in T1/T2); only return to idle when the
    // last card is gone.
    set((s) => {
      const cards = s.cards.filter((c) => c.id !== id);
      return { cards, ...(cards.length === 0 ? { diagState: "T0_IDLE" as DiagState } : {}) };
    });
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

  // ---- agent mode (automated ops loop) ----
  // The controller runs in the RUST BACKEND. This store is a thin observer:
  // it starts a run, renders the snapshots the backend pushes, and answers
  // approval requests. Nothing here decides anything about the remote
  // machine — that is exactly why a window reload no longer kills the task.
  agentStatus: "idle",
  agentGoal: "",
  agentSteps: [],
  agentApproval: null,
  agentError: "",
  /** The plan produced by the Planner layer (null before planning). */
  agentPlan: null,
  /** Structured work memory: cwd / facts / hypotheses / failed attempts. */
  agentMemory: { cwd: "", facts: [], hypotheses: [], failedAttempts: [] },
  agentNotice: "",
  /** The backend run id (0 = no run). */
  agentRunId: 0,
  /** The run whose card the user closed (null = nothing dismissed). */
  agentDismissedRunId: null,

  // =====================================================================
  // Agent: the backend owns the run; this store only observes it.
  // =====================================================================
  subscribeAgent: async () => {
    const unlisten = await listen<AgentEvent>("agent-state", (e) => {
      const ev = e.payload;
      // A run belonging to another session must not overwrite this one.
      if (get().sessionId !== null && ev.sessionId !== get().sessionId) return;
      applyAgentSnapshot(ev.snapshot);
    });
    // Reattach to a task that survived a window reload: the backend kept
    // running it, and the UI only needs to re-read its state.
    await reattachAgent();
    return unlisten;
  },

  startAgent: async (goal) => {
    const st = get();
    if (!st.sessionId) {
      set({ diagError: "请先连接主机" });
      return;
    }
    if (st.agentStatus === "running" || st.agentStatus === "waiting") return;
    if (!goal.trim()) return;
    set({
      agentStatus: "running",
      agentGoal: goal,
      agentSteps: [],
      agentApproval: null,
      agentError: "",
      agentNotice: "",
      agentPlan: null,
      agentMemory: EMPTY_MEMORY,
      // A NEW run is never hidden: whatever the user dismissed before
      // belongs to a different task.
      agentDismissedRunId: null,
    });
    try {
      const runId = await ipc.agentRunStart(st.sessionId, goal, st.activeProfileId);
      set({ agentRunId: runId });
    } catch (e) {
      set({ agentStatus: "failed", agentError: String(e) });
    }
  },

  stopAgent: async () => {
    const runId = get().agentRunId;
    if (!runId) return;
    try {
      await ipc.agentRunStop(runId);
    } catch {
      // The run may already be finished; the backend still publishes the
      // terminal state, so there is nothing to fix here.
    }
  },

  resolveAgent: async (ok) => {
    const runId = get().agentRunId;
    if (!runId) return;
    try {
      await ipc.agentApprove(runId, ok);
    } catch (e) {
      set({ agentError: String(e) });
    }
  },
  // ---- server dashboard ----
  serverInfo: null,
  serverError: "",
  files: { path: "~", entries: [] },
  fileError: "",

  refreshServer: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    // Single POSIX probe: memory / swap / disk / load / cores / uptime /
    // network bytes (all non-LO IFs) / root-disk sectors read+written.
    // NOTE: must stay GREEN under the Rust execution gate (read-only
    // segments + no `$(...)` substitution). DISKIO reads /proc/mounts +
    // /proc/diskstats in ONE awk instead of `d=$(df …)` — command
    // substitution would force YELLOW and the gate would refuse it.
    const probe =
      "echo @MEM; free -b | awk 'NR==2{print $2\" \"$3\" \"$7}'; " +
      "echo @SWAP; free -b | awk 'NR==3{print $2\" \"$3}'; " +
      "echo @DISK; df -B1 / | awk 'NR==2{print $2\" \"$3}'; " +
      "echo @NET; awk 'NR<3{next} $1!=\"lo:\" {rx+=$2; tx+=$10} END{print rx+0\" \"tx+0}' /proc/net/dev; " +
      "echo @DISKIO; awk 'FNR==NR{ if ($2==\"/\") { d=$1; sub(/.*\\//,\"\",d) } next } " +
      "{ b=d; sub(/[0-9]+$/,\"\",b); if ($3==d && !e) { e=$6\" \"$10 } " +
      "else if ($3==b && !p) { p=$6\" \"$10 } } " +
      "END{ if (e) print e; else if (p) print p; else print \"\" }' /proc/mounts /proc/diskstats; " +
      "echo @LOAD; cut -d' ' -f1-3 /proc/loadavg; " +
      "echo @CORES; nproc 2>/dev/null || echo 1; " +
      "echo @UPTIME; cut -d' ' -f1 /proc/uptime";
    try {
      const out = await ipc.execOneshot(sessionId, probe);
      const sec = (tag: string) => {
        const m = out.match(new RegExp(`@${tag}\\n([^\\n]*)`));
        return m ? m[1].trim() : "";
      };
      const [memT, memU, memA] = sec("MEM").split(/\s+/).map(Number);
      const [swapT, swapU] = sec("SWAP").split(/\s+/).map(Number);
      const [dskT, dskU] = sec("DISK").split(/\s+/).map(Number);
      const [l1, l5] = sec("LOAD").split(/\s+/).map(Number);
      const cores = Number(sec("CORES")) || 1;
      const [rxRaw, txRaw] = sec("NET").split(/\s+/).map(Number);
      const [dReadRaw, dWriteRaw] = sec("DISKIO").split(/\s+/).map(Number);

      // Rates: diff cumulative counters between two samples (<20s apart).
      const now = Date.now();
      const prev = lastIoRaw;
      lastIoRaw = { sessionId, rx: rxRaw || 0, tx: txRaw || 0, dr: dReadRaw || 0, dw: dWriteRaw || 0, t: now };
      const rate = (cur: number, old: number) =>
        prev && prev.sessionId === sessionId && cur >= old && now - prev.t > 0 && now - prev.t < 20000
          ? (cur - old) / ((now - prev.t) / 1000)
          : 0;

      set({
        serverInfo: {
          memTotal: memT || 0,
          memUsed: memU || 0,
          memAvailable: memA || 0,
          swapTotal: swapT || 0,
          swapUsed: swapU || 0,
          diskTotal: dskT || 0,
          diskUsed: dskU || 0,
          diskReadRate: rate(dReadRaw || 0, prev?.dr ?? 0) * 512, // sectors → bytes
          diskWriteRate: rate(dWriteRaw || 0, prev?.dw ?? 0) * 512,
          netRxRate: rate(rxRaw || 0, prev?.rx ?? 0),
          netTxRate: rate(txRaw || 0, prev?.tx ?? 0),
          load1: l1 || 0,
          load5: l5 || 0,
          cores,
          // Raw seconds from /proc/uptime — locale-independent, so the UI
          // can render it in the user's language (uptime -p emits English
          // and changes with the remote locale).
          uptimeSec: Number(sec("UPTIME")) || 0,
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
    // Must stay GREEN under the execution gate: no `$(pwd)` substitution
    // (a separate `pwd` segment instead) and only whitelisted segments.
    const probe =
      `cd -- ${qdir} 2>/dev/null || { echo @ERR; exit 0; }; echo @CWD; pwd; ` +
      `echo @LS; ls -A -p --time-style=long-iso -l 2>/dev/null | grep -v '^total'`;
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
    // File-browser operations are triggered by an explicit user action in the
    // UI (create/rename/delete/save/run) — that click is the authorization
    // for YELLOW writes. The Rust execution gate still re-grades every
    // command and unconditionally refuses RED.
    return ipc.execOneshot(sessionId, command, undefined, "approved");
  },
}));
