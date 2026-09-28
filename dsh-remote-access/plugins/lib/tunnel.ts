import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const TUNNEL_PORT = 3921
const TUNNEL_NAME = 'dsh'
const METRICS = '127.0.0.1:20241'

export interface TunnelStatus {
  installed: boolean
  authorized: boolean
  configured: boolean
  hostname: string
  running: boolean
  connected: boolean
  phase: 'idle' | 'installing' | 'authorizing' | 'configuring' | 'error'
  message: string
  loginUrl: string
}

export interface TunnelJob {
  phase: TunnelStatus['phase']
  message: string
  loginUrl: string
}

const job: TunnelJob = { phase: 'idle', message: '', loginUrl: '' }

export function tunnelStore(): string {
  return join(homedir(), '.dsh', 'storages', 'cloudflared')
}

export function assertTunnelHostname(input: string): string {
  const raw = input.trim().toLowerCase()
  if (raw.includes('://') || raw.includes('/') || raw.includes(':')) throw new Error('只填主机名，不要带协议、端口或路径')
  if (raw === 'localhost' || raw.endsWith('.local') || raw.endsWith('.localhost')) throw new Error('不能用本机或本地域名')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) throw new Error('不能用 IP')
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw)) throw new Error('域名格式不对')
  return raw
}

export function logShowsConnected(log: string): boolean {
  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (line.includes('Registered tunnel connection')) return true
    if (line.includes('Unregistered tunnel connection') || line.includes('failed to serve tunnel') || line.includes('Connection terminated')) return false
  }
  return false
}

/** 只认带着本插件配置路径的 cloudflared，避免误杀别的隧道。 */
export function isOurCloudflared(command: string, configPath: string): boolean {
  return command.includes('cloudflared') && command.includes(configPath) && !command.includes('3080')
}

export function readConfigHostname(config: string): { hostname: string; service: string } {
  const host = /^ {2}- hostname: (\S+)$/m.exec(config)?.[1] ?? ''
  const service = /^ {4}service: (\S+)$/m.exec(config)?.[1] ?? ''
  return { hostname: host, service }
}

function paths() {
  const store = tunnelStore()
  return {
    store,
    cert: join(store, 'cert.pem'),
    cred: join(store, `${TUNNEL_NAME}.json`),
    config: join(store, 'config.yml'),
    log: join(store, 'cloudflared.log'),
    pid: join(store, 'tunnel.pid'),
    legacyCert: join(homedir(), '.cloudflared', 'cert.pem'),
  }
}

function cloudflaredBin(): string {
  const candidates = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']
  for (const bin of candidates) if (existsSync(bin)) return bin
  try {
    return execFileSync('/usr/bin/which', ['cloudflared'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function listProcesses(): Array<{ pid: number; command: string }> {
  try {
    const text = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    return text.split('\n').map((line) => {
      const match = /^ *(\d+) +(.*)$/.exec(line)
      if (match === null) return undefined
      return { pid: Number(match[1]), command: match[2] ?? '' }
    }).filter((row): row is { pid: number; command: string } => row !== undefined)
  } catch {
    return []
  }
}

function ourPids(configPath: string): number[] {
  return listProcesses().filter((row) => isOurCloudflared(row.command, configPath)).map((row) => row.pid)
}

export function tunnelStatus(): TunnelStatus {
  const file = paths()
  const bin = cloudflaredBin()
  const authorized = existsSync(file.cert) || existsSync(file.legacyCert)
  let hostname = ''
  let service = ''
  let configured = false
  if (existsSync(file.config)) {
    const parsed = readConfigHostname(readFileSync(file.config, 'utf8'))
    hostname = parsed.hostname
    service = parsed.service
    configured = hostname !== '' && service === `http://127.0.0.1:${TUNNEL_PORT}`
  }
  const running = ourPids(file.config).length > 0
  let connected = false
  if (running && existsSync(file.log)) {
    const log = readFileSync(file.log, 'utf8')
    connected = logShowsConnected(log.slice(-8000))
  }
  return {
    installed: bin !== '',
    authorized,
    configured,
    hostname,
    running,
    connected,
    phase: job.phase,
    message: job.message,
    loginUrl: job.loginUrl,
  }
}

function ensureStore(): ReturnType<typeof paths> {
  const file = paths()
  mkdirSync(file.store, { recursive: true })
  chmodSync(file.store, 0o700)
  return file
}

function copyCert(): void {
  const file = paths()
  if (!existsSync(file.cert) && existsSync(file.legacyCert)) {
    copyFileSync(file.legacyCert, file.cert)
    chmodSync(file.cert, 0o600)
  }
}

export function startTunnel(): void {
  const file = ensureStore()
  if (!existsSync(file.config)) throw new Error('还没有隧道配置。先安装并授权。')
  const parsed = readConfigHostname(readFileSync(file.config, 'utf8'))
  if (parsed.service.includes('3080')) throw new Error('配置指向了 3080，已拒绝启动')
  if (ourPids(file.config).length > 0) return
  const bin = cloudflaredBin()
  if (bin === '') throw new Error('还没安装 cloudflared')
  const logFd = openSync(file.log, 'a')
  const child = spawn(bin, ['tunnel', '--config', file.config, '--metrics', METRICS, 'run'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  if (child.pid === undefined) throw new Error('隧道进程没有起来')
  writeFileSync(file.pid, String(child.pid), { mode: 0o600 })
}

export function stopTunnel(): void {
  const file = paths()
  const pids = ourPids(file.config)
  if (pids.length === 0) return
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') throw error
    }
  }
}

function run(bin: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      if (onLine !== undefined) onLine(text)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().slice(-400) || `命令失败（${code ?? 'unknown'}）`))
    })
  })
}

