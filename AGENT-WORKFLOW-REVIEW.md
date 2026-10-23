# Agent 工作流设计审查（第二轮 · 架构层）

> 审查对象：`src/store.ts` 的 `agentLoop`、`src-tauri/src/ai.rs`、`agent_plan.rs`、`agent_shell.rs`、`commands.rs`
> 审查基线：commit `3b8070a`（当前 HEAD）
> 方法：全链路通读 + 逐条构造复现路径 + `tsc --noEmit` 通过（0 error）
>
> **✅ 修复状态：F1–F10 全部已实施（2026-10-24）。** 实施记录见文末「九、修复实施记录」。

---

## 〇、一句话结论

**五层骨架（Planner / Policy / Executor / Verifier / State）方向正确，本轮 P0 修复也基本到位；但当前实现里仍有 3 个会让 Agent 直接跑歪的缺陷，其中一个是**无界循环**。此外「任务完成」的判定标准仍然偏弱——它证明的是"某条断言过了"，不是"目标达成了"。**

对比上一轮评审（`AGENT-REVIEW.md`）的 15 条缺陷：

| 上一轮条目 | 状态 |
|---|---|
| P0-1 pty 旁路 / 预览截断 | ✅ 已修（`agent_pty_write` 重新分级 + 全文预览 + ANSI 清洗） |
| P0-2 shell 死亡后重放 | ✅ 已修（`maybe_executed` 语义） |
| P0-3 done 可被伪造 | ⚠️ 部分修（改为 Rust 判定，但**门槛仍然过低**，见 F6） |
| P0-4 任务跨主机漂移 | ✅ 已修（sessionId 冻结 + 审批框显示主机） |
| P0-5 Prompt injection 外泄 | ✅ 已修（`sanitize_output` + `wrap_untrusted_output`） |
| P0-6 RED 必然失败的审批按钮 | ❌ **未修**（见 F5） |
| P1-1 expect/kind 不回灌 | ✅ 已修（`AgentStepIn` 含 kind/expect/verified/failures） |
| P1-2 头部被尾部截断作废 | ✅ 已修（Rust 侧不再截 2500 字符） |
| P1-3 wrap_command 挂死 | ✅ 已修（单行 + 单引号 + `eval`） |
| P1-4 stop→start 双循环 | ✅ 已修（runId token） |
| P1-6 畸形 JSON 不可重试 | ✅ 已修（`AGENT_REPLY_MALFORMED` 稳定标记） |
| P1-7 停止不取消在途命令 | ❌ **未修**（`ipc.agentCancel` 全仓无调用点，见 F7） |
| P1-5 无 token 预算 | ❌ **未修**（见 F8） |

---

## 一、架构判定：骨架对，三个关键接口没接上

五层分工本身没有问题，和主流做法（Claude Code 的 TodoWrite + 权限模式、OpenHands 的 planner/executor、SWE-agent 的 task+action 双层）能对上：

- **Planner**：一次调用产出整份有序计划 → ✅ 已实现（`agent_plan` / `parse_plan`）
- **Policy**：范围授权 → ⚠️ 框架在，但**唯一有区分度的那个档位是死代码**（F1）
- **Executor**：持久 shell，cd/export 跨步保留 → ✅ 已实现（`agent_shell.rs` 单行协议 + 哨兵帧）
- **Verifier**：Rust 判定断言，模型不能自判完成 → ✅ 已实现（`verify_expectation` 纯函数 + 20 个单测）
- **State**：cwd / 事实 / 假设 / 失败回灌 → ✅ 已实现（`buildGoalWithMemory`）

**问题不在分层，在于层与层之间的三个"接口契约"没有闭合**：

1. Planner 产出「哪些步骤是验收标准」→ Executor 不知道 → Verifier 只能统计"通过了几条" → **完成判定退化为计数**（F6）
2. Policy 产出「授权范围」→ Executor 收不到 → **授权档位实际只有一种**（F1）
3. Executor 产出「命令真的跑了吗」→ Verifier 收到的是 `exitCode === null` → **null 被当成成功**（F4）

