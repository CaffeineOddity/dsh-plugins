# dsh-remote-access

[English](./README.en.md)

经 Cloudflare Tunnel 远程使用家里这台 DSH。控制面只听 `127.0.0.1`，登录后才把请求转到本机界面，不把 3080 直接暴露出去。

## 安装

```bash
./run.sh dsh-remote-access -d -r
```

本机打开 `http://127.0.0.1:3080/dsh-remote-access`。这里可以看通道是否已连接，并启动或暂停。公网登录后进入的是这台电脑自己的 DSH。

## 使用

1. 在每台电脑的通道页点添加，填写这台的子域名和访问口令。
2. 保存后点安装+连接。浏览器打开这个子域名，登录后就是这台 DSH。选目录时列出的是这台电脑上的文件夹，不是手机本地目录。

细节见 [docs/specs/remote-access.md](./docs/specs/remote-access.md)。
