# Super-Agent

一个刻意保持小体量、但具备完整运行边界的 TypeScript Agent Demo。它包含多步 Agent Loop、工具审批与并发控制、循环检测、上下文双层压缩、可恢复会话、MCP 延迟加载和基础安全防护。

## 快速开始

```bash
pnpm install
pnpm build
pnpm link --global
super-agent --help
```

Session 单写者使用原生内核文件锁。源码安装需要 Python 与 C/C++ 编译工具链；锁语义面向本机文件系统，不支持把 session 目录放在 NFS 等远程文件系统上。

首次运行前从 `.env-example` 创建 `.env`：macOS/Linux 使用 `cp .env-example .env`，PowerShell 使用 `Copy-Item .env-example .env`。

包提供两套互不混淆的入口：

- `super-agent`：真正的可执行 CLI。`package.json#bin` 由 npm/pnpm 在 macOS、Linux 生成 POSIX shim，在 Windows 生成 `.cmd`/PowerShell shim。
- `import { ... } from 'super-agent'`：无启动副作用的 Node 模块入口，类型声明位于 `dist/index.d.ts`。

CLI 包含两个子命令：

```bash
super-agent chat
super-agent chat --continue --session <session-id>
super-agent run "只回复 OK"
super-agent run --prompt "只回复 OK"
super-agent run "执行可信的写操作" --yes
```

不希望全局 link 时，可以使用开发入口 `pnpm cli -- chat`，或在构建后直接运行 `node dist/bin/super-agent.js run "任务"`。

`run` 提供稳定的退出码，适合脚本、CI 和其他进程调用；`chat` 使用 Node `readline` 进入交互模式。两者共用同一个对话编排器。会话状态已经由 JSONL 持久化，因此跨平台核心运行不依赖 tmux。仅在 macOS/Linux 需要人工挂后台或随时接回终端时，可以把 tmux 作为外层托管：

```bash
tmux new-session -s super-agent 'super-agent chat --continue --session <session-id>'
```

`run` 不会等待交互审批。读写工具默认拒绝；只有在可信环境显式传入 `--yes` 才会自动批准。

## 开发与调试

日常开发直接通过 `tsx` 执行源码，不需要先 build：

```bash
pnpm dev -- chat
pnpm dev -- run "只回复 DEV_OK"
```

需要断点调试时启动 Node Inspector，然后在 IDE 或 `chrome://inspect` 中连接 9229 端口：

```bash
pnpm debug -- chat
pnpm debug -- run "调试任务"
```

全局 link 的 `super-agent` 指向 `dist/bin/super-agent.js`。源码变化后可以手动执行一次 `pnpm build`，或者在一个终端持续编译、另一个终端按需重新执行 CLI：

```bash
# 终端 1：仅编译，不自动重跑 Agent
pnpm build:watch

# 终端 2
super-agent run "测试最新构建"
```

这里刻意不对 Agent 进程做保存即重启：`run` 可能产生模型费用或外部写操作，自动重放并不安全。通过 npm/pnpm 安装的非 link 版本也不会跟随本地源码变化，需要重新 build、打包并安装新版本。

质量检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

当前 M1 可靠性验收在 POSIX 平台包含 11 个真实子进程 `SIGKILL` 注入点；Windows 会显式跳过这组用例。它们覆盖 `proposed`、`approved`、`started` write/datasync、dispatch、副作用、terminal、tool-result 与 checkpoint 之间的崩溃窗口，并在 fresh writer 上重复恢复以验证无静默重放和结果物化幂等。

## 运行链路

