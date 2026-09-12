#!/usr/bin/env bash
# run.sh - 插件发布与安装管理（通用，适用于仓库内任意插件）
#
# 版本管理：读 package.json 的 version 字段。
# 产物路径：<plugin>/.dist/<name>-<version>.tgz
#
# 用法：
#   run.sh <plugin> -r [major|minor|patch] [-t] [-i|-u]   发布；传 bump 级别则 bump，不传则用当前版本
#   run.sh <plugin> -i                                     首次安装到 DSH web profile
#   run.sh <plugin> -u                                     更新（刷新 profile node_modules）
#
# 示例：
#   run.sh dsh-cron-loop -r                 用当前版本打包发布（不 bump）
#   run.sh dsh-cron-loop -r patch           bump patch 后打包发布
#   run.sh dsh-cron-loop -r patch -u        发布后自动更新
#   run.sh dsh-cron-loop -r minor -t        发布 minor 并打 tag
#   run.sh dsh-cron-loop -u                 只更新

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
    *) err "无效的 bump 级别: $level（可选 major|minor|patch）"; exit 1 ;;
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

# ─── 发布 ───

do_release() {
  local level="$1" do_tag="$2"
  local current new_version
  current="$(get_version)"
  if [[ "$level" == "keep" ]]; then
    new_version="$current"
    log "发布 $PLUGIN: v${new_version} (使用当前版本，不 bump)"
  else
    new_version="$(bump_version "$level")"
    local tag_suffix=""
    [[ "$do_tag" == "true" ]] && tag_suffix=" +tag"
    log "发布 $PLUGIN: $current -> $new_version ($level)${tag_suffix}"
    # 更新 package.json 版本号
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

  # git add + commit（版本有变才 commit）
  if [[ "$level" != "keep" ]]; then
    (cd "$SCRIPT_DIR" && git add "$PLUGIN/package.json")
    (cd "$SCRIPT_DIR" && git commit -m "chore($PLUGIN): release v$new_version")
    log "git commit 完成"
  fi

  # git tag（-t 可选，默认不打）
  if [[ "$do_tag" == "true" ]]; then
    (cd "$SCRIPT_DIR" && git tag "${PLUGIN}-v$new_version")
    log "git tag ${PLUGIN}-v$new_version 已创建"
  fi

  # pnpm pack 打 tarball 到 .dist/
  local dist_dir="$PLUGIN_DIR/.dist"
  rm -rf "$dist_dir"
  mkdir -p "$dist_dir"
  log "打包 tarball..."
  local name
  name="$(get_name)"
  (cd "$PLUGIN_DIR" && pnpm pack --pack-destination "$dist_dir" >/dev/null 2>&1)
  local tarball="$name-$new_version.tgz"
  if [[ ! -f "$dist_dir/$tarball" ]]; then
    err "pnpm pack 未生成 $dist_dir/$tarball"
    exit 1
  fi
  log "tarball: $dist_dir/$tarball"

  # git push（commit 必推，tag 有则推）
  if [[ "$do_tag" == "true" ]]; then
    log "推送 git commit 和 tag..."
    (cd "$SCRIPT_DIR" && git push origin main && git push origin "${PLUGIN}-v$new_version")
  else
    log "推送 git commit..."
    (cd "$SCRIPT_DIR" && git push origin main)
  fi
  log "发布完成: $PLUGIN v$new_version"

  echo "$new_version"
}

# ─── 安装 ───

do_install() {
  local dsh_bin name
  dsh_bin="$(find_dsh_bin)" || exit 1
  name="$(get_name)"
  log "使用 dsh: $dsh_bin"

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
  log "安装完成: $name v$(get_version)"
}

# ─── 更新 ───

do_upgrade() {
  local dsh_bin name version
  dsh_bin="$(find_dsh_bin)" || exit 1
  name="$(get_name)"
  version="$(get_version)"
  log "使用 dsh: $dsh_bin"
  log "目标版本: ${version} ($PLUGIN/package.json)"

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

  log "更新 $name 到 v${version}..."
  "$dsh_bin" plugin --profile web update
  log "更新完成: $name v${version}"
}

# ─── 参数解析 ───

RELEASE_LEVEL=""
DO_RELEASE=false
DO_INSTALL=false
DO_UPGRADE=false
DO_TAG=false

usage() {
  cat << 'USAGE'
用法：
  run.sh <plugin> -r [major|minor|patch] [-t] [-i|-u]   发布（pack + push）；传 bump 级别则 bump 版本，不传则用当前版本
  run.sh <plugin> -i                                     首次安装到 DSH web profile
  run.sh <plugin> -u                                     更新到当前源码版本

选项：
  -r [level]   发布。level 可选：major|minor|patch；不传则用 package.json 当前版本打包
  -t           发布时打 git tag（格式：<plugin>-v<version>），默认不打
  -i           首次安装到 DSH web profile
  -u           更新（刷新 profile node_modules）
  -h           显示帮助

示例：
  run.sh dsh-cron-loop -r                  用当前版本打包发布
  run.sh dsh-cron-loop -r patch            bump patch 后打包发布
  run.sh dsh-cron-loop -r minor -t         bump minor 并打 tag
  run.sh dsh-cron-loop -r patch -u          发布后自动更新
  run.sh dsh-cron-loop -i                  首次安装
  run.sh dsh-cron-loop -u                  更新
USAGE
  exit 0
}

# 第一个位置参数 = 插件名
if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi
PLUGIN="$1"
shift

# 手动解析（getopts 不支持可选参数，手写更灵活）
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r)
      DO_RELEASE=true
      shift
      # 检查下一个参数是否是 bump 级别
      if [[ $# -gt 0 && "$1" =~ ^(major|minor|patch)$ ]]; then
        RELEASE_LEVEL="$1"
        shift
      else
        RELEASE_LEVEL="keep"
      fi
      ;;
    -t) DO_TAG=true; shift ;;
    -i) DO_INSTALL=true; shift ;;
    -u) DO_UPGRADE=true; shift ;;
    -h|--help) usage ;;
    *) err "未知选项: $1"; usage ;;
  esac
done

# 互斥检查
if [[ "$DO_INSTALL" == true && "$DO_UPGRADE" == true ]]; then
  err "-i 和 -u 不能同时使用"
  exit 1
fi

init_plugin

# 执行
if [[ "$DO_RELEASE" == true ]]; then
  do_release "$RELEASE_LEVEL" "$DO_TAG"
fi

if [[ "$DO_INSTALL" == true ]]; then
  do_install
fi

if [[ "$DO_UPGRADE" == true ]]; then
  do_upgrade
fi

# 只有插件名没有操作时显示用法
if [[ "$DO_RELEASE" == false && "$DO_INSTALL" == false && "$DO_UPGRADE" == false ]]; then
  usage
fi