---

## 二、P0 缺陷（现在就会出错）

### F1 · 「批准计划」授权档位是死代码 —— 设置里选了也没用

**位置**：`src/store.ts:684`

```ts
let planApproved = policy === "plan";     // ← 恒等式：policy==="plan" 时恒为 true
```

紧接着 `src/store.ts:729`：

```ts
if (policy === "plan" && !planApproved) {  // ← true && false，恒为 false
```

**后果**：整段「计划审批」代码块永远不执行 →
- `planApproved` 永远为 true，但 `approvedCommands`（`src/store.ts:685`）**永远是空集**
- Policy 层的判定 `!(inApprovedPlan && planApproved)` 中 `inApprovedPlan` 恒为 false
- 于是所有非绿色命令都会走逐条审批 → **「批准计划后自动执行」与「每条写命令单独确认」行为完全相同**

设置页 `SettingsModal.tsx:554` 承诺的「预览整个计划并批准一次后，计划内命令不再逐条询问」**没有兑现**。同时用户也永远看不到"执行前先批准整份计划"这个闸门——计划生成后立刻开始执行（绿色命令直接跑）。

**引入点**：`ec50339`（五层 WIP），此后未修。

**修复**：

```ts
// src/store.ts:684 —— 授权状态只能由「用户真的批准了」置位
let planApproved = false;
const approvedCommands = new Set<string>();
```

`src/store.ts:729` 的条件不用动（改完即可达）。审批通过后 `planApproved = true` 并把 `plan.steps` 的 command 灌进 `approvedCommands` 的既有逻辑就自动生效。

> 附带：`approvedCommands` 用**命令字符串**做键，而 plan 阶段的 command 与后续重规划阶段的 command 只要有一处空格/引号差异就匹配不上。建议改为**计划步骤 id** 绑定（重规划阶段产出的命令不在计划内 → 走逐条审批，这是设计意图）。

---

### F2 · 模型"空喊 done"会进入无界循环

**位置**：`src/store.ts:1021` / `1048-1057`

```ts
while (mode === "reactive" && stepNo < MAX_STEPS) {
  ...
  if (out.action === "done") {
    if (verifiedCount >= 1) { /* 收工 */ return; }
    requireVerification = true;
    continue;                 // ← 既不 stepNo++，也不 recoveryFails++
  }
```

**复现路径**：
1. 计划阶段某步失败 → `mode = "reactive"`，此时 `verifiedCount === 0`
2. 模型返回 `{"action":"done"}` → 因为 `verifiedCount < 1`，走 `requireVerification = true; continue`
3. 下一轮模型被强制要求返回 verify，但它仍然返回 `done`
4. `stepNo` 没有增加（`stepNo` 只在 `runAction` 里自增），`recoveryFails` 也没增加 → **while 条件恒成立**

**后果**：无限次调用 LLM，每次都带完整历史（见 F8），既烧钱又没有墙钟上限。这正是 `AGENT-REVIEW.md` 里"没有停止条件的循环就是事故"的典型样本——`MAX_STEPS` 在这里**保护不了**，因为空喊 done 根本不消耗步数。

**修复**：

```ts
// src/store.ts:1019 附近
let requireVerification = false;
let recoveryFails = 0;
let unprovenDone = 0;        // ← 新增：模型空喊 done 的次数
const MAX_UNPROVEN_DONE = 3;

...
if (out.action === "done") {
  if (verifiedCount >= 1) {
    set({ agentStatus: "done" });
    audit("done");
    return;
  }
  requireVerification = true;
  unprovenDone += 1;
  if (unprovenDone >= MAX_UNPROVEN_DONE) {
    set({
      agentStatus: "failed",
      agentError: `模型连续 ${unprovenDone} 次声称完成，但始终没有任何断言通过校验，任务中止。请人工核对。`,
    });
    audit("failed");
    return;
  }
  continue;
}
```

---

### F3 · 命令超时被当成"可能已执行"，整任务中止

**位置**：`src-tauri/src/agent_shell.rs:287` + `src/store.ts:846/872`

