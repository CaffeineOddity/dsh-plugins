# dsh-remote-access

[中文](./README.md)

Use the home DSH through a Cloudflare Tunnel. The control plane listens on `127.0.0.1` only. After login it forwards to the local GUI and never publishes port 3080 directly.

## Install

```bash
./run.sh dsh-remote-access -d -r
```

Open `http://127.0.0.1:3080/dsh-remote-access` on the machine. That page shows whether the tunnel is connected and can start or pause it. After login, the public site is this machine's own DSH.

## Use

1. On each machine, add its own subdomain and passphrase on the channel page.
2. Save, then install and connect. Opening that subdomain after login is that machine's DSH. Choosing a directory lists folders on that computer, not on the phone.

See [docs/specs/remote-access.md](./docs/specs/remote-access.md).
