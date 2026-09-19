# 7. Agents Tab

CRUD 智能体。

## 基础信息

- id: 创建时生成，之后不可改
- name: 展示名，必填
- description: 功能说明，多行可空；给人看这个智能体干什么，**也**给 Lead 决定要不要把任务分给它（见 [12](./12-leader-experts-teamwork.md)）。不注入该 agent 自己的 prompt
- workspace: agent 工作区，独占。编辑弹窗不手填路径：点「选择目录」与技能仓同一套选择器（见 [5](./05-skills.md)：桌面原生弹窗 / 移动端列表浏览），选中后写入当前表单；保存时才落盘。空则从家目录起。挂进 DSH GUI 时侧边栏标题为 `agent_<name>`（见 [3](./03-ask-and-session.md)）。

## prompt

目标：给 agent 绑定一个唯一的 prompt，并选注入位置。

- 方式：下拉列表，选择一个 [Prompts Tab](./06-prompts.md) 的预设名，保存。右侧下拉选注入位置（`prompt_placement`）：
  - 系统提示词（`system`，默认）：create / resume 的 setup 写入 `systemPrompt` section（见 [6](./06-prompts.md)）。
  - 追加到用户对话（`user`）：不写 systemPrompt section；每轮 followup 把组装后的 prompt 文本（含 `{{变量}}` 静态替换）接到用户 `context` 后面，中间空一行。
- 不绑定预设时位置控件禁用，保存仍写 `system`。改位置与改预设一样改指纹，下次 ask 开新会话。

## skills

目标：agent 上绑一份技能组列表；应用到某个落点时，把这份列表里的技能软链进该目录。可选是否把组内技能名追加进 prompt。

数据按 [4. 配置数据模型](./04-config-model.md)：`agents[].skill_groups: string[]`（组 id）、`agents[].prompt_append_skills`（默认 `true`）。未知 id 保存时剔除。**不按工具存不同组**——各工具共用这一份。

编辑弹窗技能组：标题「技能组」与右侧「添加技能组」「应用到工作区」同一行，两个按钮右对齐。已选的显示成标签，标签上 `[×]` 删除。点「添加技能组」弹窗列出全部组，已在标签上的默认勾选；确认后用勾选结果覆盖标签。开关「追加到 prompt」直绑 `prompt_append_skills`：开则 ask 时把组内技能名追加进注入文本（见 [6](./06-prompts.md)）；关则只软链、不写进 prompt。改开关与改组列表一样改指纹，下次 ask 开新会话。

落点读 `config.json` 顶层 `skill_apply`（与 `agents` 同级，见 [4](./04-config-model.md)），全中枢共用，不按 agent 拆、不进编辑弹窗。手改该文件即可拓展工具：

```json
{
  "dsh": { "global": "~/.dsh/skills", "workspace": "{workspace}/.dsh/skills" },
  "openclaw": { "global": "~/.openclaw/skills", "workspace": "{workspace}/.openclaw/skills" },
  "claudecode": { "global": "~/.claude/skills", "workspace": "{workspace}/.claude/skills" }
}
```

- 外层 key = 工具名；内层 key = 槽名（自由，常用 `global` / `workspace`）；值为路径模板。
- `{workspace}` 换成**当前被应用的** agent workspace；`~` / `~/` 换成家目录。
- 缺字段用内置缺省（上表）。某工具写成 `{}` 表示该工具无槽。整表 `{}` 表示无落点。
- 标题行右侧「应用到工作区」：先用 radio 选有非 `global` 槽的工具（缺省顺序 dsh / openclaw / claudecode，其余按名排；每工具取非 global 槽，通常是 `workspace`）。每个工具单独一行，**该工具解析后的路径紧贴在选项下方**（如 dsh 下 `/abs/ws/.dsh/skills`）。未选 workspace 则各行提示先选目录。点按钮把**当前标签上的组**发给 RPC（不读磁盘上旧的 `agents[].skill_groups`）。`global` 在 [5. Skills Tab](./05-skills.md) 的 skills组页「应用全局」，不可在本页选。新建智能体未保存时按钮禁用。

应用（`applySkillGroups`，payload `{ id, tool, slot, groupIds }`）：`slot` 不得为 `global`。`groupIds` 为当前弹窗勾选，不得为空（空则报「请先选择技能组」）；未知 id 剔除，剔完仍空同样报错。把这些组的 skill（经 `skills-map.json` 的 path）软链到顶层 `skill_apply[tool][slot]` 解析后的目录，并写回 `agents[].skill_groups`（与软链同一份）。保存智能体本身不自动软链。同一目录再次应用时，按该目录托管清单收敛为**这一次**的组（后写覆盖）。只删**该目录**里本插件建的旧软链；不动其它落点。workspace 在本插件内**独占**：保存时校验不得与其它 agent 重复，撞库报错（共享会让「删旧链」互删对方的技能软链）。symlink 失败（权限、Windows 无开发者模式）：显式报错，不静默 copy。

