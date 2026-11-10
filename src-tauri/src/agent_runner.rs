//! The Agent controller — the five-layer loop, running in the BACKEND.
//!
//! # Why this module exists
//!
//! The loop used to live in the frontend's `store.ts`. That had three
//! consequences that are unacceptable for a tool that executes commands on a
//! remote server:
//!
//! * **A page refresh killed the task.** The whole controller was renderer
//!   state; reloading the window threw away the run, its memory and its
//!   half-finished plan.
//! * **The audit trail was renderer-side.** The log was written by the UI, so
//!   it could be lost, forged or simply never written.
//! * **The approval handshake was a renderer Promise.** A UI that reloaded
//!   mid-approval left the backend with no way to learn the user's answer.
//!
//! Moving the loop here fixes all three: the controller now lives in the
//! Tauri backend process, so it survives a window reload; it writes its own
//! audit log; and it blocks on a `oneshot` channel that the UI answers with
//! a command.
//!
//! # Layering (unchanged from the frontend implementation)
//!
//! | Layer | Responsibility | Where |
//! |---|---|---|
//! | Planner | one model call produces the whole ordered plan | [`crate::ai::run_agent_plan`] |
//! | Policy | authorization scope decides what runs unattended | [`agent_policy`] |
//! | Executor | runs the plan on the persistent shell | [`crate::agent_shell`] |
//! | Verifier | Rust evaluates each step's assertions | [`crate::agent_plan::verify_expectation`] |
//! | State | cwd / facts / hypotheses / failed attempts feed back | [`AgentMemory`] |
//!
//! Every decision rule lives in [`agent_policy`] as a pure function so it
//! can be unit-tested without an SSH session or an LLM.

use crate::agent_plan::{verify_expectation, AgentPlan, ExpectSpec, PlanStep};
use crate::agent_policy::{self, AcceptanceState, AgentPolicy, RiskLevel, StepKind};
use crate::ai::{self, AgentStepIn, AgentStepOut};
use crate::provider::adapters::Usage;
use crate::provider::make_adapter;
use crate::safety::risk::RiskLevel as EngineRiskLevel;
use crate::state::AppState;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

// ---------------------------------------------------------------------------
// Budgets (C5: every autonomous loop needs a stop condition)
// ---------------------------------------------------------------------------

/// Maximum number of executed steps for one task.
pub const MAX_STEPS: u32 = 24;
/// Hard cap on model calls for ONE task (1 planner + N replans).
pub const MAX_LLM_CALLS: u32 = 40;
/// Wall-clock ceiling for the whole task.
pub const MAX_WALL_MS: u64 = 15 * 60 * 1000;
/// Char budget for the history handed back to the model on every replan.
pub const HISTORY_CHAR_BUDGET: usize = 24_000;
/// How many times a model may claim "done" without producing evidence.
pub const MAX_UNPROVEN_DONE: u32 = 3;
/// How many consecutive replan failures end the task.
pub const MAX_RECOVERY_FAILS: u32 = 8;
/// Token ceiling for ONE task (prompt + completion).
///
/// The call budget alone does not bound cost: a single call can carry a
/// huge prompt. This is the real money ceiling. It only applies when the
/// provider reports usage — providers that don't report it fall back to the
/// call budget.
pub const MAX_TOKENS: u32 = 400_000;

// ---------------------------------------------------------------------------
// Events pushed to the frontend
// ---------------------------------------------------------------------------

/// One step of the run, as rendered by the Agent card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    pub no: u32,
    pub command: String,
    pub description: String,
    pub output: String,
    pub risk: String,
    pub kind: String,
    /// Verifier verdict for this step (`None` = not asserted).
    pub verified: Option<bool>,
    /// Why the assertions failed.
    pub verify_failures: Option<Vec<String>>,
    /// Process exit code observed for this step.
    pub exit_code: Option<i32>,
}

/// The approval request shown to the user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub command: String,
    pub description: String,
    pub level: String,
    /// Full payload for a pty write (never truncated).
    pub full_text: Option<String>,
    /// Host the command will run on — the approval must say WHERE.
    pub host: String,
}

/// A pending approval, answered by `agent_approve`.
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub request: ApprovalRequest,
    /// `None` = the user rejected it.
    pub answer: Option<bool>,
}

/// Structured work memory fed back to the planner on every step.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemory {
    /// Live cwd of the agent's own shell.
    pub cwd: String,
    /// Facts confirmed by a passing assertion.
    pub facts: Vec<String>,
    /// Hypotheses that were ruled out (with the reason).
    pub hypotheses: Vec<String>,
    /// Attempts that failed (command + why).
    pub failed_attempts: Vec<String>,
}

/// The lifecycle state of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    /// Blocked waiting for the user's approval.
    Waiting,
    Done,
    Failed,
    Stopped,
}

/// The full snapshot of a run — everything the frontend renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: u64,
    pub session_id: u64,
    pub goal: String,
    pub status: RunStatus,
    pub plan: Option<AgentPlan>,
    pub steps: Vec<StepRecord>,
    pub memory: AgentMemory,
    pub error: String,
    /// Neutral note shown next to the result (skipped steps, budget warnings).
    pub notice: String,
    /// The approval the backend is currently blocked on.
    pub approval: Option<ApprovalRequest>,
    /// Tokens consumed so far, when the provider reports usage.
    ///
    /// Without this, "the agent made 12 calls" says nothing about what it
    /// cost. A task's real budget is tokens, not calls.
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// The event payload pushed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub run_id: u64,
    pub session_id: u64,
    pub snapshot: RunSnapshot,
}

/// Event name used for every agent-state change.
pub const EVENT_AGENT: &str = "agent-state";

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/// A live run, as seen from OUTSIDE the controller task.
///
/// The controller itself lives inside a spawned async task; this handle is
/// what the commands talk to (approve / cancel / snapshot).
pub struct AgentRun {
    pub run_id: u64,
    pub session_id: u64,
    /// Set by `agent_cancel_run`; the loop checks it between steps.
    pub cancelled: Arc<AtomicBool>,
    /// The approval the loop is blocked on, if any.
    pub pending: Arc<Mutex<Option<PendingApproval>>>,
    /// Latest snapshot, so a reloaded UI can reattach to a running task.
    pub snapshot: Arc<Mutex<RunSnapshot>>,
    /// Channel used to wake the loop when the user answers an approval.
    pub approval_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<bool>>>>,
}

