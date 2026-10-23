// Regression tests for the Agent workflow's decision logic.
//
// Every test here corresponds to a defect that actually broke the agent
// loop (see AGENT-WORKFLOW-REVIEW.md). They are pure-function tests: no
// store, no Tauri, no network.

import { describe, expect, it } from "vitest";
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
  type PlanStepLike,
  type StepHistoryLike,
} from "./agentPolicy";

const step = (over: Partial<PlanStepLike> = {}): PlanStepLike => ({
  id: 1,
  intent: "",
  command: "cmd",
  expect: { exitCode: 0 },
  riskHint: "read",
  dependsOn: [],
  ...over,
});

describe("F1 · the 「批准计划」 authorization scope must be reachable", () => {
  it("asks for the plan approval exactly once, in the plan scope", () => {
    expect(isPlanApprovalRequired("plan", false)).toBe(true);
    expect(isPlanApprovalRequired("plan", true)).toBe(false);
    // The other scopes never show the plan dialog.
    expect(isPlanApprovalRequired("readonly", false)).toBe(false);
    expect(isPlanApprovalRequired("step", false)).toBe(false);
  });

  it("runs plan commands unattended ONLY after the user approved the plan", () => {
    // Before approval, an approved-plan command still needs confirmation.
    expect(mayRunUnattended("yellow", true, true, false)).toBe(false);
    // After approval it runs unattended.
    expect(mayRunUnattended("yellow", true, true, true)).toBe(true);
    // A command OUTSIDE the plan never benefits from the plan approval.
    expect(mayRunUnattended("yellow", true, false, true)).toBe(false);
    // Green commands run unattended when auto-green is on.
    expect(mayRunUnattended("green", true, false, false)).toBe(true);
    expect(mayRunUnattended("green", false, false, false)).toBe(false);
  });
});

describe("F2 · a model claiming 「done」 without proof must not loop forever", () => {
  it("accepts the claim only when the acceptance criteria are satisfied", () => {
    expect(judgeDoneClaim(true, 0, 3).accept).toBe(true);
    expect(judgeDoneClaim(false, 0, 3).accept).toBe(false);
  });

  it("pushes the model back to verification while it stays below the cap", () => {
    const v = judgeDoneClaim(false, 0, 3);
    expect(v.requireVerification).toBe(true);
    expect(v.abort).toBe(false);
  });

  it("aborts once the unproven-「done」 cap is reached", () => {
    // 3rd unproven claim → abort (never an unbounded loop).
    expect(judgeDoneClaim(false, 2, 3).abort).toBe(true);
    expect(judgeDoneClaim(false, 1, 3).abort).toBe(false);
  });
});

describe("F4 · an unknown exit code is not success", () => {
  it("treats a null exit code as failure", () => {
    expect(stepSucceeded("exec", undefined, null)).toBe(false);
    expect(stepSucceeded("exec", undefined, 0)).toBe(true);
    expect(stepSucceeded("exec", undefined, 1)).toBe(false);
  });

  it("judges verify steps by their assertions, not by the exit code", () => {
    expect(stepSucceeded("verify", true, 0)).toBe(true);
    expect(stepSucceeded("verify", false, 0)).toBe(false);
    expect(stepSucceeded("verify", undefined, 0)).toBe(false);
  });

  it("treats a pty step as executed (it has no exit code)", () => {
    expect(stepSucceeded("pty", undefined, null)).toBe(true);
  });
});

