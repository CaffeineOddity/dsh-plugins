# 5. Skills Tab

用户指定若干技能根目录，扫描后分组。分组落 `skill-groups.json`（见 [4](./04-config-model.md)）。agent 上只存一份组 id 列表；workspace 落点按 [7. Agents Tab](./07-agent-tab.md) 软链。`skill_apply` 的 `global` 槽在本页 skills组「应用全局」软链到本机 agent-ide 目录（如 `~/.dsh/skills`），与某个智能体 workspace 无关。

## 宿主验证（A1）

**结论：成立。** dsh 工具软链 `{workspace}/.dsh/skills/{skill}` 可做，不必停。openclaw / claudecode 不受影响。

证据（DSH `@deepseek-ai/dsh-skill-filesystem` + `standard` preset，npx checkout）：

- `standard` preset 挂 `skill-filesystem`；`ask` 创建会话时 `cwd = agent.workspace`（见 [3](./03-ask-and-session.md) G8）。
- `tool-skill` 用 `agent.session.header.cwd` 调 `skills.list` / `snapshot`。
- filesystem provider 默认根 rank 100：`<projectRoot>/.dsh/skills`（`project-dsh`）。`projectRoot` = cwd 最近含 `.git` 的祖先，没有则用 cwd。
- 发现只认根下一层：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`；跟随符号链接（`watchFollowSymlinks` 默认 true）。

边界（实现 `applySkillGroups` 时遵守，不阻塞方案）：

- workspace 若位于另一个 git 仓库内部，projectRoot 会升到外层仓库，扫的是外层 `.dsh/skills` 而不是 agent workspace。agent workspace 应自成项目根（自带 `.git`，或放在无 `.git` 祖先的目录）。
- 嵌套 id（相对所属扫描根的 posix 路径，如 `hub/union-xxx`）不能直接作为 dsh 落点子目录，否则宿主发现不到。dsh 工具软链必须落在 `{workspace}/.dsh/skills/<单层名>`；软链名用 id 的 posix 末段（`hub/union-xxx` → `union-xxx`），与 unionyy `linkTo.sh` 一致。分类目录（`hub`/`global`/`ios` 等）不编进软链名，否则工具名、prompt tools、宿主发现名都对不上。同一落点末段冲突显式报错（见 [7](./07-agent-tab.md) `applySkillGroups`）。

## 页内 Tab

同一路径 `/agent-bot/skills` 两个页内 Tab（侧栏仍叫 Skills）：

| Tab | 内容 |
|---|---|
| 技能仓 | 扫描目录列表（可添加/删除；每行可单独扫描）、扫描结果列表 |
| skills组 | 分组 CRUD（创建/编辑弹窗：名称 + 技能多选） |

默认打开技能仓。hash `#warehouse` / `#groups` 记住当前 Tab。

## 扫描

- 配置项：`skill_roots`（绝对路径数组）。技能仓不提供手填输入。标题「技能仓」与「添加目录」同一行，按钮在右侧。点「添加目录」：桌面（细指针且宽屏）走系统原生选文件夹弹窗（RPC `pickDirectory`，Host 侧 `osascript`/`zenity`/`kdialog`，取消返回 null）；触控或窄屏走页内列表浏览（RPC `listDirectories` 一层一层列子目录，「选择此目录」）。空路径浏览从家目录起。选中后追加进 `skill_roots`（`saveSkillRoots`）。不依赖 DSH `ctx.directoryPicker`（web profile 常钉成 browse，且独立配置站接不到 Remote）。
- 扫描目录用列表：title = 路径末段目录名，subtitle = 完整路径。每行右侧文字按钮「扫描」「删除」。删除即从数组移除。没有目录时列表空态。
- 「扫描」（该行）：只扫这一条已配置的根（RPC `scanSkills` payload `{ root }`，须在 `skill_roots` 内）。递归找含技能说明文件的目录，合并进 `skills-map.json`：换掉该根下旧条目，其它根已扫到的技能保留。该根有 `.agentbot/linkmap.json` 则当场套用该根分组。完成后提示「扫描到 N 个技能，M 个分组」。提示里的「未知」是该根 linkmap 里的名字在扫描产物对不上（目录没扫到，或 id/末段都不唯一匹配）。
- 无 `root` 的 `scanSkills` 仍扫全部 `skill_roots`（测试 / 排障）。配置站技能仓不提供整表「整理扫描」。文件名大小写不敏感（`SKILL.md` / `skill.md` 都算；同一目录两者都在时优先 `SKILL.md`）。目录名作默认 id；说明文件标题作展示名，没有则用目录名。合并后按 id 排序。
- 写出 `skills-map.json`：

