//! Pure decision rules for the Agent workflow (Policy / Verifier / Executor /
//! Controller layers).
//!
//! These functions are the SAME rules that used to live inline in the
//! frontend's `store.ts` — they are ported here so the controller can run in
//! the Rust backend. They are deliberately free of I/O, of the Tauri runtime
//! and of any shared state, so every one of them is unit-testable.
//!
//! Why they must live on the backend: a rule that only exists in the renderer
//! cannot be enforced when the renderer is gone. The frontend is now an
//! OBSERVER; it renders what the backend reports and answers approval
//! requests. Every decision that can affect the remote machine is taken here.

use crate::agent_plan::ExpectSpec;
use std::collections::HashSet;

/// Authorization scope for write operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPolicy {
    /// Only read-only commands run unattended.
    ReadOnly,
    /// Commands belonging to the APPROVED plan run unattended.
    Plan,
    /// Every write command is confirmed individually.
    Step,
}

impl AgentPolicy {
    /// Parse the persisted setting. Unknown values fall back to the safest
    /// scope (`ReadOnly`) — a malformed config must never widen the gate.
    pub fn from_setting(raw: &str) -> Self {
        match raw.trim() {
            "plan" => AgentPolicy::Plan,
            "step" => AgentPolicy::Step,
            _ => AgentPolicy::ReadOnly,
        }
    }
}

/// Risk level of a command, as graded by the Rust risk engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskLevel {
    Green,
    Yellow,
    Red,
}

impl RiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskLevel::Green => "green",
            RiskLevel::Yellow => "yellow",
            RiskLevel::Red => "red",
        }
    }
}

// ---------------------------------------------------------------------------
// Assertion strength
// ---------------------------------------------------------------------------

/// True when a spec carries at least one machine-checkable field.
pub fn is_assertive(e: Option<&ExpectSpec>) -> bool {
    match e {
        None => false,
        Some(s) => {
            s.exit_code.is_some()
                || !s.contains.is_empty()
                || !s.not_contains.is_empty()
                || s.regex.as_ref().is_some_and(|r| !r.trim().is_empty())
        }
    }
}

/// True when a spec checks the command OUTPUT (contains / not_contains /
/// regex). An exit-code-only spec is satisfied by `true` or `echo ok` —
/// it proves nothing about the goal.
pub fn has_output_check(e: &ExpectSpec) -> bool {
    !e.contains.is_empty()
        || !e.not_contains.is_empty()
        || e.regex.as_ref().is_some_and(|r| !r.trim().is_empty())
}

/// May a passing verification count as goal evidence for the acceptance
/// gate (the `reactive_verified` channel)?
///
/// Three requirements, all required:
///  1. the step carried a machine-checkable spec at all;
///  2. the spec checks the OUTPUT, not just the exit code — without this,
///     a failing run could be "laundered" into a success by verifying
///     `true` with `expect:{exit_code:0}`;
///  3. when the plan defined acceptance steps, the verification must be the
///     SAME command as one of them — the model must re-prove what the
///     planner promised, not a trivial look-alike. (When the plan defined
///     no acceptance steps there is nothing to match against; the output
///     check is then the only barrier, and the `assert_count`/`verified_count`
///     gates still apply.)
pub fn verify_is_goal_evidence(
    spec: Option<&ExpectSpec>,
    command: &str,
    acceptance_commands: &[String],
) -> bool {
    let Some(spec) = spec else {
        return false;
    };
    if !has_output_check(spec) {
        return false;
    }
    if acceptance_commands.is_empty() {
        return true;
    }
    let cmd = command.trim();
    acceptance_commands.iter().any(|c| c.trim() == cmd)
}

// ---------------------------------------------------------------------------
// Policy layer
// ---------------------------------------------------------------------------

/// Does the "approve the whole plan" gate still have to be shown?
///
/// The gate must be reachable EXACTLY once, when the user has not approved
/// yet. Deriving `plan_approved` from the policy itself made this predicate
/// permanently false, so the "批准计划" scope silently behaved like "逐条确认".
pub fn is_plan_approval_required(policy: AgentPolicy, plan_approved: bool) -> bool {
    matches!(policy, AgentPolicy::Plan) && !plan_approved
}

/// May this command run WITHOUT asking the user?
///
/// Two independent ways to be unattended: a green (read-only) command when
/// auto-green is on, or a command that belongs to the plan the user already
/// approved.
pub fn may_run_unattended(
    level: RiskLevel,
    auto_green: bool,
    in_approved_plan: bool,
    plan_approved: bool,
) -> bool {
    (matches!(level, RiskLevel::Green) && auto_green) || (in_approved_plan && plan_approved)
}

