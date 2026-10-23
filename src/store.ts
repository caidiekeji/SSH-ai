// Global store: AI config state machine (S0-S5), diagnosis state machine
// (T0-T5), connection state. Every transition edge from PRD §2.2/§2.3 has an
// explicit branch here.

import { create } from "zustand";
import { ipc } from "./ipc";
import {
  isAcceptanceSatisfied,
  isAssertive,
  isOverBudget,
  isPlanApprovalRequired,
  judgeDoneClaim,
  mayRunUnattended,
  pickRunnableStep,
  resolveAcceptanceIds,
  stepSucceeded,
  trimHistory,
} from "./agentPolicy";
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
  _agentResolve: ((ok: boolean) => void) | null;
  /** Run token: a fresh startAgent invalidates any previous loop. */
  _agentRunId: number;
  agentLoop: (runId: number) => Promise<void>;
  startAgent: (goal: string) => void;
  stopAgent: () => void;
  resolveAgent: (ok: boolean) => void;

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
export interface AgentStepRecord {
  no: number;
  command: string;
  description: string;
  output: string;
  risk: string;
  kind: "exec" | "verify" | "pty";
  /** Verifier verdict for this step (undefined = not asserted). */
  verified?: boolean;
  /** Why the assertions failed. */
  verifyFailures?: string[];
  /** Process exit code observed for this step (fed back to the model). */
  exitCode?: number | null;
}

/** The approval request shown to the user. */
export interface AgentApproval {
  command: string;
  description: string;
  level: string;
  /** Full payload for a pty write (never truncated — the preview must match
   *  what is actually written byte for byte). */
  fullText?: string;
  /** Host the command will run on — the approval must say WHERE. */
  host?: string;
}

/** Structured work memory fed back to the planner on every step. */
export interface AgentMemory {
  /** Live cwd of the agent's own shell. */
  cwd: string;
  /** Facts confirmed by a passing assertion. */
  facts: string[];
  /** Hypotheses that were ruled out (with the reason). */
  hypotheses: string[];
  /** Attempts that failed (command + why). */
  failedAttempts: string[];
}

let cardSeq = 0;
const nextCardId = () => `card-${Date.now()}-${cardSeq++}`;
let lastQuestion = "";
let diagRunning = false;

// Agent run token: incremented on every startAgent; a loop whose token no
// longer matches the current one exits instead of resurrecting (stop -> start
// race previously let the OLD and NEW loops run in parallel).
let agentRunSeq = 0;

/**
 * Trim command output for the model: keep head + tail + error-ish lines in
 * the middle, with an EXPLICIT omission marker (OpenHands-style). Long
 * outputs otherwise either get silently cut at the tail (losing the error at
 * the top) or blow the context window.
 */
const trimForAi = (raw: string): string => {
  const MAX_CHARS = 6000;
  if (raw.length <= MAX_CHARS && raw.split("\n").length <= 60) return raw;
  const lines = raw.split("\n");
  const head = lines.slice(0, 12);
  const tail = lines.slice(-30);
  const errRe =
    /(error|fail|fatal|traceback|exception|denied|refused|not found|no such|timeout|panic|错误|失败|拒绝|超时|不存在)/i;
  const mid = lines.slice(12, -30).filter((l) => errRe.test(l)).slice(0, 15);
  const omitted = Math.max(0, lines.length - head.length - tail.length - mid.length);
  const out = [
    ...head,
    `…（已省略中间 ${omitted} 行，保留错误相关行与结尾）…`,
    ...mid,
    ...tail,
  ].join("\n");
  return out.length > MAX_CHARS + 500 ? out.slice(-(MAX_CHARS + 500)) : out;
};

// Human-readable rendering of a step's machine-checkable expectation, shown
// in the Agent card so the user can see WHAT will be verified before it runs.
const describeExpect = (e: import("./types").ExpectSpec): string => {
  const parts: string[] = [];
  if (e.exitCode !== null && e.exitCode !== undefined) parts.push(`退出码=${e.exitCode}`);
  for (const c of e.contains ?? []) parts.push(`输出包含「${c}」`);
  for (const c of e.notContains ?? []) parts.push(`输出不含「${c}」`);
  if (e.regex) parts.push(`输出匹配 /${e.regex}/`);
  return parts.length ? `（断言：${parts.join("；")}）` : "";
};

