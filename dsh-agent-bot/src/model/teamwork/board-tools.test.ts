/**
 * 看板工具单测：卡片组装 / 目标校验 / 工具注册面。
 * 工具本体多依赖 DSH scoped ctx，这里主要测纯函数面。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import { createAgent as createAgentConfig, saveAgent, type AgentWrite } from '../agents.js'
import { buildExpertCards, resolveTargetWorkspace, runningSummaries, type ExpertCard } from './board-tools.js'

let dir: string
let prevEnv: string | undefined
let bobId = ''
let aliceId = ''

const wsOf = (n: string) => join(dir, n)

function mkAgent(name: string, over: Partial<AgentWrite> = {}): string {
  const skill = join(dir, 'skills')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(dir, 'skill-groups.json'),
    JSON.stringify({ designers: { id: 'designers', name: '设计组', skill_ids: ['designer'] } }),
  )
  writeFileSync(
    join(dir, 'skills-map.json'),
    JSON.stringify({
      roots: [],
      scanned_at: Date.now(),
      skills: [{ id: 'designer', name: 'designer', path: join(skill, 'design.md'), description: '擅长界面设计' }],
    }),
  )
  const wrote = saveAgent({
    id: '',
    name,
    description: name === 'Bob' ? 'Bob 描述' : '',
    workspace: wsOf(name),
    prompt: '',
    prompt_placement: 'system',
    skill_groups: name === 'Bob' ? ['designers'] : [],
    prompt_append_skills: true,
    reuse_session: true,
    session_by_sender: false,
    permission_mode: 'danger-full-access',
    session_timeout_minutes: 30,
    concurrency: 'serial',
    needs_target_workspace: name === 'Alice',
    ...over,
  })
  return wrote.agent.id
}

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'board-tools-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
  bobId = mkAgent('Bob')
  aliceId = mkAgent('Alice', { needs_target_workspace: true })
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

const members = () => [
  { agentId: bobId, name: 'Bob', description: 'Bob 描述' },
  { agentId: aliceId, name: 'Alice', description: '' },
]

describe('buildExpertCards', () => {
  it('按 agents.json + skills-map 补齐卡片；未落盘成员丢弃', () => {
    const cards = buildExpertCards([...members(), { agentId: 'ghost', name: '幽灵', description: '' }])
    expect(cards.length).toBe(2)
    const bob = cards.find((c) => c.agentId === bobId) as ExpertCard
    expect(bob.description).toBe('Bob 描述')
    expect(bob.needs_target_workspace).toBeUndefined()
    expect(bob.skills?.[0].name).toBe('design.md')
    const alice = cards.find((c) => c.agentId === aliceId) as ExpertCard
    expect(alice.needs_target_workspace).toBe(true)
    expect(alice.workspaceCandidates?.some((w) => w.workspace === wsOf('Bob'))).toBe(true)
  })
})

describe('resolveTargetWorkspace', () => {
  const aliceCfg = async () => {
    // 已在 beforeEach 落盘 Alice（needstarget），直接取最新副本
    const cfg = await import('../agents.js').then((m) => m.getAgent(aliceId as string))
    if (cfg === undefined) throw new Error('alice 未落盘')
    return cfg
  }
  it('needs_target_workspace=true 必填绝对路径 + 存在', async () => {
    const cfg = await aliceCfg()
    expect(resolveTargetWorkspace(cfg, undefined).ok).toBe(false)
    const proj = join(dir, 'proj')
    mkdirSync(proj, { recursive: true })
    const r = resolveTargetWorkspace(cfg, proj)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe(proj)
  })
  it('needs_target_workspace=false 不强制 target', async () => {
    const cfg = await aliceCfg()
    const r = resolveTargetWorkspace({ ...cfg, needs_target_workspace: false }, '')
    expect(r.ok).toBe(true)
  })
})

describe('runningSummaries', () => {
  it('空 running 返回空数组', () => {
    expect(runningSummaries('local', {})).toEqual([])
  })
})