Rust 侧：

```rust
let maybe_executed = written && exit_code.is_none();
```

超时路径下 `written == true`（字节已送达）且 `exit_code == None`（没等到退出码）→ `maybe_executed = true`。
前端 `src/store.ts:872` 一旦看到 `maybeExecuted` 就直接 `fatal`：

```ts
set({ agentStatus: "failed", agentError: "通道在返回结果前断开：最后一条命令可能已在远端执行。…" });
```

**后果**：**任意一次命令超时都会让整个 Agent 任务以"可能已执行，请人工核实"中止**。而超时在真实运维里非常常见（`apt-get install` 90 秒、默认超时 60 秒；`journalctl -f`；`systemctl restart` 卡住）。

两个概念被合并成了一个布尔量：
- `timed_out` = 我主动放弃了这次等待
- `shell_gone`（写后断开）= 命令的命运未知

对**只读**命令，超时只是"没读到结果"，重试无害；对**写**命令，未知才是危险。当前实现对两者一视同仁地中止。

**修复（Rust 侧区分语义）**：

```rust
// src-tauri/src/agent_shell.rs:287
// 超时是"我放弃了等待"，与"写完后通道断开"（命令命运未知）不是一回事。
// 超时由 timed_out 单独表达，maybe_executed 只保留真正未知的场景。
let maybe_executed = written && exit_code.is_none() && !timed_out;
```

**修复（前端按风险分级处理）**：

```ts
// src/store.ts:872 附近
if (resp.maybeExecuted) {
  // 命运未知的写操作：必须停，绝不重放。
  set({ agentStatus: "failed", agentError: "…" });
  audit("failed");
  return { ok: false, verified: undefined, fatal: true };
}
if (resp.timedOut) {
  // 超时：只读命令可以安全重来一次；写命令按"未知"处理。
  output += "\n（命令超时：只读命令可安全重试；写操作请先核实远端状态）";
  if (assessment.level !== "green") {
    set({ agentStatus: "failed", agentError: "写操作超时，远端状态未知，任务已中止。请人工核实。" });
    audit("failed");
    return { ok: false, verified: undefined, fatal: true };
  }
}
```

---

### F4 · `exitCode === null` 被当成执行成功

**位置**：`src/store.ts:949`

```ts
const ok = kind === "verify" ? verified === true : exitCode === null || exitCode === 0;
```

`exitCode === null` 表示**没拿到退出码**（命令没跑完 / 通道在写入前就死了）。把它算作成功，会导致：

- 该步骤被记为 `doneIds`，**依赖它的后续步骤照常执行**
- `commands.rs:1256` 的"shell 在写入前已死 → 安全重开一次"路径，若重开后仍失败，最终返回 `written=false, exit_code=None` 的 resp → 前端判 ok=true → **步骤被静默标记为已完成，实际什么都没执行**

**修复**：

```ts
// src/store.ts:949 —— 未知退出码不等于成功
const ok = kind === "verify" ? verified === true : exitCode === 0;
```

并在 `runAction` 里把 `timedOut` / `shellGone` 显式纳入失败判定（配合 F3）。

---

## 三、P1 缺陷（功能不达预期）

### F5 · RED 命令仍然弹"批准执行"，然后必然被拒

**位置**：`src/store.ts:799`

```ts
if (!(isGreen && autoGreen) && !(inApprovedPlan && planApproved)) {
  const ok = await requestApproval(action.command, action.description, assessment.level, …);
```

`assessment.level === "red"` 也会进审批框（UI 显示"高危命令，需要你确认"）。用户点批准 → 前端传 `user_ack="approved"` → `commands.rs:1067` 的 `execution_gate` **无条件拒绝 RED** → 用户刚点的按钮必然失败。

而且 Rust 的拒绝文案说"如确需执行请在终端中手动输入"——Agent 跑在**独立持久 shell 通道**（`commands.rs:1223`），用户在可见终端里手动输入对该通道无效，文案是错的。

**修复**（前端先判，Rust 仍作为最终权威）：

