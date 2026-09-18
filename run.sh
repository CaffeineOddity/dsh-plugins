#!/usr/bin/env bash
# run.sh - 插件发布与安装管理（通用，适用于仓库内任意插件）
#
# 版本管理：读 package.json 的 version 字段。
# 产物路径：<plugin>/.dist/<name>-<version>.tgz
#
# 安装模式（互斥）：
#   -d          开发模式：link 源码到 profile（改完代码即生效）
#   -i/install  部署模式：从 .dist/ tarball 安装（版本锁定到打包时的快照）
#   -u/upgrade  升级模式：从 .dist/ tarball 更新（同 -i，先移除旧依赖再装）
#   release     发布：bump（可选）+ pack；默认不 commit / push，需 --commit / --tag 才动 git
#   -r/--restart 安装/升级/开发模式后重启 dsh web（委托 ~/.dsh/run.sh --restart）
#
# 用法：
#   run.sh <plugin> -d [-r]                             开发：link 源码，可选重启
#   run.sh <plugin> release [major|minor|patch]        发布：bump + pack（不动 git）
#   run.sh <plugin> release [level] [--commit] [--tag] 发布 + 提交/打 tag（可选）
#   run.sh <plugin> release [level] -i [-r]            发布 + 装 tarball，可选重启
#   run.sh <plugin> release [level] -u [-r]            发布 + 升级 tarball，可选重启
#   run.sh <plugin> -i [-r]                            装 .dist/ tarball，可选重启
#   run.sh <plugin> -u [-r]                            升级 .dist/ tarball，可选重启
#
# 示例：
#   run.sh dsh-cron-loop -d -r              开发：link 源码 + 重启
#   run.sh dsh-cron-loop release patch       发布：bump + pack（不 commit）
#   run.sh dsh-cron-loop release patch --commit --tag  发布 + commit + push + tag
#   run.sh dsh-cron-loop release -u -r       发布（保持版本）+ 升级 tarball + 重启
#   run.sh dsh-cron-loop release patch --tag -i -r  发布 + tag + 装 tarball + 重启
#   run.sh dsh-cron-loop install -r          装当前版本 tarball + 重启
#   run.sh dsh-cron-loop upgrade             升级当前版本 tarball（不重启）

set -euo pipefail

# 路径常量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$HOME/.dsh/profiles/web"
DSH_NPX_CACHE="$HOME/.npm/_npx"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[run.sh]${NC} $*"; }
warn() { echo -e "${YELLOW}[run.sh]${NC} $*"; }
err()  { echo -e "${RED}[run.sh]${NC} $*" >&2; }

# ─── 路径与版本 ───

PLUGIN=""
PLUGIN_DIR=""

init_plugin() {
  PLUGIN_DIR="$SCRIPT_DIR/$PLUGIN"
  if [[ ! -d "$PLUGIN_DIR" ]]; then
    err "插件目录不存在: $PLUGIN_DIR"
    exit 1
  fi
  if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
    err "未找到 $PLUGIN/package.json"
    exit 1
  fi
}

get_version() {
  node -e "console.log(require('$PLUGIN_DIR/package.json').version)"
}

get_name() {
  node -e "console.log(require('$PLUGIN_DIR/package.json').name)"
}

bump_version() {
  local level="$1" current
  current="$(get_version)"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  case "$level" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) err "无效的 bump 级别: $level (可选 major|minor|patch)"; exit 1 ;;
  esac
  echo "${major}.${minor}.${patch}"
}

set_pkg_version() {
  local version="$1"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$PLUGIN_DIR/package.json', 'utf8'));
    p.version = '$version';
    fs.writeFileSync('$PLUGIN_DIR/package.json', JSON.stringify(p, null, 2) + '\n');
  "
}

# ─── dsh 查找 ───

find_dsh_bin() {
  if command -v dsh &>/dev/null; then
    echo "$(command -v dsh)"
    return
  fi
  local found
  found="$(find "$DSH_NPX_CACHE" -path "*/.bin/dsh" \( -type f -o -type l \) 2>/dev/null | head -1 || true)"
  if [[ -z "$found" ]]; then
    found="$(ls "$DSH_NPX_CACHE"/*/node_modules/.bin/dsh 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$found" && -x "$found" ]]; then
    echo "$found"
    return
  fi
  err "找不到 dsh 可执行文件。请先 npm i -g @deepseek-ai/dsh 或 npx dsh"
  return 1
}

# ─── tarball 查找 ───

