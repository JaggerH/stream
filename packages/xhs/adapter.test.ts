import { describe, it, expect } from 'vitest'
import { XhsAdapter, STREAM_NOT_REGISTERED } from './adapter.ts'
import { StreamTable } from './streams.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { BROWSER_UA } from '../../shared/package-sdk/browser-ua.ts'

// 进 registry 的是全名（`<包名>/<局部名>`），adapter 按后缀分派。
const RESOLVE = { id: '@streamapp/xhs/xhs-resolve' } as unknown as SourceManifest
const URL_A = 'http://sns-video-qc.example-cdn.com/stream/a.mp4?sign=s'

function setup() {
  const streams = new StreamTable()
  const adapter = new XhsAdapter({ streams, readSource: async () => [] })
  return { streams, adapter }
}

describe('XhsAdapter — xhs-resolve（video-xhs 行的成员）', () => {
  it('id 是 xhs；init 不做事', async () => {
    const { adapter } = setup()
    expect(adapter.id).toBe('xhs')
    await expect(adapter.init()).resolves.toBeUndefined()
  })

  it('streams 命中 → progressive 描述子，出站带完整桌面 Chrome UA（沿用原视频代理路由的请求形状）', async () => {
    const { adapter, streams } = setup()
    streams.set('n1', URL_A)
    expect(await adapter.fetch({ vid: 'n1' }, RESOLVE)).toEqual([
      { kind: 'progressive', url: URL_A, headers: { 'User-Agent': BROWSER_UA } },
    ])
    expect(BROWSER_UA).toMatch(/^Mozilla\/5\.0 .*Chrome\//)
  })

  it("format:'dash' → []（本站只有 mp4 直链，前端 dash 502 后再问 progressive）", async () => {
    const { adapter, streams } = setup()
    streams.set('n1', URL_A)
    expect(await adapter.fetch({ vid: 'n1', format: 'dash' }, RESOLVE)).toEqual([])
  })

  it('缺 vid → []', async () => {
    const { adapter } = setup()
    expect(await adapter.fetch({}, RESOLVE)).toEqual([])
  })

  it('streams 未命中 → 抛原话「先打开这条笔记」，不去跑一条没 token 的 detail（那是注定失败的运行）', async () => {
    const { adapter } = setup()
    await expect(adapter.fetch({ vid: 'n2' }, RESOLVE)).rejects.toThrow(STREAM_NOT_REGISTERED)
    expect(STREAM_NOT_REGISTERED).toContain('先打开这条笔记')
  })

  it('不认识的 manifest id → 抛', async () => {
    const { adapter } = setup()
    await expect(adapter.fetch({}, { id: '@streamapp/xhs/other' } as unknown as SourceManifest)).rejects.toThrow(/unsupported source/)
  })
})