```ts
// src/store.ts:797 附近
if (assessment.level === "red") {
  // 黑名单永拒：不要问用户要不要批准一个必然失败的命令。
  memory.failedAttempts.push(`${action.command} → 命中黑名单「${assessment.rule}」，已拒绝`);
  setMemory({});
  // 记为该步失败，交给重规划换一条路，而不是直接终止整个任务。
  return { ok: false, verified: undefined };
}
```

Rust 侧文案同步修正：

```rust
// src-tauri/src/commands.rs:1068
"已拒绝执行：命中黑名单规则「{}」——{}。该命令风险过高，Agent 不会执行；如确需执行请在可见终端中手动输入。",
```

### F6 · 完成判定是"数到 1"，不是"目标达成"

**位置**：`src/store.ts:1112-1128`

```ts
if (assertCount === 0) { /* 失败 */ }
if (verifiedCount === 0) { /* 失败 */ }
set({ agentStatus: "done" });
```

只要**任意一步**断言通过就算完成。对"分析服务器装了哪些应用"这类任务，`cat /etc/os-release` 的 `exit_code=0` 就能满足 `verifiedCount >= 1`，随后模型返回 done → UI 显示"任务完成"。

`verify_expectation` 里 `exit_code: Some(0)` 单独就能构成一次"通过"，`not_contains` 也能（`agent_plan.rs:188` 的 `checked > 0`）。**证据强度没有分级。**

上一轮评审 §5.2 给的判据是"**计划中所有必需步骤的断言全部通过**"，当前实现退回了计数。

**修复**（引入计划级验收标准）：

1. Rust `PlanStep` 增加 `required: bool`（`agent_plan.rs`）：

```rust
/// 该步骤是否为「验收标准」。done 要求所有 required 步骤断言通过。
#[serde(default)]
pub required: bool,
```

2. `AGENT_PLAN_PROMPT`（`ai.rs`）要求模型标注：

```
{"id":1,"intent":"…","command":"…","expect":{…},"risk_hint":"read","depends_on":[],"required":true}
```
并补一条规则：`至少一步 required=true，它必须直接验证运维目标本身（例如"已安装包清单非空且含关键包"），而不是"命令执行成功"。`

3. 前端完成闸门改为：

```ts
// src/store.ts:1112 附近
const requiredIds = plan.steps.filter((s) => s.required).map((s) => s.id);
const requiredPassed = requiredIds.filter((id) => doneIds.has(id)).length;
if (requiredIds.length === 0) {
  set({ agentStatus: "failed", agentError: "计划中没有标注验收步骤（required），无法确认目标是否达成，任务中止。" });
  audit("failed");
  return;
}
if (requiredPassed < requiredIds.length) {
  set({
    agentStatus: "failed",
    agentError: `验收步骤未全部通过（${requiredPassed}/${requiredIds.length}），任务中止。请人工核对。`,
  });
  audit("failed");
  return;
}
```

> 注：`required` 步在重规划阶段若被改写，需要同步更新 `requiredIds` 与 `doneIds`，否则会因为计划外的等价验证而误判失败。这一层建议同时保留"全局至少一条断言通过"的兜底，避免过度严格。

### F7 · 「停止」不取消在途命令，且会被改写成「失败」

- `ipc.agentCancel` 在 `src/` 下**没有任何调用点**（只有 `src/ipc.ts` 里的定义）→ `stopAgent` 只改前端状态，远端命令继续跑完。
- reactive 循环的 `while` 条件里**没有 `alive()` 检查** → 用户点停止后，循环仍会继续调用 LLM（最多再 8 次，因为 `runAction` 里的 `alive()` 会让 `recoveryFails` 累加）。
- 终止时 `recoveryFails >= 8` 的分支会 `set({ agentStatus: "failed" })`，**覆盖用户看到的"已停止"**，并弹一句"多次重规划仍未达成一致"。

**修复**：