# 在 .dist/ 下按 version 找对应 tarball（scoped 包文件名去 @，故按后缀匹配）
find_tarball() {
  local version name tarball
  version="$(get_version)"
  name="$(get_name)"
  tarball="$(cd "$PLUGIN_DIR/.dist" && ls -1 *-"$version".tgz 2>/dev/null | head -1 || true)"
  if [[ -z "$tarball" || ! -f "$PLUGIN_DIR/.dist/$tarball" ]]; then
    err "未找到 tarball: $name-$version.tgz (在 $PLUGIN_DIR/.dist/)"
    err "请先运行: run.sh $PLUGIN release"
    exit 1
  fi
  echo "$PLUGIN_DIR/.dist/$tarball"
}

# ─── 重启 dsh web ───

# 委托 ~/.dsh/run.sh --restart 重启（杀端口占用 + 启动 dsh web）
# 默认 nohup 后台执行，日志写 /tmp/dsh-web.log；-n/--nohup 跟踪日志直到进程退出。
restart_dsh_web() {
  local restart_script="$HOME/.dsh/run.sh"
  if [[ ! -x "$restart_script" ]]; then
    warn "未找到 $restart_script，跳过重启（请手动重启 dsh web）"
    return 0
  fi
  log "重启 dsh web..."
  # dsh web 是常驻进程不退出：默认 nohup 后台跑，脚本立即返回；
  # --nohup 时前台启动并 tail 日志（Ctrl-C 只停 tail，不影响 web 进程）。
  if [[ "$DO_NOHUP" == true ]]; then
    nohup sh "$restart_script" --restart > /tmp/dsh-web.log 2>&1 &
    log "重启已调度，日志: /tmp/dsh-web.log"
  else
    nohup sh "$restart_script" --restart > /tmp/dsh-web.log 2>&1 &
    log "web 日志: /tmp/dsh-web.log（Ctrl-C 退出跟踪，web 继续运行）"
    tail -f /tmp/dsh-web.log
  fi
}

# ─── 发布 ───

do_release() {
  local level="$1"
  local current new_version
  current="$(get_version)"
  if [[ "$level" == "keep" ]]; then
    new_version="$current"
    log "发布 $PLUGIN: v${new_version} (使用当前版本，不 bump)"
  else
    new_version="$(bump_version "$level")"
    local tag_suffix=""
    [[ "$DO_TAG" == "true" ]] && tag_suffix=" +tag"
    log "发布 $PLUGIN: $current -> $new_version ($level)${tag_suffix}"
    set_pkg_version "$new_version"
    log "package.json 版本号已更新为 $new_version"
  fi

  # typecheck（有 typecheck 脚本才跑）
  if node -e "process.exit(require('$PLUGIN_DIR/package.json').scripts?.typecheck ? 0 : 1)" 2>/dev/null; then
    log "运行 typecheck..."
    (cd "$PLUGIN_DIR" && pnpm typecheck)
    log "typecheck 通过"
  else
    log "无 typecheck 脚本，跳过"
  fi

  # 编译 + 暂存目录（有 build 脚本才走）。
  # Node 拒绝对 node_modules 下的 .ts 做 type stripping，tarball 必须装编译产物：
  # 暂存目录放 dist/ + package.json + 指向 dist/*.js 的发布版 cordis.patch.yml。
  local stage_dir=""
  if node -e "process.exit(require('$PLUGIN_DIR/package.json').scripts?.build ? 0 : 1)" 2>/dev/null; then
    log "编译产物..."
    (cd "$PLUGIN_DIR" && pnpm build)
    stage_dir="$(mktemp -d)"
    rm -rf "$stage_dir"
    mkdir -p "$stage_dir"
    cp "$PLUGIN_DIR/package.json" "$stage_dir/package.json"
    cp -R "$PLUGIN_DIR/dist" "$stage_dir/dist"
    cp "$PLUGIN_DIR/README.md" "$stage_dir/README.md" 2>/dev/null || true
    # 发布版 patch：./plugins/<id>.ts -> ./dist/<id>.js（仓库源 patch 保持 .ts 供 link 开发模式用）
    sed 's|\./plugins/\([^.]*\)\.ts|./dist/\1.js|g' "$PLUGIN_DIR/cordis.patch.yml" > "$stage_dir/cordis.patch.yml"
    log "暂存目录: $stage_dir"
  else
    log "无 build 脚本，按源码打包"
  fi

  # pnpm pack 打 tarball 到 .dist/（有暂存目录则从暂存目录打包，否则从源码目录打包）
  local dist_dir="$PLUGIN_DIR/.dist"
  rm -rf "$dist_dir"
  mkdir -p "$dist_dir"
  log "打包 tarball..."
  local pack_dir="$PLUGIN_DIR"
  [[ -n "$stage_dir" ]] && pack_dir="$stage_dir"
  (cd "$pack_dir" && pnpm pack --pack-destination "$dist_dir" >/dev/null 2>&1)
  # scoped 包（@scope/name）经 pnpm pack 产物文件名会去掉 @，不能直接拿 name 拼，
  # 改取 .dist/ 下以 -$new_version.tgz 结尾的实际产物。
  local tarball
  tarball="$(cd "$dist_dir" && ls -1 *-"$new_version".tgz 2>/dev/null | head -1 || true)"
  if [[ -z "$tarball" || ! -f "$dist_dir/$tarball" ]]; then
    err "pnpm pack 未生成 $dist_dir/*-$new_version.tgz"
    exit 1
  fi
  log "tarball: $dist_dir/$tarball"
  rm -rf "$stage_dir"

  # git 提交与推送：默认不做，需 --commit / --tag 显式开启。
  # --commit：版本有变才 commit 并 push origin main；--tag：建 tag 并 push tag。
  if [[ "$DO_COMMIT" == "true" && "$level" != "keep" ]]; then
    (cd "$SCRIPT_DIR" && git add "$PLUGIN/package.json")
    (cd "$SCRIPT_DIR" && git commit -m "chore($PLUGIN): release v$new_version")
    log "git commit 完成"
    log "推送 git commit..."
    (cd "$SCRIPT_DIR" && git push origin main)
  fi
  if [[ "$DO_TAG" == "true" ]]; then
    (cd "$SCRIPT_DIR" && git tag "${PLUGIN}-v$new_version")
    log "git tag ${PLUGIN}-v$new_version 已创建"
    log "推送 git tag..."
    (cd "$SCRIPT_DIR" && git push origin "${PLUGIN}-v$new_version")
  fi
  log "发布完成: $PLUGIN v$new_version"
  echo "$new_version"
}

