/**
 * Plugin gateway — a single published ingress for every plugin backend.
 *
 * The backend (serve-backend) OWNS `/_p`: it sits on the same `stream` network as every
 * plugin container and path-routes `/_p/<service>/*` to each backend by compose DNS name
 * itself (see `mountPluginGateway` in `src/http/plugin-gateway.ts`, resolved via
 * `resolvePluginTarget`). Backends stay network-internal (compose `expose`, no host ports).
 * In docker-compose dev, a thin-edge Caddy still publishes the one host port and forwards
 * `/_p` (plus `/api`/`/ws`/`/`) straight through to serve-backend — it no longer knows about
 * individual plugins. On the main path (the backend running natively on the host) there's
 * no Caddy at all: the backend binds this port directly, and reaches plugin containers
 * through the `host` net mode instead — standby wakes the container, inspects the loopback
 * port Docker assigned it, and the backend fetches that origin directly (see
 * `plugin-target.ts` and `docs/superpowers/specs/2026-07-22-host-plugin-door-design.md`). That
 * loopback port is bound to 127.0.0.1, assigned at container start and released at stop — it
 * never counts against the host's published-port budget. Either way host-port count is O(1)
 * no matter how many plugins, which is the whole point: hundreds of crawlers can't exhaust
 * ports they never occupy.
 *
 * The compose generator (publish + thin Caddyfile) imports GATEWAY_PORT/GATEWAY_PREFIX;
 * client-facing code imports pluginGatewayUrl (root-relative `/_p/<service>`, same-origin —
 * never a host). Server-side fetch bases are a DIFFERENT concern (a container-DNS origin in
 * compose mode, a discovered loopback origin in host mode, or none when there's no plugin
 * network) — those go through `resolvePluginTarget` / the host-mode standby origin cache in
 * `plugin-target.ts`, not this file.
 */
export const GATEWAY_PORT = Number(process.env.STREAM_GATEWAY_PORT ?? 8900)
export const GATEWAY_PREFIX = '/_p'

/** 给客户端（浏览器/前端）的插件 URL：一律根相对、同源 `/_p/<service>`。谁持有入口谁解析——
 *  绝不泄漏内部 host。后端自己 fetch 插件走 resolvePluginTarget（server-side origin，见
 *  `src/plugins/plugin-target.ts`），两者分家，消 base 一身二用。 */
export function pluginGatewayUrl(service: string): string {
  return `${GATEWAY_PREFIX}/${service}`
}