```ts
// src/store.ts:1021 —— 循环顶部加存活检查
while (mode === "reactive" && stepNo < MAX_STEPS) {
  if (!alive()) return;          // ← 新增
  ...
}

// src/store.ts:1131 stopAgent —— 真正取消远端命令
stopAgent: () => {
  const resolve = get()._agentResolve;
  const sid = get().sessionId;
  set({ agentStatus: "stopped", agentApproval: null, _agentResolve: null });
  resolve?.(false);
  if (sid !== null) void ipc.agentCancel(sid).catch(() => {});
  ...
},
```

以及所有 `set({ agentStatus: "failed" })` 分支前加一道 `if (get().agentStatus === "stopped") return;`。

### F8 · 重规划历史无上限（O(n²) 且可能撑爆上下文）

`executed` 数组每步追加一条，每条 `trimForAi` 后仍可达 6000 字符；reactive 每一轮把**全部** `executed` 重发给模型（`src/store.ts:1026`）。24 步 × 6000 ≈ 144 KB ≈ 4 万 token，**每轮重发一次**。后端 `run_agent_step`（`ai.rs:552`）逐条拼进 user message，没有任何总量上限。

结果是：任务越到后面越慢越贵，且容易超出模型上下文窗口 → 触发 `重规划失败` 直接终止。

**修复**：加总量预算 + 滚动窗口。

```ts
// src/store.ts —— 历史裁剪
const HISTORY_CHAR_BUDGET = 24000;
const trimHistory = (list: import("./types").AgentStepHistory[]) => {
  const kept: typeof list = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const cost = s.command.length + s.output.length + s.description.length;
    if (total + cost > HISTORY_CHAR_BUDGET && kept.length >= 2) break;
    kept.unshift(s);
    total += cost;
  }
  return kept;
};
```
调用处改为 `ipc.agentStep(sessionId, goalWithMemory, trimHistory(executed), …)`。

同时 `buildGoalWithMemory` 已经只保留最近 6~8 条事实/假设，方向是对的。

### F9 · Planner 看不到 Agent 通道的真实 cwd

`ipc.agentPlan(sessionId, goal, profileId)`（`src/ipc.ts:130`）**不传 cwd**，Rust 侧 `commands.rs:1356` 用的是连接时一次性探测的 `system_info.cwd`。
而 reactive 阶段通过 `agent_cwd` 传了实时 cwd（`commands.rs:620`）。

后果：**第一份计划是在一个可能已失效的目录假设下生成的**（用户此前在可见终端里 `cd` 过、或 `/home/user` 与 `/root` 不同），相对路径命令直接跑错目录。

**修复**：`agent_plan` 增加 `agent_cwd` 参数，前端传 `memory.cwd || 启动时的真实 cwd`（可在 `startAgent` 时用 `ipc.execOneshot(sessionId, "pwd")` 探一次，或复用 `agent_exec` 的 cwd 返回）。

### F10 · 计划阶段"未执行的步骤"被静默吞掉

`src/store.ts:989-995`：`pickIdx === -1` 且 `failedIds.size === 0` 时直接 `break`。若某步的 `depends_on` 指向不存在的 id，它永远不可运行，且**不会产生任何提示**——最终可能因为别的步骤有一条断言通过而报"任务完成"。

**修复**：把"因依赖不可满足而跳过"的步骤 id 收集起来，在完成闸门里作为警告输出：

```ts
if (skippedIds.size > 0) {
  set({ agentError: `有 ${skippedIds.size} 个计划步骤因依赖无法满足而未执行，请核对计划。` });
}
```

---

## 四、P2（技术债 / 架构建议）

| # | 项 | 说明 |
|---|---|---|
| P2-1 | **控制器放在前端** | 整个 agentLoop 在 `store.ts`（浏览器进程）。窗口刷新 = 任务丢失；无服务端审计。建议把控制器下沉到 Rust，前端只订阅事件。 |
| P2-2 | **无墙钟预算 / 无 token 预算** | 只有 `MAX_STEPS=24`。单步最长 300s → 最坏 2 小时。需要整体墙钟上限 + token 上限（C5 要求的三要素只满足了一个）。 |
| P2-3 | **并发执行缺失** | 无依赖的步骤仍串行。属于优化项，不是缺陷。 |
| P2-4 | **UI 只显示输出末 4 行** | `AiSidebar.tsx:540`。用户审批时看不到上文，建议折叠展开看全文。 |
| P2-5 | **`action` 无后端白名单** | Rust 侧 `pub action: String`，未知 action 会被前端防御分支兜住，但建议 Rust 也校验枚举。 |
| P2-6 | **计划外命令不追加进计划** | 重规划阶段产生的命令即使被批准，也不在 `plan.steps` 里，UI 上"计划"视图与实际执行不一致。 |
| P2-7 | **`profileId` 整轮冻结** | 任务中途切模型对当前任务无效（可接受，但应在 UI 提示）。 |