// ---------------------------------------------------------------------------
// Verifier layer — the acceptance verdict
// ---------------------------------------------------------------------------

/// Which plan steps are the acceptance criteria?
///
/// The planner marks the step that verifies the GOAL itself with
/// `required = true`. A required step WITHOUT an assertion is unusable (it
/// could never be satisfied), so it is filtered out. When the planner marks
/// nothing, fall back to the LAST assertive step of the plan.
pub fn resolve_acceptance_ids(steps: &[(u32, bool, bool)]) -> Vec<u32> {
    let marked: Vec<u32> = steps
        .iter()
        .filter(|(_, required, assertive)| *required && *assertive)
        .map(|(id, _, _)| *id)
        .collect();
    if !marked.is_empty() {
        return marked;
    }
    steps
        .iter()
        .rev()
        .find(|(_, _, assertive)| *assertive)
        .map(|(id, _, _)| *id)
        .into_iter()
        .collect()
}

/// The evidence the acceptance verdict is computed from.
#[derive(Debug, Clone, Default)]
pub struct AcceptanceState {
    /// Required steps whose assertions passed.
    pub passed_step_ids: HashSet<u32>,
    /// The reactive phase produced a passing re-check of the goal.
    pub reactive_verified: bool,
    /// step_no of the most recent PASSING verification (-1 = none).
    pub last_pass_at: i64,
    /// step_no of the most recent FAILED step (-1 = none).
    pub last_fail_at: i64,
}

/// Is the goal demonstrably achieved?
///
/// Three conditions, all required:
///  1. there IS something to prove against (no assertion → no verdict);
///  2. the evidence is FRESH — a verification that happened BEFORE the last
///     failure proves nothing (the failed step may have undone it);
///  3. either every required plan step passed, or the reactive phase
///     produced a fresh passing verification.
pub fn is_acceptance_satisfied(acceptance_ids: &[u32], state: &AcceptanceState) -> bool {
    if acceptance_ids.is_empty() {
        return false;
    }
    if state.last_fail_at >= 0 && state.last_pass_at <= state.last_fail_at {
        return false;
    }
    if state.reactive_verified {
        return true;
    }
    acceptance_ids
        .iter()
        .all(|id| state.passed_step_ids.contains(id))
}

// ---------------------------------------------------------------------------
// Executor layer
// ---------------------------------------------------------------------------

/// What kind of step is being executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    Exec,
    Verify,
    Pty,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StepKind::Exec => "exec",
            StepKind::Verify => "verify",
            StepKind::Pty => "pty",
        }
    }
}

/// Did this step actually succeed?
///
/// `exit_code = None` means "we never learned the exit code" (timeout, or the
/// shell died before the command ran). It is NOT success: a command that
/// never executed must never satisfy a dependency. `pty` steps have no exit
/// code by nature — the user's terminal judges them — so they count as
/// executed.
pub fn step_succeeded(kind: StepKind, verified: Option<bool>, exit_code: Option<i32>) -> bool {
    match kind {
        StepKind::Verify => verified == Some(true),
        StepKind::Pty => true,
        StepKind::Exec => exit_code == Some(0),
    }
}

/// The outcome of picking the next runnable plan step.
#[derive(Debug, Clone, PartialEq)]
pub struct PickResult<T> {
    /// The next runnable step, or `None` when the plan is blocked/finished.
    pub pick: Option<T>,
    /// Steps dropped because one of their dependencies can never succeed.
    pub skipped: Vec<T>,
}

/// Pick the next runnable planned step, respecting `depends_on`.
///
/// A step whose dependency failed (or was itself skipped) can never run →
/// it is dropped and reported, not silently ignored.
///
/// `T: Clone` is required because a skipped step is COPIED into the result
/// (the caller keeps its own queue). `deps_of` returns an owned list on
/// purpose: returning a borrow would tie the closure's lifetime to the
/// element's and make the higher-ranked bound un-inferable.
pub fn pick_runnable_step<T: Clone>(
    queue: &[T],
    done_ids: &HashSet<u32>,
    failed_ids: &HashSet<u32>,
    skipped_ids: &mut HashSet<u32>,
    id_of: impl Fn(&T) -> u32,
    deps_of: impl Fn(&T) -> Vec<u32>,
) -> PickResult<T> {
    let mut skipped: Vec<T> = Vec::new();
    for s in queue {
        let id = id_of(s);
        // A step that already ran (or already failed) is not a candidate any
        // more — the outcome set is the truth.
        if done_ids.contains(&id) || failed_ids.contains(&id) {
            continue;
        }
        let deps = deps_of(s);
        let deps_failed = deps
            .iter()
            .any(|d| skipped_ids.contains(d) || failed_ids.contains(d));
        if deps_failed {
            skipped_ids.insert(id);
            skipped.push(s.clone());
            continue;
        }
        if deps.iter().all(|d| done_ids.contains(d)) {
            return PickResult {
                pick: Some(s.clone()),
                skipped,
            };
        }
    }
    PickResult {
        pick: None,
        skipped,
    }
}

