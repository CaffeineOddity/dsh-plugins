import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const KEEP = 200

export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  path: string
  home: string
  parent: string | null
  entries: DirectoryEntry[]
  truncated: boolean
}

function explain(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'ENOENT') return '目录不存在'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限读取这个目录'
  if (code === 'ENOTDIR') return '这不是目录'
  return error instanceof Error ? error.message : String(error)
}

export async function listHostDirectory(requested: string | undefined): Promise<DirectoryListing> {
  const home = homedir()
  const raw = requested === undefined || requested === '' ? home : requested
  if (raw.includes('\0') || !isAbsolute(raw)) throw new Error('目录必须是这台电脑上的绝对路径')
  const path = resolve(raw)
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error('这不是目录')
    const found = await readdir(path, { withFileTypes: true })
    const entries: DirectoryEntry[] = []
    let truncated = false
    const names = found.map((item) => item.name).sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      if (entries.length >= KEEP) {
        truncated = true
        break
      }
      const child = join(path, name)
      try {
        const childInfo = await stat(child)
        if (!childInfo.isDirectory()) continue
        entries.push({ name, path: child })
      } catch {
        // 读不到的子项跳过，不让整层失败。
      }
    }
    const parent = dirname(path)
    return { path, home, parent: parent === path ? null : parent, entries, truncated }
  } catch (error) {
    if (error instanceof Error && error.message === '这不是目录') throw error
    throw new Error(explain(error))
  }
}