---

## 五、修复优先级与落地顺序

| 批次 | 条目 | 理由 |
|---|---|---|
| **第一批（必须）** | F1、F2、F4 | F2 是无界循环（烧钱+卡死）；F1 让授权档位形同虚设；F4 会静默假成功。三处都是**几行改动**，风险极低。 |
| **第二批（必须）** | F3、F5 | 关系到"任务莫名中止"和"必然失败的审批按钮"，属体验硬伤。 |
| **第三批（强烈建议）** | F6 | 完成判定的语义正确性，是"Agent 能不能真正自动运维"的分水岭。 |
| **第四批** | F7、F8、F9、F10 | 稳定性与成本。 |
| **第五批（架构）** | P2-1、P2-2 | 控制器下沉 Rust + 完整预算三件套。 |

---

## 六、验收标准（修复后应逐条可验证）

- [ ] 设置选「批准计划后自动执行」→ 计划生成后弹出**整份计划**的审批框 → 批准后计划内写命令不再逐条询问
- [ ] 模型连续返回 `{"action":"done"}` 且无断言通过 → **在第 3 次时中止**，不再继续调用 LLM
- [ ] 只读命令超时 → 任务**不中止**，步骤标记失败并进入重规划
- [ ] 写命令超时 → 任务中止，提示人工核实远端状态
- [ ] 命令未真正执行（通道写入前死）→ 步骤**不得**被标记为完成
- [ ] 计划命中黑名单命令 → **不弹审批框**，直接拒绝该步并交给重规划换路
- [ ] 目标为"分析已安装应用"，但关键验证步失败 → **不得**显示"任务完成"
- [ ] 任务运行中点「停止」→ 远端命令被取消，状态保持"已停止"（不被改写为"失败"）
- [ ] 24 步任务的重规划请求体 → 单次不超过 24k 字符
- [ ] 第一份计划里的相对路径命令 → 落在 Agent 通道的真实 cwd 下

---

## 七、复核方法说明

本轮每条缺陷均按"**构造复现路径 → 定位到具体行 → 判断触发条件是否现实**"三步复核，未依赖上一轮评审的结论；上一轮 15 条缺陷逐条重新验证了修复状态（上表）。
静态检查：`npx tsc --noEmit` → 0 error（当前前端类型干净）。
Rust 侧单测（`cargo test`，需 CI 环境执行）现有覆盖：`agent_plan.rs` 20 个（断言语义/描述检测/正则/注入）、`agent_shell.rs` 16 个（哨兵帧/协议泄漏/单行包装）、`ai.rs` 12 个（解析降级/不可信包裹）。**F1/F2/F4/F7 属前端逻辑，当前无测试覆盖，建议随修复补上。**

---

## 九、修复实施记录（2026-10-24）

全部 F1–F10 已实施，并把**决策逻辑从内联表达式抽成纯函数模块** `src/agentPolicy.ts`——
原先这些规则藏在一个 1200 行的 `store.ts` 里，任何测试都够不着，所以它们坏了几个月才被发现。

### 9.1 改动清单

