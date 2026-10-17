# AI SSH Assistant

安装包 ≤ 30MB 的跨平台 SSH 客户端。用户自带 API Key 接入主流大模型，AI 先识别终端输出的结构化状态，再给出诊断与可执行命令。**命令永不自动执行**——AI 生成的命令只写入输入行，Enter 由用户按下。

## 核心安全设计

| 约束 | 实现 |
|---|---|
| HC-01 体积门控 | CI `scripts/size-gate.mjs`：Win ≤30MB / macOS ≤40MB / Linux ≤35MB |
| HC-02 凭据不落盘 | API Key / SSH 密码仅存 OS Keychain（`keyring` crate），日志经脱敏过滤器 |
| HC-03 永不自动执行 | AI 响应路径产出纯数据（`ai.rs`），预填充不发送 `\r`/`\n`（源码级测试断言） |
| HC-04 直连 base_url | `reqwest` 直接请求用户配置端点，仅允许 https |
| HC-05 原始字节不进 LLM | Rust 管线：ANSI 归一化 → 屏幕重建 → 错误提取 → 上下文裁剪（≤6000 tokens） |

## 安全纵深（§5.5）

1. **黑名单硬拦截**（红，不可降级）：`rm -rf /`、`mkfs`、`dd of=/dev/sd*`、断电关机、`iptables -F` 等
2. **写操作识别**（黄）：系统路径写入、服务管理、包管理、权限变更、`git reset --hard`
3. **只读白名单**（绿）：`ls`/`cat`/`grep`/`docker ps`/`kubectl get` 等
4. **默认黄**：未命中任何规则的命令一律要求确认
5. **用户白名单**：仅精确匹配跳过确认，黑名单优先级永远最高

TOFU 主机密钥验证：首连展示 SHA256 指纹需显式信任；密钥不匹配硬失败，不提供任何绕过按钮。

## 开发

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 构建
cargo test             # Rust 侧全部安全/管线单元测试
```

## CI

GitHub Actions（`.github/workflows/build.yml`）：三平台构建 + `cargo test` + `cargo clippy` + `cargo audit` + 体积门控，产物见 Actions Artifacts。
