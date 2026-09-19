# 15. `agent_ask` 工具：对话流里调用 agent

## 目标

让当前会话的 agent 在对话流里通过**工具调用**转交问题给 agent-bot 的 agent（设计师等），回复作为 tool result 返回。渲染顺序天然为：`用户消息 -> 工具调用入口 -> 工具结果 -> agent 复述`，无命令卡片、无手动注入 turn 边界。

## 背景

spec 14 的 `/agent` 斜杠命令有两个无法绕过的固有问题：

1. **命令卡片位置**：`dsh-commands.execute` 先写 `command/run`（seq = N）再调 handler，命令卡片（CommandNode）锚定在 `command/run` 的 seq，必然排在 handler 注入的任何 `user/message` 之前。用户要的「输入在上、卡片在中、回复在下」顺序在 slash command 下不可能实现。
2. **手动注入 turn 边界**（早期方案）：`command/run`/`command/done` 是 direct log-only appends（无 turn 包裹），手动注入 `turn/start` + `assistant/message` + `turn/end` 会把 command 节点夹进 turn 边界，导致渲染层重复路由、顺序错乱、产生孤儿 `turn-process` 节点（spec 14 已记录）。

而 DSH 的 **tool 机制**（`dsh-tools`）天然就是对话流顺序：agent loop 写 `user/message` -> 模型请求 `tool/call` -> tool body 执行 -> `tool/result` -> 模型复述。无需命令卡片、无需手动注入任何事件。

## 方案

agent-bot host 半体注册一个全局工具 `agent_ask`：

- `parameters`：`{ agent: string, question: string }`。`agent` 是目标 agent 的名字或 id（中文名可用），`question` 是问题。
- `execute(args, exec)`：调 `service.localAsk(`${agent} ${question}`)`，返回 `{ reply: string }`（回复文本；无内容/出错时 `reply` 为错误文案）。
- `output.schema`：`{ reply: string }`；`output.render` 把 `reply` 投影成 `[{ type:'text', text: reply }]`（模型可见 + tool/result 展示）。
- `presentCall` / `presentResult`：可选，回退到 generic 卡片（标题 = 工具名，参数/结果原样展示）即可，先不自定义。

`execute` 通过闭包访问 `apply` 里创建的 `service`（AgentBotService）。`localAsk` 内部走 `ask()` 同一条回路（ensureAgent + followup），结果在 agent-bot 的 agent 独立会话里产生，这里只取回展平文本。

## 触发

模型根据 `description` 判断是否调用。`description` 明确：当用户要求某个专业 agent（设计师等）处理任务时，调用此工具把问题转交给它。

> 触发是模型判断，非用户 `/` 主动触发。若模型不调用，回复不产生。这是 tool 机制与 slash command 的本质差异。

## 注册与依赖

- host 半体 `inject` 加 `'tools'`。
- 新增 external 依赖：`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/schemastery`（`z` schema）。两者均由 DSH 运行时注入，devDependencies 加类型、tsup external 不打包。
- `apply` 里 `ctx.tools.register(defineTool({...}))`，返回 disposer 纳入 effect cleanup。

## 与 spec 14 的关系

- spec 14 的 `/agent`、`/agent_<slug>` 命令**保留**，作为「用户主动触发」的补充入口（命令卡片在顶部，接受此顺序）。
- 本 spec 的 `agent_ask` 工具是「对话流内触发」的主入口（无命令卡片）。

## 不做项

- 不手动注入任何会话事件（`user/message` / `turn/*` / `assistant/message`）；tool 生命周期由 agent loop 管理。
- 不自定义 `presentCall` / `presentResult`（先走 generic 卡片）。
- 不做 tool 的并发安全声明（`isConcurrencySafe` 省略 = 独占，同一 agent 串行）。
- 不改 spec 13 的配置站对话页。
