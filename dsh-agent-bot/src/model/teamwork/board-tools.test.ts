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
import { buildExpertCards, hubMembers, resolveTargetWorkspace, type ExpertCard } from './board-tools.js'
import { taskSlotKey } from './relay.js'
import { registerBoardTools } from './board-tools.js'
import { writeTask, type TaskBoard } from './task-board.js'
import { getAgent } from '../agents.js'

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

describe('open_task：把当前会话写进该单任务槽', () => {
  it('捡起 running 单后，任务槽指向当前会话（后续入站/叫醒命中同一条）', async () => {
    const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = []
    const ctx = {
      get: (n: string) =>
        n === 'tools' ? { register: (d: { name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }) => { tools.push(d); return () => undefined } } : undefined,
      effect: () => undefined,
    }
    registerBoardTools(ctx as never, {
      conversationKeyFor: (_p, parts) => parts.group_id ?? 'local',
      agentIdentity: () => ({ agentId: bobId, agentName: 'Bob' }),
      ensureAgent: async () => ({}) as never,
      agents: () => undefined,
    })
    const openTask = tools.find((t) => t.name === 'open_task')
    if (openTask === undefined) throw new Error('open_task 未注册')
    const t: TaskBoard = {
      taskId: 'task_ot',
      taskLead: bobId,
      sender: 'alice',
      providerId: 'demo',
      sessionParts: { bot_id: 'r1', group_id: 'g1' },
      originContext: 'c',
      access: 'write',
      createdAt: 1,
      deadlineAt: 2,
      groupSnapshot: [],
      assignees: [],
      body: '',
    }
    writeTask('running', t)

    await openTask.execute({ taskId: 'task_ot' }, { agent: { id: 'sess-1' } })
    expect(getAgent(bobId)?.sessions[taskSlotKey('task_ot', bobId)]?.sessionId).toBe('sess-1')
  })
})

describe('taskSlotKey（任务槽 key 不含 sender）', () => {
  it('同一单同一 agent 一条槽；不同单/不同 agent 各自一条', () => {
    expect(taskSlotKey('task_1', 'a1')).toBe('task:task_1:a1')
    expect(taskSlotKey('task_1', 'a2')).not.toBe(taskSlotKey('task_1', 'a1'))
    expect(taskSlotKey('task_2', 'a1')).not.toBe(taskSlotKey('task_1', 'a1'))
  })
})

describe('hubMembers（路线 b：中枢全集来源）', () => {
  it('列出 agents.json 全集，不经群快照；可被 buildExpertCards 补齐技能', () => {
    const hub = hubMembers()
    const ids = hub.map((m) => m.agentId).sort()
    expect(ids).toEqual([bobId, aliceId].sort())
    expect(hub.find((m) => m.agentId === bobId)?.name).toBe('Bob')
    // 与群快照无关：全集里也有 Bob（即使没人把它放进群）
    const cards = buildExpertCards(hub)
    expect(cards.find((c) => c.agentId === bobId)?.skills?.[0].name).toBe('design.md')
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