impl AgentRun {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Registry of live runs, kept in the app state.
#[derive(Default)]
pub struct RunRegistry {
    runs: Mutex<HashMap<u64, Arc<AgentRun>>>,
    next_id: AtomicU64,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn insert(&self, run: Arc<AgentRun>) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.insert(run.run_id, run);
    }

    pub fn get(&self, run_id: u64) -> Option<Arc<AgentRun>> {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.get(&run_id).cloned()
    }

    /// Drop every run attached to a session (its previous task).
    ///
    /// Called when a NEW task starts on a session: the old controller is
    /// cancelled, and its handle is dropped so the registry does not grow
    /// without bound. A finished run is kept until the next task on the same
    /// session, so a reloaded UI can still read its result.
    pub fn remove_for_session(&self, session_id: u64) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<u64> = runs
            .values()
            .filter(|r| r.session_id == session_id)
            .map(|r| r.run_id)
            .collect();
        for id in stale {
            runs.remove(&id);
        }
    }

    /// The run attached to a session (a session hosts at most one agent task).
    pub fn for_session(&self, session_id: u64) -> Option<Arc<AgentRun>> {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.values()
            .find(|r| r.session_id == session_id && !r.is_cancelled())
            .cloned()
    }
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/// Everything the loop needs to talk to the outside world.
///
/// These are the seams that make the loop testable: the LLM calls, the
/// command execution and the approval handshake are all injected.
pub struct RunContext {
    pub session_id: u64,
    pub goal: String,
    pub host: String,
    pub profile_id: Option<String>,
    pub exec_timeout: u64,
    pub auto_green: bool,
    pub policy: AgentPolicy,
}

/// The model adapter, resolved ONCE per task.
///
/// Rebuilding it per model call meant re-reading the API key from the OS
/// Keychain (a real IPC round trip on Windows/macOS) and re-deriving the
/// provider profile for every single step. A task issues up to 40 model
/// calls, so this was 40 needless Keychain hits.
pub type RunAdapter = Box<dyn crate::provider::adapters::LLMProvider>;

