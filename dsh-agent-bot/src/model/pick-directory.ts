/**
 * 宿主系统原生选文件夹。配置站桌面用；不走 DSH directoryPicker。
 * 取消返回 null；命令不存在或平台不支持显式抛错。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 跑一条本机命令，stdout 给解析。 */
export type NativeCommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

/** 默认 runner：execFile，5 分钟内等用户关弹窗。 */
export function runNativeCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { timeout: 300000, encoding: 'utf8' }).then((r) => ({
    stdout: r.stdout,
    stderr: r.stderr,
  }))
}

function trimPath(stdout: string): string | null {
  let path = stdout.replace(/[\r\n]+$/, '')
  if (path === '') return null
  if (path.length > 1 && (path.endsWith('/') || path.endsWith('\\'))) path = path.slice(0, -1)
  return path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isCancel(error: unknown): boolean {
  return errorCode(error) === 1
}

/**
 * 打开系统选文件夹对话框。
 * darwin: osascript choose folder；linux: zenity → kdialog；win32: PowerShell FolderBrowserDialog。
 */
export async function pickNativeDirectory(run: NativeCommandRunner, platform: string): Promise<string | null> {
  if (platform === 'darwin') {
    try {
      const out = await run('osascript', [
        '-e',
        'set selectedFolder to choose folder with prompt "选择目录"',
        '-e',
        'POSIX path of selectedFolder',
      ])
      return trimPath(out.stdout)
    } catch (error) {
      if (isCancel(error) && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }
  if (platform === 'linux') {
    try {
      const out = await run('zenity', ['--file-selection', '--directory', '--title=选择目录'])
      return trimPath(out.stdout)
    } catch (error) {
      if (isCancel(error)) return null
      if (!isMissingCommand(error)) throw error
    }
    try {
      const out = await run('kdialog', ['--getexistingdirectory', '.', '--title', '选择目录'])
      return trimPath(out.stdout)
    } catch (error) {
      if (isCancel(error)) return null
      if (isMissingCommand(error)) throw new Error('agent-bot: 未找到系统选目录工具（请安装 zenity 或 kdialog）')
      throw error
    }
  }
  if (platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
      '$d.Description = "选择目录"; $d.ShowNewFolderButton = $true; ' +
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { exit 1 }'
    try {
      const out = await run('powershell', ['-NoProfile', '-STA', '-Command', script])
      return trimPath(out.stdout)
    } catch (error) {
      if (isCancel(error)) return null
      throw error
    }
  }
  throw new Error(`agent-bot: 系统选目录不支持平台 ${platform}`)
}
