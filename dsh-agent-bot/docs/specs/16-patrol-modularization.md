# patrol 模块化（状态回 frontmatter）

## 背景与目标

`src/model/teamwork/patrol.ts` 已膨胀为约 1100 行的 `createPatrol` 一体化闭包工厂，
内部定义了约 50 个闭包、持有 8 个进程内 `Map`。它同时承担巡检主循环、唤醒、交付、
审批问卷、任务锁、生命周期六类职责，违反 SRP / God Function。

目标：按 hub 的"文件为真相 + 职责单一模块"架构重构——把跨重启的持久状态迁回
`task-board.ts` 的 frontmatter，仅把 in-flight 并发去重与定时器句柄留在内存（hub 的
`waking`/`synthesizing` 两个 `Set` 同理）；闭合闭包拆成职责单一、可独立测试的模块。

## 状态迁移：进程内 Map → frontmatter / 留存内存

### 落盘（跨重启必须保留的持久语义）

仅两类状态有强持久需求；`notified` 的四条去重支线**不落盘**（见下）。

| 现状 Map | 语义 | 去向 |
|---|---|---|
| `probeRenew` | 活性续期计数 + `missingSince` 时间戳（`sessionId` 已有） | `assignee.renew: int`、`assignee.missingSince: int`（缺省 0） |
| `collecting.text` | lead 综合已产出、尚未投出去的文本 | `task.deliverText: string` |
| `collecting.attempts` | 收口投递重试次数 | `task.deliverAttempts: int`（缺省 0） |

落盘理由：`probeRenew` 若不落盘，重启后续期计数清零、专家可能永远判不死；
`collecting.text` 若不落盘，重启后已综合的产出丢失、任务僵在 running/ 永不交付。

### 留存内存（去重指纹 / in-flight 并发 / 定时器句柄 / 生命周期）

| 现状 | 说明 | 对齐 hub / 不落盘理由 |
|---|---|---|
| `notified`（wake/progress/ask/approval 四支） | 去重指纹 | 原代码明说"指纹存内存：重启补叫一次是要的恢复行为"；其余支线重启重复通知一条不致命，hub 的 `waking`/`synthesizing` 也是内存 `Set` |
| `delivering` / `deciding` | 同任务收口/拍板 job 只跑一次 | hub `synthesizing`（`Set`） |
| `collecting.firstSeq` | 综合轮起点事件序号，与活会话 seq 绑定 | hub 内存态 |
| `askTimers` / `deadlineTimers` / `lastScheduledDeadline` | `setTimeout` 句柄；`start()` 重建墙钟 | — |
| `relay.writeFence`（`holders`） | 进程内写锁，靠会话活性 reap | hub `fifo` 进程内 |
| `stopped` / `lastReconcileAt` | 巡检器生命周期 | — |

## 模块划分

保留现有：`task-board.ts`（扩展上述字段）、`binding.ts`、`board-tools.ts`、`handoff-task.ts`、
`relay.ts`（含 `WriteFence`，锁不迁）、`inbound.ts`。

`patrol.ts` 闭合闭包按职责拆为六个模块；`patrol.ts` 只留编排与主循环。

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `patrol.ts` | 巡检主循环 + **组合根编排**：`createPatrol` + 状态机（`patrolTask`/`probeTask`）+ 收口综合（`summarizeAndDeliver`/`retryDeliver`/`decidePendingAndClear`）+ 问卷审批动作（`watchAskUserQuestion`/`handOffAskToHuman`/`sendQuestionnaire`/`askHumanToDecide`）+ 去重叫醒（`wakeOnce`）+ 定时器调度；持有留存内存的瞬态 Map | `createPatrol` |
| `wake.ts` | 叫醒链**纯函数**：定位会话、完成情况指纹、叫醒文本、终态判定 | `hasPendingDownstream`、`wakeSessionIdFor`、`wakeFingerprint`、`wakeText`、`assigneeOf`、`shouldDeliver`、`isTerminal`、`terminalFingerprint` |
| `deliver.ts` | 发消息/通知：deliver 给 sender、进度反馈、审批通知、事件序号判定 | `deliverToSender`、`hasEventsAfter`、`notifyProgress`、`notifyApprovalWait` |
| `intercept.ts` | 审批/问卷**检测**：找挂起的审批与 `ask_user_question` | `openApprovals`、`openAskCalls`、`parseAskQuestions`、`ASK_TOOL_NAME` |
| `liveness.ts` | 生命周期/活性：拉起会话、叫醒、重启、救活 | `ensureLive`、`followup`、`restartExpert`、`reviveDead`、`agentAlive` |
| `fence.ts` | 任务锁/写队列：写锁释放、队列推进、恢复 waiting | `fenceDirOf`、`isWaitingForLock`、`releaseAndAdvance`、`advanceWriteQueue`、`resumeWaiting` |

深度依赖 patrol 共享状态（`synthesizing`/`notified`/定时器）与互相调用的编排函数
（`wakeOnce`/`summarizeAndDeliver`/`retryDeliver`/`decidePendingAndClear`/`probeTask`/问卷审批动作）
保留在 `patrol.ts` 作为组合根，避免依赖注入爆炸；它们调用叶子模块的纯函数与原子动作。

## 数据流与依赖

- 依赖方向自下而上：`task-board`/`binding` → `relay`/`wake`/`fence` → `deliver`/`intercept`/`liveness` → `patrol`（组合根）。
- `patrol.ts` 保留最小瞬态状态：`notified`/`synthesizing`/`delivering`/`deciding`/`askTimers`/`deadlineTimers`/`lastScheduledDeadline`/`stopped`。
- 所有写盘仍走 `patchTask`（重读→改→写），避免覆盖并发期间他人写回的内容。
- 续期计数与收口进度由 frontmatter 字段承担（`writeTask` 后即持久）；通知去重由内存 `notified` Map 承担。

## 行为约定

- **行为等价**：重构不改变状态机语义、事件入口、交付与超时策略。`patrol.test.ts` 现有用例是判定基准。
- **重启可恢复**：续期计数、收口进度在重启后不丢失；定时器由 `start()` 重建；通知去重指纹随进程重启丢失（按原语义补叫/补通知一次，可接受）。
- **纯函数优先**：叶子模块对外函数尽量无副作用，副作用限定在读/写 frontmatter 与 deliver/ensureAgent。

## 验收标准

1. `patrol.ts` 主循环不持有持久状态 Map（仅定时器句柄与 in-flight 去重）。
2. 六个职责模块各自 `typecheck` 通过，无循环依赖。
3. `patrol.test.ts` 及 teamwork 全套测试通过，行为与重构前一致。
4. 新增 frontmatter 字段（`renew`/`missingSince`/`deliverText`/`deliverAttempts`）可往返（marshal/unmarshal），旧文件缺字段时按缺省值兼容，不抛错。

## 已知边界与不做项

- 模块化当时不改状态机。超时策略后来改成 hub 方案：无等待上限、无续期、无任务墙钟；问卷天数 + 巡检间隔。见 [12](./12-leader-experts-teamwork.md)。
- 不迁移 `relay.writeFence`（进程内写锁，注释已明确体检活性 reap，不落盘）。
- 不调整 `board-tools.ts` / `handoff-task.ts` / `binding.ts` / `inbound.ts` 的既有接口。
- 不引入新的依赖或运行时框架。