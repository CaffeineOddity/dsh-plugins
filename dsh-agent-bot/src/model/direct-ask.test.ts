import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { directAskPlacement } from './direct-ask.js'

describe('directAskPlacement', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('未勾选时忽略调用方目录，cwd 仍是技能仓', () => {
    const placed = directAskPlacement(
      { name: '答疑', workspace: '/skills/qa', needs_target_workspace: false },
      '/proj',
    )
    expect(placed).toEqual({ cwd: '/skills/qa', targetWorkspace: '', sessionKeySuffix: '', notice: '' })
  })

  it('勾选后会话仍开在技能仓，产出目录是调用方项目，且不同目录分槽', () => {
    const project = mkdtempSync(join(tmpdir(), 'direct-ask-'))
    dirs.push(project)
    const placed = directAskPlacement(
      { name: '设计师', workspace: '/skills/design', needs_target_workspace: true },
      project,
    )
    expect(placed.cwd).toBe('/skills/design')
    expect(placed.targetWorkspace).toBe(project)
    expect(placed.sessionKeySuffix).toMatch(/^__ag_[0-9a-f]{12}$/)
    expect(placed.notice).toContain(project)
    expect(placed.notice).toContain('/skills/design')
    expect(placed.notice).toContain('抛回调用方会话')

    const other = mkdtempSync(join(tmpdir(), 'direct-ask-'))
    dirs.push(other)
    const again = directAskPlacement(
      { name: '设计师', workspace: '/skills/design', needs_target_workspace: true },
      other,
    )
    expect(again.sessionKeySuffix).not.toBe(placed.sessionKeySuffix)
  })

  it('勾选但没有调用方目录时报错，不回落技能仓', () => {
    expect(() => directAskPlacement(
      { name: '设计师', workspace: '/skills/design', needs_target_workspace: true },
      '',
    )).toThrow(/需要目标项目目录/)
  })
})
