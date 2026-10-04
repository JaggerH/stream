// Sidequest 面板反代：面板起在容器内 loopback:8678、basePath=/_p/sidequest（资源引用自带
// 前缀），所以这里**不剥前缀**整路透传——与剥前缀的 plugin-gateway 相反，必须先于它注册。
import type { Hono } from 'hono'
import { errText } from '../err-text.ts'

export function mountTaskDashboard(app: Hono, opts: { port: number; fetchImpl?: typeof fetch }): void {
  const doFetch = opts.fetchImpl ?? fetch
  app.all('/_p/sidequest/*', async (c) => {
    const url = new URL(c.req.url)
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')
    // RFC 7230 逐跳头必须剥掉——参见 plugin-gateway.ts 同处理的事故说明(2026-07-23)
    for (const h of headers.get('connection')?.split(',').map((s) => s.trim().toLowerCase()) ?? []) {
      if (h) headers.delete(h)
    }
    for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'expect']) {
      headers.delete(h)
    }
    const init: RequestInit = { method: c.req.method, headers }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = c.req.raw.body
      if (init.body) {
        // undici requires `duplex: 'half'` when sending a streaming body; Node's fetch
        // typings don't (yet) include it on RequestInit, so this cast keeps tsc clean
        // without weakening runtime behavior.
        ;(init as RequestInit & { duplex?: string }).duplex = 'half'
      }
    }
    try {
      const resp = await doFetch(`http://127.0.0.1:${opts.port}${url.pathname}${url.search}`, init)
      return new Response(resp.body, { status: resp.status, headers: resp.headers })
    } catch (e) {
      return c.json({ error: errText(e) }, 502)
    }
  })
}
