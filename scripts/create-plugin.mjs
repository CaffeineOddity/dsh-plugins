#!/usr/bin/env node
// 生成 DSH 插件脚手架。入口是仓库根 run.sh --create；本文件也可直接调用。

import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.dirname(SCRIPT_DIR)
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates/plugin')

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const RESERVED = new Set(['ui', 'docs', 'scripts', 'templates', 'output'])
const VERSION = '0.0.1'

/** @param {string} name @returns {string | null} 错误文案；合法则 null。 */
export function validatePluginName(name) {
  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    return '插件名须为小写字母开头，仅含小写字母、数字和连字符，长度 1–64（如 dsh-notes）'
  }
  if (RESERVED.has(name)) return `插件名 ${name} 是保留目录，不能使用`
  return null
}

/** @param {string} name */
export function pluginTitle(name) {
  const base = name.startsWith('dsh-') ? name.slice(4) : name
  return (base || name)
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** @param {string} target */
async function exists(target) {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false
    throw error
  }
}

/** @param {string} raw @param {Record<string, string>} tokens */
function applyTokens(raw, tokens) {
  let next = raw
  for (const [token, value] of Object.entries(tokens)) next = next.replaceAll(token, value)
  return next
}

/**
 * @param {string} src
 * @param {string} dest
 * @param {Record<string, string>} tokens
 */
async function writeTree(src, dest, tokens) {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await writeTree(from, to, tokens)
      continue
    }
    if (!entry.isFile()) continue
    const raw = await readFile(from, 'utf8')
    const next = applyTokens(raw, tokens)
    if (next.includes('__PLUGIN_')) throw new Error(`模板残留占位符: ${path.relative(TEMPLATE_ROOT, from)}`)
    await writeFile(to, next)
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 */
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
    child.on('error', (error) => {
      reject(new Error(`无法执行 ${cmd}: ${error.message}`))
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} 失败，退出码 ${code ?? 'null'}`))
    })
  })
}

/**
 * @param {{ name: string, root?: string, repoRoot?: string, install?: boolean }} options
 * @returns {Promise<string>} 插件目录
 */
export async function createPlugin(options) {
  const name = options.name
  const root = path.resolve(options.root ?? REPO_ROOT)
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT)
  const install = options.install !== false
  const nameError = validatePluginName(name)
  if (nameError) throw new Error(nameError)
  if (!(await exists(path.join(repoRoot, 'ui/package.json')))) {
    throw new Error('未找到仓库 ui/package.json，脚手架页面依赖共享的 shadcn 组件')
  }
  if (!(await exists(TEMPLATE_ROOT))) throw new Error(`未找到模板目录: ${TEMPLATE_ROOT}`)
  if (install && root !== repoRoot) {
    throw new Error('安装依赖时插件必须创建在仓库根目录，否则无法解析 ui/')
  }

  const dest = path.resolve(root, name)
  if (path.dirname(dest) !== root) throw new Error('插件名不能包含路径')
  if (await exists(dest)) throw new Error(`目录已存在: ${dest}`)

  const staging = path.join(root, `.${name}.creating`)
  await rm(staging, { recursive: true, force: true })
  try {
    await writeTree(TEMPLATE_ROOT, staging, {
      __PLUGIN_NAME__: name,
      __PLUGIN_TITLE__: pluginTitle(name),
      __PLUGIN_ROUTE__: `/${name}`,
      __PLUGIN_VERSION__: VERSION,
    })
    await rename(staging, dest)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  if (!install) return dest

  try {
    if (!(await exists(path.join(repoRoot, 'ui/node_modules/react')))) {
      console.log('[create-plugin] 安装 ui/ 依赖…')
      await run('pnpm', ['install'], path.join(repoRoot, 'ui'))
    }
    console.log('[create-plugin] 安装插件依赖并构建页面…')
    await run('pnpm', ['install'], dest)
    await run('pnpm', ['run', 'build'], dest)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`目录已生成，但安装或构建失败：${message}\n可进入 ${dest} 执行 pnpm install && pnpm run build，或删除该目录后重试。`)
  }
  return dest
}

function printUsage() {
  console.log(`用法: node scripts/create-plugin.mjs --name <插件名> [--no-install] [--root <目录>]

创建 React + Tailwind + shadcn/ui 的 DSH 插件，默认布局为侧边栏 + 主窗口。
日常请用仓库根目录的 ./run.sh --create <插件名>。`)
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ name: string, root?: string, install: boolean, help: boolean }} */
  const opts = { name: '', install: true, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-install') opts.install = false
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--name') {
      opts.name = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--root') {
      opts.root = argv[i + 1] ?? ''
      i += 1
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    printUsage()
    return
  }
  if (!opts.name) throw new Error('用法: run.sh --create <插件名>')
  const dest = await createPlugin(opts)
  const name = opts.name
  console.log(`[create-plugin] 已创建 ${dest}`)
  console.log(`[create-plugin] 页面: http://127.0.0.1:3080/${name}`)
  console.log('[create-plugin] 下一步:')
  console.log(`  ./run.sh ${name} -d -r`)
  console.log('[create-plugin] 只改页面后: pnpm run build，然后刷新（不必重启）')
  console.log('[create-plugin] 改 plugins/web.ts 后需要重启 dsh web')
  console.log('[create-plugin] 请在仓库 README 插件表追加一行')
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[create-plugin] ${message}`)
    process.exit(1)
  })
}
