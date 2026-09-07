// ruliu agent 回合的纯决策逻辑的本地复用：idle→idle 收口 + 最终文本提取。
// 来源参考 ruliu-dsh-plugin/plugins/lib/agent-run.ts（避免跨项目依赖，按需内联最小子集）。

/** 一条会话事件的最小投影（只读 type/seq；data 按 type 收窄）。 */
export interface RunEvent {
  seq: number
  type: string
  data?: unknown
}
/** 拥有区间的结束方式：等到 idle，或安全阀超时。 */
export type IdleWaitResult = 'idle' | 'timeout'

/** 从 assistant/message 的 data 抽出非空 text 块拼接。 */
function assistantText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const message = (data as { message?: { content?: unknown } }).message
  if (message === undefined || !Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const row = block as { type?: unknown; text?: unknown }
    if (row.type !== 'text' || typeof row.text !== 'string' || row.text === '') continue
    parts.push(row.text)
  }
  return parts.join('')
}

/**
 * 汇总一段自有运行区间的最终 assistant 文本：从 firstSeq 起遇到 turn/start
 * 才开始记账，空文本的 tool-call assistant 不覆盖已有答案。
 */
export function summarizeOwnedInterval(events: readonly RunEvent[], firstSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type !== 'assistant/message') continue
    const joined = assistantText(event.data)
    if (joined !== '') text = joined
  }
  return text
}

/**
 * 竞速 whenIdle 与超时。timeoutMs<=0 表示只等 idle。
 */
export async function waitIdleOrTimeout(whenIdle: Promise<void>, timeoutMs: number): Promise<IdleWaitResult> {
  if (timeoutMs <= 0) {
    await whenIdle
    return 'idle'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<IdleWaitResult>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const idle = whenIdle.then((): IdleWaitResult => 'idle')
    return await Promise.race([idle, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
