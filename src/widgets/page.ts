/**
 * widget 最小界面（openspec `widget-manifest`）：只读列表 + sandbox iframe。
 *
 * 挂在访问门之内的 `/api/widgets`（远程访问要 token，页脚本把 URL 里的 token 传给凭证口）。
 * iframe 地址指向转发入口（`device-loopback-forward`），凭证由页脚本向
 * `/api/widgets/:id/credential` 现取、在过期前刷新。设备不在线给可读的失败页，不白屏。
 */
import type { Hono } from 'hono'
import { mintForwardCredential, FORWARD_CRED_TTL_MS } from '../http/device-forward.ts'
import type { WidgetsStore, WidgetRow } from './store.ts'
import { parseWidgetManifest } from './manifest.ts'
import type { WidgetManifest } from './manifest.ts'

export interface WidgetPageDeps {
  store: WidgetsStore
  /** {@link mintForwardCredential} 的密钥（`forwardSecretOf` 派生）。 */
  secret: string
  /** 现取设备在线与端口声明的窄视图。 */
  directory: {
    isOnline(id: string): boolean
    portsOf(id: string): readonly number[] | undefined
  }
  /** 读一个挂载的 manifest（从挂载目录现读）。 */
  manifestOf(m: WidgetRow): WidgetManifest | null
  now?: () => number
  log?: (line: string) => void
}

const READ_SCRIPT = String.raw`
<script>
(async () => {
  const params = new URLSearchParams(location.search)
  const token = params.get('token') ?? ''
  const tid = token ? '&token=' + encodeURIComponent(token) : '?'
  const refreshMs = Math.max(60_000, Number(document.documentElement.dataset.ttl ?? 3600000) - 300_000)
  async function open(id, frame) {
    try {
      const r = await fetch(document.baseURI.replace(/\/widgets.*$/, '') + '/api/widgets/' + encodeURIComponent(id) + '/credential' + tid, { credentials: 'include' })
      if (!r.ok) { frame.dataset.error = 'credential ' + r.status; return }
      const d = await r.json()
      frame.src = new URL(d.src, document.baseURI).href
      frame.dataset.exp = String(d.exp)
    } catch { frame.dataset.error = 'credential failed' }
  }
  document.querySelectorAll('iframe[data-widget]').forEach((f) => open(f.dataset.widget, f))
  ;(function check() {
    document.querySelectorAll('iframe[data-widget]').forEach((f) => {
      const exp = Number(f.dataset.exp ?? 0)
      if (exp && Date.now() > exp - 300_000) open(f.dataset.widget, f)
    })
    setTimeout(check, 60_000)
  })()
})()
</script>
`

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)

export function mountWidgetListPage(app: Hono, deps: WidgetPageDeps): void {
  const rows = () => deps.store.list()

  // 列表页：每行 name / size / 设备与在线状态；点开进详情页。
  app.get('/widgets', (c) => {
    const items = Object.entries(rows()).map(([id, row]) => {
      const m = deps.manifestOf(row)
      const port = m?.serve?.port
      const online = port !== undefined && deps.directory.isOnline(row.device) && (deps.directory.portsOf(row.device)?.includes(port) ?? false)
      return { id, name: m?.name ?? id, size: m?.size ?? 'card', device: row.device, online }
    })
    const list = items
      .map(
        (w) => `<tr><td><a href="/widgets/${encodeURIComponent(w.id)}${c.req.query('token') ? `?token=${encodeURIComponent(c.req.query('token')!)}` : ''}">${esc(w.name)}</a></td>` +
          `<td>${esc(w.size)}</td><td>${esc(w.device)}</td><td>${w.online ? '在线' : '<b style="color:#c00">离线</b>'}</td></tr>`,
      )
      .join('\n')
    return c.html(
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Widgets</title></head>` +
        `<body><h1>Widgets</h1><table border="1" cellpadding="6"><tr><th>名称</th><th>尺寸</th><th>设备</th><th>状态</th></tr>` +
        `${list || '<tr><td colspan="4">还没有挂载任何 widget——用 widget:add 添加。</td></tr>'}</table>` +
        READ_SCRIPT.replace('<script>', '<script data-unused>'),
      )
  })

  // 详情页：sandbox iframe（不带 allow-same-origin）；设备离线给可读失败页。
  app.get('/widgets/:id', (c) => {
    const id = c.req.param('id')
    const row = rows()[id]
    if (!row) return c.text('没有这个 widget', 404)
    const m = deps.manifestOf(row)
    if (!m) return c.text('widget.json 读不了或 schema 不合法——先跑 widget:check', 500)
    const port = m.serve?.port
    const online = port !== undefined && deps.directory.isOnline(row.device) && (deps.directory.portsOf(row.device)?.includes(port) ?? false)
    const ttl = String(FORWARD_CRED_TTL_MS)
    const frame = online
      ? `<iframe data-widget="${esc(id)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" style="width:100%;height:80vh;border:1px solid #ccc"></iframe>`
      : `<p style="color:#c00"><b>设备 ${esc(row.device)} 不在线</b>——上线后刷新本页。</p>`
    return c.html(
      `<!DOCTYPE html><html lang="zh-CN" data-ttl="${ttl}"><head><meta charset="utf-8"><title>${esc(m.name)}</title></head>` +
        `<body><h1>${esc(m.name)}</h1>${frame}${online ? READ_SCRIPT : ''}</body></html>`,
    )
  })

  // 凭证现取口：为 (device, port, widget id) 签一条短期凭证。挂在访问门之内——远程访问
  // 要 token（页脚本从自己的 URL 透传），本机回环免密。
  app.get('/widgets/:id/credential', (c) => {
    const id = c.req.param('id')
    const row = rows()[id]
    if (!row) return c.json({ error: 'not-found' }, 404)
    const m = deps.manifestOf(row)
    if (!m?.serve) return c.json({ error: 'no-serve', message: '这个 widget 没有声明 serve 后端' }, 400)
    const port = m.serve.port
    if (!deps.directory.portsOf(row.device)?.includes(port)) return c.json({ error: 'port-not-declared' }, 403)
    if (!deps.directory.isOnline(row.device)) return c.json({ error: 'device-offline' }, 503)
    const { cred, exp } = mintForwardCredential(deps.secret, { device: row.device, port, widget: id }, { now: deps.now })
    const entry = m.entry.replace(/^\/+/, '')
    return c.json({ src: `/api/fwd/${encodeURIComponent(row.device)}/${port}/${cred}/${entry}`, exp })
  })
}