/**
 * Fold the structured work memory into the goal string that is handed to the
 * reactive planner (B: memory backfeed). The model cannot self-correct if it
 * cannot see what already failed and why, so the cwd / confirmed facts /
 * ruled-out hypotheses / failed attempts are injected here on every replan
 * call. Keep it short — only the most recent ~8 failed attempts survive.
 */
const buildGoalWithMemory = (goal: string, m: AgentMemory): string => {
  const lines: string[] = [];
  if (m.cwd) lines.push(`当前工作目录：${m.cwd}`);
  if (m.facts.length) lines.push("已确认的事实：\n- " + m.facts.slice(-6).join("\n- "));
  if (m.hypotheses.length)
    lines.push("已被证伪的假设：\n- " + m.hypotheses.slice(-6).join("\n- "));
  if (m.failedAttempts.length)
    lines.push(
      "已失败的尝试（不要重复相同做法，换个思路）：\n- " +
        m.failedAttempts.slice(-8).join("\n- "),
    );
  if (!lines.length) return goal;
  return `${goal}\n\n[工作记忆]\n${lines.join("\n")}`;
};

// Previous raw byte/sector counters (for computing per-second rates).
let lastIoRaw: { sessionId: number; rx: number; tx: number; dr: number; dw: number; t: number } | null = null;