describe("F6 · 「done」 must be backed by evidence about the GOAL", () => {
  it("uses the step the planner marked as required", () => {
    const steps = [
      step({ id: 1, expect: { exitCode: 0 } }),
      step({ id: 2, expect: { exitCode: 0, contains: ["nginx"] }, required: true }),
      step({ id: 3, expect: { exitCode: 0 } }),
    ];
    expect(resolveAcceptanceIds(steps)).toEqual([2]);
  });

  it("falls back to the last assertive step when the planner marks none", () => {
    const steps = [
      step({ id: 1, expect: { exitCode: 0 } }),
      step({ id: 2, expect: { exitCode: 0, contains: ["nginx"] } }),
    ];
    expect(resolveAcceptanceIds(steps)).toEqual([2]);
  });

  it("ignores a required step that carries no assertion (unsatisfiable)", () => {
    const steps = [
      step({ id: 1, expect: {}, required: true }),
      step({ id: 2, expect: { exitCode: 0 }, required: true }),
    ];
    expect(resolveAcceptanceIds(steps)).toEqual([2]);
  });

  it("rejects the claim when no assertion exists at all", () => {
    expect(resolveAcceptanceIds([step({ id: 1, expect: {} })])).toEqual([]);
    expect(
      isAcceptanceSatisfied([], {
        passedStepIds: [],
        reactiveVerified: true,
        lastPassAt: 1,
        lastFailAt: -1,
      }),
    ).toBe(false);
  });

  it("requires EVERY required step to pass", () => {
    const ids = [1, 2];
    expect(
      isAcceptanceSatisfied(ids, {
        passedStepIds: [1, 2],
        reactiveVerified: false,
        lastPassAt: 2,
        lastFailAt: -1,
      }),
    ).toBe(true);
    expect(
      isAcceptanceSatisfied(ids, {
        passedStepIds: [1],
        reactiveVerified: false,
        lastPassAt: 1,
        lastFailAt: -1,
      }),
    ).toBe(false);
  });

  it("rejects STALE evidence — a verification that predates the last failure", () => {
    expect(
      isAcceptanceSatisfied([1], {
        passedStepIds: [1],
        reactiveVerified: false,
        lastPassAt: 2,
        lastFailAt: 5,
      }),
    ).toBe(false);
    // The same evidence, but produced AFTER the failure, is accepted.
    expect(
      isAcceptanceSatisfied([1], {
        passedStepIds: [1],
        reactiveVerified: false,
        lastPassAt: 7,
        lastFailAt: 5,
      }),
    ).toBe(true);
  });

  it("accepts a fresh reactive re-check that replaces a failed required step", () => {
    expect(
      isAcceptanceSatisfied([1], {
        passedStepIds: [],
        reactiveVerified: true,
        lastPassAt: 9,
        lastFailAt: 3,
      }),
    ).toBe(true);
  });

  it("knows an empty assertion is not evidence", () => {
    expect(isAssertive({})).toBe(false);
    expect(isAssertive({ exitCode: 0 })).toBe(true);
    expect(isAssertive({ contains: ["x"] })).toBe(true);
    expect(isAssertive({ notContains: ["x"] })).toBe(true);
    expect(isAssertive({ regex: "x" })).toBe(true);
  });
});

describe("F10 · a step that can never run must be reported, not swallowed", () => {
  it("runs a step whose dependencies are satisfied", () => {
    const queue = [step({ id: 1 }), step({ id: 2, dependsOn: [1] })];
    const done = new Set([1]);
    const r = pickRunnableStep(queue, done, new Set(), new Set());
    expect(r.pick?.id).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it("drops a step whose dependency failed and reports it", () => {
    const queue = [step({ id: 1 }), step({ id: 2, dependsOn: [1] })];
    const skipped = new Set<number>();
    const r = pickRunnableStep(queue, new Set(), new Set([1]), skipped);
    expect(r.pick).toBeNull();
    expect(r.skipped.map((s) => s.id)).toEqual([2]);
    expect(skipped.has(2)).toBe(true);
  });

  it("returns null when nothing is runnable any more", () => {
    const queue = [step({ id: 1, dependsOn: [99] })];
    const r = pickRunnableStep(queue, new Set(), new Set(), new Set());
    expect(r.pick).toBeNull();
  });
});

describe("P2-2 · the loop needs more than a step budget", () => {
  it("stops when the model-call budget is exhausted", () => {
    expect(isOverBudget(40, 40, 0, 60_000)).toBe(true);
    expect(isOverBudget(39, 40, 0, 60_000)).toBe(false);
  });

  it("stops when the wall-clock budget is exhausted", () => {
    expect(isOverBudget(0, 40, 61_000, 60_000)).toBe(true);
    expect(isOverBudget(0, 40, 59_000, 60_000)).toBe(false);
  });
});

describe("F8 · the replan history must stay inside a char budget", () => {
  const hist = (n: number, size: number): StepHistoryLike[] =>
    Array.from({ length: n }, (_, i) => ({
      command: `cmd${i}`,
      output: "x".repeat(size),
      kind: "exec",
      description: "",
      expect: "",
    }));

  it("keeps the newest steps and drops the oldest", () => {
    const list = hist(10, 500);
    const kept = trimHistory(list, 2000);
    expect(kept.length).toBeLessThan(10);
    expect(kept[kept.length - 1].command).toBe("cmd9");
    expect(kept[0].command).not.toBe("cmd0");
  });

  it("always keeps at least the two newest steps", () => {
    const kept = trimHistory(hist(10, 5000), 10);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept[kept.length - 1].command).toBe("cmd9");
  });

  it("leaves short histories untouched", () => {
    const list = hist(2, 10);
    expect(trimHistory(list, 100)).toBe(list);
  });
});
