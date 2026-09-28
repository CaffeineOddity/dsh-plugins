#!/usr/bin/env bash
# macOS 的 sh 是 POSIX bash，会把 $CONFIG。当成变量名。强制回到 bash。
if [ -z "${BASH_VERSION:-}" ] || [ -n "${POSIXLY_CORRECT:-}" ]; then
  unset POSIXLY_CORRECT
  exec /usr/bin/env bash "$0" "$@"
fi
# 在家里这台创建 Cloudflare Tunnel，只把域名指到本机控制面。
# 凭证和 config 写到 ~/.dsh/storages/cloudflared。不要指到 3080。
#
#   ./scripts/setup-tunnel.sh dsh.example.com
#   ./scripts/setup-tunnel.sh dsh.example.com --port 3921 --run
#   ./scripts/setup-tunnel.sh run
set -euo pipefail

STORE="${HOME}/.dsh/storages/cloudflared"
NAME="dsh"
PORT="3921"
HOSTNAME=""
DO_RUN=false

usage() {
  cat <<'EOF'
用法:
  setup-tunnel.sh <域名> [--port 3921] [--run]
  setup-tunnel.sh run

域名示例: dsh.example.com
--run  写完配置后在前台启动隧道（Ctrl-C 停止）
run    用已有配置启动，不再登录或改 DNS
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --run) DO_RUN=true; shift ;;
    run) DO_RUN=true; shift ;;
    --) shift; break ;;
    -*) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$HOSTNAME" ]]; then echo "只能有一个域名" >&2; exit 2; fi
      HOSTNAME="$1"
      shift
      ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1024 ]] || [[ "$PORT" -gt 65535 ]]; then
  echo "端口必须是 1024-65535" >&2
  exit 2
fi
if [[ "$PORT" == "3080" ]]; then
  echo "拒绝指向 3080。那是 DSH 图形界面，不能进隧道。" >&2
  exit 2
fi

if [[ -n "$HOSTNAME" ]]; then
  HOST_LC="$(python3 -c 'import sys,re
raw=sys.argv[1].strip().lower()
if "://" in raw or "/" in raw or ":" in raw:
    raise SystemExit("只填主机名，不要带协议、端口或路径")
if raw in {"localhost"} or raw.endswith(".local") or raw.endswith(".localhost"):
    raise SystemExit("不能用本机或本地域名")
if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", raw) or ":" in raw:
    raise SystemExit("不能用 IP")
if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+", raw):
    raise SystemExit("域名格式不对")
print(raw)' "$HOSTNAME")" || exit 2
fi

find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return
  fi
  if command -v brew >/dev/null 2>&1; then
    echo "未找到 cloudflared，正在 brew install ..." >&2
    brew install cloudflared >&2
    command -v cloudflared
    return
  fi
  echo "未找到 cloudflared，也没有 brew。请先安装后再运行。" >&2
  exit 1
}

CF="$(find_cloudflared)"
mkdir -p "$STORE"
chmod 700 "$STORE"

CERT="$STORE/cert.pem"
CRED="$STORE/${NAME}.json"
CONFIG="$STORE/config.yml"
export TUNNEL_ORIGIN_CERT="$CERT"

run_tunnel() {
  if [[ ! -f "$CONFIG" ]]; then
    echo "还没有 ${CONFIG}。先运行: $0 <域名>" >&2
    exit 1
  fi
  echo "启动隧道，配置: $CONFIG"
  exec "$CF" tunnel --config "$CONFIG" run
}

if [[ -z "$HOSTNAME" ]]; then
  if [[ "$DO_RUN" == true ]]; then
    run_tunnel
  fi
  usage >&2
  exit 2
fi

if [[ ! -f "$CERT" && -f "${HOME}/.cloudflared/cert.pem" ]]; then
  cp "${HOME}/.cloudflared/cert.pem" "$CERT"
  chmod 600 "$CERT"
fi

if [[ ! -f "$CERT" ]]; then
  echo "接下来会打开浏览器，登录 Cloudflare 并选择这个域名所在的站点。"
  "$CF" tunnel --origincert "$CERT" login || "$CF" tunnel login
  if [[ ! -f "$CERT" && -f "${HOME}/.cloudflared/cert.pem" ]]; then
    cp "${HOME}/.cloudflared/cert.pem" "$CERT"
  fi
fi
if [[ ! -f "$CERT" ]]; then
  echo "登录后没有得到证书: $CERT" >&2
  exit 1
fi
chmod 600 "$CERT"

if [[ ! -f "$CRED" ]]; then
  "$CF" tunnel --origincert "$CERT" create --credentials-file "$CRED" "$NAME"
fi
chmod 600 "$CRED"

TUNNEL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["TunnelID"])' "$CRED")"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "凭证里没有 TunnelID" >&2
  exit 1
fi

TMP="$CONFIG.$$.tmp"
cat > "$TMP" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED}

ingress:
  - hostname: ${HOST_LC}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF
chmod 600 "$TMP"
mv "$TMP" "$CONFIG"

echo "写入 DNS: ${HOST_LC} -> 隧道 ${NAME}"
"$CF" tunnel --origincert "$CERT" route dns --overwrite-dns "$TUNNEL_ID" "$HOST_LC"

ORIGIN="https://${HOST_LC}"
BOOT="$(curl -s --max-time 3 -H 'Host: 127.0.0.1:3080' http://127.0.0.1:3080/dsh-remote-access/api/hub/bootstrap || true)"
if printf '%s' "$BOOT" | python3 -c 'import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if d.get("local") else 1)' 2>/dev/null; then
  python3 - "$BOOT" "$ORIGIN" "$HOST_LC" "$PORT" <<'PY' | curl -s --max-time 5 -H 'Host: 127.0.0.1:3080' -H 'content-type: application/json' -X POST --data-binary @- http://127.0.0.1:3080/dsh-remote-access/api/hub/settings >/dev/null
import json, sys
boot, origin, host, port = sys.argv[1:]
data = json.loads(boot)
suffix = (data.get("domainSuffix") or "").strip() or host
body = {
    "deviceName": data.get("deviceName") or "这台 DSH",
    "publicOrigin": origin,
    "domainSuffix": suffix,
    "listenPort": int(port),
    "selfSlug": data.get("selfSlug") or "home",
}
print(json.dumps(body))
PY
  echo "已把插件公网地址设为 ${ORIGIN}"
else
  echo "插件控制面没开。装好插件后，在本机设置把公网地址填成 ${ORIGIN}"
fi

echo "配置目录: $STORE"
echo "前台运行: $0 run"
if [[ "$DO_RUN" == true ]]; then
  run_tunnel
fi
