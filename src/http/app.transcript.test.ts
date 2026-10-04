// 从 app.test.ts 拆出(2026-07-22):按路由域分文件,理由见 __fixtures__/app-harness.ts 头注。
//
// 原来这里还有一整族 /api/transcripts 的路由测试——那族端点已于 2026-07-25 退场(转换收敛成
// /api/conversions,契约测试在 conversions-routes.test.ts)。留下的这一条是**声纹**路由:
// 它不属于转换资源,但要从 runner 读转写、并起一次 identify。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'
import { ConversionRunner, type Converter } from '../conversions/runner.ts'
import { ConversionStore } from '../conversions/store.ts'

describe('POST /api/voiceprint/item/:itemId/clusters (补说话人——identify-only)', () => {
  const baseStubs = {
    service: { streamsResource: () => [] },
    itemStore: { get: () => undefined },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
    speakerRegistry: {}, // 路由只判存在性;真 registry 由 identify 步内部使用
  } as never

  const identifyConverter = (available = true): Converter => ({
    kind: 'identify',
    label: '补说话人',
    stages: [],
    available: () => available,
    run: async () => ({ ok: true, result: {} }),
  })

  /** 一个带转写的 runner。`sttStatus` 控制那条转写处于什么状态（done / running / 根本没有）。 */
  function setup(opts: { sttStatus?: 'done' | 'running' | null; engine?: boolean } = {}) {
    const store = new ConversionStore(':memory:')
    const conversions = new ConversionRunner({ store, converters: [identifyConverter(opts.engine ?? true)], derivations: [], costarts: [] })
    const status = opts.sttStatus === undefined ? 'done' : opts.sttStatus
    if (status) {
      const rec = store.create({ kind: 'extract', itemId: 'ep1' })
      store.update(rec.id, {
        status,
        // 转写分支的 extract：时间轴在 detail 下（合同只有 text）。
        result: status === 'done'
          ? { text: 'hi', format: 'plain', branch: 'stt', detail: { segments: [{ start: 0, end: 2, text: 'hi' }] } }
          : undefined,
      })
    }
    return { store, conversions }
  }

  it('202 queues an identify-only pass on a done transcript', async () => {
    const { conversions, store } = setup()
    const app = createHttpApp({ ...(baseStubs as object), conversions } as never)
    const r = await app.request('/api/voiceprint/item/ep1/clusters', { method: 'POST' })
    expect(r.status).toBe(202)
    expect(await r.json()).toEqual({ status: 'queued' })
    // 真的入了队:该 item 上多了一条 identify,且 inputId 指向那条转写
    const identify = store.latestFor('ep1', 'identify')
    expect(identify).toBeTruthy()
    expect(identify!.inputId).toBe(store.latestFor('ep1', 'extract')!.id)
  })

  it('503 when voiceprint/engine is not configured', async () => {
    const noRegistry = createHttpApp({ ...(baseStubs as object), speakerRegistry: undefined, conversions: setup().conversions } as never)
    expect((await noRegistry.request('/api/voiceprint/item/ep1/clusters', { method: 'POST' })).status).toBe(503)
    // engine 装不上 ≠ 这条记录不满足前提:必须还是 503,不能串成 409
    const noEngine = createHttpApp({ ...(baseStubs as object), conversions: setup({ engine: false }).conversions } as never)
    expect((await noEngine.request('/api/voiceprint/item/ep1/clusters', { method: 'POST' })).status).toBe(503)
  })

  it('从没转写过的 item 照样 202——识别只需要音频，转写不是前提', async () => {
    const { conversions, store } = setup({ sttStatus: null })
    const app = createHttpApp({ ...(baseStubs as object), conversions } as never)
    const r = await app.request('/api/voiceprint/item/nope/clusters', { method: 'POST' })
    expect(r.status).toBe(202)
    // 没有上游转写可指 → inputId 留空，converter 走纯 diarization
    expect(store.latestFor('nope', 'identify')!.inputId).toBeUndefined()
  })

  it('409 job already active（转写在跑 / 已有 identify 排队）', async () => {
    const running = createHttpApp({ ...(baseStubs as object), conversions: setup({ sttStatus: 'running' }).conversions } as never)
    const r1 = await running.request('/api/voiceprint/item/ep1/clusters', { method: 'POST' })
    expect(r1.status).toBe(409)
    expect((await r1.json()).error.message).toContain('already')

    // 已有一条 identify 在排队 → 再点一次必须被拒(两个 pass 抢同一条转写会互相覆盖 segments)
    const { conversions, store } = setup()
    const busy = createHttpApp({ ...(baseStubs as object), conversions } as never)
    const first = store.create({ kind: 'identify', itemId: 'ep1' })
    store.update(first.id, { status: 'queued' })
    const r2 = await busy.request('/api/voiceprint/item/ep1/clusters', { method: 'POST' })
    expect(r2.status).toBe(409)
    expect((await r2.json()).error.message).toContain('already')
  })
})