/// Run one agent task to completion.
///
/// This is the whole five-layer loop. It never blocks the caller's thread and
/// never returns before the task reached a terminal state.
pub async fn run_agent_task(
    app: tauri::AppHandle,
    state: AppState,
    run: Arc<AgentRun>,
    ctx: RunContext,
) {
    let mut snapshot = RunSnapshot {
        run_id: run.run_id,
        session_id: ctx.session_id,
        goal: ctx.goal.clone(),
        status: RunStatus::Running,
        plan: None,
        steps: Vec::new(),
        memory: AgentMemory::default(),
        error: String::new(),
        notice: String::new(),
        approval: None,
        usage: None,
    };

    // The Planner needs the agent shell's LIVE cwd: the connect-time probe
    // ran in the USER'S PTY channel and never saw the agent's own `cd`.
    let mut agent_cwd = String::new();
    match crate::commands::exec_oneshot_inner(
        &state,
        ctx.session_id,
        "pwd",
        Some(10),
        Some("approved"),
    )
    .await
    {
        Ok(out) => {
            agent_cwd = out
                .trim()
                .split('\n')
                .filter(|l| !l.trim().is_empty())
                .next_back()
                .unwrap_or("")
                .trim()
                .to_string();
        }
        Err(_) => agent_cwd = String::new(),
    }
    if !agent_cwd.is_empty() {
        snapshot.memory.cwd = agent_cwd.clone();
    }

    let started = Instant::now();
    let mut llm_calls: u32 = 0;

    // Resolve the model adapter ONCE for the whole task. Rebuilding it per
    // call re-read the API key from the OS Keychain every time.
    let adapter: RunAdapter = match make_run_adapter(&state, ctx.profile_id.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Failed,
                &format!("{e}"),
            );
        }
    };

    // --- PLANNER ---------------------------------------------------------
    llm_calls += 1;
    let plan: AgentPlan = match call_plan(&state, &ctx, adapter.as_ref(), &agent_cwd).await {
        Ok((p, u)) => {
            if let Some(u) = u {
                snapshot.usage = Some(u);
            }
            p
        }
        Err(e) => {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Failed,
                &format!("规划失败：{e}"),
            );
        }
    };
    if plan.steps.is_empty() {
        return finish(
            &app,
            &state,
            &run,
            &mut snapshot,
            RunStatus::Failed,
            "AI 未产出可执行的计划",
        );
    }
    snapshot.plan = Some(plan.clone());
    publish(&app, &run, &snapshot);

    // --- POLICY: the whole-plan approval gate ---------------------------
    // `plan_approved` is set ONLY by the user's explicit approval below.
    // It used to be initialised from the policy itself, which made the
    // approval branch unreachable — the "批准计划" scope then behaved
    // exactly like "逐条确认".
    let mut plan_approved = false;
    let mut approved_commands: HashSet<String> = HashSet::new();

    if agent_policy::is_plan_approval_required(ctx.policy, plan_approved) {
        let summary = plan
            .steps
            .iter()
            .map(|s| {
                let tag = if s.required {
                    " 〔验收步骤〕"
                } else {
                    ""
                };
                format!(
                    "{}. {}{}\n     $ {}",
                    s.id,
                    if s.intent.trim().is_empty() {
                        "（未说明意图）"
                    } else {
                        s.intent.trim()
                    },
                    tag,
                    s.command
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let request = ApprovalRequest {
            command: format!("【执行计划】共 {} 步\n{}", plan.steps.len(), summary),
            description: "批准后，计划内的命令将不再逐条询问；标记为〔验收步骤〕的步骤断言全部通过才算任务完成。".to_string(),
            level: "yellow".to_string(),
            full_text: None,
            host: ctx.host.clone(),
        };
        let ok = match request_approval(&app, &run, &mut snapshot, request).await {
            Some(v) => v,
            None => {
                // Cancelled while waiting for the answer.
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Stopped,
                    "你未批准该计划，任务已停止",
                );
            }
        };
        if !ok {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Stopped,
                "你未批准该计划，任务已停止",
            );
        }
        plan_approved = true;
        for s in &plan.steps {
            approved_commands.insert(s.command.clone());
        }
    }

    // --- Executor state ---------------------------------------------------
    let mut step_no: u32 = 0;
    let mut verified_count: u32 = 0;
    let mut assert_count: u32 = 0;
    let mut executed: Vec<AgentStepIn> = Vec::new();
    let mut acceptance_state = AcceptanceState {
        passed_step_ids: HashSet::new(),
        reactive_passed_ids: HashSet::new(),
        last_pass_at: -1,
        last_fail_at: -1,
    };
    let acceptance_ids = agent_policy::resolve_acceptance_ids(
        &plan
            .steps
            .iter()
            .map(|s| {
                (
                    s.id,
                    s.required,
                    // Only a step with a POSITIVE output assertion can be an
                    // acceptance criterion. `{"required":true,"command":
                    // "true","expect":{"exit_code":0}}` used to slip through
                    // and mark the whole task Done without checking anything.
                    agent_policy::is_goal_assertive(Some(&s.expect)),
                )
            })
            .collect::<Vec<_>>(),
    );
    // The commands the planner promised as the goal's proof. A reactive
    // verification only counts as goal evidence when it re-runs one of
    // these (see `verify_is_goal_evidence`) — this is what stops the model
    // from laundering a failed run with `true` + `expect:{exit_code:0}`.
    // Keep the step id alongside the command so a re-check can credit ONLY
    // the criterion it actually re-proved.
    let acceptance_pairs: Vec<(u32, String)> = plan
        .steps
        .iter()
        .filter(|s| acceptance_ids.contains(&s.id))
        .map(|s| (s.id, s.command.clone()))
        .collect();
    let acceptance_commands: Vec<String> = acceptance_pairs
        .iter()
        .map(|(_, c)| c.clone())
        .collect();

    // ---- Phase 1: execute the Planner's plan, respecting depends_on ----
    let mut done_ids: HashSet<u32> = HashSet::new();
    let mut failed_ids: HashSet<u32> = HashSet::new();
    let mut skipped_ids: HashSet<u32> = HashSet::new();
    let mut queue: Vec<PlanStep> = plan.steps.clone();
    let mut mode_reactive = false;

    while !mode_reactive {
        if step_no >= MAX_STEPS {
            break;
        }
        if run.is_cancelled() {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Stopped,
                "任务已停止",
            );
        }
        let picked = agent_policy::pick_runnable_step(
            &queue,
            &done_ids,
            &failed_ids,
            &mut skipped_ids,
            |s| s.id,
            |s| s.depends_on.clone(),
        );
        // Steps dropped because a dependency can never succeed are REPORTED,
        // not silently swallowed.
        if !picked.skipped.is_empty() {
            let drop: HashSet<u32> = picked.skipped.iter().map(|s| s.id).collect();
            queue.retain(|s| !drop.contains(&s.id));
        }
        let plan_step = match picked.pick {
            Some(s) => s,
            None => {
                // No more runnable planned steps. If a step actually failed,
                // switch to reactive replanning; otherwise the plan simply
                // finished (fall through to the final gate).
                mode_reactive = !failed_ids.is_empty();
                break;
            }
        };
        queue.retain(|s| s.id != plan_step.id);

        let kind = if agent_policy::is_assertive(Some(&plan_step.expect)) {
            StepKind::Verify
        } else {
            StepKind::Exec
        };
        let outcome = run_action(
            &app,
            &state,
            &run,
            &mut snapshot,
            &mut step_no,
            &mut verified_count,
            &mut assert_count,
            &mut executed,
            &mut acceptance_state,
            &ctx,
            &mut plan_approved,
            &approved_commands,
            &acceptance_pairs,
            Action {
                command: plan_step.command.clone(),
                expect: Some(plan_step.expect.clone()),
                kind,
                description: plan_step.intent.clone(),
                risk_hint: plan_step.risk_hint.clone(),
                note: None,
                expect_text: None,
            },
        )
        .await;

        match outcome {
            ActionOutcome::Stopped => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Stopped,
                    "任务已停止",
                );
            }
            ActionOutcome::Fatal => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    "通道在返回结果前断开：最后一条命令可能已在远端执行。为避免重复执行，任务已中止，请人工核实状态。",
                );
            }
            ActionOutcome::FatalTimeout => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    "写操作超时，远端可能仍在执行，任务已中止。请人工核实远端状态后再继续。",
                );
            }
            ActionOutcome::Ok { ok, verified } => {
                if ok {
                    done_ids.insert(plan_step.id);
                    // Phase 1 used to accept ANY verified==true on a required
                    // step, bypassing verify_is_goal_evidence entirely. Now
                    // the plan's own spec must carry a positive output
                    // assertion and the command must be one of the promised
                    // acceptance commands.
                    if verified == Some(true)
                        && acceptance_ids.contains(&plan_step.id)
                        && agent_policy::verify_is_goal_evidence(
                            Some(&plan_step.expect),
                            &plan_step.command,
                            &acceptance_commands,
                        )
                    {
                        acceptance_state.passed_step_ids.insert(plan_step.id);
                    }
                } else {
                    failed_ids.insert(plan_step.id);
                    mode_reactive = true; // reality diverged → let the model re-decide
                }
            }
        }
    }

    // If the plan ran but the acceptance criteria are NOT satisfied, let the
    // model add a verification step (self-correction) before we declare
    // failure.
    if !mode_reactive && !agent_policy::is_acceptance_satisfied(&acceptance_ids, &acceptance_state)
    {
        mode_reactive = true;
    }

    // ---- Phase 2: reactive replanning (observe → decide → act) ----
    let mut require_verification = false;
    let mut recovery_fails: u32 = 0;
    // This path never consumes a step, so MAX_STEPS does NOT protect it —
    // without this counter a model that keeps answering "done" would spin
    // here forever, burning one LLM call per iteration.
    let mut unproven_done: u32 = 0;

    while mode_reactive && step_no < MAX_STEPS {
        if run.is_cancelled() {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Stopped,
                "任务已停止",
            );
        }
        if agent_policy::is_over_budget(
            llm_calls,
            MAX_LLM_CALLS,
            started.elapsed().as_millis() as u64,
            MAX_WALL_MS,
        ) {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Failed,
                &format!(
                    "任务超出预算（模型调用 {llm_calls}/{MAX_LLM_CALLS} 次，用时 {}s），任务中止。请人工核对。",
                    started.elapsed().as_secs()
                ),
            );
        }
        // Token budget — the real cost ceiling. Only enforceable when the
        // provider reports usage.
        if let Some(u) = snapshot.usage {
            let total = u.total();
            if total > MAX_TOKENS {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    &format!(
                        "任务超出 token 预算（{total}/{MAX_TOKENS}），任务中止。请人工核对。"
                    ),
                );
            }
        }

        let goal_with_memory = agent_policy::build_goal_with_memory(
            &ctx.goal,
            &snapshot.memory.cwd,
            &snapshot.memory.facts,
            &snapshot.memory.hypotheses,
            &snapshot.memory.failed_attempts,
        );
        let history = agent_policy::trim_history(&executed, HISTORY_CHAR_BUDGET, |h| {
            h.command.len() + h.output.len() + h.description.len() + 80
        });

        llm_calls += 1;
        let out: AgentStepOut = match call_step(
            &state,
            &ctx,
            adapter.as_ref(),
            &agent_cwd,
            &goal_with_memory,
            &history,
            require_verification,
        )
        .await
        {
            Ok((o, u)) => {
                if let Some(u) = u {
                    snapshot.usage = Some(match snapshot.usage {
                        Some(prev) => Usage {
                            // Saturate, never wrap: a u32 overflow used to
                            // wrap the counter back to a small value and
                            // silently disable the MAX_TOKENS budget.
                            prompt_tokens: prev.prompt_tokens.saturating_add(u.prompt_tokens),
                            completion_tokens: prev
                                .completion_tokens
                                .saturating_add(u.completion_tokens),
                        },
                        None => u,
                    });
                }
                o
            }
            Err(e) => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    &format!("重规划失败：{e}"),
                );
            }
        };

        // Defensive: a stray/empty action must not become a blind exec.
        let has_command = out.action == "command" || out.action == "verify";
        if (out.action != "done" && out.action != "giveup" && out.action != "pty" && !has_command)
            || (has_command && out.command.as_deref().unwrap_or("").trim().is_empty())
        {
            recovery_fails += 1;
            if recovery_fails >= MAX_RECOVERY_FAILS {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    "重规划返回了无法执行的动作，任务中止。请人工核对。",
                );
            }
            continue;
        }

        if out.action == "done" {
            let acceptance_ok =
                agent_policy::is_acceptance_satisfied(&acceptance_ids, &acceptance_state);
            let verdict =
                agent_policy::judge_done_claim(acceptance_ok, unproven_done, MAX_UNPROVEN_DONE);
            if verdict.accept {
                return finish(&app, &state, &run, &mut snapshot, RunStatus::Done, "");
            }
            require_verification = verdict.require_verification;
            unproven_done += 1;
            if verdict.abort {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    &format!(
                        "模型连续 {unproven_done} 次声称任务完成，但始终没有通过验收断言，任务中止。请人工核对。"
                    ),
                );
            }
            continue;
        }

        if out.action == "giveup" {
            return finish(
                &app,
                &state,
                &run,
                &mut snapshot,
                RunStatus::Failed,
                &format!(
                    "Agent 放弃任务：{}",
                    out.reason
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "模型判断无法完成目标".to_string())
                ),
            );
        }

        if out.action == "pty" {
            let outcome = run_action(
                &app,
                &state,
                &run,
                &mut snapshot,
                &mut step_no,
                &mut verified_count,
                &mut assert_count,
                &mut executed,
                &mut acceptance_state,
                &ctx,
                &mut plan_approved,
                &approved_commands,
                &acceptance_pairs,
                Action {
                    command: out.keys.clone().unwrap_or_default(),
                    expect: None,
                    kind: StepKind::Pty,
                    description: out
                        .description
                        .clone()
                        .filter(|d| !d.trim().is_empty())
                        .unwrap_or_else(|| "终端交互操作".to_string()),
                    risk_hint: "write".to_string(),
                    note: None,
                    expect_text: None,
                },
            )
            .await;
            match outcome {
                ActionOutcome::Stopped => {
                    return finish(
                        &app,
                        &state,
                        &run,
                        &mut snapshot,
                        RunStatus::Stopped,
                        "任务已停止",
                    );
                }
                ActionOutcome::Fatal | ActionOutcome::FatalTimeout => {
                    return finish(
                        &app,
                        &state,
                        &run,
                        &mut snapshot,
                        RunStatus::Failed,
                        "任务已中止，请人工核实远端状态。",
                    );
                }
                ActionOutcome::Ok { ok, .. } => {
                    if !ok {
                        recovery_fails += 1;
                    }
                    continue;
                }
            }
        }

        // command | verify
        let is_verify = out.action == "verify";
        // The expectation must be a MACHINE-CHECKABLE spec. A plain-text
        // description ("至少5行软件包信息") can never be found in the output
        // by substring match, so it is NOT used as a needle.
        let spec: Option<ExpectSpec> = if is_verify {
            out.expect_spec.clone()
        } else {
            None
        };
        let note = if is_verify && spec.is_none() {
            Some(format!(
                "（本次 verify 未提供结构化断言 expect{}，无法机械校验；请在下一步返回 expect:{{\"exit_code\":0,\"contains\":[\"输出中会逐字出现的字面子串\"]}}）",
                out.expect_text
                    .as_ref()
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| format!("（只给了描述「{t}」）"))
                    .unwrap_or_default()
            ))
        } else {
            None
        };
        let outcome = run_action(
            &app,
            &state,
            &run,
            &mut snapshot,
            &mut step_no,
            &mut verified_count,
            &mut assert_count,
            &mut executed,
            &mut acceptance_state,
            &ctx,
            &mut plan_approved,
            &approved_commands,
            &acceptance_pairs,
            Action {
                command: out.command.clone().unwrap_or_default(),
                expect: spec,
                kind: if is_verify {
                    StepKind::Verify
                } else {
                    StepKind::Exec
                },
                description: out
                    .description
                    .clone()
                    .filter(|d| !d.trim().is_empty())
                    .unwrap_or_else(|| out.reasoning.clone().unwrap_or_default()),
                risk_hint: out
                    .risk_hint
                    .clone()
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| "read".to_string()),
                note,
                expect_text: out.expect_text.clone(),
            },
        )
        .await;
        match outcome {
            ActionOutcome::Stopped => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Stopped,
                    "任务已停止",
                );
            }
            ActionOutcome::Fatal | ActionOutcome::FatalTimeout => {
                return finish(
                    &app,
                    &state,
                    &run,
                    &mut snapshot,
                    RunStatus::Failed,
                    "任务已中止，请人工核实远端状态。",
                );
            }
            ActionOutcome::Ok { ok, .. } => {
                require_verification = false;
                // Goal evidence from a passing verify is recorded INSIDE
                // `run_action`, guarded by `verify_is_goal_evidence` — the
                // loop must not set `reactive_verified` on its own.
                if !ok {
                    recovery_fails += 1;
                }
                if recovery_fails >= MAX_RECOVERY_FAILS {
                    return finish(
                        &app,
                        &state,
                        &run,
                        &mut snapshot,
                        RunStatus::Failed,
                        "多次重规划仍未达成一致，任务中止。请人工核对状态。",
                    );
                }
            }
        }
    }

    // =====================================================================
    // Completion gate — a claim of success needs ACCEPTANCE EVIDENCE
    // =====================================================================
    // Skipped steps must never disappear silently.
    if !skipped_ids.is_empty() {
        let mut ids: Vec<u32> = skipped_ids.iter().copied().collect();
        ids.sort_unstable();
        snapshot.notice = format!(
            "有 {} 个计划步骤因依赖无法满足而未执行（步骤 {}），请核对计划。",
            ids.len(),
            ids.iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join("、")
        );
    }
    if assert_count == 0 {
        return finish(
            &app,
            &state,
            &run,
            &mut snapshot,
            RunStatus::Failed,
            "计划中没有可校验的验证步骤，无法确认目标是否达成，任务中止。请人工核对。",
        );
    }
    if verified_count == 0 {
        return finish(
            &app,
            &state,
            &run,
            &mut snapshot,
            RunStatus::Failed,
            "所有验证步骤的断言均未通过，无法确认目标已达成，任务中止。请人工核对。",
        );
    }
    if !agent_policy::is_acceptance_satisfied(&acceptance_ids, &acceptance_state) {
        let missing = acceptance_ids
            .iter()
            .filter(|id| !acceptance_state.passed_step_ids.contains(id))
            .count();
        return finish(
            &app,
            &state,
            &run,
            &mut snapshot,
            RunStatus::Failed,
            &format!(
                "验收步骤未全部通过（{}/{} 通过），无法确认目标已达成，任务中止。请人工核对。",
                acceptance_ids.len() - missing,
                acceptance_ids.len()
            ),
        );
    }
    finish(&app, &state, &run, &mut snapshot, RunStatus::Done, "")
}

