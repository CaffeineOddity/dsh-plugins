# dsh-plugins

[English](./README.en.md) | 中文

[DeepSeek Harness (DSH)](https://github.com/DeepSeekAI/deepseek-harness) 原生插件集合。每个插件是一个独立目录，通过 `dsh web --patch` 以 cordis 插件形式加载，不修改 DSH 本体。

## 插件列表

| 插件 | 功能 | 文档 |
|------|------|------|
| [dsh-cron-loop](./dsh-cron-loop) | 项目级 cron 定时任务：`/cron` 命令 + `cron_job` 工具 + `http://127.0.0.1:3080/cron` 任务中心 | [README](./dsh-cron-loop/README.md) |

> 新增插件时在此表格追加一行，并在插件目录内放置 `README.md`。

## 什么是 DSH 插件

DSH 插件是 cordis 插件，通过 `dsh web --patch <file>` 叠加到 web profile 上，不侵入 DSH 核心。插件用公开 Service（`webServer`/`agents`/`commands`/`timer` 等）+ 直接文件 IO 实现能力。

```mermaid
flowchart LR
  User["dsh web --patch"] --> Profile["~/.dsh/profiles/web"]
  Profile --> Bundle["base bundles"]
  Patch["插件 cordis.patch.yml"] --> Profile
  Profile --> App["DSH Web 服务 :3080"]
  App -.加载.-> Plugin["插件（insert 列表）"]
```

## 通用安装方式

仓库根目录提供 `run.sh` 统一管理插件的发布与安装。三种安装模式互斥：

```mermaid
flowchart LR
  subgraph "开发模式 -d"
    DevLink["link 源码目录"] --> DevRestart["重启 dsh web"]
  end
  subgraph "部署模式 -i / 升级模式 -u"
    Pack["-r 打包 tarball"] --> Tarball[".dist/xxx.tgz"]
    Tarball --> Install["装 tarball 到 profile"]
    Install --> Restart["重启 dsh web"]
  end
```

```bash
# 开发模式：link 源码 + 重启（改完代码即生效）
./run.sh <plugin> -d               # 例: ./run.sh dsh-cron-loop -d

# 部署模式：从 .dist/ tarball 安装 + 重启（版本锁定到打包快照）
./run.sh <plugin> -i               # 装当前版本 tarball
./run.sh <plugin> -r patch -i      # 发布 + 装 tarball + 重启

# 升级模式：从 .dist/ tarball 更新 + 重启
./run.sh <plugin> -u               # 升级到当前版本 tarball
./run.sh <plugin> -r patch -u      # 发布 + 升级 tarball + 重启

# 只发布（不安装）
./run.sh <plugin> -r patch         # bump patch + pack + push
./run.sh <plugin> -r               # 用当前版本打包（不 bump）
./run.sh <plugin> -r minor -t      # 发布 minor 并打 git tag
```

> 产物路径：`<plugin>/.dist/<name>-<version>.tgz`
> `-i`/`-u` 按 `package.json` 的 version 匹配对应 tarball，找不到则提示先 `-r` 发布。

### 手动安装（不用 run.sh）

1. 确保已安装 DSH（`npm i -g @deepseek-ai/dsh` 或 npx）与 pnpm ≥ 10、Node.js ≥ 22。
2. 克隆本仓库：`git clone https://github.com/CaffeineOddity/dsh-plugins.git`
3. 进入目标插件目录安装依赖：`cd dsh-<name> && pnpm install`
4. 把插件作为 bundle 安装进 web profile：`dsh plugin --profile web add link:$(pwd)`
5. 启动：`dsh web`

各插件的具体用法见其目录内的 `README.md`。

## 约定

- 每个插件独立目录，自含 `package.json` / `tsconfig.json` / `cordis.patch.yml`。
- 设计 spec 放 `specs/`，遵循 SDD（spec 是需求单一事实来源）。
- 主 README 只写功能简介 + 安装使用；开发细节用相对链接指向 spec/docs。
- 双语：中文 `README.md` 为主，英文 `README.en.md` 同步，顶部互链。

## License

MIT
