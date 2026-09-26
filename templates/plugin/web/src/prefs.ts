export const PLUGIN_NAME = '__PLUGIN_NAME__'
export const PLUGIN_TITLE = '__PLUGIN_TITLE__'
export const PLUGIN_ROUTE = '__PLUGIN_ROUTE__'

export const STORAGE_KEY = `${PLUGIN_NAME}:settings`

export type Prefs = {
  displayName: string
  compact: boolean
}

export function defaultPrefs(): Prefs {
  return { displayName: PLUGIN_TITLE, compact: false }
}

export function readPrefs(): { value: Prefs; warning: string } {
  const fallback = defaultPrefs()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { value: fallback, warning: '' }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    if (typeof parsed.displayName !== 'string' || typeof parsed.compact !== 'boolean') {
      return { value: fallback, warning: '已保存的设置格式不对，已恢复默认值。重新保存即可覆盖。' }
    }
    return { value: { displayName: parsed.displayName, compact: parsed.compact }, warning: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { value: fallback, warning: `读不到已保存的设置（${message}），已使用默认值。` }
  }
}

export function writePrefs(value: Prefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}
