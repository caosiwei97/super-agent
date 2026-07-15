# ADR-0003：Unknown Outcome 与人工对账

- 状态：Accepted
- 日期：2026-07-15
- 适用里程碑：M0、M1B、M1C

## 背景

外部操作 dispatch 后发生进程崩溃、网络断开、超时或强制取消时，调用方通常无法证明副作用是否已经发生。把这种情况记录为失败并自动重试，可能重复执行付款、发消息、创建资源或覆盖文件。

## 决策

- `operation.started` 必须在 dispatch 前 durable 落盘。
- `failed` 只表示可以证明没有产生副作用，或下游明确事务性拒绝。
- `cancelled` 只适用于尚未 dispatch，或执行器可以证明没有开始执行。
- `started` 后发生 timeout、disconnect、crash、强杀或未知取消时，状态进入 `uncertain`。
- 恢复时所有遗留 `started` 追加为 `uncertain`，绝不自动重放。
- Durable `started` 后、真正 dispatch 前崩溃产生的“假 uncertain”是允许的；系统选择宁可要求对账，也不静默重复。
- 只有下游提供经过测试、仍在 TTL 内且明确允许 unknown-outcome retry 的幂等契约时，系统才可以自动重试。
- 对账优先调用只读 reconcile；不得通过再次执行写操作来猜测结果。
- unresolved `uncertain` 默认阻止 session 开始新 turn，直到用户通过 `ops resolve` 或等价 API 追加 reconciliation 事件。
- terminal event 必须保存脱敏、截断后的 model-facing result 或耐久引用。terminal 已存在但 tool-result 缺失时，恢复过程使用确定性事件 ID 补建一次。

## 影响

- 系统不承诺通用 exactly-once，而是承诺不 silent replay。
- 少数没有对账能力的操作会要求人工确认。
- M1 必须提供最小对账入口，否则 fail-closed 会让 session 永久不可继续。
- Crash matrix 必须覆盖 durable started 前后、dispatch 前后、terminal event 前后和 tool-result 前后的窗口。
