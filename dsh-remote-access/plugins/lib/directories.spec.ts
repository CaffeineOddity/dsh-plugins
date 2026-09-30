import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listHostDirectory } from './directories.ts'

describe('本机目录列表', () => {
  it('只返回这台电脑上的子目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-dir-'))
    await mkdir(join(root, 'work'))
    const listed = await listHostDirectory(root)
    expect(listed.path).toBe(root)
    expect(listed.entries.map((entry) => entry.name)).toContain('work')
    await expect(listHostDirectory('relative')).rejects.toThrow(/绝对路径/)
  })
})
