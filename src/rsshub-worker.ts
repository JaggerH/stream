/**
 * rsshub-worker — RSSHub runs HERE, in a worker thread, not in the Stream process.
 *
 * This is the far side of RsshubClient's MessagePort. It owns RSSHub's whole footprint so the
 * Stream process no longer has to:
 *   - RSSHub's lib/app.ts imports @/utils/request-rewriter, which REPLACES the global
 *     fetch/Headers/Request/Response + node:http(s). In-process that rewrote OUR outbound too
 *     (self-origin Referer → xhs image CDN 403 → black covers). Here it patches THIS worker's
 *     globals only — Stream's fetch is untouched.
 *   - Routes compile lazily on first hit (wrapSafe, ~200ms) on whatever thread runs them. Here
 *     that's the worker's event loop, so it can't stall Stream's health probes.
 *
 * Protocol (mirror of the echo fixture used in rsshub-client.test.ts):
 *   in : { id, type:'init', env } | { id, type:'request', path }
 *   out: { id, ok:true, data? } | { id, ok:false, error }
 */
import { parentPort, workerData } from 'node:worker_threads'
import { toImportSpecifier } from './rsshub-specifier.ts'

const wd = workerData as { pkgPath?: string; pkgSource?: 'checkout' | 'datadir' | 'package' } | undefined
const pkgPath = wd?.pkgPath
if (!pkgPath) throw new Error('[rsshub-worker] missing workerData.pkgPath')
const pkgSource = wd?.pkgSource ?? (pkgPath.endsWith('.ts') ? 'checkout' : 'package')

/** Windows 上绝对路径必须转成 `file://` 才 import 得动（理由与活体记录在那个模块里）。 */
const pkgSpecifier = toImportSpecifier(pkgPath)

/**
 * 只有 **开发检出**那一档要这两样，而且必须在 import RSSHub **之前**做完：
 *
 *  - `tsx/esm/api` 的 `register()`：`--import tsx` 转 .ts，但在 worker 线程里**不套 tsconfig 的
 *    `paths`**（tsx 的已知限制）。RSSHub 的树里满是 `@/…`，靠这次编程式 register 才解析得到。
 *  - `React` 垫片：检出里的 JSX 路由模板（某个路由的 popular 之类）在项目根之外，tsx 按 classic
 *    模式转成 `React.createElement`；hono/jsx 兼容 React，垫在**本 worker 自己的** global 上。
 *
 * npm 包那一档（发行安装）是预构建 ESM：JSX 已经编译过、没有 `@/` 别名，两样都不需要——
 * **也不能要**，发行包里根本没有 tsx。所以是动态 import：静态 import 会让这份 worker 在
 * 发行形态下连加载都做不到。
 */
async function prepareCheckoutLoader(): Promise<void> {
  if (pkgSource !== 'checkout') return
  const { register } = await import('tsx/esm/api')
  register()
  const { createElement, Fragment } = await import('hono/jsx')
  ;(globalThis as Record<string, unknown>).React ??= { createElement, Fragment }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pkgPromise: Promise<any> | null = null
function getPkg() {
  // Lazy + memoized: importing pkg is what triggers the rewriter monkeypatch and the first
  // route compiles, so defer it to the first message rather than paying it at spawn.
  if (!pkgPromise) pkgPromise = prepareCheckoutLoader().then(() => import(/* @vite-ignore */ pkgSpecifier))
  return pkgPromise
}

interface InMessage {
  id: number
  type: 'init' | 'request'
  env?: Record<string, string>
  path?: string
}

parentPort!.on('message', async (msg: InMessage) => {
  const { id, type } = msg
  try {
    if (type === 'init') {
      // RSSHub snapshots its config from process.env and never re-reads it; re-run init() after
      // updating env so a cookie that arrives now actually reaches it. Empty env still runs the
      // one-time first init.
      Object.assign(process.env, msg.env ?? {})
      const pkg = await getPkg()
      if (typeof pkg.init === 'function') await pkg.init()
      parentPort!.postMessage({ id, ok: true })
      return
    }
    if (type === 'request') {
      const pkg = await getPkg()
      if (typeof pkg.request !== 'function') {
        throw new Error(`[rsshub-worker] pkg.request not exported; check ${pkgPath}`)
      }
      // Not awaited-in-sequence across messages on purpose: each handler runs on the worker's
      // event loop concurrently, matching RSSHub's in-process concurrency.
      const data = await pkg.request(msg.path)
      parentPort!.postMessage({ id, ok: true, data })
      return
    }
    throw new Error(`[rsshub-worker] unknown message type: ${String(type)}`)
  } catch (err) {
    parentPort!.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