DSH **会**加载 `{workspace}/.dsh/skills`（验证结论见 [5. Skills Tab](./05-skills.md)）。对该工具软链时：落点必须是该目录下的**单层**子目录（宿主只扫一层）；软链名 = skill id 的 posix 末段（`hub/union-xxx` → `union-xxx`）。同一落点末段冲突显式报错。agent workspace 应自成项目根，避免 cwd 被外层 `.git` 吃掉。

## 配置

开关文案跟字段同向，checkbox 直绑、不取反。

- 续接会话（`reuse_session`）：默认开（`true`）。
  - 开：复用 sessionKey 槽关联的 sessionId。槽在且未归档、`lastAskAt` 距今未超 `session_timeout_minutes`、prompt 指纹一致 → 直接用；已归档、空闲超时或指纹变了 → 新建 sessionId 并写回槽。
  - 关：每次 ask 新建 sessionId 并覆盖槽（完全并行，但丢跨轮上下文）。
- 按人隔离会话（`session_by_sender`）：默认关（`false`）。
  - 关：key 不含人，同群共用一路（例 `r1_6031348`）。
  - 开：key 并入 `sender`（`fromuserid`），同群每人一路（例 `r1_6031348_alice`）。
  - 作为 Lead 时**强制开**（保存时写入），本开关禁用：Alice / Bob 各一路 lead session，巡检互不串。
  - key 编码见 [encodeSessionKey](./03-ask-and-session.md)，不在本页拼 key。
- 空闲超时（分钟）（`session_timeout_minutes`）：整数 ≥ 0，默认 30。`0` = 不因空闲拆会话（仍尊重归档与 prompt 指纹）。仅「续接会话」打开时有效；关掉时控件禁用，保存仍写下当前值。
- 权限（`permission_mode`）：标签与下拉同一行，默认「完全访问」。三档对齐 DSH preset，保存后只影响新建/resume 的会话：
  - 完全访问（`danger-full-access`）：沙箱全开，审批 `never`。技能里的 shell 不被拦住。
  - 工作区可写（`workspace-write`）：只能改 workspace，审批 `ask`。
  - 只读（`read-only`）：不能写盘，审批 `ask`。
- 作为 Lead（`is_lead`）：**已废弃**。新方案无专职 lead，谁被 @ 谁就是这一单的任务 lead。所有 agent setup 都注册看板工具（`open_task` / `update_task` / `dispatch_expert` / `list_group_experts` / `list_tasks` / `ask_task_lead`），见 [12](./12-leader-experts-teamwork.md)。旧字段保存时忽略。
- 磁盘并发（`concurrency`）：默认「串行」。这是 **cwd 安全阀**：串行 = 即使两路 `write` 的 `target` 不同，该专家所有来源仍进同一 FIFO；并发 = 不同 target 的 `write` 可并行（适合改目标工程、不改自己 workspace 的设计类）。同 target 的 `write` 一律 FIFO；`read` 一律可并行新会话。见 [12](./12-leader-experts-teamwork.md)。与「续接/按人」无关。
- 需要目标项目目录（`needs_target_workspace`）：默认关。开 = 被 `dispatch_expert` 或直 @ 时必须带 `target_workspace`（产出写到那个已存在的目录）；自己的 workspace 只放技能。关 = 不传、传入也忽略。设计师类打开；数据/答疑类关掉。
- 本轮等待（毫秒）（`agent_wait_timeout_ms`）：可空 = 用全局。专家填 `0` 时巡检探针 fallback 全局。任务 lead 派发 turn 用全局窗口；任务墙钟是全局 `task_round_timeout_ms`（默认 2h），不要把本字段当「永不超时」。

## sessions

`sessions` 为 `{ [sessionKey]: { sessionId, lastAskAt, promptFingerprint? } }`。通道 key 来自 [encodeSessionKey](./03-ask-and-session.md)；协作 key 以 `task:` 开头（见 [12](./12-leader-experts-teamwork.md)）。运行时维护；**编辑弹窗不展示会话槽、不清槽**。改 prompt、注入位置、技能组或「追加到 prompt」开关后，通道 ask 与协作 `session=reuse` 都会因指纹不一致开新会话。不提供手填 key 或 uuid。RPC `clearSession` 仍留给测试 / 排障，配置站不用。

是否每次新开一轮、是否按人隔离：看该 agent 的 `reuse_session` / `session_by_sender` / `session_timeout_minutes`，见 [续接策略](./03-ask-and-session.md)。不在通道消息上带 reset。

通道不在此绑定。通道的 bot 上选 `agentId`（见 [02. 通道 Provider 契约](./02-provider-contract.md)）。

## 运行

`ask` 使用该 agent 的 workspace / prompt / 已应用软链。一个 agent 可被多个 Provider、多个 sessionKey 同时打进来。

## 不做项

- 不在 agent 上存 `providerId` 白名单（v1 任意已注册 Provider 都可 ask 该 id；若要限制，另开需求）。
- 不在 agent 上存群 ID。
- 不按工具存 `skill_groups`（工具只是 apply 时的落点）。
