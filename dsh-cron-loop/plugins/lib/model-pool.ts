// 全局模型池：按 priority 取优先级最高的可用模型，额度耗尽标记 exhausted，
// 队列结构不动，只改运行时状态。重置周期到了自动恢复。
// 配置存 ~/.dsh/storages/crons/model-pool.json，独立于 job。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** 额度重置周期。 */
export interface QuotaReset {
  /** hours: n 小时后重置；daily: 每天 0 点；weekly: 每周一 0 点；monthly: 每月 1 号 0 点。 */
  type: 'hours' | 'daily' | 'weekly' | 'monthly'
  /** hours 模式下的重置间隔（小时）。 */
  value?: number
}

/** 模型配置 + 运行时状态。 */
export interface ModelEntry {
  /** 唯一标识（用户自定义，如 volcengine-135）。 */
  id: string
  /** DSH provider route（如 volcengine）。 */
  provider: string
  /** 模型 id（如 ark-code-latest）。 */
  model: string
  /** 优先级，数字越小越优先。 */
  priority: number
  /** 额度重置周期。 */
  quotaReset: QuotaReset
  /** 运行时：额度是否耗尽。 */
  exhausted?: boolean
  /** 运行时：耗尽时间戳（epoch ms）。 */
  exhaustedAt?: number | null
  /** 运行时：不可恢复（如 INVALID_CREDENTIAL）。 */
  permanentlyUnavailable?: boolean
}

/** 模型池配置文件。 */
export interface ModelPoolFile {
  enabled: boolean
  models: ModelEntry[]
}

/** 模型选择结果。 */
export interface ModelSelection {
  provider: string
  model: string
  id: string
}

/** 模型池根目录。 */
function poolDir(): string {
  return join(homedir(), '.dsh', 'storages', 'crons')
}

/** 模型池配置文件路径。 */
export function modelPoolPath(): string {
  return join(poolDir(), 'model-pool.json')
}

/** 原子写入。 */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const { rename } = await import('node:fs/promises')
  const tmp = join(join(path, '..'), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

/**
 * 计算模型的恢复时间点（epoch ms）。
 * - hours: exhaustedAt + value * 3600_000
 * - daily: 下一个自然日 0 点
 * - weekly: 下一个周一 0 点
 * - monthly: 下一个自然月 1 号 0 点
 */
export function computeRecoveryAt(entry: ModelEntry): number | null {
  if (entry.exhaustedAt === undefined || entry.exhaustedAt === null) return null
  const base = entry.exhaustedAt
  const reset = entry.quotaReset
  if (reset.type === 'hours') {
    const hours = reset.value ?? 24
    return base + hours * 3_600_000
  }
  // daily/weekly/monthly: 计算下一个重置自然时间点
  const d = new Date(base)
  if (reset.type === 'daily') {
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  if (reset.type === 'weekly') {
    d.setHours(0, 0, 0, 0)
    const day = d.getDay() // 0=周日
    const daysUntilMonday = day === 1 ? 7 : (1 - day + 7) % 7
    d.setDate(d.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday))
    return d.getTime()
  }
  // monthly
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

/** 全局模型池：不依赖 ctx，纯文件读写 + 内存缓存。 */
export class ModelPool {
  private config: ModelPoolFile | null = null

  private constructor() {}

  /** 加载模型池配置（首次或刷新时调用）。 */
  static async load(): Promise<ModelPool> {
    const pool = new ModelPool()
    await pool.reload()
    return pool
  }

  /** 从磁盘重新加载配置。 */
  async reload(): Promise<void> {
    try {
      const text = await readFile(modelPoolPath(), 'utf8')
      this.config = JSON.parse(text) as ModelPoolFile
    } catch {
      // 文件不存在或格式错误 -> 视为未启用
      this.config = null
    }
  }

  /** 测试用：从内存配置构造（绕过文件读取）。 */
  static fromConfig(config: ModelPoolFile): ModelPool {
    const pool = new ModelPool()
    pool.config = config
    return pool
  }

  /** 是否启用（配置存在且 enabled=true）。 */
  get isEnabled(): boolean {
    return this.config !== null && this.config.enabled === true && this.config.models.length > 0
  }

  /**
   * 取优先级最高的可用模型（exhausted=false 且 非 permanentlyUnavailable）。
   * 同时恢复已到重置周期的耗尽模型。无可用模型返回 null。
   */
  pickAvailable(): ModelSelection | null {
    if (!this.isEnabled) return null
    const now = Date.now()
    let changed = false
    const models = this.config!.models

    // 恢复检查：exhausted=true 且重置周期已到 -> 恢复
    for (const m of models) {
      if (m.exhausted === true && !m.permanentlyUnavailable) {
        const recoveryAt = computeRecoveryAt(m)
        if (recoveryAt !== null && recoveryAt <= now) {
          m.exhausted = false
          m.exhaustedAt = null
          changed = true
        }
      }
    }
    if (changed) void this.save()

    // 按 priority 升序取第一个可用的
    const sorted = [...models].sort((a, b) => a.priority - b.priority)
    const picked = sorted.find((m) => m.exhausted !== true && !m.permanentlyUnavailable)
    if (picked === undefined) return null
    return { provider: picked.provider, model: picked.model, id: picked.id }
  }

  /** 标记模型额度耗尽（写回文件）。 */
  async markExhausted(modelId: string, permanent = false): Promise<void> {
    if (this.config === null) return
    const entry = this.config.models.find((m) => m.id === modelId)
    if (entry === undefined) return
    entry.exhausted = true
    entry.exhaustedAt = Date.now()
    if (permanent) entry.permanentlyUnavailable = true
    await this.save()
  }

  /** 写回配置文件。 */
  async save(): Promise<void> {
    if (this.config === null) return
    await writeAtomic(modelPoolPath(), JSON.stringify(this.config, null, 2))
  }

  /** 获取当前配置快照（只读）。 */
  snapshot(): ModelPoolFile | null {
    if (this.config === null) return null
    return JSON.parse(JSON.stringify(this.config)) as ModelPoolFile
  }

  /** 更新配置（整体替换并写回）。 */
  async update(next: ModelPoolFile): Promise<void> {
    this.config = next
    await this.save()
  }
}
