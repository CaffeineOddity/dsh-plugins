#!/usr/bin/env bash
# run.sh - dsh-cron-loop 发布与安装管理
#
# 用法：
#   run.sh -r <major|minor|patch> [-i|-u]   发布（bump 版本 + tag + pack）后可选安装/更新
#   run.sh -i                               首次安装到 DSH web profile
#   run.sh -u                               更新到最新 git tag 版本
#
# 示例：
#   run.sh -r patch              发布 patch 版本
#   run.sh -r patch -u           发布后自动更新
#   run.sh -r minor -i           发布后自动首次安装
#   run.sh -u                    只更新到最新版本

set -euo pipefail

# 路径常量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/dsh-cron-loop"
PROFILE_DIR="$HOME/.dsh/profiles/web"
DSH_NPX_CACHE="$HOME/.npm/_npx"
PLUGIN_NAME="dsh-cron-loop"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[run.sh]${NC} $*"; }
warn() { echo -e "${YELLOW}[run.sh]${NC} $*"; }
err()  { echo -e "${RED}[run.sh]${NC} $*" >&2; }

# ─── 辅助函数 ───

# 找到 dsh 可执行文件
find_dsh_bin() {
  # 优先 PATH 里的 dsh
  if command -v dsh &>/dev/null; then
    echo "$(command -v dsh)"
    return
  fi
  # 退而求其次：npx 缓存里的 dsh（可能是符号链接，用 ls 兜底）
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

# 读取 package.json 的版本号
get_version() {
  node -e "console.log(require('$PLUGIN_DIR/package.json').version)"
}

# 读取 package.json 的 name
get_name() {
  node -e "console.log(require('$PLUGIN_DIR/package.json').name)"
}

# 读取最新 git tag 的版本号
get_latest_tag_version() {
  local tags
  tags="$(cd "$SCRIPT_DIR" && git tag -l 'v*' --sort=-v:refname 2>/dev/null | head -1 || true)"
  if [[ -z "$tags" ]]; then
    echo ""
    return
  fi
  echo "${tags#v}"
}

# bump 版本号
bump_version() {
  local level="$1"
  local current
  current="$(get_version)"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  case "$level" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) err "无效的 bump 级别: $level（可选 major|minor|patch）"; exit 1 ;;
  esac
  echo "${major}.${minor}.${patch}"
}

# 更新 package.json 的 version 字段
set_package_version() {
  local version="$1"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$PLUGIN_DIR/package.json', 'utf8'));
    p.version = '$version';
    fs.writeFileSync('$PLUGIN_DIR/package.json', JSON.stringify(p, null, 2) + '\n');
  "
}

# ─── 发布 ───

do_release() {
  local level="$1"
  local current new_version

  current="$(get_version)"
  new_version="$(bump_version "$level")"
  log "发布: $current -> $new_version ($level)"

  # 1. 更新 package.json 版本号
  set_package_version "$new_version"
  log "package.json 版本号已更新为 $new_version"

  # 2. typecheck
  log "运行 typecheck..."
  (cd "$PLUGIN_DIR" && pnpm typecheck)
  log "typecheck 通过"

  # 3. git add + commit
  (cd "$SCRIPT_DIR" && git add "$PLUGIN_DIR/package.json")
  (cd "$SCRIPT_DIR" && git commit -m "chore(cron-loop): release v$new_version")
  log "git commit 完成"

  # 4. git tag
  (cd "$SCRIPT_DIR" && git tag "v$new_version")
  log "git tag v$new_version 已创建"

  # 5. pnpm pack 打 tarball（先清理旧 tarball）
  rm -f "$PLUGIN_DIR"/*.tgz
  log "打包 tarball..."
  local name
  name="$(get_name)"
  (cd "$PLUGIN_DIR" && pnpm pack >/dev/null 2>&1)
  local tarball="$name-$new_version.tgz"
  local tarball_path="$PLUGIN_DIR/$tarball"
  if [[ ! -f "$tarball_path" ]]; then
    err "pnpm pack 未生成 $tarball"
    exit 1
  fi
  log "tarball: $tarball_path"

  # 6. git push + push tags
  log "推送 git commit 和 tag..."
  (cd "$SCRIPT_DIR" && git push origin main && git push origin "v$new_version")
  log "发布完成: v$new_version"

  echo "$new_version"
}

# ─── 安装 ───

do_install() {
  local dsh_bin
  dsh_bin="$(find_dsh_bin)" || exit 1
  log "使用 dsh: $dsh_bin"

  local name
  name="$(get_name)"

  # 检查是否已安装
  local installed
  installed="$(node -e "
    try {
      const p = require('$PROFILE_DIR/package.json');
      console.log(p.dependencies?.['$name'] || '');
    } catch { console.log(''); }
  " 2>/dev/null || true)"

  if [[ -n "$installed" ]]; then
    warn "$name 已安装（$installed），如需更新请用 -u"
    return 0
  fi

  log "首次安装 $name 到 DSH web profile..."
  "$dsh_bin" plugin --profile web add "$SCRIPT_DIR"
  log "安装完成"
}

# ─── 更新 ───

do_upgrade() {
  local dsh_bin
  dsh_bin="$(find_dsh_bin)" || exit 1
  log "使用 dsh: $dsh_bin"

  local name version
  name="$(get_name)"

  # 获取最新版本号（git tag 或 package.json）
  version="$(get_latest_tag_version)"
  if [[ -z "$version" ]]; then
    version="$(get_version)"
    warn "未找到 git tag，使用 package.json 当前版本 $version"
  fi
  log "目标版本: $version"

  # 检查是否已安装
  local installed
  installed="$(node -e "
    try {
      const p = require('$PROFILE_DIR/package.json');
      console.log(p.dependencies?.['$name'] || '');
    } catch { console.log(''); }
  " 2>/dev/null || true)"

  if [[ -z "$installed" ]]; then
    warn "$name 未安装，切换为首次安装"
    do_install
    return
  fi

  # 已安装 -> 更新
  log "更新 $name 到 v$version..."
  # 源码 link 模式：重新 pnpm install 刷新 profile node_modules
  "$dsh_bin" plugin --profile web update
  log "更新完成: v$version"
}

# ─── 参数解析 ───

RELEASE_LEVEL=""
DO_INSTALL=false
DO_UPGRADE=false

usage() {
  cat << 'USAGE'
用法：
  run.sh -r <major|minor|patch> [-i|-u]   发布（bump + tag + pack + push）后可选安装/更新
  run.sh -i                               首次安装到 DSH web profile
  run.sh -u                               更新到最新版本
USAGE
  exit 0
}

while getopts ":r:iuh" opt; do
  case "$opt" in
    r) RELEASE_LEVEL="$OPTARG" ;;
    i) DO_INSTALL=true ;;
    u) DO_UPGRADE=true ;;
    h) usage ;;
    \?) err "未知选项: -$OPTARG"; usage ;;
    :) err "-$OPTARG 需要参数"; usage ;;
  esac
done

# 互斥检查
if [[ "$DO_INSTALL" == true && "$DO_UPGRADE" == true ]]; then
  err "-i 和 -u 不能同时使用"
  exit 1
fi

# 执行
if [[ -n "$RELEASE_LEVEL" ]]; then
  do_release "$RELEASE_LEVEL"
fi

if [[ "$DO_INSTALL" == true ]]; then
  do_install
fi

if [[ "$DO_UPGRADE" == true ]]; then
  do_upgrade
fi

# 无参数时显示用法
if [[ -z "$RELEASE_LEVEL" && "$DO_INSTALL" == false && "$DO_UPGRADE" == false ]]; then
  usage
fi
