# 4. 配置数据模型

目录 `env:AGENT_BOT_CONFIG_DIR`，缺省 `~/.dsh/storages/agentbot`。热更新：写盘后刷新缓存，不重启进程。软链只在 apply 时按所选落点重建；改 `skill_groups` 或 workspace 不自动改磁盘链。

| 文件 | 内容 |
|---|---|
| `config.json` | `skill_roots`、`skill_apply`、`pending_questionnaire_max_days`、`patrol_interval_minutes`、`use_hub_experts` |
| `skill-groups.json` | 技能分组（对象，key = 组 id） |
| `prompts.json` | Prompt 预设（对象，key = 预设名） |
| `agents.json` | 智能体数组 |
| `skills-map.json` | 扫描产物，覆盖写入，不手改 |
| `jobs/{todo|running|done}/task_xxx.md` | 任务看板（见 [12](./12-leader-experts-teamwork.md)）。独立目录，不进 `agents.json` |

内存仍合成一份 `AgentBotFileConfig`。读：分文件存在则用分文件；否则回退旧 `config.json` 里嵌套的 `skill_groups` / `prompts` / `agents`。写：`config.json` + 三份分文件一起落，并从 `config.json` 去掉这三项。缺文件给内存默认值、不落盘。

## config.json

```json
{
  "skill_roots": ["/abs/skills", "~/other/skills"],
  "skill_apply": {
    "dsh": { "global": "~/.dsh/skills", "workspace": "{workspace}/.dsh/skills" },
    "openclaw": { "global": "~/.openclaw/skills", "workspace": "{workspace}/.openclaw/skills" },
    "claudecode": { "global": "~/.claude/skills", "workspace": "{workspace}/.claude/skills" }
  },
  "pending_questionnaire_max_days": 7,
  "patrol_interval_minutes": 3,
  "use_hub_experts": true
}
```

## skill-groups.json

```json
{
  "rd": { "id": "rd", "name": "rd", "skill_ids": ["git-skill"] }
}
```

## prompts.json

```json
{
  "default": { "system_prompt": "…", "tools": [] }
}
```

## agents.json

```json
[
  {
    "id": "a1",
    "name": "联运RD",
    "description": "联运需求答疑与排期",
    "workspace": "~/Documents/agents/union-rd",
    "prompt": "default",
    "prompt_placement": "system",
    "skill_groups": ["rd"],
    "prompt_append_skills": true,
    "reuse_session": true,
    "session_by_sender": false,
    "permission_mode": "danger-full-access",
    "concurrency": "serial",
    "sessions": { "r1_6031348": { "sessionId": "uuid", "lastAskAt": 1730000000000, "promptFingerprint": "你是联运助手" } },
    "session_timeout_minutes": 30
  }
]
```

字段约束：