# ─── 开发模式：link 源码 ───

do_dev() {
  local dsh_bin name version
  dsh_bin="$(find_dsh_bin)" || exit 1
  name="$(get_name)"
  version="$(get_version)"
  log "切换到源码模式 (link): $PLUGIN_DIR"

  # npm_config_loglevel=error：抑制 pnpm 的 missing-peer WARN（宿主包由 dsh 运行时注入，
  # 不在 profile node_modules，pnpm 静态看不到必然告警；只留真错误）
  # 先移除旧依赖（可能是 tarball），再加 link
  "$dsh_bin" plugin --profile web remove "$name" 2>/dev/null || true
  npm_config_loglevel=error "$dsh_bin" plugin --profile web add "link:$PLUGIN_DIR"
  log "已链接源码: $name v${version} (源码)"
}

# ─── 部署模式：装 tarball ───

do_install() {
  local dsh_bin name version tarball
  dsh_bin="$(find_dsh_bin)" || exit 1
  name="$(get_name)"
  version="$(get_version)"
  tarball="$(find_tarball)"
  log "安装 tarball: $tarball"

  # 先移除旧依赖（可能是 link 或旧 tarball），再装新 tarball
  # npm_config_loglevel=error：抑制 pnpm 的 missing-peer WARN（同 do_dev 注释）
  "$dsh_bin" plugin --profile web remove "$name" 2>/dev/null || true
  npm_config_loglevel=error "$dsh_bin" plugin --profile web add "$tarball"
  log "安装完成: $name v${version} (tarball)"
}

# ─── 升级模式：更新 tarball ───

do_upgrade() {
  local dsh_bin name version tarball
  dsh_bin="$(find_dsh_bin)" || exit 1
  name="$(get_name)"
  version="$(get_version)"
  tarball="$(find_tarball)"
  log "升级到 tarball: $tarball"

  # 移除旧依赖（可能是 link 或旧 tarball），再装新 tarball
  # npm_config_loglevel=error：抑制 pnpm 的 missing-peer WARN（同 do_dev 注释）
  "$dsh_bin" plugin --profile web remove "$name" 2>/dev/null || true
  npm_config_loglevel=error "$dsh_bin" plugin --profile web add "$tarball"
  log "升级完成: $name v${version} (tarball)"
}

# ─── 参数解析 ───

