# 6. Prompts Tab

预设名 + system prompt，CRUD。落盘 `prompts.json`（见 [4](./04-config-model.md)）。推荐工具不在本页手填。

## 行为

- 列表：每行预设名，右侧文字按钮「编辑」「删除」，与技能仓扫描目录列表同一套对齐。可筛选名称。
- 添加/编辑弹窗：预设名、`system_prompt` 多行。不展示、不编辑推荐工具。
- 删除：若仍有 agent 引用该预设名，禁止删并提示先改 agent；或提供「仍删除，引用清空」需二次确认——默认禁止删。
- 变量：通道 **不** 传入 `{{webhook_url}}`。允许 `{{sender}}` / `{{session_key}}` / `{{provider_id}}` 以及 `sessionParts` 里的键（如 `{{bot_id}}` / `{{group_id}}`）。被派专家且声明了目标目录时另有 `{{target_workspace}}`（见 [12](./12-leader-experts-teamwork.md)）；未传则为 `-`。
- 变量注册：大脑在会话 setup 时通过 `systemPrompt.variable` 注册，每轮 ask 前更新为当前值；不做拼接期静态替换。
- 注入位置由 agent 的 `prompt_placement` 决定（见 [7](./07-agent-tab.md)）。`system`：正文只在 create / resume 的 setup 写入 `systemPrompt` section。`user`：setup 不写 section，每轮把正文接到用户对话后面。改预设、改绑定、改注入位置、改技能组或改「追加到 prompt」后，下次 ask 因指纹不一致开新会话（见 [3](./03-ask-and-session.md)），不改已有 live 会话上的 section。
- 文本里出现未登记的合法 `{{name}}`（含旧预设遗留的 `{{webhook_url}}`）：setup 时登记为 `-`，不让 DSH 因 unknown prompt variable 整轮失败。不覆盖宿主已有变量（`provider` / `model` / `cwd`）。

推荐工具在 ask 时按**当前 agent** 的 `skill_groups` 展开，且仅当 `prompt_append_skills` 为 `true`（默认）：各组 `skill_ids` 用 posix 末段作名（`hub/union-xxx` → `union-xxx`，与软链名一致），去重保序，追加进注入文本（如「推荐工具：union-xxx, git-skill」）。开关关掉、无绑定组、或不绑 prompt 则不加这一段。不读 `prompts.*.tools`，不扫 workspace 目录，不调用 `tools` 注册表裁剪。改组列表、组内技能或该开关会改指纹，下次 ask 开新会话（见 [3](./03-ask-and-session.md)）。

## 与通道

Prompt 属于大脑。通道原有 `presets` 迁到本 Tab，迁完后通道配置站去掉 Prompt 页。

## 不做项

- 不按群、不按机器人存 prompt（那是 agent 绑定 + 大脑编码的 sessionKey 隔离）。
- 不在 prompt 里教模型调用通道 webhook。
