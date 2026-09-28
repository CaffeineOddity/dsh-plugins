import { describe, expect, it } from 'vitest'
import { isControlApi, isPlainDocument, launchToken, upstreamRequestHeaders } from './gui-proxy.ts'
import { injectMobileSidebar } from './mobile-sidebar.ts'

describe('完整界面代理', () => {
  it('控制面接口不转去 3080', () => {
    expect(isControlApi('/api/hub/login')).toBe(true)
    expect(isControlApi('/api/relay/poll')).toBe(true)
    expect(isControlApi('/dsh-remote-access/api/hub/tunnel')).toBe(true)
    expect(isControlApi('/')).toBe(false)
    expect(isControlApi('/api/remote.mux')).toBe(false)
  })

  it('公网 Origin 不能带到本机界面', () => {
    const headers = upstreamRequestHeaders({
      host: 'dsh.sideproject.top',
      origin: 'https://dsh.sideproject.top',
      referer: 'https://dsh.sideproject.top/',
      'sec-fetch-site': 'same-origin',
    }, 'dsh-auth-test=1')
    expect(headers.host).toBe('127.0.0.1:3080')
    expect(headers.origin).toBe('http://127.0.0.1:3080')
    expect(headers.referer).toBeUndefined()
    expect(headers['sec-fetch-site']).toBeUndefined()
  })

  it('页面请求去掉压缩，方便插入悬浮按钮', () => {
    expect(isPlainDocument('GET', '/')).toBe(true)
    expect(isPlainDocument('GET', '/assets/app.js')).toBe(false)
    expect(isPlainDocument('GET', '/api/sessions')).toBe(false)
  })

  it('只在 HTML 里插入一次悬浮按钮', () => {
    const page = '<html><body><div></div></body></html>'
    const once = injectMobileSidebar(page)
    expect(once).toContain('data-dsh-remote-fab')
    expect(once).toContain('打开侧边栏')
    expect(injectMobileSidebar(once)).toBe(once)
    expect(injectMobileSidebar('{"ok":true}')).toBe('{"ok":true}')
  })

  it('启动地址只能是本机 3080', () => {
    expect(launchToken('http://127.0.0.1:3080/?token=abc')).toBe('abc')
    expect(() => launchToken('http://127.0.0.1:3921/?token=abc')).toThrow(/本机界面/)
    expect(() => launchToken('http://evil.example/?token=abc')).toThrow(/本机界面/)
  })
})
