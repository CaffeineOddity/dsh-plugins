# 13. 本地入口（内置 local provider + 配置站对话页）

## 目标

不装任何 IM 通道插件也能直接跟中枢的 agent 对话：红点变绿，配置站加一个「对话」页，选 agent -> 输入框直接聊。零宿主耦合，不动 DSH client 内部 API。

## 背景

原 `ask()` 强校验 `providerId` 已注册，且 `meta.sessionParts` / `sender` 全靠 IM 通道填。无通道 -> 红点 -> 用不了。本 spec 引入内置 local provider 与配置站对话页，把本地对话也走 `ask()` 同一条回路，不另造路径。

## 内置 local provider

`createAgentBotService` 初始化时预置一个内置 provider，不走 `registerProvider`（无 disposer、不可被外部覆盖）：

- `id: 'local'`，`label: '本地'`
- `listProviders()` 结果含它 -> `status.providers` 非空 -> 红点变绿
- 不带 `listGroupAgents` / `deliver`（本地对话页不需要；协作场景另见 [12](./12-leader-experts-teamwork.md)，本地不参与）

热重载不变：内置 provider 在 service 构造时即存在，不随外部 `registerProvider` 的代数 dispose。

## 对话页

路由 `GET /agent-bot/chat`（`serve.ts` FILES 加 `chat: 'chat.html'`；siteKey 白名单天然覆盖）。HTML 不拆框架，复用 `site.js` 的 `rpc()` / `setMsg()` / 目录选择器。

布局：

- 顶部 agent 下拉（`listAgents()`：`id` + `name` + `description`），空则提示「先去 Agents 页建一个」
- 输入框 + 发送按钮；消息列表（user / assistant 气泡，assistant 渲染 markdown 文本）
- 空回复显示「本轮没有生成内容」；`ask` 抛错显示错误文案，不崩页

页面会话 id：首次打开生成随机 id（存 `localStorage`），作为 `sessionParts.session`。不按人隔离（本地单用户），`sender` 固定为 `'local'`（本地对话无需区分用户；不引 `dsh-anonymous-user-id` 依赖）。

## RPC 端点 ask

新增端点 `ask`（`handleRpc`），`AgentBotRpcHost` 增 `ask(req)`：

```
ask(payload) -> { ok, value: { messages, pending? } }
```

payload：

| 字段 | 填 |
|---|---|
| `agentId` | 对话页选中的 agent |
| `context` | 用户输入文本 |
| `sessionKey?` | 页面会话 id（仅提示用；真实 key 由大脑编） |

端点内部组装 `meta`：

- `traceId` = `randomUUID()`
- `providerId` = `'local'`
- `sessionParts` = `{ session: <页面会话id> }`（或端点生成；禁止键校验照旧）
- `sender` = `'local'`

调 `host.ask(req)`：`messages` 按序展示；`pending` 非空则先显示已有条、`await` 后补剩余条（与 IM 通道同语义，见 [3. 出站条](./03-ask-and-session.md)）。`ask` 抛错 -> `{ ok:false, error }`，页显示错误文案。

> 不经 IM：本地对话页的会话槽 key = `encodeSessionKey({ session })` = 该会话 id 本身；agent 的 `reuse_session` / `session_timeout_minutes` / prompt 指纹续接规则照常生效。

## 不做项

- 不碰 DSH client 的 `inputTriggers` / `@` 提及 / 会话路由（那是第二步 A 路由，另立 spec）。
- 不做多轮 pending 的流式渲染；v1 `await` 完再补，与 IM 通道一致。
- 不在本地对话页做协作派发 / `deliver`（本地无群、无投递）。
- 不让本地 provider 被 `registerProvider` 覆盖（内置，固定）。
