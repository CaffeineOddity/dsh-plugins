// 配置站共享：RPC、状态灯。功能逻辑在各 HTML。不配如流 token。
async function rpc(endpoint, payload) {
  const body = payload === undefined ? {} : payload
  const res = await fetch('/agent-bot-rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: body }),
  })
  if (!res.ok) return { ok: false, error: 'http ' + res.status }
  return await res.json()
}
const $ = (id) => document.getElementById(id)
let msgTimer = null
function setMsg(text, isErr) {
  const el = $('msg')
  if (!el) return
  el.textContent = text
  el.className = isErr ? 'msg err' : 'msg ok'
  clearTimeout(msgTimer)
  msgTimer = setTimeout(() => { el.textContent = '' }, 6000)
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function setText(id, value) {
  const el = $(id)
  if (el) el.textContent = value
}
function updateStatus(s) {
  if (!s) return
  const providers = Array.isArray(s.providers) ? s.providers : []
  const on = providers.length > 0
  const dot = $('hub-dot')
  const txt = $('side-dot-txt')
  if (dot) {
    dot.classList.toggle('on', on)
    dot.classList.toggle('off', !on)
    const title = on ? ('在线 Provider：' + providers.map((p) => p.label || p.id).join('、')) : '无在线 Provider'
    dot.title = title
    if (txt) txt.textContent = on ? '在线' : '离线'
  }
  setText('st-configDir', s.configDir || '-')
  setText('st-providers', providers.length === 0 ? '无' : providers.map((p) => (p.label || p.id) + ' (' + p.id + ')').join('、'))
  setText('st-boot', s.bootLogTail || '-')
  setText('st-ask', s.askLogTail || '-')
  setText('st-scan', s.scanLogTail || '-')
}
async function refreshStatus() {
  const r = await rpc('status')
  if (r.ok && r.value) updateStatus(r.value)
  return r
}
document.addEventListener('DOMContentLoaded', () => {
  refreshStatus()
  setInterval(refreshStatus, 5000)
  bindDirectoryPicker()
})

/** 目录浏览弹窗：页面提供 #dir-modal 骨架，选中路径回给 onPick。 */
function bindDirectoryPicker() {
  const modal = $('dir-modal')
  if (!modal) return
  let browse = { path: '', parent: null, home: '', entries: [] }
  let onPick = null
  const pathEl = $('dir-path')
  const upEl = $('dir-up')
  const homeEl = $('dir-home')
  const listEl = $('dir-entries')
  const emptyEl = $('dir-empty')
  const pickEl = $('dir-pick')
  const cancelEl = $('dir-cancel')
  const titleEl = $('dir-title')

  function renderDirEntries() {
    if (pathEl) pathEl.textContent = browse.path || ''
    if (upEl) upEl.disabled = !browse.parent
    if (listEl) {
      listEl.innerHTML = (browse.entries || []).map((e) => `
        <button type="button" class="dir-row" data-dir="${esc(e.path)}">${esc(e.name)}
          <span class="hint">${esc(e.path)}</span>
        </button>`).join('')
    }
    if (emptyEl) emptyEl.style.display = (browse.entries || []).length ? 'none' : 'block'
  }

  async function loadDir(path) {
    const r = await rpc('listDirectories', { path: path || '' })
    if (!r.ok || !r.value) { setMsg('❌ ' + (r.error || '无法列出目录'), true); return }
    browse = r.value
    renderDirEntries()
  }

  function closeDirModal() {
    modal.style.display = 'none'
    onPick = null
  }

  if (cancelEl) cancelEl.onclick = closeDirModal
  if (homeEl) homeEl.onclick = () => loadDir(browse.home || '')
  if (upEl) upEl.onclick = () => { if (browse.parent) loadDir(browse.parent) }
  if (listEl) {
    listEl.addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-dir]')
      if (row) loadDir(row.dataset.dir)
    })
  }
  if (pickEl) {
    pickEl.onclick = () => {
      const path = browse.path
      if (!path) { setMsg('⚠️ 请先进入一个目录', true); return }
      const cb = onPick
      closeDirModal()
      if (cb) cb(path)
    }
  }

  function isMobileBrowse() {
    return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 720px)').matches
  }

  async function openBrowseModal(opts) {
    const start = opts && opts.startPath ? opts.startPath : ''
    const title = opts && opts.title ? opts.title : '选择目录'
    if (titleEl) titleEl.textContent = title
    onPick = opts && opts.onPick ? opts.onPick : null
    modal.style.display = 'flex'
    await loadDir(start)
  }

  window.openDirectoryPicker = async function openDirectoryPicker(opts) {
    if (isMobileBrowse()) {
      await openBrowseModal(opts)
      return
    }
    const r = await rpc('pickDirectory')
    if (!r.ok) { setMsg('❌ ' + (r.error || '无法打开系统选目录'), true); return }
    const path = r.value && r.value.path
    if (path === null || path === undefined || path === '') return
    if (opts && opts.onPick) opts.onPick(path)
  }
}
