const MARKER = 'data-dsh-remote-dir'

const SCRIPT = `<script>
(() => {
  if (window.__dshRemoteDir) return
  window.__dshRemoteDir = true
  const original = window.fetch.bind(window)
  const isPick = (input) => {
    const href = input instanceof URL ? input.href : typeof input === "string" ? new URL(input, location.href).href : input.url
    return href.includes("/api/directoryPicker/pick")
  }
  window.fetch = (input, init) => isPick(input) ? browse(init) : original(input, init)
  const reply = (rpcId, result) => new Response(JSON.stringify({ type: "server-response", rpcId, result }), { status: 200, headers: { "content-type": "application/json" } })
  const browse = async (init) => {
    let rpcId = "remote-dir"
    try {
      const raw = init && typeof init.body === "string" ? init.body : "{}"
      const message = JSON.parse(raw)
      if (typeof message.rpcId === "string") rpcId = message.rpcId
      const path = await ask(init && init.signal)
      return reply(rpcId, { ok: true, value: path })
    } catch (error) {
      if (init && init.signal && init.signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      return reply(rpcId, { ok: false, error: { code: "directory-picker/unreadable", message, details: {} } })
    }
  }
  const ask = (signal) => new Promise((resolve, reject) => {
    const root = document.createElement("div")
    root.setAttribute("${MARKER}", "")
    root.style.cssText = "position:fixed;z-index:200;inset:0;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45)"
    const panel = document.createElement("section")
    panel.style.cssText = "width:min(560px,100%);max-height:min(78vh,640px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:16px 16px 0 0"
    const title = document.createElement("h2")
    title.textContent = "选择这台电脑的目录"
    title.style.cssText = "margin:0;padding:16px 16px 8px;font-size:16px"
    const current = document.createElement("p")
    current.style.cssText = "margin:0;padding:0 16px 8px;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-tertiary,#666)"
    const list = document.createElement("div")
    list.style.cssText = "overflow:auto;flex:1;min-height:180px"
    const actions = document.createElement("div")
    actions.style.cssText = "display:flex;gap:8px;padding:12px 16px 16px"
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "取消"
    const choose = document.createElement("button")
    choose.type = "button"
    choose.textContent = "选择此目录"
    for (const button of [cancel, choose]) button.style.cssText = "flex:1;height:40px;border:0;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#eee)"
    choose.style.background = "var(--dsw-alias-label-primary,#111)"
    choose.style.color = "var(--dsw-alias-bg-layer-1,#fff)"
    actions.append(cancel, choose)
    panel.append(title, current, list, actions)
    root.append(panel)
    document.documentElement.append(root)
    let selected = ""
    let closed = false
    const close = (settle) => {
      if (closed) return
      closed = true
      root.remove()
      settle()
    }
    const finish = (path) => close(() => resolve(path))
    const fail = (error) => close(() => reject(error))
    cancel.addEventListener("click", () => finish(null))
    choose.addEventListener("click", () => { if (selected) finish(selected) })
    if (signal) signal.addEventListener("abort", () => finish(null), { once: true })
    const row = (label, path) => {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      button.style.cssText = "display:block;width:100%;text-align:left;border:0;background:transparent;padding:12px 16px;font-size:15px"
      button.addEventListener("click", () => { void load(path).catch((error) => { current.textContent = error instanceof Error ? error.message : String(error) }) })
      return button
    }
    const load = async (path) => {
      list.replaceChildren(row("读取中…", selected || path))
      const query = path ? "?path=" + encodeURIComponent(path) : ""
      const response = await original("/api/hub/directories" + query, { headers: { accept: "application/json" } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || "不能读取目录")
      selected = body.path
      current.textContent = body.path
      const items = []
      if (body.parent) items.push(row("上一级", body.parent))
      for (const entry of body.entries || []) items.push(row(entry.name, entry.path))
      if (items.length === 0) {
        const empty = document.createElement("p")
        empty.textContent = "没有子目录"
        empty.style.cssText = "margin:0;padding:12px 16px;color:var(--dsw-alias-label-tertiary,#666)"
        items.push(empty)
      }
      list.replaceChildren(...items)
    }
    void load("").catch(fail)
  })
})()
</script>`

export function injectDirectoryPicker(html: string): string {
  if (!html.includes('<html') && !html.includes('<HTML')) return html
  if (html.includes(MARKER)) return html
  const head = html.search(/<head[^>]*>/i)
  if (head >= 0) {
    const end = html.indexOf('>', head) + 1
    return html.slice(0, end) + SCRIPT + html.slice(end)
  }
  return SCRIPT + html
}
