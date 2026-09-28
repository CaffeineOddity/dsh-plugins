import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { newHubKey } from './secrets.ts'

export interface PairedDevice {
  id: string
  name: string
  origin: string
  cipher: string
  iv: string
  tag: string
  pairedAt: number
}

export interface HubSession {
  hash: string
  expiresAt: number
}

/** 中枢上的一条路径。tokenHash 为空表示还没完成接入。 */
export interface PathSlot {
  slug: string
  name: string
  tokenHash: string
  enroll: { hash: string; expiresAt: number } | null
  createdAt: number
}

/** 本机作为出站端连到别人的中枢。令牌只以密文保存。 */
export interface SpokeConfig {
  hubOrigin: string
  slug: string
  cipher: string
  iv: string
  tag: string
}

export interface RemoteState {
  deviceId: string
  deviceName: string
  publicOrigin: string
  domainSuffix: string
  listenPort: number
  tokenHash: string
  /** 已绑定的控制台令牌哈希。空时回落到 tokenHash。 */
  tokenHashes: string[]
  hubPassHash: string
  hubKey: string
  pairing: { hash: string; expiresAt: number } | null
  hubSessions: HubSession[]
  devices: PairedDevice[]
  activeDeviceId: string
  /** 本机在中枢上的路径，缺省 home。`dsh.example.com/home` 打到自己。 */
  selfSlug: string
  paths: PathSlot[]
  spoke: SpokeConfig | null
  /** 本机是否应保持隧道运行。暂停后重启插件不会自己拉起。 */
  tunnelDesired: 'run' | 'stop'
  /** hub：这台是中枢。spoke：这台出站连中枢。 */
  role: 'hub' | 'spoke'
}

export function defaultState(): RemoteState {
  return {
    deviceId: randomUUID(),
    deviceName: '这台 DSH',
    publicOrigin: '',
    domainSuffix: '',
    listenPort: 3921,
    tokenHash: '',
    tokenHashes: [],
    hubPassHash: '',
    hubKey: newHubKey(),
    pairing: null,
    hubSessions: [],
    devices: [],
    activeDeviceId: 'this',
    selfSlug: 'home',
    paths: [],
    spoke: null,
    tunnelDesired: 'stop',
    role: 'hub',
  }
}

export function statePath(): string {
  return join(homedir(), '.dsh', 'storages', 'dsh-remote-access', 'state.json')
}

export function loadState(file = statePath()): RemoteState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteState>
    const base = defaultState()
    return {
      ...base,
      ...parsed,
      deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId !== '' ? parsed.deviceId : base.deviceId,
      hubKey: typeof parsed.hubKey === 'string' && parsed.hubKey !== '' ? parsed.hubKey : base.hubKey,
      pairing: parsed.pairing ?? null,
      hubSessions: Array.isArray(parsed.hubSessions) ? parsed.hubSessions : [],
      tokenHashes: Array.isArray(parsed.tokenHashes) ? parsed.tokenHashes.filter((h) => typeof h === 'string' && h !== '') : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      activeDeviceId: typeof parsed.activeDeviceId === 'string' && parsed.activeDeviceId !== '' ? parsed.activeDeviceId : 'this',
      selfSlug: typeof parsed.selfSlug === 'string' && parsed.selfSlug !== '' ? parsed.selfSlug : 'home',
      paths: Array.isArray(parsed.paths) ? parsed.paths : [],
      spoke: parsed.spoke ?? null,
      tunnelDesired: parsed.tunnelDesired === 'run' ? 'run' : 'stop',
      role: parsed.role === 'spoke' ? 'spoke' : 'hub',
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return defaultState()
    throw new Error(`读取远程接入状态失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function saveState(state: RemoteState, file = statePath()): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}
