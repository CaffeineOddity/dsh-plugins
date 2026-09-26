# 14. `/agent_<slug>` 斜杠命令转交 agent_ask

## 目标

在 DSH Web 会话里输 `/agent_<slug> <问题>`，把问题**投递给当前会话的 agent**，引导它调用 `agent_ask` 工具（spec 15）转交给目标 agent，回复在对话流里以「消息 -> 工具调用 -> 结果 -> 复述」的顺序呈现。不跳页、不依赖 IM 通道。

## 背景

DSH `/` 命令名正则 `/^[a-z][a-z0-9_-]*$/`（`dsh-commands`），**不支持中文**。故每个有 `slug`（英文）的 agent 动态注册一个命令 `/agent_<slug>`。无 slug 的 agent 不注册命令（走 spec 15 的 `agent_ask` 工具或配置站对话页）。

`/agent_<slug>` 不直接调 `localAsk`——那会让回复落在 `command/done` 的 `text`，由 command 卡片显示，而 command 卡片又固定在顶部（`command/run` 在 handler 前写入），无法呈现「输入在上、回复在下」的对话流顺序。

## 投递：followup 引导 agent_ask

命令 handler 用 `agent.followup(createUserMessage(...))` 把一条指令投递给**当前会话的 agent**（同 `dsh-command-goal` 的 followup 模式）：

1. `delegateViaTool(agent, a.name, rawInput)`：followup 投递文本「调用 agent_ask 工具：agent 参数填「<名字>」，question 参数填「<问题>」。」。目标勾了「需要项目工作区」时，再带当前会话 cwd 作为 `target_workspace`；当前会话没有 cwd 则命令直接报错，不转交。专家会话开在专家自己的 workspace，不挂进调用方目录，也不改调用方工作区标题。这是会话 A 交给专家会话 B，运行时会建 job；自己做完后结果 followup 抛回当前会话，job 移到 `done/`。
2. handler 立即返回 `{ kind:'success', text:'已转交 agent「<名字>」处理' }`（command 卡片摘要显示该 ack，输入框立即清空）。
3. 当前 agent 收到 followup，agent loop 开新 turn，模型判断调 `agent_ask` 工具。
4. `agent_ask.execute` 调 `localAsk`，回复作为 tool result，当前 agent 复述。

> followup 是投递给当前 agent 的 inbox，由 agent loop 管理 turn/step 边界，**不手动注入任何 session 事件**，故无早期「手动注入 turn 边界导致重复渲染」的问题。

### 对话流顺序

```
command 卡片（已转交 agent「设计师」处理）   ← command/run -> command/done，顶部
user/message（调用 agent_ask 工具…）         ← followup 投递，agent loop 写
tool/call（agent_ask）                       ← 模型请求
tool/result（设计师回复）                    ← agent_ask.execute 结果
assistant/message（复述）                    ← 当前 agent 复述
```

## slug 字段

`AgentConfig.slug?: string`（可选，空串视同未设）。保存时校验：非空须匹配 `^[a-z][a-z0-9_-]*$`，且全局唯一。配置站 agents.html 表单加输入框。

## 注册与依赖

agent-bot host 半体 `inject` 加 `commands`、`tools`：

- 动态命令 `/agent_<slug>`：`watchConfig` 回调里遍历 `listAgents()`，为每个有 slug 的 agent 注册命令，handler 调 `delegateViaTool`。agents 变了先注销旧命令再重注册。
- `createUserMessage` 来自 `@deepseek-ai/dsh-llm`（静态 import，external，DSH 运行时注入）。

## 已知限制

- 触发仍靠当前 agent 判断是否调 `agent_ask`：followup 指令明确「调用 agent_ask 工具」，但模型若忽略，则无回复。
- followup 指令文本会以 user/message 出现在对话流里（非原始问题，而是「调用 agent_ask 工具…」）。
- command 卡片仍在顶部（`command/run` 固定顺序）。

## 不做项

- 不手动注入任何会话事件（`user/message` / `turn/*` / `assistant/message` / `tool/*`）；一切由 agent loop 管理。
- 不把结果写进模型历史（command 卡片是 log-only 节点；followup 由 agent loop 正常记账）。
- 不为无 slug 的中文名 agent 动态注册命令。
- 不动 spec 13 的配置站对话页。
