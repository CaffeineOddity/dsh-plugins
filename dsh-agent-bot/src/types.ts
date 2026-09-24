/**
 * dsh-agent-bot 公开契约（Host 半体 provide('agentBot')）。
 * 完整约定见 docs/specs/01-overview.md。通道插件（feishu / …）duck-type 本文件，不 npm 依赖本包。
 */

/** 已注册的通道 Provider 摘要（大脑只存 id / 展示名，不持有发送函数）。 */
export interface AgentChannelProviderInfo {
  id: string
  label: string
}

/** 通道 sessionParts 禁止携带：投递字段，以及 sender（sender 由大脑按 agent 配置决定是否并入）。 */
const INCOMING_PART_FORBIDDEN = new Set(['webhook_url', 'webhook', 'toid', 'sender'])

/**
 * 通道入站交给大脑的元数据。
 * webhook 由通道用 bot_id 自行解析，不进 meta。
 * 是否按人隔离、是否续旧会话都由该 agent 配置决定。
 */
export interface AgentAskMeta {
  /** 本轮追踪 id，通道生成，补发/日志用。 */
  traceId: string
  /** 必须等于已注册 Provider 的 id（`feishu` / …）。 */
  providerId: string
  /**
   * 「这是哪一路对话」的具名字段，不是拼好的 key。
   * 示例：`{ bot_id, group_id }`；飞书：`{ app_id, chat_id }`。
   * 不含 webhook_url / sender。禁止传 sessionKey / reset。
   */
  sessionParts: Record<string, string>
  /** 发言者稳定 id。始终传入；是否写入 sessionKey 看 agent.session_by_sender。 */
  sender: string
}

/**
 * 按 agent 配置生成真正拿去编码的 map。
 * session_by_sender=false：原样（通道 parts）。
 * session_by_sender=true：拷贝后加上 sender；此时 sender 必填。
 */
export function sessionPartsForEncode(
  sessionParts: Record<string, string>,
  sender: string,
  sessionBySender: boolean,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sessionParts)) {
    if (INCOMING_PART_FORBIDDEN.has(key)) {
      throw new Error(`agent-bot: sessionParts 禁止字段 ${key}`)
    }
    if (key === '' || value === '') {
      throw new Error(`agent-bot: sessionParts 键值不可为空`)
    }
    out[key] = value
  }
  if (Object.keys(out).length === 0) {
    throw new Error('agent-bot: sessionParts 需要至少一对键值')
  }
  if (sessionBySender) {
    if (sender === '') throw new Error('agent-bot: session_by_sender 需要非空 sender')
    out.sender = sender
  }
  return out
}

/**
 * 大脑唯一的会话槽编码：`<providerId>_<按 key 字母序的各值>`，用 `_` 连接。
 * 调用前先走 sessionPartsForEncode。例：`feishu_r1_6031348` / `feishu_r1_6031348_alice`。
 *
 * `providerId` **必须**进来：只用 `sessionParts` 的值拼时，不同通道若 `bot_id` / `group_id`
 * 取值撞上会共用同一个槽（跨通道串台）。
 */
export function encodeSessionKey(sessionParts: Record<string, string>, providerId: string): string {
  const pid = providerId.trim()
  if (pid === '') throw new Error('agent-bot: encodeSessionKey 需要 providerId')
  const keys = Object.keys(sessionParts).sort()
  if (keys.length === 0) throw new Error('agent-bot: encodeSessionKey 需要非空 sessionParts')
  const values: string[] = []
  for (const key of keys) {
    if (key === '') throw new Error('agent-bot: sessionParts 键不可为空')
    const value = sessionParts[key]
    if (value === undefined || value === '') {
      throw new Error(`agent-bot: sessionParts.${key} 不可为空`)
    }
    values.push(value)
  }
  return [pid, ...values].join('_')
}

export interface AgentAskRequest {
  agentId: string
  /** 用户可见文本。唯一格式 `用户[<fromuserid>]: <纯文本>`；不含 webhook / toid / prompt / 档案。 */
  context: string
  meta: AgentAskMeta
}

/**
 * 本轮一条出站。通道按数组顺序各发一次，不合并成一条 IM。
 * ack / 超时 / ask 抛错由通道自己发，不出现在这里。
 * v1 大脑只产单条 markdown；text / image / link 为通道已实现、大脑 v1 不产。
 * AT 不是独立 kind：挂在 text/link 上（atAll / atUserIds），不能与 markdown/image 混合。
 */
export interface AgentOutboundMessage {
  kind: 'text' | 'markdown' | 'image' | 'link'
  /** text / markdown 正文；link 的可选 label；image 可空（配图说明须拆独立 markdown 条）。 */
  text: string
  /**
   * image：http(s) 直链或绝对路径（大脑已解析完相对路径）。通道编成 IM 图片的 base64。
   * link：href，必填、≤1024 字。
   * 其它 kind 为空串。
   */
  url: string
  /** @ 成员稳定 id。空 = 不 AT。仅 text/link 有效。 */
  atUserIds: string[]
  /** true 则 @全体，忽略 atUserIds。仅 text/link 有效。 */
  atAll: boolean
}

