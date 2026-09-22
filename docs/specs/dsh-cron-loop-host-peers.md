# dsh-cron-loop 宿主依赖声明

## 背景与目标

`dsh-cron-loop` 运行时使用 Cordis 与 DSH 提供的宿主能力。这些包由 DSH 运行环境提供，不安装到 profile 自身的 `node_modules`。插件以 tarball 安装到 profile 时，pnpm 因无法静态发现宿主包而报告缺失 peer。

目标是在保留运行时兼容范围的同时，避免 `dsh-cron-loop` 触发误导性的 missing-peer 告警。

## 依赖设计

- `package.json` 的 `peerDependencies` 保留 Cordis、Cordis timer 及 DSH 宿主包的版本范围，用于声明兼容性。
- 上述宿主 peer 在 `peerDependenciesMeta` 中全部标记为 `optional: true`。
- 开发和构建所需包继续由 `devDependencies` 提供。
- 插件不把宿主包改为普通 `dependencies`，避免加载重复的 Cordis 或 DSH 运行时实例。

## 行为约定

- 在未把 DSH 宿主包安装到目标 profile 的情况下，pnpm 安装插件 tarball 不报告由 `dsh-cron-loop` 产生的 missing-peer 告警。
- 其他插件的 peer 告警不在本需求范围内，保持原样。
- optional 使 pnpm 在 peer 缺失时既不告警也不自动安装；peer 已存在时仍按声明的版本范围检查兼容性。该设置不代表插件运行时可以脱离对应的 Cordis 或 DSH 宿主能力。

## 验收标准

1. `package.json` 中每个 `peerDependencies` 条目都有对应的 `peerDependenciesMeta.<name>.optional: true`。
2. 类型检查与构建通过。
3. 将打包产物安装到所有声明 peer 均缺失的隔离项目时，即使 `auto-install-peers=true`，安装输出也不包含归属于 `dsh-cron-loop` 的 `missing peer` 告警，且这些 optional peer 不会被自动安装。
4. 隔离项目显式安装不满足版本范围的 peer 时，pnpm 仍报告版本不兼容。
5. 打包产物仍包含原有 peer 版本范围及 optional 元数据。

## 已知边界与不做项

- 不修改 DSH 的 profile 初始化或插件安装机制。
- 不修改 `@yy/dsh-agent-bot`、`@yy/dsh-plugin-market`、`@yy/ducc-dsh-plugin` 等其他插件。
- 不通过降低 pnpm 日志级别隐藏真实依赖问题。
- 不保证插件在缺少实际 DSH 宿主服务时可以运行。
