/**
 * 系统原生选文件夹（注入 runner，不弹真对话框）。
 */
import { describe, expect, it } from 'vitest'
import { pickNativeDirectory, type NativeCommandRunner } from './pick-directory.js'

function runner(impl: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>): NativeCommandRunner {
  return impl
}

describe('pickNativeDirectory', () => {
  it('darwin 解析 POSIX path；取消返回 null', async () => {
    const picked = await pickNativeDirectory(
      runner(async () => ({ stdout: '/Users/me/skills/\n', stderr: '' })),
      'darwin',
    )
    expect(picked).toBe('/Users/me/skills')
    await expect(
      pickNativeDirectory(
        runner(async () => {
          const err = new Error('canceled') as Error & { code: number; stderr: string }
          err.code = 1
          err.stderr = 'User canceled. (-128)'
          throw err
        }),
        'darwin',
      ),
    ).resolves.toBe(null)
  })

  it('linux 先 zenity，缺命令再 kdialog', async () => {
    const calls: string[] = []
    const picked = await pickNativeDirectory(
      runner(async (cmd) => {
        calls.push(cmd)
        if (cmd === 'zenity') {
          const err = new Error('missing') as Error & { code: string }
          err.code = 'ENOENT'
          throw err
        }
        return { stdout: '/home/me/ws', stderr: '' }
      }),
      'linux',
    )
    expect(calls).toEqual(['zenity', 'kdialog'])
    expect(picked).toBe('/home/me/ws')
  })

  it('不支持的平台显式报错', async () => {
    await expect(pickNativeDirectory(runner(async () => ({ stdout: '', stderr: '' })), 'freebsd')).rejects.toThrow(
      /不支持平台 freebsd/,
    )
  })
})
