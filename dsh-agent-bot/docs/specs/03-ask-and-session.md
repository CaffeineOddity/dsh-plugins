# 3. ask 与会话续接

`agentBot.ask` 是通道进入大脑的唯一运行时入口。落盘按 **(agentId, sessionKey) → 槽对象**：`agents[].sessions[sessionKey] = { sessionId, lastAskAt }`。

两层不要混：

| | 谁给 | 用途 |
|---|---|---|
| `sessionParts` | 通道 ask 的 map（`bot_id` / `group_id` 等） | 场景身份，不含人 |
| `sender` | 通道始终传入 | 发言者；是否并入 key 看 agent 配置 |
| `sessionKey` | 仅本插件编码 | `sessions` 的字符串下标 |
| `sessionId` | 本插件生成的 uuid | DSH `agents.create/resume` 的 id |

通道不传 `sessionKey` / `reset`。是否续旧、是否按人隔离只看该 agent 的配置。协作调专家的槽是另一套 `task:` key，不走本节编码，见 [12](./12-leader-experts-teamwork.md)。

## sessionParts

通道用来回答「这是哪一路对话」的 **map**（具名字段），不是数组，也不是拼好的 key。

| 是 | 不是 |
|---|---|
| 稳定场景：`bot_id` + `group_id`（示例通道） | 拼好的 `sessionKey` |
| 稳定场景：`app_id` + `chat_id`（飞书） | `webhook_url`（通道用 `bot_id` 自己查） |
| 值均为非空字符串 | 通道 parts 里的 `sender` / `toid` / 消息 id |

通道 **始终** 另传 `meta.sender`，不要把它塞进 `sessionParts`。禁止键：`webhook_url`、`webhook`、`toid`、`sender`。

## 行为

1. `providerId` 必须已 `registerProvider`；`agentId` 必须存在且可运行（有 workspace）；`sessionParts` 至少一对非空键值。
2. `parts = sessionPartsForEncode(sessionParts, sender, agent.session_by_sender)`，再 `sessionKey = encodeSessionKey(parts)`。按该 agent 配置决定续或建（见「续接策略」）。
3. 创建会话时：`cwd = agent.workspace`；挂宿主 `standard` preset；`prompt_placement=system` 时把该 agent 的 prompt 注入 systemPrompt，`user` 时不写 section、每轮接到用户 `context` 后；workspace 内已按 skill 组做好软链（见 [5. Skills Tab](./05-skills.md)）。create 之后必须 `workspaceRegistry.create(cwd, title)` + `attachSession(sessionId)`，否则 GUI 侧边栏落在「未分组」（DSH 引导只发生一次，之后会话只能通过 `attachSession` 入组）。`title` 固定为 `agent_<agent.name>`（name 去首尾空白）。已有同路径记录时 `create` 不改标题，再 `setTitle` 对齐；已是该名则跳过。resume / live 同样 attach 并对齐标题。无 `workspaceRegistry` 时跳过。attach / 改标题失败显式抛错。
4. `followup(context)` → 等 idle 或全局 `agent_wait_timeout_ms`（从 **followup 实际开始** 起算，排队不消耗本轮超时）。
5. 返回 `{ messages, pending }`：`messages` 是此刻可发的条；`pending === null` 表示本轮已 `whenIdle` 收口，通道不必再等。仅超时未 idle 时 `pending` 非空，settle 后给剩余条。**空回复**：`messages=[]` 且 `pending=null`，通道发「本轮没有生成内容」（与 pending resolve 空数组同一文案）。v1 出站条固定为**单条 `markdown`**（本轮最后一条助手文本）；多条与 image 为 v2（见「出站条」）。
6. 同一 `(agentId, sessionKey)` 且 `reuse_session: true` 时走串行队列：FIFO 逐轮执行、不设上限；本轮出站条在 idle 时**同步截取**事件区间（`firstSeq` → 当前），截取完成（或安全阀触发）后才放行下一轮 followup——补发绝不吃到下一轮事件。并行不靠队列，靠配置开关：`session_by_sender: true`（每人一路）或 `reuse_session: false`（每轮新会话），代价见「续接策略」。
7. **待决决策停车**（见 [12](./12-leader-experts-teamwork.md)）：被派专家缺信息 → `ask_task_lead` 上抛给任务 lead（拒绝 `ask_user_question`，记入任务 md）；任务 lead 能定就改 md 再叫醒提问者，不能定再问人（入站则本轮 messages，内部则 `deliver` 问卷 @owner）。不占原 `ask` 的 pending。**不做**运行时硬匹配，不印问卷码。人 @任务 lead 或 @任一已派专家：谁被 @ 谁读同一份 md 的待决，LLM 自己认。直 @（该专家就是任务 lead）：停车键 `(agentId, sessionKey)`；有待决则本轮 followup 该专家自己认，等 idle 后消费。真答案只进下一次 followup。任务 lead 入站 `ask` 只覆盖派发 turn；巡检综合与入站共用 `(taskLead, sessionKey)` FIFO，不走这次返回值。
8. 本轮收口时把 `lastAskAt`（epoch 毫秒）写回 `sessions[sessionKey]` 并落盘（空闲判定重启不重置）。

