# 2. 通道 Provider 契约

每种 IM 一个插件、一个 `providerId`（`feishu`、…）。大脑只认本契约。

## 接入（inject 登记 / get 调用）

登记和调用分开，通道**不要**写硬依赖 `inject: ['agentBot']`（中枢挂了通道会 waiting，降级文案发不出去）。

**登记**——`apply` 里只用 inject 回调：

```
ctx.inject(['agentBot'], (c) => {
  const dispose = c.agentBot.registerProvider({
    id: 'demo',
    label: '示例通道',
    listGroupAgents: (sessionParts) => /* 本群绑定了 agentId 的成员 */,
    deliver: (req) => /* sessionParts + messages，与本轮回发同一套 send */,
  })
  c.effect(() => () => dispose())
})
```

- 大脑热重载/重激活后回调重跑，provider 自动重注册。**不要**在 `apply` 里 `ctx.get('agentBot')` 一次性注册——拿不到就静默失败，大脑重启也不补注册。
- `id` 非空、进程内唯一；重复 id 后写覆盖并打日志。
- 返回 disposer **带代数（token）**：只删除「仍是自己那代」的登记，被覆盖后的旧 disposer 是 no-op——热重载「新先注册、旧后卸载」不会误删新登记。
- 大脑只存 `{ id, label }` 与可选反向能力 `listGroupAgents` / `deliver`，**不持有 webhook、不 inject 通道服务**。

`listGroupAgents(sessionParts): { agentId, name, description }[]` 可选。任务 lead 派发时用它发现**该群**里的专家，不读 `agents.json` 全集（见 [12](./12-leader-experts-teamwork.md)）。缺此函数则专家清单为空，任务 lead 自己回答。通道从 `sessionParts` 取群身份（`group_id`）。返回的未知 `agentId` 大脑丢掉。技能名与技能 description 由大脑按该 `agentId` 的 `skill_groups` + `skills-map.json` 补齐，通道不必返回。

`deliver({ sessionParts, messages }): Promise<void>` 可选。任务收口 / 问卷 / 超时时，大脑把与 ask 出站同形状的 `messages[]` 交给通道投递（通道用 `bot_id` 查 webhook，`group_id` 当 toid，一条 item 一次 POST）。**不走** 入站 `ask` 的 FIFO，也不复用原 ask 的 `pending`。缺此函数：任务能跑、lead 能综合，结果只进日志，群里没有收口；必须打日志，不能假装成功。`messages` 里的 `atUserIds` 用于 @ 原发送者；v1 markdown 若通道不吃 AT，正文写 `@name`。

未注册的 `providerId` 调 `ask`：抛错。通道应先注册再收消息。

**ask / listAgents / getAgent**——当时 `ctx.get('agentBot')`：

- 拿到：照常调用。
- 拿不到（未装 / 热更新窗口）：通道发固定文案（「智能体中枢不可用，请联系管理员」），日志记 traceId，不静默丢弃。设置页下拉给空列表 + 提示安装中枢。

`listProviders()` 供配置站展示「当前在线通道」；通道设置页不依赖此列表来填 agent 下拉（下拉走 `listAgents`）。

## 入站

通道组好纯 JSON 后调用 `ask`（类型见 [src/types.ts](../../src/types.ts)，duck-type，不 import 本包）：

| 字段 | 谁填 | 约束 |
|---|---|---|
| `agentId` | 通道配置（如 bot.agentId） | 必须是已有 agent |
| `context` | 通道从 IM 抽出的用户文本 | 不含 webhook / toid / prompt / 档案；唯一格式见 [3](./03-ask-and-session.md) |
| `meta.traceId` | 通道 | 本轮唯一，日志用 |
| `meta.providerId` | 通道 | 等于注册 id |
| `meta.sessionParts` | 通道 | 具名身份 map，见 [3. ask 与会话续接](./03-ask-and-session.md) |
| `meta.sender` | 通道 | 发言者稳定 id，始终传；是否写入 sessionKey 由 agent 配置决定 |

通道 **禁止** 传入 `sessionKey`、`reset`、`webhook_url`。key 编码与是否续旧会话都在大脑。webhook 由通道用 `bot_id`（或飞书 `app_id`）在自己的配置里解析后再投递。

`sessionParts` 示例：

- 示例通道：`sessionParts={ bot_id: "r1", group_id: "6031348" }`，另传 `sender`。默认不按人 → key `r1_6031348`；agent 开了 `session_by_sender` → key `r1_6031348_alice`
- 飞书：`sessionParts={ app_id: "cli_xxx", chat_id: "oc_yyy" }`，规则相同

返回（单字符串 `rsp_context` **不够**：无法先图后文、无法区分 TEXT/MD/IMAGE）：

| 字段 | 含义 |
|---|---|
| `messages` | 此刻已可发的条，按序。空且 `pending` 非空 = 先别发结果；空且 `pending=null` = 通道发「本轮没有生成内容」 |
| `pending` | 非空则 **await** 后再按序投递。同进程 Promise，禁止 `JSON.stringify` |

每条 `AgentOutboundMessage`：`kind: text | markdown | image | link`，`text`，`url`，`atUserIds`，`atAll`。image 的 `url` 是 http(s) 或绝对路径（大脑已解析）；link 的 `url` 是 href。AT 不是独立 kind，只挂在 text/link 上。通道 **一条 item 恰好一次 send**，不把数组揉成一条 IM。v1 大脑只产单条 `markdown`（`url:''`、`atUserIds:[]`、`atAll:false`）；其它 kind 通道已实现、大脑 v1 不产（见 [3. 出站条](./03-ask-and-session.md)）。

通道负责：协议 ack、用户可见「收到了」、按序投递 `messages` / `pending`、`ask` 抛错或 pending 失败时用自己的 send 报错/超时、以及可选的 `deliver`。大脑不持 webhook，不自己 POST。

## 出站（本轮回复）

唯一路径：通道按 `messages` 顺序自己发。通道用 `bot_id` 找 webhook、`group_id` 当 toid。

**不走 ask 返回值的**，由通道自己发：

- 入站立刻：「收到了」类 ack（通道固定规则文案，不经模型）
- `ask` 抛错：「处理失败，请稍后重试」（固定文案；错误详情与 traceId 只进日志）
- `pending` reject（安全阀超时）：「处理超时」
- `messages=[]` 且 `pending=null`，或 `pending` resolve 空数组：「本轮没有生成内容」

agent 内主动推（告警等、非本轮、非任务）：走该 agent skill 组里的通道技能，不经 `agentBot`。任务收口走 `deliver`，见 [12](./12-leader-experts-teamwork.md)。

## 通道插件职责边界

Provider 插件做：账号/凭证、入站过滤（@、白名单）、出站 API、通道 CRUD UI、绑定 `agentId`、给出稳定 `sessionParts` map、用 `bot_id` 解析 webhook。

Provider 插件不做：拼 `sessionKey`、DSH `agents.create`、prompt 拼装、skills 扫描、session map、workspace。

## 不做项

- 不把 webhook / 裸 send 函数交给大脑。反向能力只有可选的 `listGroupAgents` 与 `deliver`（按 `sessionParts` 路由）。
- 不在 meta 放 `sessionKey`、`reset`、`webhook_url` / toid。
- 通道不写硬 `inject: ['agentBot']`（登记用 inject 回调，ask 用 get）。
- 不共享 npm types 包；以 [src/types.ts](../../src/types.ts) + 本文为契约，第二调用方仍 duck-type。