// ---------------------------------------------------------------------------
// One action through policy → executor → verifier
// ---------------------------------------------------------------------------

/// What the loop asked the executor to do.
struct Action {
    command: String,
    expect: Option<ExpectSpec>,
    kind: StepKind,
    description: String,
    risk_hint: String,
    /// Advisory note for the model (never part of the verified payload).
    note: Option<String>,
    /// The model's own wording of the expectation (fed back to the model).
    expect_text: Option<String>,
}

/// The result of one action.
enum ActionOutcome {
    Ok {
        ok: bool,
        verified: Option<bool>,
    },
    /// The user cancelled.
    Stopped,
    /// The channel died after the bytes were handed over — the command may
    /// have executed, so replaying it would be unsafe.
    Fatal,
    /// A write command timed out — it may still be running remotely.
    FatalTimeout,
}

#[allow(clippy::too_many_arguments)]
async fn run_action(
    app: &tauri::AppHandle,
    state: &AppState,
    run: &Arc<AgentRun>,
    snapshot: &mut RunSnapshot,
    step_no: &mut u32,
    verified_count: &mut u32,
    assert_count: &mut u32,
    executed: &mut Vec<AgentStepIn>,
    acceptance_state: &mut AcceptanceState,
    ctx: &RunContext,
    plan_approved: &mut bool,
    approved_commands: &HashSet<String>,
    acceptance_pairs: &[(u32, String)],
    action: Action,
) -> ActionOutcome {
    *step_no += 1;
    if *step_no > MAX_STEPS {
        return ActionOutcome::Ok {
            ok: false,
            verified: None,
        };
    }
    let this_step = *step_no;

    // --- Policy: does this command need an individual confirmation? -----
    let assessment = state.risk.assess(&action.command, &action.risk_hint);
    let level = match assessment.level {
        EngineRiskLevel::Green => RiskLevel::Green,
        EngineRiskLevel::Yellow => RiskLevel::Yellow,
        EngineRiskLevel::Red => RiskLevel::Red,
    };

    if run.is_cancelled() {
        return ActionOutcome::Stopped;
    }

    // A step that never ran is still INFORMATION for the reactive planner:
    // it must see "this command was refused" instead of silently retrying.
    let record_refusal =
        |snapshot: &mut RunSnapshot, executed: &mut Vec<AgentStepIn>, reason: &str| {
            snapshot.steps.push(StepRecord {
                no: this_step,
                command: action.command.clone(),
                description: action.description.clone(),
                output: reason.to_string(),
                risk: level.as_str().to_string(),
                kind: action.kind.as_str().to_string(),
                verified: None,
                verify_failures: None,
                exit_code: None,
            });
            executed.push(AgentStepIn {
                command: action.command.clone(),
                output: reason.to_string(),
                kind: action.kind.as_str().to_string(),
                description: action.description.clone(),
                expect: action.expect_text.clone().unwrap_or_default(),
                verified: None,
                exit_code: None,
                failures: vec![],
            });
        };

    // RED = blacklist hit. The Rust gate refuses it unconditionally, so
    // asking the user "do you approve?" would offer a button that can only
    // fail. Refuse the step HERE and let the planner find another route.
    if matches!(level, RiskLevel::Red) {
        let reason = format!(
            "【已拒绝】命中黑名单规则「{}」——{}。该命令不会被执行，请换一种方式达成目标。",
            assessment.rule, assessment.reason
        );
        record_refusal(snapshot, executed, &reason);
        snapshot.memory.failed_attempts.push(format!(
            "{} → 命中黑名单「{}」，已拒绝执行",
            action.command, assessment.rule
        ));
        acceptance_state.last_fail_at = this_step as i64;
        publish(app, run, snapshot);
        return ActionOutcome::Ok {
            ok: false,
            verified: None,
        };
    }

    let in_approved_plan = approved_commands.contains(&action.command);
    if !agent_policy::may_run_unattended(level, ctx.auto_green, in_approved_plan, *plan_approved) {
        let request = ApprovalRequest {
            command: action.command.clone(),
            description: action.description.clone(),
            level: level.as_str().to_string(),
            full_text: if action.kind == StepKind::Pty {
                Some(action.command.clone())
            } else {
                None
            },
            host: ctx.host.clone(),
        };
        let ok = match request_approval(app, run, snapshot, request).await {
            Some(v) => v,
            None => return ActionOutcome::Stopped,
        };
        if !ok {
            return ActionOutcome::Stopped;
        }
    }
    if run.is_cancelled() {
        return ActionOutcome::Stopped;
    }

    // --- Idempotency: don't re-run what already verified ----------------
    // An identical command whose earlier run PASSED its assertion cannot
    // yield new information. Re-running it burns a remote execution, a
    // step and a round of model tokens for nothing. The earlier output is
    // replayed verbatim so the planner still sees the result.
    if action.kind == StepKind::Exec {
        let prior: Vec<(String, bool, String)> = executed
            .iter()
            .filter(|e| e.kind == StepKind::Exec.as_str())
            .map(|e| {
                (
                    e.command.clone(),
                    e.verified.unwrap_or(false),
                    e.output.clone(),
                )
            })
            .collect();
        if let agent_policy::IdempotencyVerdict::Skip { previous_output } =
            agent_policy::check_idempotent(&action.command, &prior)
        {
            let reason = format!(
                "【已跳过】命令与此前已通过断言的一次执行完全相同，结果不会改变。复用上次输出：\n{}",
                previous_output
            );
            snapshot.steps.push(StepRecord {
                no: this_step,
                command: action.command.clone(),
                description: action.description.clone(),
                output: reason.clone(),
                risk: level.as_str().to_string(),
                kind: action.kind.as_str().to_string(),
                // A SKIP executes nothing, so it must not manufacture a
                // passing assertion or an exit code. The old code wrote
                // verified:Some(true)/exit_code:Some(0) here, which was a
                // brand-new way to launder acceptance evidence without ever
                // touching the remote host.
                verified: None,
                verify_failures: None,
                exit_code: None,
            });
            executed.push(AgentStepIn {
                command: action.command.clone(),
                output: previous_output,
                kind: action.kind.as_str().to_string(),
                description: action.description.clone(),
                expect: action.expect_text.clone().unwrap_or_default(),
                verified: None,
                exit_code: None,
                failures: vec![],
            });
            snapshot.memory.facts.push(format!(
                "{} → 跳过重复执行（复用先前输出，本次未产生新证据）",
                action.command
            ));
            // Deliberately NOT touching last_pass_at / passed_step_ids: a
            // skipped step proves nothing new about the goal.
            publish(app, run, snapshot);
            return ActionOutcome::Ok {
                ok: true,
                verified: None,
            };
        }
    }

    // --- Executor: run it on the persistent shell ------------------------
    // `raw_output` is the command's own output; `output` additionally carries
    // the annotations that explain a non-zero exit / timeout to the MODEL.
    // The Verifier must judge the RAW payload.
    let mut output = String::new();
    let mut raw_output = String::new();
    let mut exit_code: Option<i32> = None;
    let mut maybe_executed = false;
    let mut timed_out = false;

    if action.kind == StepKind::Pty {
        match crate::commands::agent_pty_write_inner(
            state,
            ctx.session_id,
            &action.command,
            Some("approved"),
        )
        .await
        {
            Ok(_) => {
                raw_output =
                    crate::commands::read_screen_tail_inner(state, ctx.session_id, Some(30))
                        .await
                        .unwrap_or_default();
                output = raw_output.clone();
                if output.trim().is_empty() {
                    output = "（已写入终端，未捕获到可见输出）".to_string();
                }
            }
            Err(e) => {
                let reason = format!("【执行被拒/失败】{e}");
                record_refusal(snapshot, executed, &reason);
                snapshot
                    .memory
                    .failed_attempts
                    .push(format!("{} → {e}", action.command));
                acceptance_state.last_fail_at = this_step as i64;
                publish(app, run, snapshot);
                return ActionOutcome::Ok {
                    ok: false,
                    verified: None,
                };
            }
        }
    } else {
        match crate::commands::agent_exec_inner(
            state,
            ctx.session_id,
            &action.command,
            Some(ctx.exec_timeout),
            Some("approved"),
        )
        .await
        {
            Ok(resp) => {
                raw_output = resp.output.clone();
                output = resp.output.clone();
                exit_code = resp.exit_code;
                maybe_executed = resp.maybe_executed;
                timed_out = resp.timed_out;
                if let Some(c) = resp.cwd.as_ref().filter(|c| !c.trim().is_empty()) {
                    snapshot.memory.cwd = c.clone();
                }
                if let Some(code) = resp.exit_code {
                    if code != 0 {
                        output.push_str(&format!(
                            "\n（退出码 {code}：命令未成功，请分析报错后再决定下一步）"
                        ));
                    }
                }
                if resp.timed_out {
                    output.push_str("\n（命令超时：执行通道已重置，cd/export 等状态可能已丢失）");
                } else if resp.shell_gone {
                    output
                        .push_str("\n（shell 已退出：执行通道已重置，cd/export 等状态可能已丢失）");
                }
                if resp.maybe_executed {
                    output.push_str("\n（重要：通道在返回结果前断开，该命令可能已在远端执行。请先用只读命令核实状态，不要直接重试。）");
                }
                if output.trim().is_empty() {
                    output = "（命令执行完成，无输出）".to_string();
                }
            }
            Err(e) => {
                let reason = format!("【执行被拒/失败】{e}");
                record_refusal(snapshot, executed, &reason);
                snapshot
                    .memory
                    .failed_attempts
                    .push(format!("{} → {e}", action.command));
                acceptance_state.last_fail_at = this_step as i64;
                publish(app, run, snapshot);
                return ActionOutcome::Ok {
                    ok: false,
                    verified: None,
                };
            }
        }
    }

    // Advisory note for the model (and the UI): it rides on the ANNOTATED
    // copy only — the Verifier always judges the raw payload.
    if let Some(note) = action.note.as_ref() {
        output.push('\n');
        output.push_str(note);
    }

    // The command may have executed remotely before the channel died —
    // replaying it would run it twice. Stop and let the user decide.
    if maybe_executed {
        snapshot.steps.push(StepRecord {
            no: this_step,
            command: action.command.clone(),
            description: action.description.clone(),
            output: agent_policy::trim_for_ai(&output),
            risk: level.as_str().to_string(),
            kind: action.kind.as_str().to_string(),
            verified: None,
            verify_failures: None,
            exit_code: exit_code.or(None),
        });
        publish(app, run, snapshot);
        return ActionOutcome::Fatal;
    }

    // A TIMEOUT is a DIFFERENT situation from `maybe_executed`: we simply
    // stopped waiting and closed the channel on purpose. A read-only
    // command that timed out is safe to run again — the step just failed and
    // the planner picks another approach. A WRITE command may still be
    // running remotely, so stop and let a human check.
    if timed_out && !matches!(level, RiskLevel::Green) {
        snapshot.steps.push(StepRecord {
            no: this_step,
            command: action.command.clone(),
            description: action.description.clone(),
            output: agent_policy::trim_for_ai(&output),
            risk: level.as_str().to_string(),
            kind: action.kind.as_str().to_string(),
            verified: None,
            verify_failures: None,
            exit_code: exit_code.or(None),
        });
        publish(app, run, snapshot);
        return ActionOutcome::FatalTimeout;
    }

    // --- Verifier: Rust decides whether the assertions hold --------------
    let mut verified: Option<bool> = None;
    let mut verify_failures: Vec<String> = Vec::new();
    let has_expect = agent_policy::is_assertive(action.expect.as_ref());
    if has_expect {
        *assert_count += 1;
        let spec = action.expect.clone().unwrap_or_default();
        let outcome = verify_expectation(&spec, exit_code, &raw_output);
        verified = Some(outcome.passed);
        verify_failures = outcome.failures;
        if outcome.passed {
            *verified_count += 1;
            // Freshness must not be revived by an UNRELATED passing Verify
            // step: any `echo ok` + `contains:["ok"]` used to reset
            // last_pass_at and resurrect stale acceptance evidence. Exec
            // steps really changed the host, so they still count; Verify
            // steps refresh freshness only in the goal-evidence block below.
            if action.kind != StepKind::Verify {
                acceptance_state.last_pass_at = this_step as i64;
            }
            snapshot.memory.facts.push(format!(
                "{} → 断言通过",
                if action.description.trim().is_empty() {
                    &action.command
                } else {
                    &action.description
                }
            ));
        } else {
            snapshot.memory.hypotheses.push(format!(
                "{} → 断言未通过（{}）",
                if action.description.trim().is_empty() {
                    &action.command
                } else {
                    &action.description
                },
                if verify_failures.is_empty() {
                    "输出与预期不符".to_string()
                } else {
                    verify_failures.join("；")
                }
            ));
        }
    }

    let description = match action.expect.as_ref() {
        Some(spec) if has_expect => {
            let d = agent_policy::describe_expect(spec);
            if d.is_empty() {
                action.description.clone()
            } else {
                format!("{}{}", action.description, d)
            }
        }
        _ => action.description.clone(),
    };

    let trimmed = agent_policy::trim_for_ai(&output);
    snapshot.steps.push(StepRecord {
        no: this_step,
        command: action.command.clone(),
        description,
        output: trimmed.clone(),
        risk: level.as_str().to_string(),
        kind: action.kind.as_str().to_string(),
        verified,
        verify_failures: if verify_failures.is_empty() {
            None
        } else {
            Some(verify_failures.clone())
        },
        exit_code,
    });

    // Feed the result back to the reactive planner (B).
    executed.push(AgentStepIn {
        command: action.command.clone(),
        output: trimmed,
        kind: action.kind.as_str().to_string(),
        description: action.description.clone(),
        expect: match action.expect.as_ref() {
            Some(spec) if has_expect => agent_policy::describe_expect(spec),
            _ => action.expect_text.clone().unwrap_or_default(),
        },
        // Record the REAL verification result for Exec steps too. It used to
        // be hard-coded to None, which made `check_idempotent` dead code:
        // `prior` only sees Exec entries and could never find a passing one.
        verified,
        exit_code,
        // Feed the WHY back: without the reason, the model only sees
        // "assertion failed" and thrashes on new commands instead of
        // fixing the assertion itself.
        failures: verify_failures.clone(),
    });

    // A step that ran but did not satisfy its assertions (or exited non-zero
    // without one) is a REAL failure.
    let ok = agent_policy::step_succeeded(action.kind, verified, exit_code);
    if !ok {
        acceptance_state.last_fail_at = this_step as i64;
        snapshot.memory.failed_attempts.push(format!(
            "{} → {}",
            action.command,
            if verified == Some(false) {
                if verify_failures.is_empty() {
                    "输出与预期不符".to_string()
                } else {
                    verify_failures.join("；")
                }
            } else {
                format!("退出码 {}", exit_code.unwrap_or(-1))
            }
        ));
    } else {
        snapshot.memory.facts.push(format!(
            "{} → 已完成",
            if action.description.trim().is_empty() {
                &action.command
            } else {
                &action.description
            }
        ));
    }

    // A passing verification is goal evidence ONLY when it re-proves what
    // the planner promised: the spec must check the OUTPUT (an exit-code-only
    // check is satisfied by `true`), and when the plan defined acceptance
    // steps the command must be one of them. Anything else must never
    // satisfy the acceptance gate.
    if action.kind == StepKind::Verify && verified == Some(true) {
        let promised: Vec<String> = acceptance_pairs
            .iter()
            .map(|(_, c)| c.clone())
            .collect();
        if agent_policy::verify_is_goal_evidence(
            action.expect.as_ref(),
            &action.command,
            &promised,
        ) {
            // Credit ONLY the criterion this verification re-proved. A single
            // bool used to short-circuit the entire gate, laundering every
            // other required step (and never resetting after a later failure).
            if let Some((id, _)) = acceptance_pairs
                .iter()
                .find(|(_, c)| c.trim() == action.command.trim())
            {
                acceptance_state.reactive_passed_ids.insert(*id);
                // Freshness is refreshed ONLY by real goal evidence.
                acceptance_state.last_pass_at = this_step as i64;
            }
        }
    }
    publish(app, run, snapshot);
    ActionOutcome::Ok { ok, verified }
}

