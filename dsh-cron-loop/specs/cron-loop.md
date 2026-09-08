# dsh-cron-loop — 项目级 cron 定时任务插件

## 背景与目标

DSH 内置的 automation/automation 工具是「全局/会话级」定时任务，缺少项目（workspace）维度：
任务不挂在某个项目目录上，也没有跨项目的任务中心。dsh-cron-loop 以 DSH 原生插件
（`dsh web --patch` 加载的 cordis 插件，参考 ruliu-dsh-plugin 的形态）补齐：

- 项目级定时器：每条 job 绑定一个绝对工作目录（cwd），到期后在该目录新开/续接一个
  DSH 会话并注入任务 prompt，由完整 agent loop 执行。
- Claude Code 风格命令：会话内 `/cron`、`/loop` 管理当前项目（按 agent cwd 归属）的定时任务。
- 任务中心页面：`http://127.0.0.1:3080/cron` 查看本地所有项目的任务列表、执行历史，
  并可新建/编辑/暂停/删除任务。

## 接口设计

### 存储（`ctx.cronLoopStore` 服务，按项目目录名分组的文件树）

直接 fs 读写（不依赖 storage-domain，因为 domain name 受 `UNIT_NAME_RE` 约束，
不支持 `/` 和 `-`，无法表达 `dsh-plugins` 这类项目目录名）。

布局：`~/.dsh/storages/crons/<project-basename>/<job-id>.json`

- `<project-basename>` = cwd 路径的 basename（如 `/Users/x/YYInc/Me/dsh-plugins` -> `dsh-plugins`）。
- 每个 job 一个 JSON 文件（`cron-1.json`），每个 run 一个 JSON 文件（`run-cron-1-xxx.json`）。
- 启动时全量扫描 `crons/` 下所有项目子目录加载到内存缓存；写操作同步刷盘（原子 rename）。
- cwd 标准化：所有入口（`cron_job` 工具、`/cron` `/loop` 命令、Web API）在落盘前
  用 `normalizeCwd` 展开 `~` 为绝对路径，防止 AI 或用户传入未展开的 `~` 前缀。

数据结构与之前一致：

- `CronJobRecord`：`id`, `name`, `cwd`（绝对路径）, `cron`, `prompt`, `enabled`,
  `timezone`, `createdAt`, `updatedAt`, `lastRunAt?`, `lastStatus?`, `nextRunAt?`
- `CronRunRecord`：`id`, `jobId`, `jobName`, `startedAt`, `finishedAt?`,
  `status`, `sessionId?`, `summary?`, `error?`
- 每 job 保留最近 50 条 run（写入新 run 时裁剪旧 run）。

### 调度（`cron-scheduler.ts`）

- apply 时 `ctx.effects` 中以 `ctx.timer.interval(tick, 30s)` 驱动；tick：
  1. 遍历 enabled job，用 `computeNextRun`（`cron-core.ts` 纯函数，本地时区）算 `nextRunAt`；
  2. `nextRunAt <= now` 的 job 进入执行：先置 `lastStatus: 'running'` 并写 running run 记录，
     防重入（同一 job 同时至多一个在途执行）。
- 执行：`ctx.agents` create/resume（会话 id = `cron-<jobId>`）。
  resume 条件：会话已 live 且 `session.header.cwd` 与 job.cwd 一致；否则 create
  （保证会话落在正确项目分组，不复用旧 cwd 的残留会话）。
  setup 阶段 `agentPresets.mount(agentCtx, 'standard')` + `installModelSelection`
  + `setSandboxMode(session, 'danger-full-access')`（无人值守，需完整文件/bash 权限），
  `agent.followup(createUserMessage(...))`，等待 idle->followup->idle 或 10 分钟安全阀超时，
  `sessions.flush` 后取本轮 assistant 文本写 run 记录。
  sandbox 策略靠 `session.header.cwd` 定 workspace root，cwd 正确即项目级隔离。
- catch-up 策略：latest-only--错过多次只补跑最新一次；job 停用/暂停期间不补跑。

### 模型工具（`cron-scheduler.ts` 内 `harness.registerTool`）

`cron_job`（单工具多 action，避免枚举一堆相似工具）：
`action: 'add'|'list'|'update'|'remove'|'pause'|'resume'|'runs'`。
add/update 的 `cwd` 缺省取当前 agent 会话的 `session.header.cwd`（项目级归属的落点）；
`cron` 参数必须通过 `parseCron` 校验，非法即抛错。

### 斜杠命令（`cron-commands.ts`，`ctx.commands.register`）

- `/cron <cron表达式> <任务描述…>`：为当前项目新增任务（cwd = agent session.header.cwd）。
- `/cron list` / `/cron rm <id>` / `/cron on <id>` / `/cron off <id>`：列表/删除/启停。
- `/loop <cron表达式> <任务描述…>`：`/cron add` 的别名（对齐 Claude Code 习惯）。
- `/loop`（无参数）：列出当前项目的任务。
- 命令结果为 success 文本（CommandResult），不进模型。

### Web 任务中心（`cron-web.ts` + `assets/cron.html`）

通过 `ctx.webServer.register`（exact 路由）：

- `GET /cron` → 任务中心页面（内联单文件 HTML+JS，调用下方 JSON API）。
- `GET /cron/api/jobs` → 全部 job（含 nextRunAt 计算）。
- `POST /cron/api/jobs` → 新建（body: name/cwd/cron/prompt）。
- `PUT /cron/api/jobs/:id` → 更新（cron/prompt/enabled/name）。
- `DELETE /cron/api/jobs/:id` → 删除。
- `GET /cron/api/runs?jobId=&limit=` → 执行历史（默认 100 条，新→旧）。

## 行为约定

- cron 表达式：5 段（分 时 日 月 周），支持 `*`、数字、`,`、`-`、`*/n`、星期与月份英文缩写；
  解析失败抛 `CronParseError`（消息含原始表达式与出错字段）。
- 时区：一律用系统本地时区（`Date` 语义），v1 不做 IANA 时区参数。
- 执行历史与 job 记录持久化在 `~/.dsh/storages/crons/<project-basename>/` 文件树下。
- 重启后：running 状态的 run 标记为 error（进程中断），调度从 next-run 重算，不补积压。
- 会话命名：`cron-<jobId>`，在 DSH 会话列表中可见可续聊。

## 验收标准

1. `pnpm typecheck` 通过。
2. `dsh web --patch ./cordis.patch.yml` 启动后 `/cron` 页面可打开并展示空列表。
3. 会话内 `/cron 0 9 * * 1-5 总结项目状态` 能创建任务，`/cron list` 可见。
4. 模型可调用 `cron_job` 工具完成增删改查。
5. 到期任务自动执行：`/cron` 页面出现 ok/error 状态的 run 记录与摘要文本。
6. 页面上可编辑 cron/prompt、启停、删除，改动即时生效（下次 tick 重算）。

## 已知边界与不做项

- 不做时区参数、秒级精度（tick 粒度 30s）。
- 不做跨进程分布式锁：单 web 进程持有调度器（多进程同时跑本插件可能重复触发，v1 不处理）。
- 不做每 job 独立并发键/队列（同 job 串行由防重入标记保证）。
- 不修改 deepseek-harness 本体，全部能力走公开 Service（webServer/agents/commands）+ 直接 fs。