| 条目 | 修复位置 | 做法 |
|---|---|---|
| **F1** 授权范围失效 | `agentPolicy.ts::isPlanApprovalRequired` / `mayRunUnattended`；`store.ts` `planApproved = false` | 授权状态只由用户真实批准置位；审批框现在展示**命令原文**并标注〔验收步骤〕 |
| **F2** 无界循环 | `agentPolicy.ts::judgeDoneClaim`；`store.ts` `unprovenDone` 计数（上限 3） | 空喊 done 连续 3 次即中止并给出明确原因 |
| **F3** 超时误判 | `agent_shell.rs::is_ambiguous_execution`（新增纯函数 + 3 个单测）；`store.ts` 分级处理 | 超时不再被算作「可能已执行」：只读命令→该步失败继续重规划；写操作→中止并交人工核实 |
| **F4** 未知退出码算成功 | `agentPolicy.ts::stepSucceeded` | `exitCode === null` 一律判失败；`pty` 步单独处理 |
| **F5** RED 必然失败的审批 | `store.ts` RED 前置拒绝 | 不再弹「批准执行」；该步直接拒绝并进入重规划换路 |
| **F6** 完成判定过弱 | `agent_plan.rs` 新增 `PlanStep.required`；`ai.rs` 提示词第 9 条；`agentPolicy.ts::resolveAcceptanceIds` / `isAcceptanceSatisfied` | 完成 = **验收步骤断言全通过** + **证据是新鲜的**（晚于最后一次失败）+ 全部 required 步通过或重规划阶段产出新的通过验证 |
| **F7** 停止不生效 | `store.ts` `stopAgent` 调用 `ipc.agentCancel`；循环顶部 `alive()` 检查；`failTask` 守卫 | 点「停止」会真正取消远端命令，终态不再被改写成「失败」 |
| **F8** 历史无上限 | `agentPolicy.ts::trimHistory`（24k 字符预算） | 重规划只回灌最近的步骤，历史不再 O(n²) 膨胀 |
| **F9** Planner 拿不到真实 cwd | `ipc.ts::agentPlan` 新增 `agentCwd`；`commands.rs::agent_plan` 接收 `agent_cwd`；`store.ts` 规划前探一次 `pwd` | 首份计划即基于 Agent 通道的真实目录 |
| **F10** 跳过的步骤被吞掉 | `agentPolicy.ts::pickRunnableStep` 返回 `skipped`；`store.ts` 写入 `agentNotice` | 依赖不满足的步骤会在 UI 上明确告知 |
| **P2-2** 无预算 | `store.ts` `MAX_LLM_CALLS=40` / `MAX_WALL_MS=15min`；`agentPolicy.ts::isOverBudget` | 模型调用数与墙钟双上限 |
| **P2-5** 死代码 | 删除 `store.ts` 中未使用的 `byId` | — |

### 9.2 新增测试

- `src/agentPolicy.test.ts` — **24 个 vitest 用例**，逐条覆盖 F1/F2/F4/F6/F8/F10 与预算判定。
- `src-tauri/src/agent_shell.rs` — 3 个单测覆盖 `is_ambiguous_execution`（超时≠命运未知）。
- `src-tauri/src/agent_plan.rs` — 1 个单测覆盖 `required` 解析。
- CI 新增 `web-test` job（`tsc --noEmit` + `vitest run`），`build` job 现在依赖 `test` + `web-test`。

### 9.3 验证

```
npx tsc --noEmit      → 0 error
npx vitest run        → 24 passed
npm run build         → ✓ built（前端产物正常）
cargo test            → 由 CI 验证（本地无 Rust 工具链）
```

### 9.4 遗留（未做，需单独排期）

- **P2-1 控制器下沉 Rust**：整个 agentLoop 仍在 `store.ts`（渲染进程）。窗口刷新 = 任务丢失、无服务端审计。
  这是本轮唯一未实施的结构性改动——它会重写整个控制流，风险远高于修 bug，建议独立立项。
- **P2-3 并发执行**、**P2-4 UI 展开全文**、**P2-6 计划外命令追加进计划**、**P2-7 运行中切模型提示**：均为体验增强项。
- **验收证据强度的残余弱点**：重规划阶段产出的验证虽由 Rust 判定，但断言内容仍由模型书写，
  理论上仍可用弱断言蒙混。要根治需引入「验收断言白名单/模板」或第三方交叉校验，属独立课题。
