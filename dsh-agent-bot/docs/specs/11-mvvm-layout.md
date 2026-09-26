# 11. MVVM 源码布局

Host 业务源码按 MVVM 分目录。配置站 View 用 React + shadcn/ui（`web/` 源码，构建成单文件 HTML 放到 `assets/`）。不在 View 里读配置或跑 Model。

`src/index.ts` 只做组合根（provide / 路由 / effect）。`src/types.ts` 仍是通道 duck-type 的公开契约，留在 `src/` 根，不进 model。

## 分层

| 层 | 职责 | 依赖 |
|---|---|---|
| **Model** | 落盘、扫描、规范化、会话槽、ask 回合（无 Cordis UI、不组 RPC 信封） | 不 import view / viewmodel |
| **ViewModel** | `AgentBotService` 门面、配置站 RPC：把 View 的意图转成 Model 调用 | 可 import model；不操作 DOM、不 `readFile` 静态页 |
| **View** | 设置页 Client 入口、配置站静态页、静态路由 | 只调 ViewModel / RPC；不直接读 `config.json`、不跑 `agents.create` |

## 目录

```
src/
  index.ts                 # 组合根
  types.ts                 # 公开契约
  client/index.ts          # View：设置页入口
  model/
    config.ts              # ~/.dsh/storages/agentbot：config.json + skill-groups.json + prompts.json + agents.json / 热更新
    skills.ts
    prompts.ts
    agents.ts
    ask.ts                 # 入站校验 / sessionKey / 续接 / followup / 出站
    queue.ts               # (agentId, sessionKey) 串行；pending settle 后才放行
    runtime.ts             # ensureAgent live/resume/create；disposeAll
    teamwork/              # 协作：task md 看板 / dispatch_expert / 叫醒链 / deliver（独立目录，见 12）
  viewmodel/
    service.ts             # provide('agentBot') 的实现；unload 调 dispose
    rpc.ts                 # POST /agent-bot-rpc
  view/
    config-site/
      serve.ts
      assets/              # 构建产物：各路由同内容的单文件 HTML
  web/                     # 配置站 React + shadcn/ui 源码
```

## 约束

- 新 TS 不得再堆进 `src/host/`。
- View 静态页可以内联脚本调 RPC，不强制再拆 VM。
- 测试按层：model 纯函数单测不启 webServer。

## 不做项

- 配置站是 shadcn/ui 页面，但仍是「每个 URL 一份 HTML」：服务端白名单不变，不做独立前端部署。
- 不把 `types.ts` 拆进 model（通道要稳定路径）。
