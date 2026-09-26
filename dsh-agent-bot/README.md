# @oddity/dsh-agent-bot

DSH **智能体中枢**：skills / prompts / agents CRUD，以及多通道入站 `ask`。
飞书等 IM 是独立 Provider 插件，只做收发；本插件不持有 webhook / toid，不代发 IM。

当前架构：[docs/architecture.md](docs/architecture.md)。

规格（唯一事实来源，按阅读顺序）：

1. [总览](docs/specs/01-overview.md)
2. [通道 Provider 契约](docs/specs/02-provider-contract.md)
3. [ask 与会话](docs/specs/03-ask-and-session.md)
4. [配置数据](docs/specs/04-config-model.md)
5. [Skills](docs/specs/05-skills.md)
6. [Prompts](docs/specs/06-prompts.md)
7. [Agents](docs/specs/07-agent-tab.md)
8. [配置站](docs/specs/08-config-site.md)
9. [消息转发原理](docs/specs/10-message-relay.md)
10. [MVVM 源码布局](docs/specs/11-mvvm-layout.md)
11. [Leader 与专家协作](docs/specs/12-leader-experts-teamwork.md)（[流程用例](docs/specs/12-leader-experts-teamwork-cases.md)）
12. [本地入口](docs/specs/13-local-entry.md)
13. [`/agent_<slug>` 斜杠命令转交 agent_ask](docs/specs/14-slash-agent.md)
14. [`agent_ask` 工具（对话流内转交）](docs/specs/15-agent-tool.md)

## 当前能力

- `provide('agentBot')`：`listAgents` / `getAgent` / `listProviders` / `registerProvider`（代数 disposer）/ `ask`。
- 内置 `local` provider：不装 IM 通道也能跑，红点不空。配置站「对话」页（`GET /agent-bot/chat`）选 agent 直接聊，内部走 `ask()` 同一条回路。
- `ask`：校验失败显式抛错；只在大脑编 `sessionKey`；按 agent 配置续接；同槽串行队列；`ensureAgent` live/resume/create（cwd = workspace，standard preset，新建写 full-access）；followup 超时从实际开始起算；v1 出站单条 markdown；`{ messages, pending }`（pending 二次竞速，安全阀 reject，禁止 `JSON.stringify`）；收口写 `lastAskAt` 并落盘。
- 配置目录 `env:AGENT_BOT_CONFIG_DIR`，缺省 `~/.dsh/storages/agentbot`（`config.json` 与 `skills-map.json` 直接在该目录）。缺文件给内存默认值、不落盘。
- 配置站 `GET /agent-bot`：skills / prompts / agents / chat / settings / log，界面为 shadcn/ui。设置页 Client 入口只打开配置页，不配通道 token。
- `agent_ask` 工具：当前会话的 agent 在对话流里调用它转交给 agent-bot 的 agent（设计师等）。勾了「需要目标项目目录」时，专家会话开在专家自己的 workspace（侧边栏 `agent_<name>`），产出写到调用方项目；自己做完后结果抛回调用方会话。`/agent_<slug>` 命令保留为主动触发入口。
- unload 时 dispose 本插件 create/resume 的 live handle。删 agent 时 sessions map 随走。

通道 duck-type [`src/types.ts`](src/types.ts)，不 npm 依赖本包。登记用 `ctx.inject(['agentBot'], cb)`；`ask` / `listAgents` 当时 `ctx.get`。不要硬 `inject: ['agentBot']`。

v1 大脑只产单条 markdown。ack / 超时 / 空回复由通道自己发，不进 `messages`。

## 安装

仓库根：

```sh
./run.sh dsh-agent-bot -d
```

Host 半体随 profile 常驻，改代码后需 build 并重启 dsh web。
