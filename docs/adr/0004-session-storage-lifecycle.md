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

quota 使用 regular soft limit 与 critical reserve 两层语义。`operation.proposed` 在写入前
原子预留两个 hard-limit critical slot，覆盖 pre-start terminal 与 materialization；durable
`operation.started` 在 dispatch 前再增加一个 uncertain control slot。正常 terminal 释放
control 并保留一个 materialization slot；uncertain 消耗 control、保留两个 critical slot，
覆盖 reconciliation/supersede 与 materialization。reservation 由事件流恢复，不另写记录，
普通事件不得消耗该预留。

PR11B 将 layout、record stream、migration、segment storage 与 quota admission 拆成独立内部
模块；Store 只负责单写队列、事件封装和 projection。generation 严格由 legacy source
fingerprint 派生；fence 是唯一 commit point。迁移持有 fixed + legacy exclusive locks，预锁
fence temp，并在 rename 后复验 path/fd/bytes、fsync parent，才释放 legacy lock；fence lock
保持到 Store close。typed Operation/quota gate 在 staging 内、canonical publish 前完成；捕获的
pre-publish 失败删除本次 exact staging，后续持锁恢复仅回收严格命名的 abandoned staging。
bundle root、generation、segments、format 与 segment descriptor 从最后复验跨到 fence parent
fsync，observer hook 后再次复验；fence 前 legacy 是唯一真相，fence 后只采用其指定 generation。

segment catalog 由连续的 12 位 ordinal 文件名重建。rotation 顺序固定为 active fdatasync、
rename sealed、segments directory fsync、O_EXCL 创建下一 active、file/directory sync，再发布
可重建 manifest。sealed EOF fragment fatal；仅 active fragment 可由 exclusive writer 截断。
doctor 只读扫描 segment 事实，manifest 缺失、损坏或陈旧不改变权威状态。普通 manifest cache
发布失败不会否定已同步 event，unsafe metadata 仍 fatal，失败 temp 必须精确清理。writer 将
generation/segments directory 与 active descriptor pin 到 close，并在 ack 前复验；lazy recovery
失败先关闭局部 storage，只有完整恢复与 quota 校验成功才转移所有权。

## 默认值

- 新记录 hard limit：1 MiB（最终 UTF-8 JSONL 字节，包含换行）。
- 既有记录兼容读取上限：16 MiB；超过上限 fail closed，交由显式离线迁移处理。
- segment target：16 MiB。
- regular session soft quota：64 MiB。
- critical reserve：16 MiB；proposed operation 持有两个 hard-limit critical slot，started
  operation 另持有一个 hard-limit uncertain control slot。
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
- migration/rotation 的 throw-probe 测试称为 fault injection；只有实际子进程收到
  `SIGKILL` 的矩阵称为 process-crash recovery。两者都不扩张为 power-loss 证明。
- 跨 segment scanner、doctor 与 Store 在线诊断使用同一全局事实顺序；错误对外定位到实际
  segment 与 segment-local offset。manifest diagnostic 不得把失败重建误报为 `repaired`。

## 影响

- PR11A 不改变现有磁盘格式，降低第一批改动的兼容风险；PR11B 首次打开时在线迁移到
  layout v1，并以 invalid-JSON fence 防止旧 writer 形成 split brain。
- rotation 已在 PR11B 具备 fault injection 与真实进程崩溃矩阵；archive 仍延后到 PR11C。
- PR11B 本地非 CI 门禁为 447 tests（437 pass、10 platform skip、0 fail），PR11B 定向
  185/185，build/diff check 与 deterministic seccomp artifact 2/2 通过；真实
  migration/rotation `SIGKILL` 为 12+5 点。真实 Key E2E 在 512-byte target 下
  生成 10 个 segment，doctor 6→11 records 均 healthy，2 个 secret value 在输出与全部 bundle
  artifact 中 0 命中。target-Linux、OOM 与 power-loss 仍是独立 release gate。
- Store 热路径不会承担 retention 和远程归档复杂度。
- 远程/跨文件系统 archive、压缩/加密 archive、NFS/distributed writer、数据库迁移、
  原地删除历史 Operation 事实和全文 session index 不属于 PR11。
