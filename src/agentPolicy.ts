// Pure decision logic for the Agent workflow.
//
// Everything here is a FUNCTION OF ITS INPUTS — no I/O, no store access, no
// React. The controller in `store.ts` owns the side effects; this module owns
// the rules, so the rules can be unit-tested (the defects that broke the
// agent loop — a dead authorization branch, an unbounded "done" loop, an
// unknown exit code counted as success — all lived in inline expressions
// that no test could reach).

/** Authorization scope for write operations. */
export type AgentPolicy = "readonly" | "plan" | "step";

export type RiskLevel = "green" | "yellow" | "red";

/** Machine-checkable expectation for one plan step. */
export interface ExpectSpecLike {
  exitCode?: number | null;
  contains?: string[];
  notContains?: string[];
  regex?: string | null;
}

/** One planned step (the subset this module needs). */
export interface PlanStepLike {
  id: number;
  intent: string;
  command: string;
  expect: ExpectSpecLike;
  riskHint: string;
  dependsOn: number[];
  /**
   * Acceptance criterion: "task done" requires EVERY required step's
   * assertions to pass.
   */
  required?: boolean;
}

/** One executed step fed back to the model. */
export interface StepHistoryLike {
  command: string;
  output: string;
  kind: string;
  description: string;
  expect: string;
  verified?: boolean | null;
  exitCode?: number | null;
  failures?: string[];
}

// ---------------------------------------------------------------------------
// Assertion strength
// ---------------------------------------------------------------------------

/** True when a spec carries at least one machine-checkable field. */
export function isAssertive(e?: ExpectSpecLike | null): boolean {
  return (
    !!e &&
    ((e.exitCode !== null && e.exitCode !== undefined) ||
      (e.contains?.length ?? 0) > 0 ||
      (e.notContains?.length ?? 0) > 0 ||
      !!e.regex)
  );
}

// ---------------------------------------------------------------------------
// Policy layer
// ---------------------------------------------------------------------------

/**
 * Does the "approve the whole plan" gate still have to be shown?
 *
 * The gate must be reachable EXACTLY once, when the user has not approved
 * yet. Deriving `planApproved` from the policy itself made this predicate
 * permanently false, so the "批准计划" scope silently behaved like "逐条确认".
 */
export function isPlanApprovalRequired(policy: AgentPolicy, planApproved: boolean): boolean {
  return policy === "plan" && !planApproved;
}

/**
 * May this command run WITHOUT asking the user?
 *
 * Two independent ways to be unattended: a green (read-only) command when
 * auto-green is on, or a command that belongs to the plan the user already
 * approved.
 */
export function mayRunUnattended(
  level: RiskLevel,
  autoGreen: boolean,
  inApprovedPlan: boolean,
  planApproved: boolean,
): boolean {
  return (level === "green" && autoGreen) || (inApprovedPlan && planApproved);
}

// ---------------------------------------------------------------------------
// Verifier layer — the acceptance verdict
// ---------------------------------------------------------------------------

/**
 * Which plan steps are the acceptance criteria?
 *
 * The planner marks the step that verifies the GOAL itself with
 * `required: true`. A required step WITHOUT an assertion is unusable (it
 * could never be satisfied), so it is filtered out. When the planner marks
 * nothing, fall back to the LAST assertive step of the plan.
 */
export function resolveAcceptanceIds(steps: PlanStepLike[]): number[] {
  const marked = steps.filter((s) => s.required && isAssertive(s.expect)).map((s) => s.id);
  if (marked.length > 0) return marked;
  const fallback = [...steps].reverse().find((s) => isAssertive(s.expect));
  return fallback ? [fallback.id] : [];
}

export interface AcceptanceState {
  /** Required steps whose assertions passed. */
  passedStepIds: number[];
  /** The reactive phase produced a passing re-check of the goal. */
  reactiveVerified: boolean;
  /** stepNo of the most recent PASSING verification. */
  lastPassAt: number;
  /** stepNo of the most recent FAILED step. */
  lastFailAt: number;
}

/**
 * Is the goal demonstrably achieved?
 *
 * Three conditions, all required:
 *  1. there IS something to prove against (no assertion → no verdict);
 *  2. the evidence is FRESH — a verification that happened BEFORE the last
 *     failure proves nothing (the failed step may have undone it);
 *  3. either every required step passed, or the reactive phase produced a
 *     fresh passing verification.
 */
