import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import { mountPanelAssets } from './panel-mount.ts'

function appWithPanel(): { app: Hono; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'panel-'))
  writeFileSync(join(root, 'panel.js'), 'window.x=1')
  writeFileSync(join(root, 'panel.css'), '.a{color:red}')
  const app = new Hono()
  mountPanelAssets(app, { root })
  return { app, root }
}

test('发出 js 与 css，带对得上的 content-type', async () => {
  const { app } = appWithPanel()
  const js = await app.request('/panel/panel.js')
  expect(js.status).toBe(200)
  expect(js.headers.get('content-type')).toContain('text/javascript')
  expect(await js.text()).toBe('window.x=1')

  const css = await app.request('/panel/panel.css')
  expect(css.status).toBe(200)
  expect(css.headers.get('content-type')).toContain('text/css')
})

// 掉了这个头，跨源脚本的异常就只剩一句不带文件名和行号的 "Script error."，
// 面板里任何崩溃都无从诊断——而它掉了**不会有任何一处报错**，只是排查突然变瞎。
test('带 CORS 头——否则面板里的崩溃在工作台那一页是一团黑', async () => {
  const { app } = appWithPanel()
  const js = await app.request('/panel/panel.js')
  expect(js.headers.get('access-control-allow-origin')).toBe('*')
})

// `/panel/panel.js` 这个 URL 里没有内容指纹，所以「新构建有没有被取到」全靠这一对头。
// 掉了它，浏览器留着一份没有校验器的旧 bundle，后端发新的、页面跑旧的、无一处报错——
// 真栽过：面板改完构建完，活体上按钮就是不出现，而服务端 curl 回来的是新的。
test('带 no-cache + ETag——否则旧 bundle 会被静默留在浏览器里', async () => {
  const { app } = appWithPanel()
  const first = await app.request('/panel/panel.js')
  expect(first.headers.get('cache-control')).toBe('no-cache')
  const etag = first.headers.get('etag')
  expect(etag).toMatch(/^".+"$/)

  const revalidated = await app.request('/panel/panel.js', { headers: { 'if-none-match': etag! } })
  expect(revalidated.status).toBe(304)
  expect(await revalidated.text()).toBe('')
})

// ETag 必须跟着**内容**变，不是跟着文件名变——不变的话 304 就成了把旧内容钉死的那把锁。
test('内容变了 ETag 就变，旧 ETag 换不到 304', async () => {
  const { app, root } = appWithPanel()
  const before = (await app.request('/panel/panel.js')).headers.get('etag')
  writeFileSync(join(root, 'panel.js'), 'window.x=2')
  const after = await app.request('/panel/panel.js', { headers: { 'if-none-match': before! } })
  expect(after.status).toBe(200)
  expect(after.headers.get('etag')).not.toBe(before)
  expect(await after.text()).toBe('window.x=2')
})

test('产物没构建时是干净的 404，不是 500', async () => {
  const app = new Hono()
  mountPanelAssets(app, { root: join(tmpdir(), 'panel-does-not-exist') })
  expect((await app.request('/panel/panel.js')).status).toBe(404)
})

// 路径穿越必须在**路由匹配**那一层就不成立，而不是靠 handler 里判一次——
// handler 里的判断是可以被下一次改动绕过去的，路由约束不会。
//
// `/panel/../../etc/passwd` 这种写法测不出这条约束：URL 解析器在请求到达路由器之前
// 就把 `..` 规范化掉了（`new Request('http://localhost/panel/../../etc/passwd').url`
// 直接变成 `http://localhost/etc/passwd`），落到 catch-all 上跟路由模式写没写限制字符集
// 无关——就算把路由放宽成 `/panel/:file{.+}` 这条用例照样通过，测的是 URL 解析器不是
// 路由。真正会摸到路由匹配器的是编码过的穿越（`%2e%2e%2f` 不会被 URL 解析器提前吃掉）
// 与带斜杠的多段路径。
test('带斜杠或编码点点的文件名根本匹配不上这条路由', async () => {
  const { app } = appWithPanel()
  app.get('*', (c) => c.text('fell-through', 418))
  const encoded = await app.request('/panel/%2e%2e%2fetc%2fpasswd')
  expect(encoded.status).toBe(418)
  const nested = await app.request('/panel/sub/deep.js')
  expect(nested.status).toBe(418)
})

// 看板面板资产(panel-asset-delivery):插件装载器按 /panel/panel-boards.js 取。这个文件名是
// 跨包字符串契约(app/vite.panel.config.ts ENTRIES.boards.file ↔ 插件 boards/panel-assets.ts),
// 这条用例钉住"路由收紧/改名时必须两头一起改",否则断供是静默的(装载器只会报加载失败)。
test('panel-boards.js 走同一条路由发出:JS content-type + CORS 头', async () => {
  const { app, root } = appWithPanel()
  writeFileSync(join(root, 'panel-boards.js'), 'window.__streamBoardPanels={elements:[]}')
  const res = await app.request('/panel/panel-boards.js')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(await res.text()).toContain('__streamBoardPanels')
})
