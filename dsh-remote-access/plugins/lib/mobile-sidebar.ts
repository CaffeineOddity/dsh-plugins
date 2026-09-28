const MARKER = 'data-dsh-remote-fab'

const SCRIPT = `<style>
html[data-dsh-remote-mobile] [data-dsh-remote-frame]{grid-template-columns:0px minmax(0,1fr) var(--dsh-remote-details,0px)!important}
html[data-dsh-remote-mobile] [data-dsh-remote-slot]{overflow:hidden!important}
[data-dsh-remote-host]{display:none}
html[data-dsh-remote-mobile][data-dsh-remote-overlay="open"] [data-dsh-remote-host]{display:flex;position:fixed;z-index:50;top:0;bottom:0;left:0;width:min(86vw,320px);overflow:auto;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 0 24px rgba(0,0,0,.24)}
html[data-dsh-remote-mobile][data-dsh-remote-overlay="open"] [data-dsh-remote-host] [data-dsh-remote-sidebar]{display:flex!important;visibility:visible!important;width:100%!important;height:100%!important;min-height:100%}
[data-dsh-remote-backdrop]{display:none}
html[data-dsh-remote-mobile][data-dsh-remote-overlay="open"] [data-dsh-remote-backdrop]{display:block;position:fixed;z-index:40;inset:0;border:0;background:rgba(0,0,0,.4)}
[data-dsh-remote-fab]{display:none}
html[data-dsh-remote-mobile] [data-dsh-remote-fab]{display:grid;place-items:center;position:fixed;z-index:60;top:12px;left:12px;width:40px;height:40px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 4px 16px rgba(0,0,0,.18)}
</style>
<script>
(() => {
  const OPEN = /打开侧边栏|Open sidebar/
  const CLOSE = /收起侧边栏|Collapse sidebar/
  const narrowQuery = window.matchMedia("(max-width: 1024px)")
  const host = document.createElement("div")
  host.setAttribute("data-dsh-remote-host", "")
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("${MARKER}", "")
  button.setAttribute("aria-label", "打开工作区")
  button.textContent = "☰"
  const backdrop = document.createElement("button")
  backdrop.type = "button"
  backdrop.setAttribute("data-dsh-remote-backdrop", "")
  backdrop.setAttribute("aria-label", "关闭侧边栏")
  document.body.append(button)
  const reactRoot = (node) => {
    let el = node
    let marked = null
    while (el && el !== document.body) {
      if (Object.keys(el).some((key) => key.startsWith("__reactContainer") || key.startsWith("_reactRootContainer"))) marked = el
      el = el.parentElement
    }
    if (marked) return marked
    el = node
    while (el.parentElement && el.parentElement !== document.body) el = el.parentElement
    return el
  }
  const mountInPage = (frame) => {
    const root = reactRoot(frame)
    if (backdrop.parentElement !== root) root.append(backdrop, host)
  }
  const labeled = (pattern) => [...document.querySelectorAll("button[aria-label]")].find((item) => pattern.test(item.getAttribute("aria-label") || ""))
  const frameOf = (node) => {
    let el = node.parentElement
    while (el) {
      if ((el.style.gridTemplateColumns || "").includes("minmax")) return el
      el = el.parentElement
    }
    return null
  }
  const slotOf = (frame, node) => {
    let el = node
    while (el.parentElement && el.parentElement !== frame) el = el.parentElement
    return el.parentElement === frame ? el : null
  }
  const detailsTrack = (value) => {
    const matched = value.match(/minmax\\(0,\\s*1fr\\)\\s+(.+)$/)
    return matched ? matched[1] : "0px"
  }
  const sync = () => {
    const mobile = narrowQuery.matches
    document.documentElement.toggleAttribute("data-dsh-remote-mobile", mobile)
    if (!mobile) {
      document.documentElement.removeAttribute("data-dsh-remote-overlay")
      const parked = host.querySelector("[data-dsh-remote-sidebar]")
      const slot = document.querySelector("[data-dsh-remote-slot]")
      if (parked && slot) slot.appendChild(parked)
      return
    }
    const toggle = labeled(OPEN) || labeled(CLOSE)
    const frame = toggle ? frameOf(toggle) : null
    const slot = frame && toggle ? slotOf(frame, toggle) : document.querySelector("[data-dsh-remote-slot]")
    if (!frame || !slot || !toggle) return
    let panel = toggle
    while (panel.parentElement && panel.parentElement !== slot && panel.parentElement !== host) panel = panel.parentElement
    mountInPage(frame)
    frame.setAttribute("data-dsh-remote-frame", "")
    frame.style.setProperty("--dsh-remote-details", detailsTrack(frame.style.gridTemplateColumns || ""))
    slot.setAttribute("data-dsh-remote-slot", "")
    panel.setAttribute("data-dsh-remote-sidebar", "")
    const open = !frame.hasAttribute("data-sidebar-collapsed")
    document.documentElement.setAttribute("data-dsh-remote-overlay", open ? "open" : "closed")
    if (open) {
      if (panel.parentElement !== host) host.appendChild(panel)
    } else if (panel.parentElement !== slot) {
      slot.appendChild(panel)
    }
  }
  button.addEventListener("click", () => {
    const collapsed = document.querySelector("[data-sidebar-collapsed]")
    const target = labeled(collapsed ? OPEN : CLOSE)
    if (target) target.click()
    window.setTimeout(sync, 0)
  })
  backdrop.addEventListener("click", () => {
    const target = labeled(CLOSE)
    if (target) target.click()
    window.setTimeout(sync, 0)
  })
  const observer = new MutationObserver(() => sync())
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "data-sidebar-collapsed", "aria-label"] })
  narrowQuery.addEventListener("change", sync)
  sync()
})()
</script>`

export function injectMobileSidebar(html: string): string {
  if (!html.includes('<html') && !html.includes('<HTML')) return html
  if (html.includes(MARKER)) return html
  const body = html.lastIndexOf('</body>')
  if (body >= 0) return html.slice(0, body) + SCRIPT + html.slice(body)
  return html + SCRIPT
}
