import { describe, expect, it } from 'vitest'
import { assertTunnelHostname, isOurCloudflared, logShowsConnected, readConfigHostname } from './tunnel.ts'

describe('隧道状态判断', () => {
  it('日志里最后一次登记算已连接，断开之后不算', () => {
    expect(logShowsConnected('INF Registered tunnel connection connIndex=0')).toBe(true)
    expect(logShowsConnected('Registered tunnel connection\nUnregistered tunnel connection')).toBe(false)
  })

  it('只匹配本插件配置，且拒绝 3080', () => {
    const config = '/Users/a/.dsh/storages/cloudflared/config.yml'
    expect(isOurCloudflared(`cloudflared tunnel --config ${config} run`, config)).toBe(true)
    expect(isOurCloudflared('cloudflared tunnel --config /other/config.yml run', config)).toBe(false)
    expect(isOurCloudflared(`cloudflared tunnel --config ${config} run 3080`, config)).toBe(false)
  })

  it('配置必须指向 3921，不能是 3080', () => {
    const ok = readConfigHostname('ingress:\n  - hostname: dsh.example.com\n    service: http://127.0.0.1:3921\n')
    expect(ok).toEqual({ hostname: 'dsh.example.com', service: 'http://127.0.0.1:3921' })
    expect(() => assertTunnelHostname('https://dsh.example.com')).toThrow(/主机名/)
    expect(() => assertTunnelHostname('127.0.0.1')).toThrow(/IP/)
  })
})
