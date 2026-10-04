import type { Hono } from 'hono'
import type { PluginDescriptor } from '../plugins/types.ts'
import { resolvePluginTarget, type PluginNetMode } from '../plugins/plugin-target.ts'
import { withAwake, standbyOrigin } from '../plugins/standby/hook.ts'
import { errText } from '../err-text.ts'

/**
 * 后端持有 /_p 网关：把 /_p/<service>/<rest> 反代到该插件的容器 origin。
 * 剥掉 /_p/<service> 前缀（与 Caddy handle_path 语义一致），透传 method/headers/body，
 * 回传上游 status + 流式 body。三档 mode 各自的目标解析不同：compose 静态解析容器 DNS
 * （resolvePluginTarget）；host 档目标是随容器生灭的 loopback 随机口，装不进静态表，改用
 * standbyOrigin 动态查（唤醒后 inspect 缓存的 origin，见 plugin-target.ts 头注 + spec
 * 2026-07-22-host-plugin-door-design.md），此处只判「这个 service 声明过 backend」放行、
 * 实际 origin 留到请求时才查；none 或全无 backend 声明 → 不注册路由，核心 /、/api、/ws、
 * /api/mcp 照常（backend-single-entry「No gateway target configured」）。
 * 像 mountMcp 一样在 serve.ts 里对 app 调用，不进 HttpDeps（避开三处接线陷阱）。
 * host 档与 none 档的失败面不同，别当成同一档降级：none 档整条 /_p/* 路由都不挂，任何请求
 * 直接落 404；host 档只要有一个插件声明了 backend，网关本身照常挂载，命中已声明的 service 但
 * origin 暂不可得（容器还没唤醒/唤醒失败）时走的是 502，不是 404（终审 Minor 6）。
 */
export function mountPluginGateway(
  app: Hono,
  opts: {
    descriptors: PluginDescriptor[]
    mode: PluginNetMode
    fetchImpl?: typeof fetch
    /** host 档动态取址(默认 standbyOrigin);注入以便单测。 */
    resolveHostOrigin?: (service: string) => string | null
  },
): void {
  const resolveHostOrigin = opts.resolveHostOrigin ?? standbyOrigin
  const hasTarget =
    opts.mode === 'compose'
      ? opts.descriptors.some(
          (d) => resolvePluginTarget(d.backend?.service ?? d.id, { descriptors: opts.descriptors, mode: opts.mode }) !== null,
        )
      : opts.mode === 'host'
        ? opts.descriptors.some((d) => d.backend)
        : false
  if (!hasTarget) {
    console.log('[stream] /_p gateway not mounted (no plugin network target — mode=none or no backends)')
    return
  }
  const doFetch = opts.fetchImpl ?? fetch
  app.all('/_p/:service/*', async (c) => {
    const service = c.req.param('service')
    if (opts.mode === 'host') {
      const known = opts.descriptors.some(
        (d) => d.backend && ((d.backend.service ?? d.id) === service || d.id === service),
      )
      if (!known) return c.json({ error: `unknown plugin: ${service}` }, 404)
    } else {
      const target = resolvePluginTarget(service, { descriptors: opts.descriptors, mode: opts.mode })
      if (!target) return c.json({ error: `unknown plugin: ${service}` }, 404)
    }
    // /_p/<service>/<rest>?<q> → <target>/<rest>?<q>
    const url = new URL(c.req.url)
    const rest = url.pathname.slice(`/_p/${service}`.length) // 含前导 /
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')
    // RFC 7230 逐跳头必须剥掉,消息分帧由本跳(undici)自己重新决定。真实事故(2026-07-23,同一天两只):
    // (1) Caddy 对大 body 以 Transfer-Encoding: chunked 分帧转进来(小 body 它整体缓冲、带
    //     content-length,所以一直没暴露),这里照抄全部头喂 undici → 立即 "fetch failed" 502——
    //     显式 transfer-encoding 头 + 流式 body 是 undici 拒绝的组合。
    // (2) curl 对超过阈值的 body 自动加 Expect: 100-continue,Caddy 已经替客户端做完了这个握手
    //     却把头透传进来,undici 直接拒收(UND_ERR_NOT_SUPPORTED"expect header not supported")。
    //     expect 名义上是端到端头,但它请求的是**本跳**的传输行为,代理链上每一跳都该自己消化。
    // connection 列出的自定义逐跳头一并剥(标准语义);content-length 是端到端头、由 undici 按实际
    // body 重算。
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
    // withAwake（非 ensureAwake）：一次代理请求的上游耗时可能远超 10 分钟闲置窗口
    // （比如 ASR/MinerU），必须把这次 fetch 全程纳入引用计数，reaper 才不会中途抽走容器。
    // 唤醒失败/超时在这里落地成 502，body 带上错误信息。
    // host 档取址挪进这个回调内：那一刻容器可能还睡着，取址必须发生在 withAwake
    // 唤醒之后（compose 档地址静态、不受此影响，仍在回调内重新解析一次但无副作用）。
    // 已知 caveat：流式 body 的请求撞上僵尸口触发 withAwake 内部恢复重试时，
    // body 流已被第一次 fetch 消费，重试会以 "body already used" 失败并落成 502——
    // 可接受，能力客户端走的是 FormData（非流式），不受影响。
    let resp: Response
    try {
      resp = await withAwake(service, () => {
        const target =
          opts.mode === 'host'
            ? resolveHostOrigin(service)
            : resolvePluginTarget(service, { descriptors: opts.descriptors, mode: opts.mode })
        if (!target) throw new Error(`no origin for plugin ${service} (container asleep and standby not wired?)`)
        return doFetch(`${target}${rest}${url.search}`, init)
      })
    } catch (e) {
      // errText(共享实现):`String((e as Error).message)` 对一个非 Error 抛出物会返回字面量
      // "undefined",把真正的失败原因整个吃掉——502 的 body 变成 {"error":"undefined"}。
      return c.json({ error: errText(e) }, 502)
    }
    return new Response(resp.body, { status: resp.status, headers: resp.headers })
  })
}
