/** 公网源、Host 与地址策略。拒绝一切可当作跳板的目标。 */

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['224.0.0.0', 4],
] as const

export function isLoopbackAddress(address: string): boolean {
  const host = address.replace(/^::ffff:/i, '').toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1'
}

export function isPrivateAddress(address: string): boolean {
  const raw = address.replace(/^::ffff:/i, '').toLowerCase()
  if (isLoopbackAddress(raw)) return true
  if (raw === '::' || raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd')) return true
  if (raw.includes(':')) return false
  const parts = raw.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  return PRIVATE_V4.some(([base, bits]) => {
    const [a, b, c, d] = base.split('.').map((p) => Number(p))
    const net = ((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (ip & mask) === (net & mask)
  })
}

export function headerHost(hostHeader: string | undefined): string {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end > 0 ? raw.slice(1, end) : ''
  }
  return raw.split(':')[0] ?? ''
}

/** 本机管理：对端是 loopback，且 Host 也是 loopback。公网隧道不算。 */
export function isLocalAdmin(remoteAddress: string | undefined, hostHeader: string | undefined): boolean {
  if (remoteAddress === undefined || !isLoopbackAddress(remoteAddress)) return false
  const host = headerHost(hostHeader)
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function publicHostname(publicOrigin: string): string {
  if (publicOrigin.trim() === '') return ''
  try {
    return new URL(publicOrigin).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export type Admission = 'local' | 'public' | 'reject'

export function admit(remoteAddress: string | undefined, hostHeader: string | undefined, publicOrigin: string): Admission {
  if (remoteAddress === undefined || !isLoopbackAddress(remoteAddress)) return 'reject'
  if (isLocalAdmin(remoteAddress, hostHeader)) return 'local'
  const expected = publicHostname(publicOrigin)
  if (expected !== '' && headerHost(hostHeader) === expected) return 'public'
  return 'reject'
}

/** 绑定用的设备源。只接受 https 主机名，且必须落在域名后缀下。 */
export function canonicalDeviceOrigin(input: string, domainSuffix: string): string {
  const suffix = domainSuffix.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (suffix.split('.').filter(Boolean).length < 2) throw new Error('先在本机设置域名后缀，例如 dsh.example.com')
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('设备地址不是合法 URL')
  }
  if (url.protocol !== 'https:') throw new Error('设备地址必须是 https')
  if (url.username !== '' || url.password !== '') throw new Error('设备地址不能带用户信息')
  if (url.port !== '') throw new Error('设备地址不能带端口')
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('设备地址不能带路径或查询')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) throw new Error('设备地址不能是本机或本地域名')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw new Error('设备地址不能是 IP')
  if (host !== suffix && !host.endsWith(`.${suffix}`)) throw new Error(`设备主机名必须在 ${suffix} 下`)
  return `https://${host}`
}

const RESERVED_SLUGS = new Set(['api', 'assets', 'dsh-remote-access'])

/** 路径槽名字。浏览器里就是 `dsh.example.com/<slug>`。 */
export function assertSlug(input: string): string {
  const slug = input.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug)) throw new Error('路径名只能是小写字母、数字和短横线，且以字母开头')
  if (RESERVED_SLUGS.has(slug)) throw new Error('这个路径名被保留')
  return slug
}

/** 公司电脑要连的中枢源。不要求落在本机后缀下，但仍拒绝 IP、本机名和非 https。 */
export function canonicalHubOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('中枢地址不是合法 URL')
  }
  if (url.protocol !== 'https:') throw new Error('中枢地址必须是 https')
  if (url.username !== '' || url.password !== '') throw new Error('中枢地址不能带用户信息')
  if (url.port !== '') throw new Error('中枢地址不能带端口')
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('中枢地址不能带路径或查询')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) throw new Error('中枢地址不能是本机或本地域名')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw new Error('中枢地址不能是 IP')
  return `https://${host}`
}

export const DEVICE_PATHS = ['/api/pair', '/api/v1/status', '/api/v1/sessions', '/api/v1/prompt'] as const
export type DevicePath = (typeof DEVICE_PATHS)[number]

export function assertDevicePath(path: string): DevicePath {
  if ((DEVICE_PATHS as readonly string[]).includes(path)) return path as DevicePath
  throw new Error('拒绝访问未允许的路径')
}

export const RELAY_PATHS = ['/api/relay/enroll', '/api/relay/poll', '/api/relay/result'] as const
export type RelayPath = (typeof RELAY_PATHS)[number]