| 路径 | 约束 |
|---|---|
| `skill_roots` | 用户选的扫描目录数组（绝对路径）；空则扫描按钮报错。可添加/删除，扫描时全部合并 |
| `skill_groups.*.id` | 稳定 key，创建时生成或用名称 slug；不可与其它组重复 |
| `skill_groups.*.skill_ids` | 必须是 `skills-map.json` 里存在的 id；保存时丢掉已消失的 id 并提示 |
| `prompts` | key = 预设名，非空、唯一 |
| `prompts.*.tools` | 旧字段，读写保留、注入时忽略。推荐工具改从当前 agent 的 `skill_groups` 展开，且受 `prompt_append_skills` 控制（见 [6](./06-prompts.md)） |
| `agents[].id` | 创建时生成，之后不可改 |
| `agents[].name` | 展示名，非空 |
| `agents[].description` | 功能说明，可空字符串；给人看，**也**给任务 lead 路由（见 [12](./12-leader-experts-teamwork.md)）。不注入该专家自己的 prompt |
| `agents[].workspace` | 绝对路径或 `~`；ask 前必须能 mkdir；**不得与其它 agent 重复**（保存时校验撞库报错，共享会让软链互删） |
| `agents[].prompt` | 空 = 不叠加群/角色预设，仍挂 `standard` |
| `agents[].prompt_placement` | 注入位置。`system`（默认）：setup 写入 systemPrompt；`user`：每轮接到用户对话后面。缺字段或非法回退 `system`。不绑定 prompt 时无效果 |
| `agents[].skill_groups` | 组 id 列表（一份，不按工具拆）；未知 id 保存 / 应用到工作区时剔除。workspace 软链见 [7](./07-agent-tab.md)（apply 用当前标签并写回本字段）；global 软链见 [5](./05-skills.md) |
| `agents[].prompt_append_skills` | 是否把组内技能名追加进 prompt。默认 `true`；缺字段回退 `true`。`false` 只软链、不写「推荐工具」段。改此项改指纹 |
| `skill_apply` | 全中枢共用的软链落点：`{ 工具名: { 槽名: 路径模板 } }`。槽名自由（常用 `global` / `workspace`）。模板支持 `~` 与 `{workspace}`（workspace 槽 apply 时换成当前 agent 的 workspace）。缺字段或非法时用内置缺省。显式 `{}` 表示无落点。空字符串槽丢掉。手改 `config.json`。`global` 槽只在 skills组页「应用全局」；agent 弹窗不可选 |
| `agents[].permission_mode` | 新建/resume 会话时写入的 DSH 权限预设。三选一：`danger-full-access`（默认）、`workspace-write`、`read-only`。缺字段或非法回退默认。live 不重写；改此项对已有 live 会话不生效，清槽或超时新建后才切 |
| `agents[].reuse_session` | 默认 `true`。`false` 则每次 ask 新建会话。通道不传 reset |
| `agents[].session_by_sender` | 默认 `false`（按群）。`true` 则 sessionKey 并入 sender（按人）。协作群建议打开，避免 Alice / Bob 共用任务 lead 的对话记忆导致捡单串台 |
| `agents[].session_timeout_minutes` | 仅 `reuse_session: true` 时生效；默认 30；`0` 不因空闲拆会话 |
| `agents[].concurrency` | 默认 `serial`。cwd 安全阀：`serial` 即使不同 target 的 `write` 也 FIFO；`concurrent` 不同 target 的 `write` 可并行。同 target 的 `write` 一律 FIFO；`read` 一律可并行。见 [12](./12-leader-experts-teamwork.md) |
| `agents[].needs_target_workspace` | 默认 `false`。`true`：`dispatch_expert` / 直连 / 直 @ 时必须带已存在的绝对路径 `target_workspace`；自己的 `workspace` 仍是技能仓，会话 cwd 不改。直连自己做完把结果抛回调用方会话。见 [12](./12-leader-experts-teamwork.md) |
| `pending_questionnaire_max_days` | `config.json`。待决问卷最长等待，默认 `7`，整数 1–365。发出时 `deadlineAt = 发出时刻 + 天数`。到点先提醒一次，再一个周期仍未答则关单并移 `done/` |
| `patrol_interval_minutes` | `config.json`。巡检兜底间隔，默认 `3`，整数 1–60。只兜问卷到期、会话没了和投递失败。专家做完走事件，不等这一拍 |
| `agents[].sessions` | 运行时维护；槽值 `{ sessionId, lastAskAt, promptFingerprint? }`。`lastAskAt` 为本轮收口 epoch 毫秒。`promptFingerprint` 为本轮注入文本；缺字段视为与当前一致（旧槽继续复用）。配置站不展示、不手改 |

`sessions` 的 key 两种，禁止混用、禁止通道或 UI 手填：

- 通道槽：[encodeSessionKey](./03-ask-and-session.md)，由 `ask` 写入。
- 协作槽：`task:` 前缀（见 [12](./12-leader-experts-teamwork.md)），由 `dispatch_expert` 写入。

删 agent 时会话 map 随 agent 走；不自动 `agents.dispose` 已有 live handle（下次 ask 不到该 id 即可；unload 插件时 dispose 全部）。

## skills-map.json

扫描产物，结构见 [5. Skills Tab](./05-skills.md)。不进 `config.json`，避免与手改配置冲突。

## 不做项

- 不在 config 里存通道凭证、webhook、群列表。
- 不把 skill 文件复制进 config；只存 id 与软链。