export function beginTunnelSetup(hostname: string, onReady: (origin: string) => void): void {
  if (job.phase === 'installing' || job.phase === 'authorizing' || job.phase === 'configuring') return
  const host = assertTunnelHostname(hostname)
  job.phase = 'installing'
  job.message = '正在检查 cloudflared'
  job.loginUrl = ''
  void setup(host, onReady).catch((error: unknown) => {
    job.phase = 'error'
    job.message = error instanceof Error ? error.message : String(error)
  })
}

async function setup(host: string, onReady: (origin: string) => void): Promise<void> {
  const file = ensureStore()
  let bin = cloudflaredBin()
  if (bin === '') {
    job.message = '正在安装 cloudflared'
    await run('/opt/homebrew/bin/brew', ['install', 'cloudflared'])
    bin = cloudflaredBin()
  }
  if (bin === '') throw new Error('cloudflared 没装上')
  copyCert()
  if (!existsSync(file.cert)) {
    job.phase = 'authorizing'
    job.message = '请在打开的浏览器里登录 Cloudflare，并选择这个域名所在的站点'
    await run(bin, ['tunnel', '--origincert', file.cert, 'login'], (text) => {
      const url = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/.exec(text)?.[0]
      if (url !== undefined) job.loginUrl = url
    })
    copyCert()
  }
  if (!existsSync(file.cert)) throw new Error('授权没完成，没有证书')
  chmodSync(file.cert, 0o600)
  job.phase = 'configuring'
  job.message = '正在写入隧道配置'
  if (!existsSync(file.cred)) {
    await run(bin, ['tunnel', '--origincert', file.cert, 'create', '--credentials-file', file.cred, TUNNEL_NAME])
  }
  chmodSync(file.cred, 0o600)
  const tunnelId = (JSON.parse(readFileSync(file.cred, 'utf8')) as { TunnelID?: string }).TunnelID ?? ''
  if (tunnelId === '') throw new Error('凭证里没有 TunnelID')
  const yaml = `tunnel: ${tunnelId}\ncredentials-file: ${file.cred}\n\ningress:\n  - hostname: ${host}\n    service: http://127.0.0.1:${TUNNEL_PORT}\n  - service: http_status:404\n`
  writeFileSync(file.config, yaml, { mode: 0o600 })
  chmodSync(file.config, 0o600)
  job.message = '正在把域名指到隧道'
  await run(bin, ['tunnel', '--origincert', file.cert, 'route', 'dns', '--overwrite-dns', tunnelId, host])
  onReady(`https://${host}`)
  startTunnel()
  job.phase = 'idle'
  job.message = '通道已启动'
  job.loginUrl = ''
}

export function tunnelJob(): TunnelJob {
  return { ...job }
}
