// The UI's projection of a backend agent run.
//
// The controller lives in the Rust backend (see src-tauri/src/agent_runner.rs).
// Everything the Agent card shows comes from a snapshot the backend pushes;
// the frontend never decides anything about the remote machine.
//
// This module holds the two pieces of logic the UI still owns:
//   1. how a snapshot becomes view state, and
//   2. when the card is visible (the user may dismiss a running task, but
//      a pending approval or a finished result must never stay hidden).
//
// Both are pure functions so they can be unit-tested without a Tauri runtime.

import type {
  AgentApproval,
  AgentMemory,
  AgentPlan,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStepRecord,
} from "./types";

/** The Agent card's view of one run. */
export interface AgentView {
  status: AgentRunStatus;
  goal: string;
  steps: AgentStepRecord[];
  approval: AgentApproval | null;
  error: string;
  notice: string;
  plan: AgentPlan | null;
  memory: AgentMemory;
  runId: number;
}

/** The empty work memory — used before the first snapshot arrives. */
export const EMPTY_MEMORY: AgentMemory = {
  cwd: "",
  facts: [],
  hypotheses: [],
  failedAttempts: [],
};

/**
 * Project a backend snapshot into the view.
 *
 * Every field is read defensively: a snapshot that arrives mid-write (or
 * from an older backend) must not be able to crash the UI, and a missing
 * collection must render as "empty", never as `undefined`.
 */
export function toView(snap: AgentRunSnapshot): AgentView {
  return {
    status: snap.status,
    goal: snap.goal ?? "",
    steps: snap.steps ?? [],
    approval: snap.approval ?? null,
    error: snap.error ?? "",
    notice: snap.notice ?? "",
    plan: snap.plan ?? null,
    memory: snap.memory ?? EMPTY_MEMORY,
    runId: snap.runId ?? 0,
  };
}

/** Is this a terminal status? */
export function isTerminal(status: AgentRunStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

/**
 * Should the Agent card be on screen?
 *
 * `dismissedRunId` is the run the user closed. Closing a card only hides
 * it — the task keeps running in the backend, which is the whole point of
 * moving the controller there. But:
 *
 *   * a pending APPROVAL must always be visible (the task is blocked on the
 *     user; hiding it would strand the run), and
 *   * a FINISHED run must show its result (the outcome is the answer to
 *     the question the user asked).
 *
 * A different run id means a new task, which is never hidden.
 */
export function isCardVisible(
  status: AgentRunStatus,
  runId: number,
  dismissedRunId: number | null,
): boolean {
  if (!runId) return false;
  if (dismissedRunId !== runId) return true;
  return status === "waiting" || isTerminal(status);
}
