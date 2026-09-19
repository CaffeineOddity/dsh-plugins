# 8. 配置站

独立页 `GET /agent-bot`（host webServer 前缀），设置页「智能体中枢」只做入口按钮。静态页与 RPC 按 [11. MVVM](./11-mvvm-layout.md) 放在 `src/view/` / `src/viewmodel/`；HTML 不拆框架。

## 信息架构

侧栏 Tab：

| 路径 | 内容 |
|---|---|
| `/agent-bot` 或 `/agent-bot/skills` | [5. Skills](./05-skills.md)：页内 Tab「技能仓 / skills组」；技能仓添加目录、每行扫描/删除（桌面原生弹窗，移动端列表） |
| `/agent-bot/prompts` | [6. Prompts](./06-prompts.md) CRUD |
| `/agent-bot/agents` | [7. Agents](./07-agent-tab.md) CRUD；workspace 同技能仓选目录 |
| `/agent-bot/settings` | 全局 `agent_wait_timeout_ms`、`task_round_timeout_ms`、配置目录只读、在线 Provider 列表 |
| `/agent-bot/log` | 启动/ask/扫描日志尾 |

Host RPC：`POST /agent-bot-rpc`，信封 `{ endpoint, payload }`（避免该 dsh 版本 `connection.rpc.handle` 的 webServer inject 问题）。

端点（名称稳定，供 UI 与测试）：

- `list` / `saveSkillRoots`（payload `{ skill_roots: string[] }`） / `scanSkills`（payload `{ root? }`：空则扫全部根；有 `root` 则只扫该已配置根并合并进 `skills-map`。扫描后若有对应根 `.agentbot/linkmap.json` 则套用分组；value 含 `skills`、`groupsApplied`、顶层 `skill_apply`） / `saveSkillGroups` / `applyGlobalSkillGroups`（payload `{ tool, slot, groupIds }`，`slot` 必须是 `global`，目录来自 `skill_apply[tool].global`；配置站 skills组「应用全局」弹窗调用） / `listDirectories`（payload `{ path? }`，空则家目录；只列子目录，移动端列表浏览用） / `pickDirectory`（无 payload；打开宿主系统选文件夹弹窗，value `{ path: string | null }`，null 表示取消）
- `listPrompts` / `savePrompts`
- `listAgents` / `saveAgent` / `deleteAgent` / `applySkillGroups`（payload `{ id, tool, slot, groupIds }`，`slot` 不得为 `global`；`groupIds` 为当前勾选、不得为空；目录来自顶层 `skill_apply[tool][slot]`，`{workspace}` 用该 agent；成功后写回 `agents[].skill_groups`；配置站 Agents 编辑弹窗「应用到工作区」调用） / `clearSession`
- `settings` / `saveSettings`
- `status`（providers、日志尾）

`saveAgent` 承担校验：workspace 必填可 mkdir 且不与其它 agent 重复（撞库报错）。`clearSession` 只删槽项不动 workspace；配置站 Agents 弹窗不调用。

`listAgents` 同时是通道设置页下拉的数据源：通道 Host 侧当时 `ctx.get('agentBot')?.listAgents() ?? []`（拿不到给空列表，见 [2. 接入](./02-provider-contract.md)）。

## 不做项

- 不在本站配置通道 token / 飞书 app。
- 不内嵌 IM 消息预览。
