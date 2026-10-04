// GET /api/ext/claimed-tabs —— 「后端此刻还骑着哪些浏览器标签」。
//
// 存在的理由：lane→tab 的映射只在后端进程内存里，后端一重启，用户 Chrome 里还开着的采集标签
// 就没人认了。扩展侧要回收它们，就必须能问一句「这个标签你还认不认」——**这是那句问话的口**。
// 单向只读：它只说后端认哪些，回收与否、怎么回收（红线：adopted 绝不 remove）全在扩展侧。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

const appWith = (claimedTabs: unknown) =>
  createHttpApp({ ...(stubs as object), claimedTabs } as never)

describe('GET /api/ext/claimed-tabs', () => {
  it('返回后端当前认领的 tabId', async () => {
    const app = appWith(() => [11, 22])
    const res = await app.request('/api/ext/claimed-tabs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tabIds: [11, 22] })
  })

  it('一个 lane 都没有 → 空数组，不是 404', async () => {
    // 这正是「后端刚重启完」的样子：一个都不认，于是扩展侧该收的全都收掉。
    // 若这里报错或 404，扩展会按「问不到」处理→什么都不做→孤儿永远留着。
    const app = appWith(() => [])
    const res = await app.request('/api/ext/claimed-tabs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tabIds: [] })
  })

  it('后端根本没接会话层（dep 缺失）→ 503，别返回空集合', async () => {
    // 空集合的含义是「一个都不认」，扩展据此会去回收。dep 没接线时返回空集合
    // 等于让扩展把用户正在用的标签全关掉——所以这两件事必须分开报。
    const app = createHttpApp(stubs)
    const res = await app.request('/api/ext/claimed-tabs')
    expect(res.status).toBe(503)
  })
})