```json
{
  "roots": ["/abs/skills", "/abs/other"],
  "scanned_at": 0,
  "skills": [
    { "id": "git-skill", "name": "Git", "path": "/abs/skills/git-skill", "description": "首段摘要" }
  ]
}
```

- `id` = 相对所属 `skill_roots` 项的 posix 路径（可嵌套）。冲突（同一 id 两个目录，含跨根）扫描失败，显式报错。
- 扫描不改 skill 文件。若某根存在 `{root}/.agentbot/linkmap.json` 则当场套用分组（见下）；没有该文件只扫技能、不改已有组。技能仓不提供单独的 linkmap 按钮。切到 skills组即可看到匹配出的组。

## 扫描时识别分组（linkmap）

扫描时逐根读 `{root}/.agentbot/linkmap.json`（不写回该文件）。格式为组名 → 技能 id 数组，与 unionyy `skills/.agentbot/linkmap.json` 相同：

```json
{
  "global": ["brainstorming", "find-skills"],
  "union-data": ["union-business-daily-report"]
}
```

- 键 = 组 id 且作展示名（已是 slug 则原样用）。
- 值里每项先按扫描产物 `skills[].id` 精确匹配；没有则再按 id 末段（posix 最后一层）唯一匹配。匹配不到的进 `droppedSkillIds`；同一末段对上多个 skill 进 `ambiguousSkillIds`，不写入组。
- 缺文件：不算失败，不改组。JSON 不是「字符串 → 字符串数组」显式报错（扫描失败）。
- 按组 id **覆盖**该组的 `skill_ids`（同 id 已存在则改列表、保留原名，不改其它组）。不删除 linkmap 里没有的组。不绑 agent。

## 分组 CRUD

- 创建组弹窗：名称（必填、不可与其它组 id/name 撞）+ 技能多选。
- 多选支持按名称/id 搜索过滤。过滤只改可见列表；已勾选的 id 跨搜索累计，保存时并入（搜 a 勾 3 个再搜 b 勾 2 个，保存 5 个）。取消勾选只影响当前可见项，不清掉已隐藏的选择。弹窗展示已选数量。
- 编辑组：改名、改 `skill_ids`。
- 删除组：从所有 agent 的 `skill_groups` 里去掉该 id，再删组；已打上的软链在下次对该工具 `applySkillGroups` 时收敛。

组是配置层，不移动磁盘上的 skill 目录。

## 应用全局（global）

skills组页标题行：「应用全局」与「+ 添加组」同一行。列表不勾选。点「应用全局」弹窗：

- radio 选有 `skill_apply[*].global` 的工具（缺省顺序 dsh / openclaw / claudecode，其余按名排）。
- 底部 subtitle 显示当前工具的 global 路径模板（如 `~/.dsh/skills`），随 radio 切换。
- 多选要软链的技能组；保存调用 RPC。

把选中组里的 skill 软链进该 global 目录（给本机 dsh / openclaw / claudecode 等 agent-ide 工具用）。

- RPC `applyGlobalSkillGroups`，payload `{ tool, slot, groupIds }`。`slot` 必须是 `global`。
- `{workspace}` 不得出现在 global 模板里（global 与 agent workspace 无关）；`~` 换成家目录。
- 同一目录再次应用时，按该目录托管清单收敛为**这一次**选中的组。只删该目录里本插件建的旧软链。
- 未选组则报错。无 global 落点则弹窗提示、不可保存。agent 弹窗不可选 global（见 [7](./07-agent-tab.md)）。

## 不做项

- 不在扫描时改 SKILL.md。
- 不支持把组映射成磁盘子文件夹（组是虚拟的）。
- 不在本 Tab 绑定 agent（那是 Agents Tab）。
