// cron 表达式解析与下次触发时间计算（纯函数，不依赖运行时 ctx）。
// 支持 5 段 cron（分 时 日 月 周）：`*`、数字、`,`、`-`、`*/n`、英文缩写（MON/JAN…）。
// 语义对齐 vixie-cron 的常用子集：字段相交匹配；日在 DOM/DOW 同时受限时按 cron
// 惯例取「任一匹配」（`*` 视为不受限，不触发该规则）。

/** cron 解析失败：消息带原始表达式与出错字段。 */
export class CronParseError extends Error {
  /** 原始表达式。 */
  readonly expr: string
  /** 出错的字段名（minute/hour/day-of-month/month/day-of-week）。 */
  readonly field: string

  constructor(expr: string, field: string, reason: string) {
    super(`invalid cron expression "${expr}" at ${field}: ${reason}`)
    this.name = 'CronParseError'
    this.expr = expr
    this.field = field
  }
}

/** 一个已解析的 cron 计划。 */
export interface CronPlan {
  /** 原始表达式。 */
  readonly expr: string
  /** 分钟取值集合（0-59）。 */
  readonly minutes: ReadonlySet<number>
  /** 小时取值集合（0-23）。 */
  readonly hours: ReadonlySet<number>
  /** 日-of-月取值集合；`undefined` 表示 `*` 不受限。 */
  readonly daysOfMonth: ReadonlySet<number> | undefined
  /** 月取值集合（1-12）。 */
  readonly months: ReadonlySet<number>
  /** 星期取值集合（0-6，0=周日）；`undefined` 表示 `*` 不受限。 */
  readonly daysOfWeek: ReadonlySet<number> | undefined
}

/** 单字段定义：取值范围与英文别名。 */
interface FieldSpec {
  readonly min: number
  readonly max: number
  readonly aliases?: Readonly<Record<string, number>>
}

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const DOW_ALIASES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const FIELD_SPECS: readonly [string, FieldSpec][] = [
  ['minute', { min: 0, max: 59 }],
  ['hour', { min: 0, max: 23 }],
  ['day-of-month', { min: 1, max: 31 }],
  ['month', { min: 1, max: 12, aliases: MONTH_ALIASES }],
  ['day-of-week', { min: 0, max: 6, aliases: DOW_ALIASES }],
]

/** 解析一个字段为取值集合；`*` 返回 undefined（不受限）。 */
function parseField(expr: string, field: string, spec: FieldSpec): ReadonlySet<number> | undefined {
  const trimmed = expr.trim()
  if (trimmed === '*' || trimmed === '') {
    if (trimmed === '') throw new CronParseError(expr, field, 'empty field')
    return undefined
  }
  const values = new Set<number>()
  for (const part of trimmed.split(',')) {
    const segments = part.split('/')
    const rangePart = segments[0]
    const stepPart = segments[1]
    if (rangePart === undefined) throw new CronParseError(expr, field, `bad range "${part}"`)
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(expr, field, `bad step "${part}"`)
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = spec.min
      hi = spec.max
    } else if (rangePart.includes('-')) {
      const ends = rangePart.split('-')
      lo = resolveValue(ends[0] ?? '', spec)
      hi = resolveValue(ends[1] ?? '', spec)
    } else {
      lo = resolveValue(rangePart, spec)
      hi = stepPart !== undefined ? spec.max : lo
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new CronParseError(expr, field, `range ${lo}-${hi} outside ${spec.min}-${spec.max}`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) throw new CronParseError(expr, field, 'no values')
  return values
}

/** 解析单个值：数字或英文别名。 */
function resolveValue(text: string, spec: FieldSpec): number {
  const lower = text.trim().toLowerCase()
  if (spec.aliases !== undefined && lower in spec.aliases) return spec.aliases[lower] as number
  const n = Number(lower)
  if (!Number.isInteger(n)) throw new Error(`bad value "${text}"`)
  return n
}

/** 解析 5 段 cron 表达式；失败抛 CronParseError。 */
export function parseCron(expr: string): CronPlan {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(expr, 'minute', `expected 5 fields, got ${parts.length}`)
  }
  let domError: unknown
  let dowError: unknown
  let daysOfMonth: ReadonlySet<number> | undefined
  let daysOfWeek: ReadonlySet<number> | undefined
  try {
    daysOfMonth = parseField(parts[2] as string, 'day-of-month', FIELD_SPECS[2]![1])
  } catch (e) { domError = e }
  try {
    daysOfWeek = parseField(parts[4] as string, 'day-of-week', FIELD_SPECS[4]![1])
  } catch (e) { dowError = e }
  // dom/dow 解析失败不能吞：先于其他字段抛出（保持「非法即抛错」约定）。
  if (domError !== undefined) throw domError
  if (dowError !== undefined) throw dowError
  return {
    expr,
    minutes: parseField(parts[0] as string, 'minute', FIELD_SPECS[0]![1]) ?? allOf(0, 59),
    hours: parseField(parts[1] as string, 'hour', FIELD_SPECS[1]![1]) ?? allOf(0, 23),
    daysOfMonth,
    months: parseField(parts[3] as string, 'month', FIELD_SPECS[3]![1]) ?? allOf(1, 12),
    daysOfWeek,
  }
}