export function isAcceptanceSatisfied(
  acceptanceIds: number[],
  state: AcceptanceState,
): boolean {
  if (acceptanceIds.length === 0) return false;
  if (state.lastFailAt >= 0 && state.lastPassAt <= state.lastFailAt) return false;
  if (state.reactiveVerified) return true;
  return acceptanceIds.every((id) => state.passedStepIds.includes(id));
}

// ---------------------------------------------------------------------------
// Executor layer
// ---------------------------------------------------------------------------

/**
 * Did this step actually succeed?
 *
 * `exitCode === null` means "we never learned the exit code" (timeout, or
 * the shell died before the command ran). It is NOT success: a command that
 * never executed must never satisfy a dependency. `pty` steps have no exit
 * code by nature — the user's terminal judges them — so they count as
 * executed.
 */
export function stepSucceeded(
  kind: "exec" | "verify" | "pty",
  verified: boolean | undefined,
  exitCode: number | null,
): boolean {
  if (kind === "verify") return verified === true;
  if (kind === "pty") return true;
  return exitCode === 0;
}

export interface PickResult<T> {
  /** The next runnable step, or null when the plan is blocked/finished. */
  pick: T | null;
  /** Steps dropped because one of their dependencies can never succeed. */
  skipped: T[];
}

/**
 * Pick the next runnable planned step, respecting `depends_on`.
 *
 * A step whose dependency failed (or was itself skipped) can never run →
 * it is dropped and reported, not silently ignored.
 */
export function pickRunnableStep<T extends { id: number; dependsOn: number[] }>(
  queue: T[],
  doneIds: Set<number>,
  failedIds: Set<number>,
  skippedIds: Set<number>,
): PickResult<T> {
  const skipped: T[] = [];
  const remaining = [...queue];
  for (let i = 0; i < remaining.length; i++) {
    const s = remaining[i];
    // A step that already ran (or already failed) is not a candidate any
    // more — the queue may still carry it, the outcome set is the truth.
    if (doneIds.has(s.id) || failedIds.has(s.id)) {
      remaining.splice(i, 1);
      i--;
      continue;
    }
    const depsFailed = s.dependsOn.some((d) => skippedIds.has(d) || failedIds.has(d));
    if (depsFailed) {
      skippedIds.add(s.id);
      skipped.push(s);
      remaining.splice(i, 1);
      i--;
      continue;
    }
    if (s.dependsOn.every((d) => doneIds.has(d))) {
      return { pick: s, skipped };
    }
  }
  return { pick: null, skipped };
}

// ---------------------------------------------------------------------------
// Controller layer — budgets and stop conditions
// ---------------------------------------------------------------------------

/**
 * Is the task over budget?
 *
 * A step budget alone is not a stop condition: some paths (a model that
 * keeps claiming "done") never consume a step, so they need their own
 * ceiling.
 */
export function isOverBudget(
  llmCalls: number,
  maxCalls: number,
  elapsedMs: number,
  maxWallMs: number,
): boolean {
  return llmCalls >= maxCalls || elapsedMs > maxWallMs;
}

/**
 * Judge a model's claim that the task is done.
 *
 * A claim without fresh evidence is not accepted — the model is pushed back
 * towards a verification step. But that pushback consumes no step, so it
 * needs its own counter: without it the loop could run forever.
 */
export function judgeDoneClaim(
  acceptanceSatisfied: boolean,
  unprovenDone: number,
  maxUnprovenDone: number,
): { accept: boolean; requireVerification: boolean; abort: boolean } {
  if (acceptanceSatisfied) {
    return { accept: true, requireVerification: false, abort: false };
  }
  const next = unprovenDone + 1;
  if (next >= maxUnprovenDone) {
    return { accept: false, requireVerification: true, abort: true };
  }
  return { accept: false, requireVerification: true, abort: false };
}

/**
 * Keep the history handed back to the model inside a char budget.
 *
 * The newest steps are kept in full, the oldest ones are dropped. Without
 * this the prompt grows O(n²) and eventually overflows the model's context
 * window — the task then dies with an opaque "replan failed".
 */
export function trimHistory<T extends StepHistoryLike>(list: T[], budget: number): T[] {
  if (list.length <= 2) return list;
  const kept: T[] = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const cost = s.command.length + s.output.length + s.description.length + 80;
    if (total + cost > budget && kept.length >= 2) break;
    kept.unshift(s);
    total += cost;
  }
  return kept;
}
