# ADR-0004：分阶段演进 Session Storage 生命周期

- 状态：Accepted
- 日期：2026-07-16
- 适用里程碑：M4 / PR11

## 背景

M1 的 `SessionStore` 已提供单文件 JSONL、固定 inode 的单写者锁、全局事件顺序、
durable append 和进程崩溃恢复。它尚未提供有界扫描、rotation、quota、archive、
retention 和结构化恢复诊断。直接把这些职责继续加入 Store 会同时改变读取、写入、
迁移、清理和进程关闭语义，难以证明 crash consistency，也会降低代码可读性。

## 决策

PR11 分为四个顺序阶段：

1. PR11A 保持现有 `<sessionId>.jsonl + <sessionId>.lock` 布局，先抽出分块 scanner、
   稳定诊断、只读 doctor、checkpoint `throughSequence` 和 SIGTERM 安全关停。
2. PR11B 才引入 versioned segmented layout、旧 writer fence、rotation、record hard
   limit、session soft quota 和 operation critical reserve。
3. PR11C 以独立离线 lifecycle manager 实现 local archive/restore、retention plan、
   tombstone/trash 和跨进程目录额度协调。
4. PR11D 完成 Linux signal/crash gate、运行手册和真实 Provider 装配验证。

`SessionStore` 继续作为公开门面；scanner、segment storage 和 lifecycle manager 是独立
内部边界。Event schema 保持 v2，未来物理布局使用单独的 `layoutVersion`。manifest 只是
可重建索引，不是事件真相；所有全局不变量仍由 journal 连续扫描恢复。

固定 `<sessionId>.lock` inode 永不删除或替换。归档、恢复和 retention 必须先通过同一个
session lifecycle 协调协议；active writer、未对账 operation 和 pinned session 不自动处理。

PR11A 的当前版本 writer 按 fixed lock → canonical journal 获取两个进程生命周期 exclusive
flock，doctor 同序获取 non-blocking shared flock，释放时按 journal → fixed lock 反序执行。
第二把锁是在 fixed lock inode 被替换后的纵深防护，不会让旧二进制追溯获得 journal lock。
因此 PR11A 不支持新旧 writer 并行或滚动升级：必须先停止全部旧 writer、运行 doctor，再
启动新版本；让旧 writer 必然拒绝新布局的 storage-format fence 属于 PR11B。

quota 使用 regular soft limit 与 critical reserve 两层语义。durable
`operation.started` 只有在 terminal 与 materialization 的最坏记录空间已经原子预留后
才能 ack 并允许 dispatch。普通事件不得消耗该预留。

## 默认值

- 新记录 hard limit：1 MiB（最终 UTF-8 JSONL 字节，包含换行）。
- 既有记录兼容读取上限：16 MiB；超过上限 fail closed，交由显式离线迁移处理。
- segment target：16 MiB。
- regular session soft quota：64 MiB。
- critical reserve：16 MiB，并按 started operation 预留最多两个 hard-limit 记录。
- live directory admission：1 GiB；严格跨进程保证需要固定 lifecycle lock。
- 30 天未活动可归档；自动 purge 默认关闭，显式策略可设为归档后 180 天。
- timed group commit：关闭；留待 PR13 基于性能数据决定。

## 故障语义

- 只有唯一 active journal/segment 的 EOF 半行可在 exclusive writer lock 下截断。
- sealed segment、中间坏行、完整错误尾行、无效 UTF-8、sequence 缺口和重复 ID 均
  fail closed；diagnostic 不包含记录正文。
- archive publish 允许 crash 后暂时留下 live/archive 两份 canonical copy，但任何步骤
  都不得让两份同时消失。
- 第二次 SIGINT 与 SIGKILL 是异常退出路径；恢复协议负责收束，不把它们描述为优雅关闭。
- Provider/工具忽略取消并超过 grace timeout 时不承诺 flush；外部 supervisor 必须在其
  stop timeout 内回收完整进程树。
- one-shot `run` 被 SIGINT/SIGTERM 干净取消时分别退出 130/143，flush/close 失败退出 1；
  交互 `chat` 在 active turn 上第一次 SIGINT 只取消当前 turn，第二次才强制退出 130。
- PR11 继续只承诺进程崩溃恢复。目录 sync 和 rename fault test 不等于已经证明真实主机
  掉电耐久。

## 影响

- PR11A 不改变现有磁盘格式，降低第一批改动的兼容风险。
- rotation 和 archive 延后到各自具备 fence、fault injection 与 crash matrix 的阶段。
- Store 热路径不会承担 retention 和远程归档复杂度。
- 远程/跨文件系统 archive、压缩/加密 archive、NFS/distributed writer、数据库迁移、
  原地删除历史 Operation 事实和全文 session index 不属于 PR11。