live / 磁盘已有 id / 新建 的判定复用 `resolveAgentLifecycle`：live 优先；磁盘有则必须 resume，禁止同 id create。

权限：按该 agent 的 `permission_mode` 写 DSH 三元组（`permission/preset` + `sandbox/mode` + `approval/policy`）。默认 `danger-full-access`（审批 `never`）；`workspace-write` / `read-only` 审批为 `ask`。create 与 resume 时写入；live 不重写。改 agent 权限对已有 live 会话不生效。

已知安全边界：通道侧唯一准入是群白名单。默认 full-access 时，白名单群内任何人 @ 机器人即可驱动该 agent workspace 的 full-access shell。可在 Agents 页改成工作区可写或只读以收紧。

## 续接策略（只在 agent-bot 配置）

通道每次 ask 都带同样的 `sessionParts` + `sender`。**槽怎么划、要不要新开一轮**由该 agent 字段决定，不由 meta：

| 配置 | 行为 |
|---|---|
| `session_by_sender: false`（默认） | key 不含人：同群共用一路会话 |
| `session_by_sender: true` | key 并入 `sender`：同群每人一路会话；此时 `sender` 为空则抛错。协作群建议打开此项，避免 Alice / Bob 共用任务 lead 的对话记忆导致捡单串台 |

| 配置 | 行为 |
|---|---|
| `reuse_session: false` | 每次 ask 新建 uuid，覆盖 `sessions[sessionKey]` |
| `reuse_session: true`（默认）且槽内 sessionId 未归档、`lastAskAt` 距今未超 `session_timeout_minutes`、prompt 指纹与当前注入文本一致 | resume / 复用 live |
| `reuse_session: true` 且无记录 / 已归档 / `lastAskAt` 距今超过 `session_timeout_minutes` / **prompt 指纹与当前不一致** | 新建 uuid，写回槽（含新 `lastAskAt` 与当前指纹） |

prompt 指纹 = 本轮将注入的文本：`system` 时就是 `assemblePromptText`（`prompt_append_skills` 为真时含该 agent `skill_groups` 展开的推荐工具段）；`user` 时为 `user\n` + 该文本（空 prompt 绑定时为空串）。槽上缺指纹（旧数据）视为一致，继续复用；改预设正文、改 agent 绑定的预设名、改 `prompt_placement`、改 `skill_groups` / 组内技能、改 `prompt_append_skills`、或解绑后再绑，下次 ask 开新会话。`system` 的新 prompt 进 setup；`user` 不写 section。不改 live 会话上已注入的 section。

`session_timeout_minutes` 仅在 `reuse_session: true` 时生效；`0` 表示不因空闲拆会话（仍尊重归档与 prompt 指纹）。空闲判定读落盘的 `lastAskAt`，DSH 重启后仍按真实空闲计算。

## encodeSessionKey