RELEASE_LEVEL=""
DO_RELEASE=false
DO_DEV=false
DO_INSTALL=false
DO_UPGRADE=false
DO_TAG=false
DO_COMMIT=false
DO_RESTART=false
DO_NOHUP=false

usage() {
  cat << 'USAGE'
用法：
  run.sh <plugin> -d [-r]                          开发：link 源码，可选重启
  run.sh <plugin> release [major|minor|patch]     发布：bump + pack（不动 git）
  run.sh <plugin> release [level] [--commit] [--tag] 发布 + 提交/打 tag（可选）
  run.sh <plugin> release [level] -i [-r]         发布 + 装 tarball，可选重启
  run.sh <plugin> release [level] -u [-r]         发布 + 升级 tarball，可选重启
  run.sh <plugin> -i [-r]                         装当前版本 tarball，可选重启
  run.sh <plugin> -u [-r]                         升级当前版本 tarball，可选重启

选项：
  -d            开发模式：link 源码到 profile
  release       发布。level 可选：major|minor|patch；不传则用当前版本打包
  --commit/-c  发布时 git commit + push origin main（仅版本有变才提交），默认不动 git
  --tag/-t      发布时打 git tag 并 push（格式：<plugin>-v<version>），默认不打
  -i / install  从 .dist/ tarball 安装（按 package.json version 匹配）
  -u / upgrade  从 .dist/ tarball 升级（同 -i，先移除旧依赖）
  -r            安装/升级/开发模式后重启 dsh web（--restart 的简写）
  -n / --nohup  重启后不跟踪日志，仅后台启动（默认跟踪 /tmp/dsh-web.log）
  -h            显示帮助

互斥：-d / -i / -u 三选一

示例：
  run.sh dsh-cron-loop -d -r               开发：link 源码 + 重启
  run.sh dsh-cron-loop release patch        发布：bump + pack（不 commit）
  run.sh dsh-cron-loop release patch --commit --tag  发布 + commit + push + tag
  run.sh dsh-cron-loop release -u -r        发布（保持版本）+ 升级 tarball + 重启
  run.sh dsh-cron-loop release patch --tag -i -r  发布 + tag + 装 tarball + 重启
  run.sh dsh-cron-loop install -r           装当前版本 tarball + 重启
  run.sh dsh-cron-loop upgrade              升级当前版本 tarball（不重启）
USAGE
  exit 0
}

# 第一个位置参数 = 插件名
if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi
PLUGIN="$1"
shift

# 手动解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    release)
      DO_RELEASE=true
      shift
      if [[ $# -gt 0 && "$1" =~ ^(major|minor|patch)$ ]]; then
        RELEASE_LEVEL="$1"
        shift
      else
        RELEASE_LEVEL="keep"
      fi
      ;;
    -d) DO_DEV=true; shift ;;
    -t|--tag) DO_TAG=true; shift ;;
    -c|--commit) DO_COMMIT=true; shift ;;
    -i|install) DO_INSTALL=true; shift ;;
    -u|upgrade) DO_UPGRADE=true; shift ;;
    -r|--restart) DO_RESTART=true; shift ;;
    -n|--nohup) DO_NOHUP=true; shift ;;
    -h|--help) usage ;;
    *) err "未知选项: $1"; usage ;;
  esac
done

# 互斥检查：-d / -i / -u 三选一
local_count=0
[[ "$DO_DEV" == true ]] && local_count=$((local_count + 1))
[[ "$DO_INSTALL" == true ]] && local_count=$((local_count + 1))
[[ "$DO_UPGRADE" == true ]] && local_count=$((local_count + 1))
if [[ $local_count -gt 1 ]]; then
  err "-d / -i / -u 互斥，只能选一个"
  exit 1
fi

init_plugin

# 执行
if [[ "$DO_RELEASE" == true ]]; then
  do_release "$RELEASE_LEVEL"
fi

if [[ "$DO_DEV" == true ]]; then
  do_dev
fi

if [[ "$DO_INSTALL" == true ]]; then
  do_install
fi

if [[ "$DO_UPGRADE" == true ]]; then
  do_upgrade
fi

if [[ "$DO_RESTART" == true ]]; then
  restart_dsh_web
fi

# 只有插件名没有任何操作（含仅重启）时显示用法
if [[ "$DO_RELEASE" == false && "$DO_DEV" == false && "$DO_INSTALL" == false && "$DO_UPGRADE" == false && "$DO_RESTART" == false ]]; then
  usage
fi
