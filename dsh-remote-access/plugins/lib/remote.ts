import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { assertDevicePath, canonicalDeviceOrigin, canonicalHubOrigin, isPrivateAddress, RELAY_PATHS, type DevicePath } from './policy.ts'

export interface LookupRecord {
  address: string
}

export type LookupFn = (hostname: string) => Promise<LookupRecord[]>

async function publicLookup(hostname: string): Promise<LookupRecord[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => ({ address: r.address }))
}

export async function assertPublicDns(hostname: string, resolve: LookupFn = publicLookup): Promise<LookupRecord[]> {
  const records = await resolve(hostname)
  if (records.length === 0) throw new Error('设备域名没有地址')
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('设备域名解析到非公网地址，已拒绝')
  }
  return records
}

export interface RemoteResult {
  status: number
  json: unknown
}

/** 只请求调用方给出的固定路径表。自定义 lookup 钉住已校验的公网地址，不跟随重定向。 */
export function requestFixed(
  origin: string,
  path: string,
  allow: readonly string[],
  options: { method: string; token?: string; body?: unknown; timeoutMs?: number; maxBytes?: number; lookup?: LookupFn },
): Promise<RemoteResult> {
  if (!allow.includes(path)) throw new Error('拒绝访问未允许的路径')
  const url = new URL(path, origin)
  if (url.origin !== origin || url.pathname !== path) throw new Error('拒绝改写后的设备地址')
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  const maxBytes = options.maxBytes ?? 256 * 1024
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: options.method,
      headers: {
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      lookup: (hostname, lookupOptions, callback) => {
        void (options.lookup ?? publicLookup)(hostname).then(
          (records) => {
            if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
              callback(new Error('设备域名解析到非公网地址，已拒绝'), '', 0)
              return
            }
            const family = records[0]!.address.includes(':') ? 6 : 4
            callback(null, records[0]!.address, family)
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), '', 0),
        )
      },
      servername: url.hostname,
      timeout: options.timeoutMs ?? 10_000,
    }, (res) => {
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume()
        reject(new Error('设备返回了重定向，已拒绝'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy(new Error('设备响应超过大小限制'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        if (text !== '') {
          try {
            json = JSON.parse(text) as unknown
          } catch {
            json = { error: '设备返回的不是 JSON' }
          }
        }
        resolve({ status: res.statusCode ?? 502, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('连接设备超时')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 只请求固定路径。自定义 lookup 钉住已校验的公网地址，不跟随重定向。 */
export function requestDevice(
  origin: string,
  path: DevicePath,
  options: { method: string; token?: string; body?: unknown; timeoutMs?: number; maxBytes?: number; lookup?: LookupFn },
): Promise<RemoteResult> {
  assertDevicePath(path)
  return requestFixed(origin, path, [path], options)
}

export async function pairDevice(input: string, code: string, domainSuffix: string, lookup?: LookupFn): Promise<{ origin: string; deviceId: string; name: string; token: string }> {
  const origin = canonicalDeviceOrigin(input, domainSuffix)
  await assertPublicDns(new URL(origin).hostname, lookup)
  const result = await requestDevice(origin, '/api/pair', { method: 'POST', body: { code }, maxBytes: 8192, lookup })
  const body = (result.json ?? {}) as { deviceId?: unknown; name?: unknown; token?: unknown; error?: unknown }
  if (result.status !== 200 || typeof body.token !== 'string' || typeof body.deviceId !== 'string') {
    throw new Error(typeof body.error === 'string' ? body.error : `配对失败（${result.status}）`)
  }
  return { origin, deviceId: body.deviceId, name: typeof body.name === 'string' ? body.name : body.deviceId, token: body.token }
}

/** 公司电脑向中枢换中继令牌。只打 `/api/relay/enroll`。 */
export async function enrollAtHub(input: string, slug: string, code: string, lookup?: LookupFn): Promise<{ origin: string; token: string }> {
  const origin = canonicalHubOrigin(input)
  await assertPublicDns(new URL(origin).hostname, lookup)
  const result = await requestFixed(origin, '/api/relay/enroll', RELAY_PATHS, { method: 'POST', body: { slug, code }, maxBytes: 8192, lookup })
  const body = (result.json ?? {}) as { token?: unknown; error?: unknown }
  if (result.status !== 200 || typeof body.token !== 'string' || !body.token.startsWith('relay_')) {
    throw new Error(typeof body.error === 'string' ? body.error : `接入失败（${result.status}）`)
  }
  return { origin, token: body.token }
}