实现：[src/types.ts](../../src/types.ts) `sessionPartsForEncode` + `encodeSessionKey`。通道与 UI 都不许另写一套拼接。

```
parts = sessionPartsForEncode(sessionParts, sender, session_by_sender)
sortedKeys(parts).map(k => parts[k]).join('_')
```

- 只取**值**：按 key 字母序排序后用 `_` 连接各值。不含 providerId、不含 `k=v`、不做 URL 编码。
- 键序固定（字母序），`{group_id, bot_id}` 与 `{bot_id, group_id}` 得到同一 key。
- key 是不透明下标：值本身含 `_` 不影响查找（永不反向解析 key；展示用原文）。
- 通道 parts 含禁止键、空 map、空值 → 抛错。
- `session_by_sender=true` 且 `sender` 为空 → 抛错。
- 改 `session_by_sender` **不迁移**旧槽；新旧 key 并存，可在配置站分别清除。
- 已知边界：key 不含 providerId，跨 Provider 值完全相同会共槽（实际撞值概率≈0，接受）。

例（`session_by_sender=false`）：

`{ bot_id: "r1", group_id: "6031348" }` → `r1_6031348`

例（`session_by_sender=true`，sender=`alice`）：

→ `r1_6031348_alice`

## 超时

- 全局 `agent_wait_timeout_ms`：单次 waitIdle 窗口。默认 1800000（30min）；专家 per-agent 可覆盖；专家配 `0` 时 fallback 全局。从 followup 实际开始起算。
- 任务 lead 派发 turn：仍用全局 `agent_wait_timeout_ms`。任务墙钟见 [12](./12-leader-experts-teamwork.md)。入站 ask 的 pending 安全阀管不到已放行的任务巡检。
- pending 安全阀：超时后第二段等待仍受墙钟约束；到点仍未 idle 则 settle 本轮。**例外**（见 [12](./12-leader-experts-teamwork.md)）：本轮已落盘任务 md → 出站「已接，正在做」，任务继续；否则通道发「处理超时」。不存在永不 settle 的 pending。
- 每 agent `session_timeout_minutes`：见上表。默认 30。

## 出站条

`messages` / `pending` 的元素见 [src/types.ts](../../src/types.ts) `AgentOutboundMessage`。通道按序投递；ack 不在数组里。

- **v1**：大脑固定把本轮最后一条助手文本收成单条 `[{ kind: 'markdown', text, url: '', atUserIds: [], atAll: false }]`。不做出站收集器，不产 image / link / AT。
- **v2（另立 spec，契约字段已留）**：多条收集（先图后文）、link、以及 text/link 上的 AT。

禁止把 webhook 写进条里。`image.url` 只允许 http(s) 直链或**绝对路径**（大脑返回前已解析完 workspace 相对路径，通道不做相对路径解析）。通道把该 url 编成 IM 的图片 base64；link 的 `url` 是 href。一条 item 恰好一次 IM：image 的说明文字必须是独立 `markdown` item。AT 不能单独成条，也不能挂在 markdown/image 上。

通道收尾文案（ack 不在数组里）：

- `messages` **非空** 且 `pending=null`：按序发完即结束。
- `messages=[]` 且 `pending=null`：发「本轮没有生成内容」。
- `pending` resolve **非空**：按序补发剩余条。
- `pending` resolve **空**：发「本轮没有生成内容」。
- `pending` **reject**（安全阀触发）：发「处理超时」。

## 失败

显式抛错。典型：未知 provider、未知 agent、workspace 不存在、agents 服务不可用。不在大脑里吞掉后返回空数组冒充成功。通道侧转固定文案，错误详情与 traceId 只进日志。

## 不做项

- 不在 ask 里发 IM。
- 不让通道传入 `sessionKey`、`reset` 或 `webhook_url`。
- 不按固定字段名建会话；只认 map 的键值集合。
- 通道不传 `{{webhook_url}}`；prompt 文本里遗留的该占位符渲染为 `-`，不整轮失败。
- 不把 ack / 超时 / 空回复文案放进 `messages`（那是通道的）。
