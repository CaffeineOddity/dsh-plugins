import { describe, expect, it } from 'vitest'
import { admit, canonicalDeviceOrigin, isPrivateAddress } from './policy.ts'

describe('地址策略', () => {
  it('拒绝 loopback、私网和链路本地', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
  })

  it('cloudflared 的 loopback 对端配公网 Host 不是本机管理', () => {
    expect(admit('127.0.0.1', 'mac.dsh.example.com', 'https://mac.dsh.example.com')).toBe('public')
    expect(admit('127.0.0.1', '127.0.0.1:3921', '')).toBe('local')
    expect(admit('10.0.0.8', 'mac.dsh.example.com', 'https://mac.dsh.example.com')).toBe('reject')
    expect(admit('127.0.0.1', 'evil.example', '')).toBe('reject')
  })

  it('设备源必须是后缀下的 https 主机名', () => {
    expect(canonicalDeviceOrigin('https://mac.dsh.example.com', 'dsh.example.com')).toBe('https://mac.dsh.example.com')
    expect(() => canonicalDeviceOrigin('http://mac.dsh.example.com', 'dsh.example.com')).toThrow(/https/)
    expect(() => canonicalDeviceOrigin('https://127.0.0.1', 'dsh.example.com')).toThrow(/IP/)
    expect(() => canonicalDeviceOrigin('https://user:pass@mac.dsh.example.com', 'dsh.example.com')).toThrow(/用户信息/)
    expect(() => canonicalDeviceOrigin('https://evil.example.com', 'dsh.example.com')).toThrow(/dsh\.example\.com/)
    expect(() => canonicalDeviceOrigin('https://mac.dsh.example.com/x', 'dsh.example.com')).toThrow(/路径/)
  })
})