```mermaid
flowchart TD
    Module["index.ts\nNode 模块入口（无副作用）"] --> PublicAPI["可复用 API\nRunner / Registry / Store"]
    Bin["bin/super-agent.ts\n跨平台可执行入口"] --> CLI["CLI Main\nrun / chat"]
    CLI --> Runner["ConversationRunner\n单轮事务边界"]
    PublicAPI --> Runner
    CLI --> Cancel["Root AbortController\nSIGINT + Turn Deadline"]
    Cancel -.-> Runner
    Runner --> Compact["Context Compactor\nMicrocompact + LLM Summary"]
    Runner --> Recovery["Recovery Coordinator\nuncertain gate / reconciliation"]
    Runner --> Loop["Agent Loop\nSchema-only model phase"]
    Loop --> Model["ModelGateway\nStable requestId + Commit Guard"]
    Model --> Provider["LLM Provider"]
    Model --> Audit["Model attempt audit\nstarted / failed / retried / completed"]
    Runner --> Store["SessionStore\nVersioned JSONL Event Store\n单写者锁 + Durable Append"]
    Audit --> Store
    Recovery --> Store
    Loop --> Pipeline["ToolExecutionPipeline\n唯一运行时执行入口"]
    Pipeline --> Registry["ToolRegistry Catalog / Dispatcher\nSchema、Ajv 校验、读写锁"]
    Pipeline --> Ledger["Operation Ledger\nproposed → started → terminal"]
    Ledger --> Store
    Registry --> Builtin["Builtin Tools\nFile / Shell / Web / Preview"]
    Registry --> MCP["MCP Tools\n运行时注册 + 延迟发现"]
    Builtin --> Process["ProcessExecutor\nOutput Bound + Process Group Reaping"]
    Cancel -.-> Compact
    Cancel -.-> Model
    Cancel -.-> Pipeline
    Cancel -.-> Registry
    Cancel -.-> MCP
    Cancel -.-> Process
    Pipeline --> Guard["Result Guard\n截断 + 结构化/文本嵌套脱敏"]
    Guard --> Store
```

一轮对话按以下顺序执行：

1. 用户消息先写入 append-only JSONL，再进入内存上下文。
2. 发送模型前执行压缩；若上下文或预算发生变化，立即写 checkpoint。
3. `AgentLoop` 每个 step 都重建 system prompt 和活跃工具集合；ModelGateway 集中处理稳定 requestId、deadline 和 retry。
4. text delta 或完整 tool call 一旦对用户可见，当前 attempt 失败时不再整体重试；每次 attempt 写入脱敏审计事件。
5. 完整 assistant response 先写入 journal；持久化失败时不创建 operation、不执行工具。
6. Pipeline 严格校验输入并写入 `proposed/approved`；dispatch 前必须获得 durable `started` ack。
7. 只读且并发安全的工具可并行；写工具、未知能力和 MCP 默认串行并需审批。
8. terminal event 立即持久化并物化恰好一条 tool-result；未知结果进入 `uncertain`，不会伪造失败结果或继续模型 step。
9. root signal 和 absolute deadline 贯穿模型、摘要、审批、锁、Pipeline、Web、MCP 与子进程；dispatch 前取消落 `cancelled`，durable `started` 后未知结果落 `uncertain`。
10. 下一 step 前再次压缩；Agent Loop 结束后执行最后一次压缩并写恢复 checkpoint。

因此，会话文件同时保留两种视图：原始 `messages` 事件用于审计，最新 checkpoint 用于恢复压缩后的工作上下文。旧版分离的 `message`/`budget` JSONL 仍可继续读取。

## 上下文压缩

压缩分两层：

- Microcompact：清除较旧且可重建的读取/搜索类工具结果，保留写入和编辑结果。
- LLM Summary：超过阈值后，把旧的完整用户轮次滚动合并为结构化摘要，保留最近消息。

压缩会在 `before-turn`、`between-steps`、`after-turn` 三个时机运行。摘要调用也计入预算；预算耗尽后仍允许免费的 Microcompact，但不再发起摘要模型请求。摘要只有在合法、未超长且确实缩小上下文时才会替换原消息。

## 目录职责

| 目录/文件 | 职责 |
| --- | --- |
| `src/index.ts` | 无副作用的 Node 模块入口，集中导出稳定 API |
| `src/bin/super-agent.ts` | CLI 可执行入口、dotenv 加载和进程退出码 |
| `src/cli/main.ts` | Composition Root，装配配置、模型、工具和会话 |
| `src/agent/conversation-runner.ts` | 对话轮次编排、压缩时机、持久化边界 |
| `src/agent/agent-loop.ts` | 多 step 推理、重试、审批、预算和事件通知 |
| `src/agent/loop-detection.ts` | 每次 Agent Loop 独立的重复、乒乓和无进展检测 |
| `src/context/` | Prompt 组装与上下文压缩 |
| `src/core/tool-registry.ts` | 工具 Catalog、严格 schema 校验、内部 dispatch、并发锁和生命周期 |
| `src/execution/` | Operation Ledger、Tool Execution Pipeline、恢复 gate、结果物化与显式对账 |
| `src/core/workspace.ts` | 文件工具的工作区路径与 symlink 边界 |
| `src/session/store.ts` | 版本化 append-only JSONL、单写者锁、durable append 和 checkpoint 恢复 |
| `src/tools/` | 内置工具和真实 MCP 工具的延迟发现 `tool_search` |
| `src/mcp/` | GitHub 托管 Streamable HTTP MCP 客户端 |
| `src/cli/` | 子命令解析、run/chat 执行、终端展示和人工审批 |