// ---------------------------------------------------------------------------
// Controller layer — budgets and stop conditions
// ---------------------------------------------------------------------------

/// Is the task over budget?
///
/// A step budget alone is not a stop condition: some paths (a model that
/// keeps claiming "done") never consume a step, so they need their own
/// ceiling.
pub fn is_over_budget(llm_calls: u32, max_calls: u32, elapsed_ms: u64, max_wall_ms: u64) -> bool {
    llm_calls >= max_calls || elapsed_ms > max_wall_ms
}

/// The verdict on a model's claim that the task is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DoneVerdict {
    pub accept: bool,
    pub require_verification: bool,
    pub abort: bool,
}

/// Judge a model's claim that the task is done.
///
/// A claim without fresh evidence is not accepted — the model is pushed back
/// towards a verification step. But that pushback consumes no step, so it
/// needs its own counter: without it the loop could run forever.
pub fn judge_done_claim(
    acceptance_satisfied: bool,
    unproven_done: u32,
    max_unproven_done: u32,
) -> DoneVerdict {
    if acceptance_satisfied {
        return DoneVerdict {
            accept: true,
            require_verification: false,
            abort: false,
        };
    }
    let next = unproven_done + 1;
    DoneVerdict {
        accept: false,
        require_verification: true,
        abort: next >= max_unproven_done,
    }
}

/// One step fed back to the model (the subset the trimmer needs).
///
/// The trimmer is generic over the history element, so this struct is only
/// a documentation aid for the shape the Agent controller actually feeds it
/// (`ai::AgentStepIn`).
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub command: String,
    pub output: String,
    pub description: String,
}

/// Keep the history handed back to the model inside a char budget.
///
/// The newest steps are kept in full, the oldest ones are dropped. Without
/// this the prompt grows O(n²) and eventually overflows the model's context
/// window — the task then dies with an opaque "replan failed".
///
/// `T: Clone` is required because the kept steps are COPIED into the result.
pub fn trim_history<T: Clone>(list: &[T], budget: usize, cost_of: impl Fn(&T) -> usize) -> Vec<T> {
    if list.len() <= 2 {
        return list.to_vec();
    }
    let mut kept: Vec<T> = Vec::new();
    let mut total = 0usize;
    for s in list.iter().rev() {
        let cost = cost_of(s);
        if total + cost > budget && kept.len() >= 2 {
            break;
        }
        kept.push(s.clone());
        total += cost;
    }
    kept.reverse();
    kept
}

/// Normalize a command so two spellings of the same intent compare equal.
///
/// Whitespace around the command, and repeated inner spaces, carry no
/// meaning for the shell but do defeat exact-match deduplication.
pub fn normalize_command(cmd: &str) -> String {
    cmd.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Should this command be short-circuited because it already ran?
///
/// Re-running an identical command that already produced a PASSING result
/// burns a step, a remote execution and a round of model tokens, and changes
/// nothing — the classic "the model asks `systemctl status nginx` five times
/// in a row" waste.
///
/// Only a command whose earlier run VERIFIED is short-circuited. A command
/// that failed must be retried (that is the whole point of the retry loop),
/// and a command with no assertion is left alone, because its result may
/// legitimately have changed in the meantime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdempotencyVerdict {
    /// Execute it.
    Proceed,
    /// Already verified — reuse the previous output instead of re-running.
    Skip { previous_output: String },
}

