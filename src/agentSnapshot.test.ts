import { describe, expect, it } from "vitest";
import { EMPTY_MEMORY, isCardVisible, isTerminal, toView } from "./agentSnapshot";
import type { AgentRunSnapshot, AgentRunStatus } from "./types";

function snap(over: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    runId: 7,
    sessionId: 3,
    goal: "检查 nginx 状态",
    status: "running",
    plan: null,
    steps: [],
    memory: EMPTY_MEMORY,
    error: "",
    notice: "",
    approval: null,
    ...over,
  };
}

describe("toView", () => {
  it("projects every field of a snapshot", () => {
    const v = toView(
      snap({
        status: "waiting",
        goal: "重启服务",
        steps: [
          {
            no: 1,
            command: "systemctl status nginx",
            description: "查看状态",
            output: "active",
            risk: "green",
            kind: "exec",
          },
        ],
        error: "",
        notice: "有 1 个步骤未执行",
        plan: { steps: [] },
      }),
    );
    expect(v.status).toBe("waiting");
    expect(v.goal).toBe("重启服务");
    expect(v.steps).toHaveLength(1);
    expect(v.steps[0].command).toBe("systemctl status nginx");
    expect(v.notice).toBe("有 1 个步骤未执行");
    expect(v.plan).not.toBeNull();
    expect(v.runId).toBe(7);
  });

  it("treats a missing collection as empty, never as undefined", () => {
    // A snapshot that arrives mid-write must not be able to crash the card.
    const v = toView({
      runId: 1,
      sessionId: 1,
      goal: "g",
      status: "running",
    } as unknown as AgentRunSnapshot);
    expect(v.steps).toEqual([]);
    expect(v.approval).toBeNull();
    expect(v.plan).toBeNull();
    expect(v.memory).toEqual(EMPTY_MEMORY);
    expect(v.error).toBe("");
    expect(v.notice).toBe("");
  });

  it("keeps the approval request intact", () => {
    const v = toView(
      snap({
        status: "waiting",
        approval: {
          command: "rm -rf /tmp/x",
          description: "删除临时目录",
          level: "red",
          fullText: "rm -rf /tmp/x",
          host: "10.0.0.4",
        },
      }),
    );
    expect(v.approval?.command).toBe("rm -rf /tmp/x");
    expect(v.approval?.level).toBe("red");
    expect(v.approval?.host).toBe("10.0.0.4");
  });
});

describe("isTerminal", () => {
  it("recognises the three terminal states", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("stopped")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("waiting")).toBe(false);
  });
});

describe("isCardVisible", () => {
  const cases: { status: AgentRunStatus; dismissed: number | null; visible: boolean }[] = [
    // Nothing dismissed → always visible.
    { status: "running", dismissed: null, visible: true },
    { status: "done", dismissed: null, visible: true },
    // Dismissed AND still running → hidden (the task keeps going in the
    // backend, the user just does not want to look at it).
    { status: "running", dismissed: 7, visible: false },
    // Dismissed but the agent needs the user → must come back.
    { status: "waiting", dismissed: 7, visible: true },
    // Dismissed but the task ended → the result must be shown.
    { status: "done", dismissed: 7, visible: true },
    { status: "failed", dismissed: 7, visible: true },
    { status: "stopped", dismissed: 7, visible: true },
  ];

  for (const c of cases) {
    it(`${c.status} with dismissed=${String(c.dismissed)} → ${c.visible ? "visible" : "hidden"}`, () => {
      expect(isCardVisible(c.status, 7, c.dismissed)).toBe(c.visible);
    });
  }

  it("hides everything when there is no run", () => {
    expect(isCardVisible("running", 0, null)).toBe(false);
    expect(isCardVisible("done", 0, null)).toBe(false);
  });

  it("shows a different run even when another one was dismissed", () => {
    expect(isCardVisible("running", 8, 7)).toBe(true);
  });
});