## 配置

所有运行参数都集中由 `src/core/config.ts` 校验。主要环境变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | OpenAI-compatible Provider 密钥 |
| `MODEL_BASE_URL` | `https://api.deepseek.com` | Provider Base URL |
| `MODEL_ID` | `deepseek-v4-flash` | 模型 ID |
| `TOKEN_BUDGET` | `1000000` | 会话累计 token 上限 |
| `AGENT_MAX_STEPS` | `15` | 单轮最大 step 数 |
| `AGENT_MAX_RETRIES` | `10` | 每个模型请求的重试次数，可为 0 |
| `AGENT_TURN_TIMEOUT_MS` | `120000` | 单轮总墙钟上限，形成贯穿模型、审批和工具的 absolute deadline |
| `MODEL_REQUEST_TIMEOUT_MS` | `60000` | 单次模型 request 的上限，同时受 turn deadline 约束 |
| `CONTEXT_TOKEN_THRESHOLD` | `12000` | 触发摘要的估算 token 阈值 |
| `CONTEXT_KEEP_RECENT_MESSAGES` | `8` | 摘要后保留的最近消息数目标 |
| `CONTEXT_KEEP_RECENT_TOOL_MESSAGES` | `4` | 不做 Microcompact 的最近工具消息数 |
| `CONTEXT_MAX_SUMMARY_CHARS` | `1200` | 摘要最大字符数 |
| `SUPER_AGENT_WORKSPACE` | 当前目录 | 文件、Shell 和预览工具的工作区 |
| `SUPER_AGENT_AUTO_APPROVE` | `false` | 自动批准读写工具 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 无 | GitHub MCP 的 PAT；未配置时不接入 |

配置 PAT 后直接连接 GitHub 官方托管的远程 MCP，不启动本地 MCP 进程，也不需要安装任何 binary。MCP 工具默认按“可写、串行、需审批”处理，直到引入可信的能力元数据。

## 安全与工程边界

已实现的边界包括：

- 文件读写限制在显式 workspace 内，并检查已存在路径和父目录的真实路径。
- Web 抓取限制 HTTP(S)、常用端口、响应大小和重定向次数，并阻止本地/私网 DNS 结果。
- Shell、写文件、编辑、预览和 MCP 调用默认需要审批。
- GitHub token 只发送到代码中固定的官方 HTTPS MCP 地址。
- 工具结果长度、文件大小、搜索文件数和匹配数均有上限。
- Session journal 使用固定 lock inode 上的内核单写者锁、单调事件序号、`0700/0600` 权限和显式 durable append；旧版无版本 JSONL 仍可恢复。
- 每轮取消与 deadline 贯穿模型、摘要、审批、锁、Web、MCP 和工具；POSIX Shell 取消/超时会回收独立进程组，Windows 当前仅保证直接子进程终止。

当前实现仍不宣称提供 OS 级沙箱：获批的 Shell 仍拥有当前进程权限；DNS 校验与实际连接之间仍存在 DNS rebinding 的理论窗口。Pipeline/Recovery 已提供 durable-start、unknown-outcome fail-closed、流式 Commit Guard、统一取消、Crash Matrix 和人工对账，但不宣称下游通用 exactly-once。能力策略、生产沙箱、RE2/worker 隔离、模型 tokenizer、JSONL 归档/轮转和指标系统仍属于后续里程碑。

循环检测的细节见 [`src/agent/loop-detection.md`](src/agent/loop-detection.md)。

从当前 Demo 骨架演进到单机生产 Agent 内核的目标架构、里程碑和验收门槛，见 [`docs/production-agent-spec.md`](docs/production-agent-spec.md)。