/// Decide whether a command may be skipped because an identical one already
/// succeeded with a passing assertion.
pub fn check_idempotent(
    command: &str,
    prior: &[(String, bool, String)],
) -> IdempotencyVerdict {
    let norm = normalize_command(command);
    if norm.is_empty() {
        return IdempotencyVerdict::Proceed;
    }
    // Scan newest-first: the most recent verified result wins.
    for (cmd, verified, output) in prior.iter().rev() {
        if normalize_command(cmd) == norm && *verified {
            return IdempotencyVerdict::Skip {
                previous_output: output.clone(),
            };
        }
    }
    IdempotencyVerdict::Proceed
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/// Trim command output for the model: keep head + tail + error-ish lines in
/// the middle, with an EXPLICIT omission marker. Long outputs otherwise
/// either get silently cut at the tail (losing the error at the top) or blow
/// the context window.
pub fn trim_for_ai(raw: &str) -> String {
    const MAX_CHARS: usize = 6000;
    if raw.len() <= MAX_CHARS && raw.lines().count() <= 60 {
        return raw.to_string();
    }
    let lines: Vec<&str> = raw.split('\n').collect();
    let head: Vec<&str> = lines.iter().take(12).copied().collect();
    let tail: Vec<&str> = lines
        .iter()
        .skip(lines.len().saturating_sub(30))
        .copied()
        .collect();
    const ERR_NEEDLES: [&str; 17] = [
        "error",
        "fail",
        "fatal",
        "traceback",
        "exception",
        "denied",
        "refused",
        "not found",
        "no such",
        "timeout",
        "panic",
        "错误",
        "失败",
        "拒绝",
        "超时",
        "不存在",
        "warn",
    ];
    let mid: Vec<&str> = lines
        .iter()
        .take(lines.len().saturating_sub(30))
        .skip(12)
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            ERR_NEEDLES.iter().any(|n| low.contains(n))
        })
        .take(15)
        .copied()
        .collect();
    let omitted = lines
        .len()
        .saturating_sub(head.len() + tail.len() + mid.len());
    let mut out = Vec::with_capacity(head.len() + mid.len() + tail.len() + 2);
    out.extend(head);
    let omitted_note = format!(
        "…（已省略中间 {omitted} 行，保留错误相关行与结尾）…"
    );
    out.push(omitted_note.as_str());
    out.extend(mid);
    out.extend(tail);
    let joined = out.join("\n");
    if joined.chars().count() > MAX_CHARS + 500 {
        let cut: String = joined.chars().rev().take(MAX_CHARS + 500).collect();
        cut.chars().rev().collect()
    } else {
        joined
    }
}

/// Fold the structured work memory into the goal string handed to the
/// reactive planner.
///
/// The model cannot self-correct if it cannot see what already failed and
/// why, so the cwd / confirmed facts / ruled-out hypotheses / failed attempts
/// are injected on every replan call. Only the most recent entries survive.
pub fn build_goal_with_memory(
    goal: &str,
    cwd: &str,
    facts: &[String],
    hypotheses: &[String],
    failed_attempts: &[String],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !cwd.trim().is_empty() {
        lines.push(format!("当前工作目录：{}", cwd.trim()));
    }
    if !facts.is_empty() {
        let tail = tail_slice(facts, 6);
        lines.push(format!("已确认的事实：\n- {}", tail.join("\n- ")));
    }
    if !hypotheses.is_empty() {
        let tail = tail_slice(hypotheses, 6);
        lines.push(format!("已被证伪的假设：\n- {}", tail.join("\n- ")));
    }
    if !failed_attempts.is_empty() {
        let tail = tail_slice(failed_attempts, 8);
        lines.push(format!(
            "已失败的尝试（不要重复相同做法，换个思路）：\n- {}",
            tail.join("\n- ")
        ));
    }
    if lines.is_empty() {
        return goal.to_string();
    }
    format!("{goal}\n\n[工作记忆]\n{}", lines.join("\n"))
}

fn tail_slice(items: &[String], n: usize) -> Vec<String> {
    let start = items.len().saturating_sub(n);
    items[start..].to_vec()
}

