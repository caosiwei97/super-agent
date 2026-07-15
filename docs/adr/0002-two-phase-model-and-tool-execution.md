# ADR-0002：模型生成与工具执行分为两个阶段

- 状态：Accepted
- 日期：2026-07-15
- 适用里程碑：M0、M1B

## 背景

当前 AI SDK 工具定义包含可执行回调。无需审批的工具可能在模型流尚未形成完整 assistant message 时被自动执行；需审批工具则由 Agent Loop 在流结束后手工执行。两条路径使副作用、审批、消息提交和崩溃恢复无法共享一个稳定顺序。

## 决策

模型阶段和执行阶段必须显式分离：

1. ModelGateway 只负责生成文本和完整 tool call，不调用工具实现。
2. Agent Loop 持久化完整 assistant response 和 `proposed` operation。
3. ToolExecutionPipeline 完成校验、权限、审批和 durable `started`。
4. Execution Router 执行工具。
5. Pipeline 持久化 terminal operation，再物化 tool-result 消息。
6. Agent Loop 将 tool-result 加入下一次模型上下文。

所有内置、只读、需审批和 MCP 工具必须走同一个 Pipeline。ToolRegistry 逐步收敛为只读 Catalog，不再拥有权限、并发锁和副作用执行职责。

## 影响

- AI SDK 的自动 tool execution 必须关闭或替换为 schema-only 工具描述。
- 流式文本仍可展示，但任何可观察输出出现后，整个模型 attempt 不得从头静默重试。
- 工具调用吞吐可能略有下降，但持久化顺序、审批语义和恢复行为可以统一测试。
- M1B 已完成迁移：Agent Loop 只接收 schema-only tool set，旧的 AI SDK 自动执行兼容接口已删除；底层 dispatcher 标记为内部边界，仅由 Pipeline 调用。
