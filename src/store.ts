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
  ProviderProfile,
  ProviderSpec,
  RiskAssessment,
} from "./types";

export type ConnStatus = "disconnected" | "connecting" | "connected" | "closed" | "error";

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
      cards: [card, ...s.cards],
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
          ? { ...c, streaming: false, result: payload.result, provider: payload.provider, model: payload.model }
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
}));