/// Human-readable rendering of a step's machine-checkable expectation, shown
/// in the Agent card so the user can see WHAT will be verified before it runs.
pub fn describe_expect(e: &ExpectSpec) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = e.exit_code {
        parts.push(format!("退出码={c}"));
    }
    for c in &e.contains {
        parts.push(format!("输出包含「{c}」"));
    }
    for c in &e.not_contains {
        parts.push(format!("输出不含「{c}」"));
    }
    if let Some(r) = e.regex.as_ref().filter(|r| !r.trim().is_empty()) {
        parts.push(format!("输出匹配 /{r}/"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("（断言：{}）", parts.join("；"))
    }
}

/// Transient AI failure markers worth retrying (network / timeout / rate
/// limit / mid-stream interruption). Auth-classified errors fail at once.
pub const RETRYABLE_AI_ERRORS: [&str; 9] = [
    "网络",
    "超时",
    "频率",
    "HTTP 5",
    "HTTP 429",
    "连接",
    "响应中断",
    "读取超时",
    "流式",
];

/// Is this error worth another attempt?
///
/// A malformed model reply counts. The marker is a stable, greppable token
/// precisely so the retry layer can recognise it without guessing from the
/// model's wording; without it here, a model that answers with one sentence
/// of prose instead of JSON killed the whole task instead of being retried.
pub fn is_retryable_ai_error(msg: &str) -> bool {
    msg.contains(crate::ai::AGENT_REPLY_MALFORMED)
        || RETRYABLE_AI_ERRORS.iter().any(|k| msg.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(exit_code: Option<i32>, contains: &[&str]) -> ExpectSpec {
        ExpectSpec {
            exit_code,
            contains: contains.iter().map(|s| s.to_string()).collect(),
            not_contains: vec![],
            regex: None,
        }
    }

    #[test]
    fn policy_from_setting_falls_back_to_safest() {
        assert_eq!(AgentPolicy::from_setting("plan"), AgentPolicy::Plan);
        assert_eq!(AgentPolicy::from_setting("step"), AgentPolicy::Step);
        assert_eq!(AgentPolicy::from_setting("readonly"), AgentPolicy::ReadOnly);
        // A malformed config must never widen the gate.
        assert_eq!(AgentPolicy::from_setting("yolo"), AgentPolicy::ReadOnly);
        assert_eq!(AgentPolicy::from_setting(""), AgentPolicy::ReadOnly);
    }

    #[test]
    fn is_assertive_requires_a_checkable_field() {
        assert!(!is_assertive(None));
        assert!(!is_assertive(Some(&ExpectSpec::default())));
        assert!(is_assertive(Some(&spec(Some(0), &[]))));
        assert!(is_assertive(Some(&spec(None, &["x"]))));
        let mut s = ExpectSpec::default();
        s.not_contains.push("boom".into());
        assert!(is_assertive(Some(&s)));
        let mut r = ExpectSpec::default();
        r.regex = Some("  ".into());
        assert!(!is_assertive(Some(&r)));
    }

    #[test]
    fn output_check_requires_an_output_level_field() {
        // exit_code alone proves nothing — `true` satisfies it.
        assert!(!has_output_check(&spec(Some(0), &[])));
        assert!(has_output_check(&spec(None, &["active"])));
        let mut nc = spec(None, &[]);
        nc.not_contains.push("failed".into());
        assert!(has_output_check(&nc));
        let mut rx = spec(None, &[]);
        rx.regex = Some("ok".into());
        assert!(has_output_check(&rx));
    }

    #[test]
    fn goal_evidence_needs_an_output_check() {
        let acc = vec!["systemctl is-active nginx".to_string()];
        // The laundering vector: exit-code-only spec on an unrelated command.
        assert!(!verify_is_goal_evidence(Some(&spec(Some(0), &[])), "true", &acc));
        assert!(!verify_is_goal_evidence(Some(&spec(Some(0), &[])), "echo ok", &acc));
        // No spec at all → never evidence.
        assert!(!verify_is_goal_evidence(None, "systemctl is-active nginx", &acc));
        // Output-level check on the acceptance command → evidence.
        assert!(verify_is_goal_evidence(
            Some(&spec(Some(0), &["active"])),
            "systemctl is-active nginx",
            &acc
        ));
    }

    #[test]
    fn goal_evidence_must_re_prove_the_same_command() {
        let acc = vec!["curl -s localhost:80".to_string()];
        // Output check but a DIFFERENT command → not goal evidence.
        assert!(!verify_is_goal_evidence(
            Some(&spec(Some(0), &["ok"])),
            "echo ok",
            &acc
        ));
        // Whitespace differences do not change identity.
        assert!(verify_is_goal_evidence(
            Some(&spec(Some(0), &["ok"])),
            "  curl -s localhost:80  ",
            &acc
        ));
    }

    #[test]
    fn goal_evidence_without_acceptance_steps_falls_back_to_output_check() {
        // The plan defined no acceptance steps (acceptance_ids empty): the
        // output check is the only barrier here, and the assert_count /
        // verified_count completion gates still guard the run.
        assert!(verify_is_goal_evidence(
            Some(&spec(Some(0), &["active"])),
            "systemctl is-active nginx",
            &[]
        ));
        assert!(!verify_is_goal_evidence(Some(&spec(Some(0), &[])), "true", &[]));
    }

    #[test]
    fn plan_approval_gate_is_reachable_exactly_once() {
        assert!(is_plan_approval_required(AgentPolicy::Plan, false));
        assert!(!is_plan_approval_required(AgentPolicy::Plan, true));
        assert!(!is_plan_approval_required(AgentPolicy::ReadOnly, false));
        assert!(!is_plan_approval_required(AgentPolicy::Step, false));
    }

    #[test]
    fn unattended_requires_green_or_approved_plan() {
        // green + auto-green → unattended
        assert!(may_run_unattended(RiskLevel::Green, true, false, false));
        // green but auto-green off → ask
        assert!(!may_run_unattended(RiskLevel::Green, false, false, false));
        // yellow → always ask
        assert!(!may_run_unattended(RiskLevel::Yellow, true, false, false));
        // in the approved plan → unattended
        assert!(may_run_unattended(RiskLevel::Yellow, false, true, true));
        // in the plan but NOT approved → ask
        assert!(!may_run_unattended(RiskLevel::Yellow, false, true, false));
    }

    #[test]
    fn acceptance_ids_prefer_marked_required_steps() {
        // (id, required, assertive)
        let steps = vec![(1u32, true, true), (2u32, false, true), (3u32, true, false)];
        assert_eq!(resolve_acceptance_ids(&steps), vec![1]);
    }

    #[test]
    fn acceptance_ids_fall_back_to_last_assertive_step() {
        let steps = vec![
            (1u32, false, true),
            (2u32, false, false),
            (3u32, false, true),
        ];
        assert_eq!(resolve_acceptance_ids(&steps), vec![3]);
        // No assertive step at all → no criterion.
        let none = vec![(1u32, false, false)];
        assert!(resolve_acceptance_ids(&none).is_empty());
    }

    #[test]
    fn acceptance_needs_something_to_prove_against() {
        let st = AcceptanceState {
            last_pass_at: 1,
            last_fail_at: -1,
            ..Default::default()
        };
        assert!(!is_acceptance_satisfied(&[], &st));
    }

    #[test]
    fn acceptance_accepts_a_fresh_reactive_recheck() {
        // The reactive phase re-checked the goal AFTER the last failure: that
        // is fresh evidence, even though no required step ever passed.
        let st = AcceptanceState {
            passed_step_ids: HashSet::new(),
            reactive_verified: true,
            last_pass_at: 9,
            last_fail_at: 3,
        };
        assert!(is_acceptance_satisfied(&[1], &st));
    }

    #[test]
    fn acceptance_requires_all_required_steps() {
        let ids = vec![1u32, 2];
        let mut st = AcceptanceState {
            last_pass_at: 5,
            last_fail_at: -1,
            ..Default::default()
        };
        st.passed_step_ids.insert(1);
        assert!(!is_acceptance_satisfied(&ids, &st));
        st.passed_step_ids.insert(2);
        assert!(is_acceptance_satisfied(&ids, &st));
    }

    #[test]
    fn acceptance_rejects_stale_evidence() {
        let ids = vec![1u32];
        let mut st = AcceptanceState {
            last_pass_at: 3,
            last_fail_at: 7,
            ..Default::default()
        };
        st.passed_step_ids.insert(1);
        // The passing check happened BEFORE the later failure → not proof.
        assert!(!is_acceptance_satisfied(&ids, &st));
    }

    #[test]
    fn step_success_treats_unknown_exit_code_as_failure() {
        assert!(!step_succeeded(StepKind::Exec, None, None));
        assert!(step_succeeded(StepKind::Exec, None, Some(0)));
        assert!(!step_succeeded(StepKind::Exec, None, Some(1)));
        // verify steps are judged by the assertion, not the exit code
        assert!(step_succeeded(StepKind::Verify, Some(true), Some(1)));
        assert!(!step_succeeded(StepKind::Verify, Some(false), Some(0)));
        assert!(!step_succeeded(StepKind::Verify, None, Some(0)));
        // pty steps are judged by the user's terminal
        assert!(step_succeeded(StepKind::Pty, None, None));
    }

    #[derive(Clone, Debug)]
    struct FakeStep {
        id: u32,
        depends_on: Vec<u32>,
    }

    #[test]
    fn pick_respects_dependencies() {
        let queue = vec![
            FakeStep {
                id: 1,
                depends_on: vec![],
            },
            FakeStep {
                id: 2,
                depends_on: vec![1],
            },
        ];
        let done = HashSet::new();
        let failed = HashSet::new();
        let mut skipped = HashSet::new();
        let r = pick_runnable_step(
            &queue,
            &done,
            &failed,
            &mut skipped,
            |s| s.id,
            |s| s.depends_on.clone(),
        );
        assert_eq!(r.pick.unwrap().id, 1);
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn pick_skips_steps_whose_dependency_failed() {
        let queue = vec![
            FakeStep {
                id: 1,
                depends_on: vec![],
            },
            FakeStep {
                id: 2,
                depends_on: vec![1],
            },
        ];
        let done = HashSet::new();
        let failed: HashSet<u32> = [1u32].into_iter().collect();
        let mut skipped = HashSet::new();
        let r = pick_runnable_step(
            &queue,
            &done,
            &failed,
            &mut skipped,
            |s| s.id,
            |s| s.depends_on.clone(),
        );
        assert!(r.pick.is_none());
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].id, 2);
        assert!(skipped.contains(&2));
    }

    #[test]
    fn pick_does_not_reselect_a_finished_step() {
        let queue = vec![FakeStep {
            id: 1,
            depends_on: vec![],
        }];
        let done: HashSet<u32> = [1u32].into_iter().collect();
        let failed = HashSet::new();
        let mut skipped = HashSet::new();
        let r = pick_runnable_step(
            &queue,
            &done,
            &failed,
            &mut skipped,
            |s| s.id,
            |s| s.depends_on.clone(),
        );
        assert!(r.pick.is_none());
    }

    #[test]
    fn budget_covers_both_call_count_and_wall_clock() {
        assert!(is_over_budget(40, 40, 0, 1000));
        assert!(!is_over_budget(39, 40, 0, 1000));
        assert!(is_over_budget(1, 40, 1001, 1000));
        assert!(!is_over_budget(1, 40, 999, 1000));
    }

    #[test]
    fn done_claim_needs_evidence_and_has_its_own_ceiling() {
        // With evidence → accept.
        let v = judge_done_claim(true, 0, 3);
        assert!(v.accept && !v.abort);
        // Without evidence → push back, but do not abort on the first claim.
        let v = judge_done_claim(false, 0, 3);
        assert!(!v.accept && v.require_verification && !v.abort);
        // Third unproven claim → abort.
        let v = judge_done_claim(false, 2, 3);
        assert!(!v.accept && v.abort);
    }

    #[test]
    fn trim_history_keeps_newest_and_respects_budget() {
        let items: Vec<HistoryEntry> = (0..10)
            .map(|i| HistoryEntry {
                command: format!("cmd{i}"),
                output: "x".repeat(100),
                description: String::new(),
            })
            .collect();
        let kept = trim_history(&items, 300, |h| {
            h.command.len() + h.output.len() + h.description.len() + 80
        });
        assert!(kept.len() < items.len());
        // The newest entry always survives.
        assert_eq!(kept.last().unwrap().command, "cmd9");
        // Order is preserved.
        assert_eq!(kept.first().unwrap().command, "cmd8");
    }

    #[test]
    fn trim_history_always_keeps_at_least_two_steps() {
        // Even with a budget of zero, the newest two steps survive — the
        // model must always see what just happened.
        let items: Vec<HistoryEntry> = (0..10)
            .map(|i| HistoryEntry {
                command: format!("cmd{i}"),
                output: "x".repeat(100),
                description: String::new(),
            })
            .collect();
        let kept = trim_history(&items, 0, |h| {
            h.command.len() + h.output.len() + h.description.len() + 80
        });
        assert!(kept.len() >= 2);
        assert_eq!(kept.last().unwrap().command, "cmd9");
    }

    #[test]
    fn trim_history_leaves_short_histories_untouched() {
        let items: Vec<HistoryEntry> = (0..2)
            .map(|i| HistoryEntry {
                command: format!("cmd{i}"),
                output: "out".into(),
                description: String::new(),
            })
            .collect();
        let kept = trim_history(&items, 100, |h| h.command.len());
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn trim_for_ai_keeps_short_output_untouched() {
        assert_eq!(trim_for_ai("hello"), "hello");
    }

    #[test]
    fn trim_for_ai_keeps_head_and_tail() {
        let raw = (0..200)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let out = trim_for_ai(&raw);
        assert!(out.contains("line 0"));
        assert!(out.contains("line 199"));
        assert!(out.contains("已省略中间"));
    }

    #[test]
    fn trim_for_ai_keeps_error_lines_from_the_middle() {
        let mut lines: Vec<String> = (0..100).map(|i| format!("filler {i}")).collect();
        lines[50] = "Traceback: something exploded".into();
        let raw = lines.join("\n");
        let out = trim_for_ai(&raw);
        assert!(out.contains("Traceback"));
    }

    #[test]
    fn goal_with_memory_injects_context() {
        let g = build_goal_with_memory(
            "check nginx",
            "/home/jie",
            &["nginx is running".to_string()],
            &["nginx is stopped".to_string()],
            &["systemctl start nginx failed".to_string()],
        );
        assert!(g.starts_with("check nginx"));
        assert!(g.contains("当前工作目录：/home/jie"));
        assert!(g.contains("已确认的事实"));
        assert!(g.contains("已被证伪的假设"));
        assert!(g.contains("已失败的尝试"));
    }

    #[test]
    fn goal_without_memory_is_unchanged() {
        let g = build_goal_with_memory("check nginx", "", &[], &[], &[]);
        assert_eq!(g, "check nginx");
    }

    #[test]
    fn describe_expect_lists_every_assertion() {
        let mut s = spec(Some(0), &["active"]);
        s.not_contains.push("failed".into());
        s.regex = Some("ok".into());
        let d = describe_expect(&s);
        assert!(d.contains("退出码=0"));
        assert!(d.contains("输出包含「active」"));
        assert!(d.contains("输出不含「failed」"));
        assert!(d.contains("输出匹配"));
    }

    #[test]
    fn retryable_errors_are_classified() {
        assert!(is_retryable_ai_error("网络连接失败"));
        assert!(is_retryable_ai_error("HTTP 429 频率限制"));
        assert!(is_retryable_ai_error("响应中断"));
        assert!(!is_retryable_ai_error("API Key 未配置"));
        assert!(!is_retryable_ai_error("模型返回的 JSON 字段不合法"));
    }

    #[test]
    fn malformed_reply_is_retryable() {
        // The marker is what lets the retry layer recognise a malformed
        // reply without guessing from the model's wording. Without it, one
        // sentence of prose killed the whole task.
        assert!(is_retryable_ai_error(
            "AGENT_REPLY_MALFORMED 模型未返回可解析的 JSON"
        ));
    }

    #[test]
    fn identical_verified_command_is_skipped() {
        let prior = vec![(
            "systemctl status nginx".to_string(),
            true,
            "active (running)".to_string(),
        )];
        match check_idempotent("systemctl status nginx", &prior) {
            IdempotencyVerdict::Skip { previous_output } => {
                assert_eq!(previous_output, "active (running)");
            }
            IdempotencyVerdict::Proceed => panic!("应当跳过重复且已通过断言的命令"),
        }
    }

    #[test]
    fn whitespace_differences_do_not_defeat_dedup() {
        let prior = vec![(
            "systemctl   status   nginx".to_string(),
            true,
            "ok".to_string(),
        )];
        assert!(matches!(
            check_idempotent(" systemctl status nginx ", &prior),
            IdempotencyVerdict::Skip { .. }
        ));
    }

    #[test]
    fn failed_command_is_not_skipped() {
        // A failed command MUST be retried — that is the retry loop's job.
        let prior = vec![("curl localhost".to_string(), false, "refused".to_string())];
        assert!(matches!(
            check_idempotent("curl localhost", &prior),
            IdempotencyVerdict::Proceed
        ));
    }

    #[test]
    fn unverified_command_is_not_skipped() {
        // Without an assertion the result may legitimately have changed.
        let prior = vec![("date".to_string(), false, "now".to_string())];
        assert!(matches!(
            check_idempotent("date", &prior),
            IdempotencyVerdict::Proceed
        ));
    }

    #[test]
    fn newest_verified_result_wins() {
        let prior = vec![
            ("cat /etc/hosts".to_string(), true, "old".to_string()),
            ("cat /etc/hosts".to_string(), false, "new".to_string()),
        ];
        // The most recent run failed, so the command must be retried.
        assert!(matches!(
            check_idempotent("cat /etc/hosts", &prior),
            IdempotencyVerdict::Proceed
        ));
    }

    #[test]
    fn empty_command_is_never_skipped() {
        let prior = vec![("".to_string(), true, "x".to_string())];
        assert!(matches!(
            check_idempotent("  ", &prior),
            IdempotencyVerdict::Proceed
        ));
    }
}