// Retry helper for transient AI errors (network / timeout / rate limit /
// mid-stream interruption). Auth-classified errors fail immediately.
const RETRYABLE_AI_ERRORS = ["网络", "超时", "频率", "HTTP 5", "HTTP 429", "连接", "响应中断", "读取超时", "流式"];
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      const retryable = RETRYABLE_AI_ERRORS.some((k) => msg.includes(k));
      if (!retryable || a === attempts - 1) break;
      // Exponential backoff + jitter: 2s, 4s (+0~800ms).
      await new Promise((r) => setTimeout(r, 2000 * (a + 1) + Math.random() * 800));
    }
  }
  throw lastErr;
}

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

  // ---- agent mode ----
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
  _agentResolve: null as ((ok: boolean) => void) | null,
  _agentRunId: 0,
  startAgent: (goal) => {
    const st = get();
    if (!st.sessionId) return set({ diagError: "请先连接主机" });
    if (st.agentStatus === "running" || st.agentStatus === "waiting") return;
    const runId = ++agentRunSeq;
    set({
      agentStatus: "running",
      agentGoal: goal,
      agentSteps: [],
      agentApproval: null,
      agentError: "",
      agentNotice: "",
      _agentRunId: runId,
    });
    void get().agentLoop(runId);
  },
  agentLoop: async (runId: number) => {
    // =========================================================================
    // Agent automation loop — five layers:
    //   Planner  → one model call produces the whole ordered plan
    //   Policy   → authorization scope decides what runs unattended
    //   Executor → runs the plan on the persistent shell
    //   Verifier → Rust evaluates each step's assertions
    //   State    → cwd / facts / hypotheses / failed attempts feed back
    // =========================================================================
    const MAX_STEPS = 24;
    /** Hard cap on model calls for ONE task (1 planner + N replans). */
    const MAX_LLM_CALLS = 40;
    /** Wall-clock ceiling for the whole task. */
    const MAX_WALL_MS = 15 * 60 * 1000;
    /** Char budget for the history handed back to the model on every replan. */
    const HISTORY_CHAR_BUDGET = 24000;

    const audit = (status: string) => {
      const st = get();
      void ipc.saveAgentLog(st.agentGoal, status, st.agentSteps);
    };

    // Every failure path funnels through here, so a user-initiated stop is
    // never overwritten by a later failure ("已停止" must stay "已停止").
    const failTask = (message: string) => {
      if (get().agentStatus === "stopped") {
        audit("stopped");
        return;
      }
      set({ agentStatus: "failed", agentError: message });
      audit("failed");
    };

    // --- sessionId is FROZEN for the whole task -------------------------------
    // The old loop re-read `get().sessionId` every round, so switching tabs
    // mid-task silently moved the task to ANOTHER HOST. The task now belongs
    // to the host it was started on.
    const sessionId = get().sessionId;
    if (!sessionId) {
      set({ agentStatus: "failed", agentError: "会话已断开，任务中止" });
      audit("failed");
      return;
    }
    const host = get().tabs.find((t) => t.sessionId === sessionId)?.host ?? "";

    const alive = () =>
      get()._agentRunId === runId &&
      (get().agentStatus === "running" || get().agentStatus === "waiting");

    const cfg = await ipc.getAgentConfig().catch(() => null);
    const execTimeout = Math.min(300, Math.max(5, cfg?.agentExecTimeout ?? 60));
    const autoGreen = cfg?.autoGreen ?? true;
    const policy = cfg?.policy ?? "readonly";
    const profileId = get().activeProfileId;
    const goal = get().agentGoal;

    // --- budgets (C5: every autonomous loop needs a stop condition) ---------
    const startedAt = Date.now();
    let llmCalls = 0;
    const outOfBudget = () =>
      isOverBudget(llmCalls, MAX_LLM_CALLS, Date.now() - startedAt, MAX_WALL_MS);

    // --- State layer: structured work memory ----------------------------------
    const memory: AgentMemory = { cwd: "", facts: [], hypotheses: [], failedAttempts: [] };
    const setMemory = (patch: Partial<AgentMemory>) => {
      Object.assign(memory, patch);
      set({ agentMemory: { ...memory } });
    };

    // --- Policy layer ---------------------------------------------------------
    // "readonly": only read-only commands run unattended.
    // "plan":    commands belonging to the APPROVED plan run unattended.
    // "step":    every write command is confirmed individually.
    //
    // `planApproved` is set ONLY by the user's explicit approval below.
    // It used to be initialised as `policy === "plan"`, which made the
    // approval branch unreachable (`policy === "plan" && !planApproved` was
    // always false) — the "批准计划" scope then behaved exactly like "逐条确认".
    let planApproved = false;
    const approvedCommands = new Set<string>();

    // Ask the user for approval. Returns true when the command may run.
    const requestApproval = async (
      command: string,
      description: string,
      level: string,
      fullText?: string,
    ): Promise<boolean> => {
      set({
        agentStatus: "waiting",
        agentApproval: { command, description, level, fullText, host },
      });
      const ok = await new Promise<boolean>((resolve) =>
        set({ _agentResolve: resolve } as Partial<Store>),
      );
      if (get().agentStatus === "stopped") return false;
      set({ agentApproval: null, agentStatus: "running" });
      return ok;
    };

    // =====================================================================
    // PLANNER — one model call produces the whole plan
    // =====================================================================
    // The connect-time cwd probe ran in the USER'S PTY channel and never saw
    // the agent shell's own directory. Probe the execution channel once
    // BEFORE planning, so the plan's relative-path commands land where they
    // will actually run.
    let agentCwd = "";
    try {
      const probe = await ipc.execOneshot(sessionId, "pwd", 10);
      agentCwd = probe.trim().split("\n").filter(Boolean).pop()?.trim() ?? "";
    } catch {
      agentCwd = "";
    }
    if (agentCwd) setMemory({ cwd: agentCwd });

    let plan: import("./types").AgentPlan | null = null;
    llmCalls += 1;
    try {
      plan = await withRetry(() =>
        ipc.agentPlan(sessionId, goal, profileId, agentCwd || null),
      );
      set({ agentPlan: plan });
    } catch (e) {
      if (alive()) failTask(`规划失败：${String(e)}`);
      return;
    }
    if (!alive()) return;
    if (!plan || plan.steps.length === 0) {
      failTask("AI 未产出可执行的计划");
      return;
    }

    // Under the "plan" scope the user approves the WHOLE plan once, so the
    // individual write commands do not interrupt the task step by step.
    if (isPlanApprovalRequired(policy, planApproved)) {
      // The approval must show what is actually being authorized: the
      // command text (not just the intent) and which steps are the
      // acceptance criteria.
      const summary = plan.steps
        .map((s, i) => {
          const tag = s.required ? " 〔验收步骤〕" : "";
          return `${i + 1}. ${s.intent || "（未说明意图）"}${tag}\n     $ ${s.command}`;
        })
        .join("\n");
      const ok = await requestApproval(
        `【执行计划】共 ${plan.steps.length} 步\n${summary}`,
        "批准后，计划内的命令将不再逐条询问；标记为〔验收步骤〕的步骤断言全部通过才算任务完成。",
        "yellow",
      );
      if (!ok) {
        set({ agentStatus: "stopped", agentError: "你未批准该计划，任务已停止" });
        audit("stopped");
        return;
      }
      planApproved = true;
      for (const s of plan.steps) approvedCommands.add(s.command);
    }

    // =====================================================================
    // EXECUTOR + VERIFIER + REPLANNER
    //   Phase 1: run the Planner's plan in dependency-respecting order.
    //   Phase 2 (self-correction): when a step fails OR no assertion passed,
    //            ask the model for the next action from observed output, then
    //            act on it — the plan→execute→observe→replan loop (A).
    // =====================================================================
    let stepNo = 0;
    let verifiedCount = 0;
    let assertCount = 0;
    /** Steps fed back to the model on every replan call (B: memory backfeed). */
    const executed: import("./types").AgentStepHistory[] = [];
    // --- Acceptance criteria (the Verifier's verdict on "done") -------------
    // "Task done" must be backed by evidence that the GOAL was reached — not
    // merely that some assertion passed somewhere in the run. The planner
    // marks the step(s) that verify the goal itself with `required: true`;
    // when it marks none, fall back to the LAST assertive step of the plan.
    //
    // A `required` step WITHOUT an assertion is not a usable criterion (it
    // could never be satisfied), so it is filtered out here.
    const acceptanceIds = resolveAcceptanceIds(plan.steps);
    /** Required plan steps whose assertions passed. */
    const passedAcceptance = new Set<number>();
    /** The reactive phase produced a passing re-check of the goal. */
    let reactiveVerified = false;
    /** stepNo of the most recent PASSING verification. */
    let lastPassAt = -1;
    /** stepNo of the most recent FAILED step. */
    let lastFailAt = -1;
    /**
     * Is the goal demonstrably achieved?
     *
     * Three conditions, all required:
     *  1. there IS something to prove against (no assertion → no verdict);
     *  2. the evidence is FRESH — a verification that happened BEFORE the
     *     last failure no longer proves anything (the failed step may have
     *     undone it);
     *  3. either every required plan step passed, or the reactive phase
     *     produced a fresh passing verification.
     */
    const acceptanceOk = () =>
      isAcceptanceSatisfied(acceptanceIds, {
        passedStepIds: [...passedAcceptance],
        reactiveVerified,
        lastPassAt,
        lastFailAt,
      });

    // Run ONE action (a plan step, or a model-decided command/verify/pty) through
    // the policy gate, the persistent shell, and the Rust verifier. Appends the
    // result to both the UI list and the model-history list, and updates memory.
    const runAction = async (action: {
      command: string;
      expect: import("./types").ExpectSpec | null;
      kind: "exec" | "verify" | "pty";
      description: string;
      riskHint: string;
      /** Advisory note for the model/UI (never part of the verified payload). */
      note?: string;
      /** The model's own wording of the expectation (fed back to the model). */
      expectText?: string;
    }): Promise<{ ok: boolean; verified: boolean | undefined; fatal?: boolean }> => {
      stepNo += 1;
      if (stepNo > MAX_STEPS) return { ok: false, verified: undefined };

      // --- Policy: does this command need an individual confirmation? -------
      let assessment: RiskAssessment;
      try {
        assessment = await ipc.assessRisk(action.command, action.riskHint || "read");
      } catch {
        assessment = {
          level: "yellow",
          rule: "grader-error",
          reason: "本地分级器异常，按中风险处理",
        };
      }
      if (!alive()) return { ok: false, verified: undefined };

      // A step that never ran is still INFORMATION for the reactive planner:
      // it must see "this command was refused" instead of silently retrying
      // the same thing.
      const recordRefusal = (reason: string) => {
        set((s) => ({
          agentSteps: [
            ...s.agentSteps,
            {
              no: stepNo,
              command: action.command,
              description: action.description,
              output: reason,
              risk: assessment.level,
              kind: action.kind,
            },
          ],
        }));
        executed.push({
          command: action.command,
          output: reason,
          kind: action.kind,
          description: action.description,
          expect: action.expectText || "",
          verified: undefined,
          exitCode: null,
        });
      };

      const isGreen = assessment.level === "green";
      const inApprovedPlan = approvedCommands.has(action.command);

      // RED = blacklist hit. The Rust gate refuses it unconditionally, so
      // asking the user "do you approve?" would offer a button that can only
      // fail. Refuse the step HERE, tell the planner why, and let it find
      // another route — the task survives, only this command dies.
      if (assessment.level === "red") {
        const reason = `【已拒绝】命中黑名单规则「${assessment.rule}」——${assessment.reason}。该命令不会被执行，请换一种方式达成目标。`;
        recordRefusal(reason);
        memory.failedAttempts.push(`${action.command} → 命中黑名单「${assessment.rule}」，已拒绝执行`);
        setMemory({});
        lastFailAt = stepNo;
        return { ok: false, verified: undefined };
      }

      if (!mayRunUnattended(assessment.level, autoGreen, inApprovedPlan, planApproved)) {
        const ok = await requestApproval(
          action.command,
          action.description,
          assessment.level,
          action.kind === "pty" ? action.command : undefined,
        );
        if (!ok) {
          set({ agentStatus: "stopped", agentError: "你拒绝了该命令，任务已停止" });
          audit("stopped");
          return { ok: false, verified: undefined };
        }
      }
      if (!alive()) return { ok: false, verified: undefined };

      // --- Executor: run it on the persistent shell --------------------------
      // `rawOutput` is the command's own output; `output` additionally carries
      // the annotations that explain a non-zero exit / timeout to the MODEL.
      // The Verifier must judge the RAW payload — annotations are guidance,
      // not command output, and would corrupt `contains` / `regex` assertions.
      let output = "";
      let rawOutput = "";
      let exitCode: number | null = null;
      let maybeExecuted = false;
      let timedOut = false;
      try {
        if (action.kind === "pty") {
          // Interactive terminal step: the user watches the PTY, so we read the
          // local screen model afterwards instead of a structured result.
          await ipc.agentPtyWrite(sessionId, action.command, "approved");
          rawOutput = await ipc.readScreenTail(sessionId, 30).catch(() => "");
          output = rawOutput;
          if (!output.trim()) output = "（已写入终端，未捕获到可见输出）";
        } else {
          const resp = await ipc.agentExec(sessionId, action.command, execTimeout, "approved");
          rawOutput = resp.output;
          output = resp.output;
          exitCode = resp.exitCode;
          maybeExecuted = resp.maybeExecuted;
          timedOut = resp.timedOut;
          if (resp.cwd) setMemory({ cwd: resp.cwd });
          if (resp.exitCode !== null && resp.exitCode !== 0) {
            output += `\n（退出码 ${resp.exitCode}：命令未成功，请分析报错后再决定下一步）`;
          }
          if (resp.timedOut) {
            output += "\n（命令超时：执行通道已重置，cd/export 等状态可能已丢失）";
          } else if (resp.shellGone) {
            output += "\n（shell 已退出：执行通道已重置，cd/export 等状态可能已丢失）";
          }
          if (resp.maybeExecuted) {
            output +=
              "\n（重要：通道在返回结果前断开，该命令可能已在远端执行。请先用只读命令核实状态，不要直接重试。）";
          }
          if (!output.trim()) output = "（命令执行完成，无输出）";
        }
      } catch (e) {
        // Gate refusal or channel error: record it as a failed attempt so the
        // reactive planner can change approach instead of repeating it.
        recordRefusal(`【执行被拒/失败】${String(e)}`);
        memory.failedAttempts.push(`${action.command} → ${String(e)}`);
        setMemory({});
        lastFailAt = stepNo;
        return { ok: false, verified: undefined };
      }

      // Advisory note for the model (and the UI): it rides on the ANNOTATED
      // copy only — the Verifier always judges the raw payload.
      if (action.note) output += `\n${action.note}`;

      // The command may have executed remotely before the channel died —
      // replaying it would run it twice. Stop and let the user decide.
      if (maybeExecuted) {
        set((s) => ({
          agentSteps: [
            ...s.agentSteps,
            { no: stepNo, command: action.command, description: action.description, output: trimForAi(output), risk: assessment.level, kind: action.kind },
          ],
        }));
        failTask(
          "通道在返回结果前断开：最后一条命令可能已在远端执行。为避免重复执行，任务已中止，请人工核实状态。",
        );
        return { ok: false, verified: undefined, fatal: true };
      }

      // A TIMEOUT is a DIFFERENT situation from `maybeExecuted`: we simply
      // stopped waiting and closed the channel on purpose. A read-only
      // command that timed out is safe to run again — the step just failed
      // and the planner picks another approach. A WRITE command may still be
      // running remotely, so stop and let a human check.
      if (timedOut && !isGreen) {
        set((s) => ({
          agentSteps: [
            ...s.agentSteps,
            { no: stepNo, command: action.command, description: action.description, output: trimForAi(output), risk: assessment.level, kind: action.kind },
          ],
        }));
        failTask(
          "写操作超时，远端可能仍在执行，任务已中止。请人工核实远端状态后再继续。",
        );
        return { ok: false, verified: undefined, fatal: true };
      }

      // --- Verifier: Rust decides whether the assertions hold ---------------
      let verified: boolean | undefined;
      let verifyFailures: string[] = [];
      const expect = action.expect;
      const hasExpect = isAssertive(expect);
      if (hasExpect && expect) {
        assertCount += 1;
        try {
          // Assert against the RAW payload — never against the annotated
          // copy (the annotations are notes for the model, not output).
          const outcome = await ipc.agentVerify(expect, exitCode, rawOutput);
          verified = outcome.passed;
          verifyFailures = outcome.failures;
        } catch (e) {
          verified = false;
          verifyFailures = [`断言校验失败：${String(e)}`];
        }
        if (verified) {
          verifiedCount += 1;
          lastPassAt = stepNo;
          memory.facts.push(`${action.description || action.command} → 断言通过`);
        } else {
          memory.hypotheses.push(
            `${action.description || action.command} → 断言未通过（${verifyFailures.join("；") || "输出与预期不符"}）`,
          );
        }
        setMemory({});
      }

      const kind = action.kind;
      const desc = hasExpect && expect ? `${action.description}${describeExpect(expect)}` : action.description;
      set((s) => ({
        agentSteps: [
          ...s.agentSteps,
          {
            no: stepNo,
            command: action.command,
            description: desc,
            output: trimForAi(output),
            risk: assessment.level,
            kind,
            verified,
            verifyFailures: verifyFailures.length ? verifyFailures : undefined,
            exitCode: exitCode ?? undefined,
          },
        ],
      }));
      // Feed the result back to the reactive planner (B).
      executed.push({
        command: action.command,
        output: trimForAi(output),
        kind,
        description: action.description,
        expect: hasExpect && expect ? describeExpect(expect) : action.expectText || "",
        verified: kind === "verify" ? verified : undefined,
        exitCode,
        // Feed the WHY back: without the reason, the model only sees
        // "assertion failed" and thrashes on new commands instead of
        // fixing the assertion itself.
        failures: verifyFailures.length ? verifyFailures : undefined,
      });

      // A step that ran but did not satisfy its assertions (or exited non-zero
      // without one) is a REAL failure.
      //
      // `exitCode === null` means "we never learned the exit code" (timeout,
      // or the shell died before the command ran). It is NOT success: a
      // command that never executed must never satisfy a dependency.
      // `pty` steps have no exit code by nature — they are judged by the
      // user's terminal, so they count as executed.
      const ok = stepSucceeded(kind, verified, exitCode);
      if (!ok) {
        lastFailAt = stepNo;
        memory.failedAttempts.push(
          `${action.command} → ${verified === false ? verifyFailures.join("；") : `退出码 ${exitCode}`}`,
        );
        setMemory({});
      } else {
        memory.facts.push(`${action.description || action.command} → 已完成`);
      }
      return { ok, verified };
    };

    // ---- Phase 1: execute the Planner's plan, respecting depends_on (C) ----
    const doneIds = new Set<number>();
    const failedIds = new Set<number>();
    const skippedIds = new Set<number>();
    const planQueue: import("./types").PlanStep[] = [...plan.steps];
    let mode: "plan" | "reactive" = "plan";

    while (mode === "plan") {
      if (stepNo >= MAX_STEPS) break;
      // The user may have stopped the task while we were executing.
      if (!alive()) return;
      // Pick the next runnable planned step in dependency-respecting order.
      const picked = pickRunnableStep(planQueue, doneIds, failedIds, skippedIds);
      // Steps dropped because a dependency can never succeed are REPORTED,
      // not silently swallowed.
      if (picked.skipped.length > 0) {
        const drop = new Set(picked.skipped.map((s) => s.id));
        for (let i = planQueue.length - 1; i >= 0; i--) {
          if (drop.has(planQueue[i].id)) planQueue.splice(i, 1);
        }
      }
      if (!picked.pick) {
        // No more runnable planned steps. If a step actually failed, switch to
        // reactive replanning; otherwise the plan simply finished (fall through
        // to the final gate).
        if (failedIds.size > 0) mode = "reactive";
        break;
      }
      const planStep = picked.pick;
      // It is being executed now — take it out of the queue.
      const at = planQueue.findIndex((q) => q.id === planStep.id);
      if (at >= 0) planQueue.splice(at, 1);
      const res = await runAction({
        command: planStep.command,
        expect: planStep.expect,
        kind: isAssertive(planStep.expect) ? "verify" : "exec",
        description: planStep.intent || "",
        riskHint: planStep.riskHint || "read",
      });
      if (res.fatal) return;
      if (res.ok) {
        doneIds.add(planStep.id);
        if (res.verified === true && acceptanceIds.includes(planStep.id)) {
          passedAcceptance.add(planStep.id);
        }
      } else {
        failedIds.add(planStep.id);
        mode = "reactive"; // reality diverged → let the model re-decide
      }
    }

    // If the plan ran but the acceptance criteria are NOT satisfied, let the
    // model add a verification step (self-correction) before we declare
    // failure.
    if (mode === "plan" && !acceptanceOk()) {
      mode = "reactive";
    }

    // ---- Phase 2: reactive replanning (observe → decide → act) (A) ----
    let requireVerification = false;
    let recoveryFails = 0;
    /**
     * How many times the model claimed "done" without any proof.
     *
     * This path never consumes a step (`stepNo` only grows inside runAction),
     * so MAX_STEPS does NOT protect it — without this counter a model that
     * keeps answering "done" would spin here forever, burning one LLM call
     * per iteration.
     */
    let unprovenDone = 0;
    const MAX_UNPROVEN_DONE = 3;
    while (mode === "reactive" && stepNo < MAX_STEPS) {
      // The user may have stopped the task while we were waiting for the
      // model — do not spend another call on a dead task.
      if (!alive()) return;
      if (outOfBudget()) {
        failTask(
          `任务超出预算（模型调用 ${llmCalls}/${MAX_LLM_CALLS} 次，用时 ${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s），任务中止。请人工核对。`,
        );
        return;
      }
      const goalWithMemory = buildGoalWithMemory(goal, memory);
      let out: Awaited<ReturnType<typeof ipc.agentStep>>;
      llmCalls += 1;
      try {
        out = await withRetry(() =>
          ipc.agentStep(
            sessionId,
            goalWithMemory,
            trimHistory(executed, HISTORY_CHAR_BUDGET),
            requireVerification,
            profileId,
            memory.cwd || null,
          ),
        );
      } catch (e) {
        failTask(`重规划失败：${String(e)}`);
        return;
      }
      // Defensive: a stray/empty action must not become a blind exec. Treat it
      // as one failed replan attempt and let the next call correct course.
      const hasCommand = out.action === "command" || out.action === "verify";
      if (
        (out.action !== "done" && out.action !== "giveup" && out.action !== "pty" && !hasCommand) ||
        (hasCommand && !out.command)
      ) {
        recoveryFails += 1;
        if (recoveryFails >= 8) {
          failTask("重规划返回了无法执行的动作，任务中止。请人工核对。");
          return;
        }
        continue;
      }
      if (out.action === "done") {
        const verdict = judgeDoneClaim(acceptanceOk(), unprovenDone, MAX_UNPROVEN_DONE);
        if (verdict.accept) {
          set({ agentStatus: "done" });
          audit("done");
          return;
        }
        // Claimed done WITHOUT proof — force a verification step next round.
        // The verdict counts the attempts: this branch consumes no step, so
        // it needs its own stop condition (otherwise the model could spin
        // here forever, one LLM call per iteration).
        requireVerification = verdict.requireVerification;
        unprovenDone += 1;
        if (verdict.abort) {
          failTask(
            `模型连续 ${unprovenDone} 次声称任务完成，但始终没有通过验收断言，任务中止。请人工核对。`,
          );
          return;
        }
        continue;
      }
      if (out.action === "giveup") {
        failTask(`Agent 放弃任务：${out.reason || "模型判断无法完成目标"}`);
        return;
      }
      if (out.action === "pty") {
        const res = await runAction({
          command: out.keys || "",
          expect: null,
          kind: "pty",
          description: out.description || "终端交互操作",
          riskHint: "write",
        });
        if (res.fatal) return;
        if (!res.ok) recoveryFails += 1;
        continue;
      }
      // command | verify
      const isVerify = out.action === "verify";
      // The expectation must be a MACHINE-CHECKABLE spec. A plain-text
      // description ("至少5行软件包信息") can never be found in the output by
      // substring match, so it is NOT used as a needle: the step still runs,
      // but it cannot count as verification, and the model is told exactly
      // what to return instead. (Using a description as a literal needle is
      // what made every reactive verify step fail forever.)
      const spec = isVerify ? out.expectSpec ?? null : null;
      const note =
        isVerify && !spec
          ? `（本次 verify 未提供结构化断言 expect${
              out.expectText ? `（只给了描述「${out.expectText}」）` : ""
            }，无法机械校验；请在下一步返回 expect:{"exit_code":0,"contains":["输出中会逐字出现的字面子串"]}）`
          : undefined;
      const res = await runAction({
        command: out.command || "",
        expect: spec,
        kind: isVerify ? "verify" : "exec",
        description: out.description || out.reasoning || "",
        riskHint: out.riskHint || "read",
        note,
        expectText: out.expectText,
      });
      if (res.fatal) return;
      requireVerification = false;
      // A passing reactive verification IS evidence about the goal — it is
      // the model's re-check after the plan diverged.
      if (isVerify && res.verified === true) reactiveVerified = true;
      if (!res.ok) recoveryFails += 1;
      if (recoveryFails >= 8) {
        failTask("多次重规划仍未达成一致，任务中止。请人工核对状态。");
        return;
      }
    }

    // =====================================================================
    // Completion gate — a claim of success needs ACCEPTANCE EVIDENCE
    // =====================================================================
    // Skipped steps must never disappear silently: a step whose dependency
    // could not be satisfied never ran, and the user has to know that.
    if (skippedIds.size > 0) {
      set({
        agentNotice: `有 ${skippedIds.size} 个计划步骤因依赖无法满足而未执行（步骤 ${[...skippedIds].join(
          "、",
        )}），请核对计划。`,
      });
    }
    if (assertCount === 0) {
      failTask(
        "计划中没有可校验的验证步骤，无法确认目标是否达成，任务中止。请人工核对。",
      );
      return;
    }
    if (verifiedCount === 0) {
      failTask(
        "所有验证步骤的断言均未通过，无法确认目标已达成，任务中止。请人工核对。",
      );
      return;
    }
    if (!acceptanceOk()) {
      const missing = acceptanceIds.filter((id) => !passedAcceptance.has(id));
      failTask(
        `验收步骤未全部通过（${acceptanceIds.length - missing.length}/${
          acceptanceIds.length
        } 通过），无法确认目标已达成，任务中止。请人工核对。`,
      );
      return;
    }
    set({ agentStatus: "done" });
    audit("done");
  },
  stopAgent: () => {
    const resolve = get()._agentResolve;
    const sessionId = get().sessionId;
    set({ agentStatus: "stopped", agentApproval: null, _agentResolve: null });
    resolve?.(false);
    // Cancel the in-flight remote command. Without this the command keeps
    // running on the server long after the user pressed "停止" — the UI said
    // "stopped" while the machine was still busy executing the agent's step.
    if (sessionId !== null) void ipc.agentCancel(sessionId).catch(() => {});
    const st = get();
    if (st.agentSteps.length > 0) void ipc.saveAgentLog(st.agentGoal, "stopped", st.agentSteps);
  },
  resolveAgent: (ok) => {
    const resolve = get()._agentResolve;
    set({ _agentResolve: null });
    resolve?.(ok);
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
