# __PLUGIN_NAME__

## 目标

提供一个可被 `run.sh` 安装的 DSH 页面插件。默认布局是侧边栏 + 主窗口。

## 接口

| 路径 | 作用 |
|------|------|
| `GET __PLUGIN_ROUTE__` | 概览 |
| `GET __PLUGIN_ROUTE__/settings` | 设置（本机 localStorage） |
| `GET __PLUGIN_ROUTE__/api/health` | `{ ok, name, version }` |

其它 GET 仍返回同一份 HTML，由前端显示「没有这个页面」。非 GET 返回 405。

## 验收

- 宽于 640px 时侧边栏常驻；640px 及以下用「打开导航」进入同一组链接。
- 概览能读到 health；读失败时说明原因和下一步。
- 设置可保存显示名称和紧凑间距，刷新后概览仍使用该值。

## 边界

- 不包含命令、工具或持久化到磁盘的业务数据。
- 页面 HTML 未构建时返回 500，并提示执行 `pnpm run build`。