/** 全量集合（`*` 归一化用）。 */
function allOf(min: number, max: number): Set<number> {
  const s = new Set<number>()
  for (let v = min; v <= max; v++) s.add(v)
  return s
}

/** 本地时区下某时刻是否命中计划。 */
export function matches(plan: CronPlan, date: Date): boolean {
  if (!plan.months.has(date.getMonth() + 1)) return false
  if (!plan.minutes.has(date.getMinutes())) return false
  if (!plan.hours.has(date.getHours())) return false
  const domRestricted = plan.daysOfMonth !== undefined
  const dowRestricted = plan.daysOfWeek !== undefined
  if (domRestricted && dowRestricted) {
    // vixie-cron 惯例：两字段都受限时 OR。
    const domHit = (plan.daysOfMonth as ReadonlySet<number>).has(date.getDate())
    const dowHit = (plan.daysOfWeek as ReadonlySet<number>).has(date.getDay())
    return domHit || dowHit
  }
  if (domRestricted && !(plan.daysOfMonth as ReadonlySet<number>).has(date.getDate())) return false
  if (dowRestricted && !(plan.daysOfWeek as ReadonlySet<number>).has(date.getDay())) return false
  return true
}

/**
 * 计算严格晚于 `from` 的下一次触发时间（本地时区，秒清零）。
 * 最多向前扫 5 年（覆盖全历法组合）；找不到说明表达式永不可能命中，抛错。
 */
export function computeNextRun(plan: CronPlan, from: Date): Date {
  const next = new Date(from.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)
  const limit = 5 * 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (matches(plan, next)) return next
    next.setMinutes(next.getMinutes() + 1)
  }
  throw new Error(`cron "${plan.expr}" never fires within 5 years`)
}

/** 校验表达式：合法返回 plan，非法抛 CronParseError（供工具/命令/HTTP 共用）。 */
export function assertValidCron(expr: string): CronPlan {
  return parseCron(expr)
}

/**
 * 把 cron 表达式转为人类可读的中文描述（如「每分钟」「每天 09:00」「工作日 09:00」）。
 * 仅覆盖常见模式，无法概括时回退原表达式。
 */
export function describeCron(expr: string): string {
  let plan: CronPlan
  try {
    plan = parseCron(expr)
  } catch {
    return expr
  }
  const minutes = [...plan.minutes].sort((a, b) => a - b)
  const hours = [...plan.hours].sort((a, b) => a - b)
  const domAll = plan.daysOfMonth === undefined
  const dowAll = plan.daysOfWeek === undefined
  const monAll = plan.months.size === 12

  // 每分钟
  if (minutes.length === 60 && hours.length === 24 && domAll && dowAll && monAll) {
    return '每分钟'
  }

  const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}`
  const fmtMin = (m: number): string => `${String(m).padStart(2, '0')}`

  // 每天 X:XX
  if (minutes.length === 1 && hours.length === 1 && domAll && dowAll && monAll) {
    return `每天 ${fmtHour(hours[0]!)}:${fmtMin(minutes[0]!)}`
  }

  // 每小时 X 分
  if (minutes.length === 1 && hours.length === 24 && domAll && dowAll && monAll) {
    return `每小时 ${fmtMin(minutes[0]!)} 分`
  }

  // 每 N 分钟
  if (minutes.length > 1 && hours.length === 24 && domAll && dowAll && monAll) {
    const step = minutes[1]! - minutes[0]!
    if (step > 1 && minutes.every((m, i) => i === 0 || m - minutes[i - 1]! === step)) {
      return `每 ${step} 分钟`
    }
  }

  // 工作日（周一~周五）
  const weekday = !dowAll && plan.daysOfWeek !== undefined
    && [1, 2, 3, 4, 5].every((d) => plan.daysOfWeek!.has(d))
    && plan.daysOfWeek.size === 5

  if (weekday && domAll && monAll) {
    if (minutes.length === 1 && hours.length === 1) {
      return `工作日 ${fmtHour(hours[0]!)}:${fmtMin(minutes[0]!)}`
    }
  }

  // 周末
  const weekend = !dowAll && plan.daysOfWeek !== undefined
    && [0, 6].every((d) => plan.daysOfWeek!.has(d))
    && plan.daysOfWeek.size === 2
  if (weekend && domAll && monAll && minutes.length === 1 && hours.length === 1) {
    return `周末 ${fmtHour(hours[0]!)}:${fmtMin(minutes[0]!)}`
  }

  // 每月 X 号
  if (!domAll && dowAll && monAll && plan.daysOfMonth!.size === 1 && minutes.length === 1 && hours.length === 1) {
    return `每月 ${plan.daysOfMonth!.values().next().value!} 号 ${fmtHour(hours[0]!)}:${fmtMin(minutes[0]!)}`
  }

  // 回退：原表达式
  return expr
}