export interface AgentAskResponse {
  /** 此刻已可发的条，按序。空数组 = 先别发结果（ack 已由通道发出）。 */
  messages: AgentOutboundMessage[]
  /** 非空则通道 await 后再按序投递。同进程 Promise，禁止 JSON.stringify。 */
  pending: Promise<AgentOutboundMessage[]> | null
}

export interface AgentSummary {
  id: string
  name: string
  /** 英文命令别名：非空时注册 /agent_<slug>。 */
  slug?: string
  /** 功能说明，可空。通道下拉给人看，不参与 ask。 */
  description: string
  workspace: string
}

/** 通道登记时提供的一位群成员（agent 投影）。 */
export interface AgentGroupMemberInfo {
  agentId: string
  name: string
  description: string
}

/** deliver 收口请求：与本轮回发同形。 */
export interface AgentDeliverRequest {
  sessionParts: Record<string, string>
  messages: AgentOutboundMessage[]
}

/**
 * 通道插件向大脑登记自己。dispose 在通道 unload 时必须调用。
 * `listGroupAgents` / `deliver` 可选（见 docs/specs/02-provider-contract.md）。
 */
export interface AgentChannelProviderRegistration {
  id: string
  label: string
  /** 可选：按本轮 sessionParts 返回该群绑定了 agentId 的成员。缺省专家清单为空。 */
  listGroupAgents?(sessionParts: Record<string, string>): AgentGroupMemberInfo[]
  /**
   * 可选：把一个 `sessionParts` 压成「这是哪个对话」的标识，用于**板可见性**过滤
   * （同 providerId + 同 conversationKey 才看得到彼此的任务）。
   * IM 通道应返回群身份（`group_id` / 飞书 `chat_id`）且**不要带 `bot_id`**
   * —— 带上就会同群各台 bot 各看各的板，破坏「直 @ 与协作派发看见同一块板」。
   * local（本地）返回常量，表示整台中枢共用一块板。缺省实现见 `conversationKeyOf`。
   */
  conversationKey?(sessionParts: Record<string, string>): string
  /** 可选：任务收口投递（与 ask 出站同形）。缺省只打日志。 */
  deliver?(req: AgentDeliverRequest): Promise<void>
}

/** 已注册 Provider 的运行时表示（含可选反向能力）。 */
export interface AgentChannelProviderInfo extends AgentChannelProviderRegistration {
  id: string
  label: string
}

/**
 * 板可见性用的「对话」标识：优先通道自定义；否则取 `group_id`；再否则把 sessionParts 规范化拼起来。
 */
export function conversationKeyOf(
  sessionParts: Record<string, string>,
  custom?: (parts: Record<string, string>) => string,
): string {
  if (custom !== undefined) {
    const v = custom(sessionParts)
    if (typeof v === 'string' && v !== '') return v
  }
  const group = sessionParts.group_id
  if (typeof group === 'string' && group !== '') return group
  return Object.keys(sessionParts)
    .sort()
    .map((k) => `${k}=${sessionParts[k]}`)
    .join('&')
}

export interface AgentBotService {
  listAgents(): AgentSummary[]
  getAgent(id: string): AgentSummary | undefined
  listProviders(): AgentChannelProviderInfo[]
  registerProvider(reg: AgentChannelProviderRegistration): () => void
  ask(req: AgentAskRequest): Promise<AgentAskResponse>
  /** /agent 命令与 rpc 共用：解析 rawInput 调本地 ask，展平 pending，返回所有条。 */
  localAsk(rawInput: string, sessionKey?: string): Promise<{ messages: AgentOutboundMessage[]; error?: string }>
  /** 按 providerId 查已登记通道的收口能力。 */
  providerDeliver(providerId: string): ((req: AgentDeliverRequest) => Promise<void>) | undefined
  /**
   * 宿主事件入口：某会话变为 idle（`agent/status`）时调用，
   * 让协作链「做完就上报/收口」，不依赖轮询。
   */
  notifyAgentIdle(sessionId: string): void
  /** 宿主事件入口：会话被销毁（`agent/disposed`）时调用。 */
  notifyAgentDisposed(sessionId: string): void
  /** 宿主事件入口：会话日志追加了审批审计事件（`session/event`）时调用。 */
  notifySessionEvent(sessionId: string): void
  /**
   * 取走本地（网页对话）待发的异步消息：patrol 想给人的问卷 / 进度 / 提醒
   * 没法主动推给网页，就按对话存进收件箱，网页轮询取走。取走即清空。
   */
  drainLocalInbox(sessionKey: string): AgentOutboundMessage[]
}