// ---------------------------------------------------------------------------
// Approval handshake
// ---------------------------------------------------------------------------

/// Ask the user for approval and wait for the answer.
///
/// Returns `None` when the run was cancelled while waiting.
async fn request_approval(
    app: &tauri::AppHandle,
    run: &Arc<AgentRun>,
    snapshot: &mut RunSnapshot,
    request: ApprovalRequest,
) -> Option<bool> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    {
        let mut slot = run.approval_tx.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(tx);
    }
    {
        let mut pending = run.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = Some(PendingApproval {
            request: request.clone(),
            answer: None,
        });
    }
    snapshot.status = RunStatus::Waiting;
    snapshot.approval = Some(request);
    publish(app, run, snapshot);

    // Wait for the answer. A cancelled run resolves the channel with `false`
    // so the loop never hangs forever.
    //
    // The wait is POLLING rather than a plain `rx.await`: if this run was
    // dropped from the registry (a new task took over the session), nobody
    // can answer it any more, and only the cancel flag can release it.
    // Polling at 200 ms keeps that exit prompt without a second channel.
    let mut rx = rx;
    let answer = loop {
        match tokio::time::timeout(Duration::from_millis(200), &mut rx).await {
            Ok(v) => break v.ok(),
            Err(_) => {
                if run.is_cancelled() {
                    break None;
                }
            }
        }
    };

    {
        let mut slot = run.approval_tx.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }
    {
        let mut pending = run.pending.lock().unwrap_or_else(|e| e.into_inner());
        *pending = None;
    }
    snapshot.approval = None;
    snapshot.status = if run.is_cancelled() {
        RunStatus::Stopped
    } else {
        RunStatus::Running
    };
    publish(app, run, snapshot);

    if run.is_cancelled() {
        return None;
    }
    Some(answer.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/// Push the current snapshot to the frontend.
fn publish(app: &tauri::AppHandle, run: &Arc<AgentRun>, snapshot: &RunSnapshot) {
    {
        let mut slot = run.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        *slot = snapshot.clone();
    }
    let _ = app.emit(
        EVENT_AGENT,
        AgentEvent {
            run_id: run.run_id,
            session_id: run.session_id,
            snapshot: snapshot.clone(),
        },
    );
}

/// Write the terminal state and the audit log, then publish.
fn finish(
    app: &tauri::AppHandle,
    state: &AppState,
    run: &Arc<AgentRun>,
    snapshot: &mut RunSnapshot,
    status: RunStatus,
    error: &str,
) {
    snapshot.status = status;
    snapshot.approval = None;
    snapshot.error = error.to_string();
    publish(app, run, snapshot);

    // The audit log is written HERE, by the backend — not by the UI. That is
    // the whole point of moving the controller down: the trail exists even if
    // the window is closed mid-task.
    write_audit_log(state, snapshot, status);
}

/// Persist the run to the on-disk agent log.
fn write_audit_log(state: &AppState, snapshot: &RunSnapshot, status: RunStatus) {
    let status_str = match status {
        RunStatus::Done => "done",
        RunStatus::Failed => "failed",
        RunStatus::Stopped => "stopped",
        RunStatus::Running | RunStatus::Waiting => "running",
    };
    let _ = crate::commands::save_agent_log_inner(
        state,
        &snapshot.goal,
        status_str,
        serde_json::to_value(&snapshot.steps).unwrap_or(serde_json::Value::Null),
    );
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

/// Build the provider adapter for this run.
fn make_run_adapter(
    state: &AppState,
    profile_id: Option<&str>,
) -> Result<Box<dyn crate::provider::adapters::LLMProvider>, String> {
    let (profile, key) = {
        let profiles = state.profiles.lock().unwrap_or_else(|e| e.into_inner());
        let profile = match profile_id {
            Some(id) if !id.trim().is_empty() => profiles.iter().find(|p| p.id == id).cloned(),
            _ => None,
        }
        .or_else(|| profiles.last().cloned())
        .ok_or("未配置 AI Provider：请先在设置中完成配置（S0）")?;
        let key = crate::commands::resolve_key_inner(state, &profile.id)?;
        (profile, key)
    };
    make_adapter(&profile, &key).map_err(|e| e.to_string())
}

/// Ground the model in the live system info + terminal tail.
async fn grounding(state: &AppState, session_id: u64, agent_cwd: &str) -> (String, String) {
    let pipeline_arc = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(&session_id) {
            Some(s) => s.pipeline.clone(),
            None => return (String::new(), String::new()),
        }
    };
    let (sys_info, tail) = {
        let p = pipeline_arc.lock().await;
        let n = 20.min(p.screen.lines.len());
        let tail = p
            .screen
            .lines
            .iter()
            .skip(p.screen.lines.len() - n)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        (p.system_info.clone(), tail)
    };
    let mut sys_text = crate::pipeline::context::format_system_context(&sys_info);
    if !agent_cwd.trim().is_empty() {
        sys_text = format!("{sys_text}CWD(Agent执行通道): {agent_cwd}\n");
    }
    (sys_text, tail)
}

/// Ask the model for the whole plan, with retries on transient failures.
///
/// Returns the plan together with the token usage of the call that
/// produced it, so the caller can cost the task.
async fn call_plan(
    state: &AppState,
    ctx: &RunContext,
    adapter: &dyn crate::provider::adapters::LLMProvider,
    agent_cwd: &str,
) -> Result<(AgentPlan, Option<Usage>), String> {
    let (sys_text, tail) = grounding(state, ctx.session_id, agent_cwd).await;
    let custom = state.agent_prompt();
    let mut last = String::new();
    for attempt in 0..3u32 {
        match ai::run_agent_plan(
            adapter,
            &ctx.goal,
            &sys_text,
            &tail,
            custom.as_deref(),
        )
        .await
        {
            Ok(p) => return Ok(p),
            Err(e) => {
                let msg = e.to_string();
                if !agent_policy::is_retryable_ai_error(&msg) || attempt == 2 {
                    return Err(msg);
                }
                last = msg;
                // Exponential backoff + jitter: 2s, 4s (+0~800ms).
                let backoff = 2000u64 * (attempt as u64 + 1);
                let jitter = rand::random::<u64>() % 800;
                tokio::time::sleep(Duration::from_millis(backoff + jitter)).await;
            }
        }
    }
    Err(last)
}

/// Ask the model for the next action, with retries on transient failures.
async fn call_step(
    state: &AppState,
    ctx: &RunContext,
    adapter: &dyn crate::provider::adapters::LLMProvider,
    agent_cwd: &str,
    goal: &str,
    history: &[AgentStepIn],
    require_verification: bool,
) -> Result<(AgentStepOut, Option<Usage>), String> {
    let (sys_text, tail) = grounding(state, ctx.session_id, agent_cwd).await;
    let custom = state.agent_prompt();
    let mut last = String::new();
    for attempt in 0..3u32 {
        match ai::run_agent_step(
            adapter,
            goal,
            history,
            &sys_text,
            &tail,
            require_verification,
            custom.as_deref(),
        )
        .await
        {
            Ok(o) => return Ok(o),
            Err(e) => {
                let msg = e.to_string();
                if !agent_policy::is_retryable_ai_error(&msg) || attempt == 2 {
                    return Err(msg);
                }
                last = msg;
                let backoff = 2000u64 * (attempt as u64 + 1);
                let jitter = rand::random::<u64>() % 800;
                tokio::time::sleep(Duration::from_millis(backoff + jitter)).await;
            }
        }
    }
    Err(last)
}
