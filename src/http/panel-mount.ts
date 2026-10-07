/**
 * 面板产物的出口：`app/` 用自己那套 Vite 打出来的 IIFE bundle（`app/dist-panel/`），
 * 由后端在 `/panel/*` 发出去，给任何挂点（8900 独立正门、用户 DSH 里的 Stream UI 插件）
 * 用普通 <script>/<link> 加载。
 *
 * **不进 HttpDeps**（存量键已冻结，见 app.ts 头注）——serve.ts 直连挂，同 mountMcp /
 * mountLlmIngress 先例。
 *
 * **挂载顺序**：必须在独立正门（`standalone-page.ts` 的 `*`）**之前**，否则 `/panel/*`
 * 会被它整段吞掉，表现是 200 + 一份 HTML——一个「加载成功但什么都没发生」的静默失败。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hono } from 'hono'

// 面板构建（app/vite.panel.config.ts）没开 sourcemap，所以永远不会有 `.map` 产物要发——
// 这张表只列真的会被请求到的扩展名，别为一个打不出来的文件预留类型。
const TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

const NOT_BUILT = '面板产物不存在，页面会报加载失败；构建：cd app && npm run build:panel'

/**
 * 把 `root` 下的单层文件挂到 `GET /panel/:file`。
 * 文件名正则只允许字母数字与 `._-`，所以 `/` 和 `..` 在**路由匹配**那一层就不成立。
 * @param app - hono app.
 * @param opts.root - 面板产物目录（`app/dist-panel`）。
 * @param opts.log - 挂载时的提示出口，缺省 `console.warn`。
 */
export function mountPanelAssets(app: Hono, opts: { root: string; log?: (line: string) => void }): void {
  // 产物是 gitignored 的构建物：重新克隆 / 清过工作区之后它不在，而后端照常起得来——不在这里
  // 说出来，唯一的症状是浏览器里一句「加载 panel.js 失败」，后端日志里一个字都没有。
  if (!existsSync(join(opts.root, 'panel.js'))) {
    ;(opts.log ?? console.warn)(`[panel] ${NOT_BUILT}（找的是 ${join(opts.root, 'panel.js')}）`)
  }
  app.get('/panel/:file{[A-Za-z0-9._-]+}', async (c) => {
    const file = c.req.param('file')
    const ext = file.split('.').pop() ?? ''
    const type = TYPES[ext]
    if (type === undefined) return c.notFound()
    let body: Buffer
    try {
      body = await readFile(join(opts.root, file))
    } catch {
      // 没构建过给 404 而不是 500，正文写明原因——裸的 Not Found 分不出是路径错了还是没构建。
      return c.text(`[panel] ${file}: ${NOT_BUILT}`, 404)
    }
    // CORS 不是为了取文件——普通 <script>/<link> 跨源本来就不要它。它是为了**看得见报错**：
    // 没有 CORS 头的跨源脚本一旦抛异常，浏览器只给一句不带文件名和行号的 "Script error."，
    // 面板里任何崩溃都无从诊断（真栽过一次：产物里 `process is not defined`，在 DSH 那一页
    // 完全看不出是什么）。配上 `crossorigin=anonymous`（host.ts）才能拿到真实堆栈。
    //
    // **URL 里没有内容指纹**（`/panel/panel.js` 恒定），所以缓存策略只能靠头。少了这一对，
    // 浏览器按启发式缓存一份**没有校验器**的旧 bundle：新代码构建出来了、后端也在发新的，
    // 页面却一直跑旧的，而且哪儿都不报错——「改了没生效」和「改了没差别」长得一模一样。
    // `no-cache` 不是不缓存，是**每次必须回来验**；配 ETag 让常态回 304（不重传 1MB）。
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { etag, 'cache-control': 'no-cache' })
    }
    return c.body(Uint8Array.from(body), 200, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'content-type': type,
      etag,
    })
  })
}
