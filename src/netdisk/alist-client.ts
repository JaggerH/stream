import { GATEWAY_PREFIX } from '../plugins/gateway.ts'
import { pluginTarget } from '../plugins/plugin-target.ts'
import { withAwake } from '../plugins/standby/hook.ts'
import { Agent, fetch as undiciFetch } from 'undici'
import { AlistClient, type AlistClientOptions } from '../../shared/netdisk/alist-client.ts'

/** 类本体住 `shared/netdisk/alist-client.ts`（宿主与 alist 包同吃一份）；这里 re-export 给宿主既有
 *  import 点，并补宿主独有的三样接线：plugin target 取址、standby 唤醒、网关路径改写。 */
export { isObjectNotFound, type AlistClient, type AlistFile, type AlistStorage } from '../../shared/netdisk/alist-client.ts'

/** compose service 名——`withAwake` 的唤醒键，与 `packages/alist/package.json` 的 `stream.backend.service` 同名。 */
const ALIST_SERVICE = 'alist'

/**
 * 上传（`PUT /api/fs/put`，`As-Task: false`）专用的连接：OpenList 把整个文件推完网盘才回响应头，
 * 而 Node fetch（undici）默认 `headersTimeout` 300s——几 GB 的文件往夸克推超过 5 分钟就被掐成一句
 * "fetch failed"，文件没落盘（2026-09-28：2.2GB 的 13F 持仓明细稳定失败，1.7GB 的能过）。
 * 用同版本 undici 自己的 fetch + Agent（跨版本把 Agent 塞给全局 fetch 不保证兼容），上限放到 1 小时。
 */
const PUT_AGENT = new Agent({ headersTimeout: 60 * 60_000, bodyTimeout: 60 * 60_000 })

/** server-side fetch base（NOT 客户端网关路径）：bootstrap 接线的 plugin target（compose 形态：
 *  容器 DNS；host 档醒着的容器 loopback；none：未设 → ''）。只有这一个来源——网盘底座是内置
 *  托管的，没有「指向别处」的显式地址。 */
export function resolveAlistUrl(): string {
  return pluginTarget(ALIST_SERVICE) ?? ''
}

/**
 * 宿主生产路径构造 `AlistClient` 的**唯一入口**：地址走 `resolveAlistUrl` 的 thunk（host 档下 origin
 * 是容器醒着时才存在的，每次请求现解析），唯一的 fetch 调用点包在 `withAwake('alist', …)` 里——
 * standby 唤醒不能被绕过，所以这里不收 `fetchFn`（要注入假服务端的测试直接 `new` shared 那个类）。
 */
export function hostAlistClient(
  opts: Pick<AlistClientOptions, 'token' | 'refresh' | 'sleep'>,
  ttlMs?: number,
): AlistClient {
  return new AlistClient({
    baseUrl: () => resolveAlistUrl(),
    token: opts.token,
    ...(opts.refresh ? { refresh: opts.refresh } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    fetchFn: (input, init) => withAwake(ALIST_SERVICE, () => init?.method === 'PUT'
      ? undiciFetch(input as string, { ...init, dispatcher: PUT_AGENT } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
      : fetch(input, init)),
  }, ttlMs)
}

/**
 * 把 AList 的 raw_url 变成「浏览器可达」的播放直链。
 *
 * AList 的代理/直链（`/p/…` 代理下载、`/d/…` 直链）带的是 AList 自己配置的 site host——
 * 容器化部署里那是内部名（`http://gateway`），浏览器 DNS 解析不了 → `Failed to fetch`。
 * 这类链接改走同源插件网关路由（`/_p/alist/p/…?sign=…`，后端持有、见 `mountPluginGateway`），
 * 浏览器同源直取、（compose 里经瘦边缘 Caddy 转发到）后端再反代到 AList 流式回源。真正的外部
 * CDN 直链（其它 host、非 `/p|/d` 路径）原样放行——浏览器能直连，
 * 少一跳更快。返回根相对路径：302 的 Location 相对请求源解析，自动适配 dev / 远程各自的网关源。
 */
export function toGatewayAlistUrl(rawUrl: string): string {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return rawUrl // 已是相对路径或非法 URL——原样返回
  }
  return /^\/(p|d)\//.test(u.pathname) ? `${GATEWAY_PREFIX}/alist${u.pathname}${u.search}` : rawUrl
}
