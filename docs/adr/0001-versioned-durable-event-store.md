# ADR-0001：版本化 Durable Event Store

- 状态：Accepted
- 日期：2026-07-15
- 适用里程碑：M0、M1A

## 背景

当前 SessionStore 直接向 JSONL 追加消息和 checkpoint，没有全局事件序号、单写者锁和明确的 durable write 边界。Operation Ledger 如果使用独立文件，会引入“操作状态已写、消息未写”或相反的跨文件顺序问题。

## 决策

2.0 使用一个 session 对应一个有序 JSONL Event Store：

- Session Projection 与 Operation Ledger 保持逻辑接口分离，但物理事件共用同一个 journal。
- 所有 v2 事件包含 `schemaVersion`、唯一 `eventId`、单调 `sequence` 和 `timestamp`。
- 无 `schemaVersion` 的现有事件按 v1 读取；首次写 v2 前追加 upgrade marker，不原地重写旧日志。
- 同一 session 在进程生命周期内只允许一个 writer。对固定的 `0600` lock inode 持有内核 advisory exclusive lock；lock 文件不删除、不做 PID 判活，也不执行 stale unlink。进程退出或被强杀后由内核释放，第二个 writer 才能成功。
- 普通消息允许 buffered append；`operation.started`、operation terminal 和终止事件使用 durable append。
- Durable append 定义为：以 append 模式写入一条完整 JSONL 记录，随后完成 `fdatasync` 或 `fsync`，成功后才返回 ack。
- Event Store 写入失败后进入 fail-closed，不允许 dispatch 新的外部操作。
- v2 reader 发现中间损坏、完整错误尾行、sequence 缺口或重复 `eventId` 时停止自动恢复。只有 EOF 半行允许忽略或截断。

M1 只承诺进程崩溃后的恢复，不宣称已经覆盖主机掉电。主机掉电保证需要额外定义目录项和 rename 的 fsync 策略。

该锁只承诺本机文件系统上的协作进程互斥，不承诺 NFS 等远程文件系统语义。当前 Node 实现使用原生 `fs-ext`，安装环境需要可用的 native addon 构建工具链。

## 影响

- Operation 与消息拥有同一全序，恢复 reducer 可以重建确定状态。
- 单文件会继续增长，rotation、quota 和归档延后到 M4。
- 现有 v1 会话保持可读；旧版本程序不得继续写入已经升级为 v2 的会话。
- SessionStore 必须提供显式 `close()`，确保 flush 并释放 writer lock。
- 原生锁依赖增加了构建成本，但消除了 PID 复用和 stale lock 回收的 TOCTOU；这是 M1A 接受的可靠性优先取舍。
