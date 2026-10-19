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
  agentSteps: { no: number; command: string; description: string; output: string; risk: string; kind: "exec" | "verify" }[];
  agentApproval: { command: string; description: string; level: string } | null;
  agentError: string;
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

let cardSeq = 0;
const nextCardId = () => `card-${Date.now()}-${cardSeq++}`;
let lastQuestion = "";
let diagRunning = false;

// Agent run token: incremented on every startAgent; a loop whose token no
// longer matches the current one exits instead of resurrecting (stop -> start
// race previously let the OLD and NEW loops run in parallel).
let agentRunSeq = 0;

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
      _agentRunId: runId,
    });
    void get().agentLoop(runId);
  },
  agentLoop: async (runId: number) => {
    const MAX_STEPS = 12;
    let verifyAsked = false; // 是否已要求 AI 补验证（防无限验证循环）
    // A loop whose run token was superseded (stop -> new start) must exit,
    // not resume and double-execute steps alongside the new loop.
    const alive = () =>
      get()._agentRunId === runId && (get().agentStatus === "running" || get().agentStatus === "waiting");
    // Per-command exec timeout from settings (5..=300s, default 60).
    const cfg = await ipc.getAgentConfig().catch(() => null);
    const execTimeout = Math.min(300, Math.max(5, cfg?.agentExecTimeout ?? 60));
    const profileId = get().activeProfileId;
    // 审计：任务结束时落盘（data_dir/agent_logs/），失败静默。
    const audit = (s: string) => {
      const st = get();
      void ipc.saveAgentLog(st.agentGoal, s, st.agentSteps);
    };
    for (let i = 1; i <= MAX_STEPS; i++) {
      const st = get();
      if (st.agentStatus !== "running" || !st.sessionId) return;
      const hasVerify = st.agentSteps.some((s) => s.kind === "verify");
      const requireVerification = verifyAsked && !hasVerify;

      // 1. Plan the next step (AI returns pure data; transient errors retried).
      let step: Awaited<ReturnType<typeof ipc.agentStep>>;
      try {
        step = await withRetry(() =>
          ipc.agentStep(
            st.sessionId!,
            st.agentGoal,
            st.agentSteps.map((s) => ({ command: s.command, output: s.output })),
            requireVerification,
            profileId,
          ),
        );
      } catch (e) {
        if (alive()) set({ agentStatus: "failed", agentError: String(e) });
        return;
      }
      if (!alive()) return;

      if (step.action === "done") {
        // P0 加固：done 必须有 verify 证据。第一次强令 AI 补验证；若它再次
        // 返回 done 仍无验证，判定失败而非放行（旧逻辑放行 = 可绕过）。
        if (!hasVerify) {
          if (!verifyAsked) {
            verifyAsked = true;
            continue;
          }
          set({
            agentStatus: "failed",
            agentError: "AI 宣称完成但未提供验证结果，任务中止。请人工核对目标状态。",
          });
          audit("failed");
          return;
        }
        set({ agentStatus: "done" });
        audit("done");
        return;
      }
      if (step.action === "giveup") {
        set({ agentStatus: "failed", agentError: step.reason || step.summary || "Agent 无法完成该目标" });
        audit("failed");
        return;
      }
      const command = step.command || "";
      if (!command) {
        set({ agentStatus: "failed", agentError: "Agent 返回了空命令" });
        return;
      }
      const kind: "exec" | "verify" = step.action === "verify" ? "verify" : "exec";

      // 2. Local risk grading (AI hint NOT trusted — PRD §5.5). A grader
      // failure must NOT hang the loop unhandled — degrade to YELLOW.
      let assessment: RiskAssessment;
      try {
        assessment = await ipc.assessRisk(command, step.riskHint || "read");
      } catch (e) {
        assessment = { level: "yellow", rule: "grader-error", reason: "本地分级器异常，按中风险处理" };
      }
      if (!alive()) return;
      const autoGreen = cfg?.autoGreen ?? true;
      let ok = assessment.level === "green" && autoGreen;

      // 3. Yellow/red (or auto-green off): wait for user approval.
      if (!ok) {
        set({
          agentStatus: "waiting",
          agentApproval: { command, description: step.description || "", level: assessment.level },
        });
        ok = await new Promise<boolean>((resolve) => set({ _agentResolve: resolve } as Partial<Store>));
        if (get().agentStatus === "stopped") return;
        set({ agentApproval: null, agentStatus: "running" });
        if (!ok) {
          set({ agentStatus: "stopped", agentError: "你拒绝了该命令，任务已停止" });
          return;
        }
      }

      // 4. Execute on the separate oneshot channel (timeout from settings).
      let output = "";
      try {
        output = await ipc.execOneshot(st.sessionId, command, execTimeout);
      } catch (e) {
        set((s) => ({
          agentSteps: [...s.agentSteps, { no: i, command, description: step.description || "", output: String(e), risk: assessment.level, kind }],
          agentStatus: "failed",
          agentError: `第 ${i} 步执行失败: ${String(e)}`,
        }));
        audit("failed");
        return;
      }
      if (get().agentStatus !== "running") return;
      set((s) => ({
        agentSteps: [
          ...s.agentSteps,
          {
            no: i,
            command,
            description: step.action === "verify" ? `${step.description || "验证"}${step.expect ? `（预期: ${step.expect}）` : ""}` : step.description || "",
            output: output.slice(-1600),
            risk: assessment.level,
            kind,
          },
        ],
      }));
    }
    set({ agentStatus: "failed", agentError: `已达最大步数（${MAX_STEPS} 步），任务未完成，可检查后重试` });
    audit("failed");
  },
  stopAgent: () => {
    const resolve = get()._agentResolve;
    set({ agentStatus: "stopped", agentApproval: null, _agentResolve: null });
    resolve?.(false);
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
    // network bytes (all non-lo IFs) / root-disk sectors read+written.
    const probe =
      "echo @MEM; free -b | awk 'NR==2{print $2\" \"$3\" \"$7}'; " +
      "echo @SWAP; free -b | awk 'NR==3{print $2\" \"$3}'; " +
      "echo @DISK; df -B1 / | awk 'NR==2{print $2\" \"$3}'; " +
      "echo @NET; awk 'NR>2 && $1!=\"lo:\" {rx+=$2; tx+=$10} END{print rx+0\" \"tx+0}' /proc/net/dev; " +
      "echo @DISKIO; d=$(df / | tail -1 | awk '{print $1}' | sed 's|.*/||'); " +
      "line=$(awk -v d=\"$d\" '$3==d{print $6\" \"$10; exit}' /proc/diskstats); " +
      "[ -z \"$line\" ] && line=$(awk -v d=\"${d%%[0-9]*}\" '$3==d{print $6\" \"$10; exit}' /proc/diskstats); " +
      "echo \"$line\"; " +
      "echo @LOAD; cut -d' ' -f1-3 /proc/loadavg; " +
      "echo @CORES; nproc 2>/dev/null || echo 1; " +
      "echo @UPTIME; uptime -p 2>/dev/null | sed 's/^up //'";
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
