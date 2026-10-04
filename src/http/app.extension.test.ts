// POST /api/extension/{materialize,install,decline} —— 扩展安装引导的三个动作（spec §8）。
//
// 这一层只做转发与形状：判据（"装好了"= 连上中继）在引擎里，物化在 extension-dir 里。
// 唯一必须钉在这里的语义是**「后端没接这一格」和「试过了没成功」不能长成同一个回答**。

import { describe, it, expect, vi } from 'vitest'
import { createHttpApp } from './app.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

function appWith(onboarding: unknown) {
  return createHttpApp({ ...(stubs as object), extensionOnboarding: onboarding } as never)
}

const post = (app: ReturnType<typeof createHttpApp>, path: string) =>
  app.request(path, { method: 'POST' })

describe('扩展安装引导的三个端点', () => {
  it('materialize 回绝对路径——手动装那条路要把它念给用户听', async () => {
    const app = appWith({
      materialize: () => ({ dir: 'C:\\data\\extension', source: 'repo' }),
      install: vi.fn(),
      decline: vi.fn(),
    })
    const res = await post(app, '/api/extension/materialize')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dir: 'C:\\data\\extension', source: 'repo' })
  })

  it('物化失败（产物不在场）→ 500 带原话，不回一个编出来的路径', async () => {
    const app = appWith({
      materialize: () => {
        throw new Error('找不到扩展的构建产物')
      },
      install: vi.fn(),
      decline: vi.fn(),
    })
    const res = await post(app, '/api/extension/materialize')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('找不到扩展的构建产物')
  })

  it('install 的三态原样透出，blocked 必须带 reason', async () => {
    const install = vi.fn(async () => ({ status: 'blocked', reason: '找不到「开发者模式」开关' }))
    const app = appWith({ materialize: vi.fn(), install, decline: vi.fn() })
    const res = await post(app, '/api/extension/install')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'blocked', reason: '找不到「开发者模式」开关' })
  })

  it('install 抛异常 → 500，不伪装成 blocked（那会把"没跑起来"读成"跑了但没成"）', async () => {
    const app = appWith({
      materialize: vi.fn(),
      install: async () => {
        throw new Error('Stream Desktop not connected')
      },
      decline: vi.fn(),
    })
    const res = await post(app, '/api/extension/install')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('Stream Desktop not connected')
  })

  it('拒绝过没有要读得到——横幅的挂载条件里有它，只靠 browser-capability 答不出来', async () => {
    const app = appWith({
      state: () => ({ declinedAt: '2026-08-30T10:00:00.000Z' }),
      materialize: vi.fn(),
      install: vi.fn(),
      decline: vi.fn(),
    })
    const res = await app.request('/api/extension/onboarding')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ declinedAt: '2026-08-30T10:00:00.000Z' })
  })

  it('decline 记一条就够，回 204', async () => {
    const decline = vi.fn()
    const app = appWith({ state: () => ({}), materialize: vi.fn(), install: vi.fn(), decline })
    const res = await post(app, '/api/extension/decline')
    expect(res.status).toBe(204)
    expect(decline).toHaveBeenCalledTimes(1)
  })

  it('后端没接这一格 → 404，不许伪装成「装不了」', async () => {
    const app = createHttpApp(stubs)
    for (const p of ['/api/extension/materialize', '/api/extension/install', '/api/extension/decline']) {
      expect((await post(app, p)).status).toBe(404)
    }
    expect((await app.request('/api/extension/onboarding')).status).toBe(404)
  })
})
