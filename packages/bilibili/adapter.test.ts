import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BilibiliAdapter } from './adapter.ts'
import type { BilibiliClient } from './client.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { ResolveEngine } from '../../src/resolve/engine.ts'
import { Registry } from '../../src/registry/registry.ts'
import { SourceHealthStore } from '../../src/source-health-store.ts'
import { memberCallArgs } from '../../src/providers/invoke-types.ts'

// 进 registry 的是全名（`<包名>/<局部名>`），adapter 按后缀分派。
const RESOLVE = { id: '@streamapp/bilibili/bilibili-resolve' } as unknown as SourceManifest

function fakeClient() {
  return {
    dash: vi.fn(async () => ({ durationS: 10, video: [], audio: [] })),
    progressive: vi.fn(async () => ({ url: 'https://cdn.bili/v.mp4', headers: { Referer: 'https://www.bilibili.com' } })),
    audio: vi.fn(async () => ({ url: 'https://cdn.bili/a.m4s', headers: { Referer: 'https://www.bilibili.com' } })),
  }
}

describe('BilibiliAdapter — bilibili-resolve（video-bilibili 行的成员）', () => {
  it('default (no format) resolves a dash descriptor', async () => {
    const c = fakeClient()
    const out = await new BilibiliAdapter(c as unknown as BilibiliClient).fetch({ vid: 'BV1xx' }, RESOLVE)
    expect(out).toEqual([{ kind: 'dash', manifest: { durationS: 10, video: [], audio: [] } }])
    expect(c.dash).toHaveBeenCalledWith({ bvid: 'BV1xx' })
  })

  it("format:'progressive' resolves a progressive descriptor with headers", async () => {
    const c = fakeClient()
    const out = await new BilibiliAdapter(c as unknown as BilibiliClient).fetch({ vid: 'BV1xx', format: 'progressive' }, RESOLVE)
    expect(out).toEqual([{ kind: 'progressive', url: 'https://cdn.bili/v.mp4', headers: { Referer: 'https://www.bilibili.com' } }])
    expect(c.progressive).toHaveBeenCalledWith({ bvid: 'BV1xx' })
  })

  it("format:'audio' resolves the smallest audio rep as a progressive descriptor tagged audio/mp4", async () => {
    const c = fakeClient()
    const out = await new BilibiliAdapter(c as unknown as BilibiliClient).fetch({ vid: 'BV1xx', format: 'audio' }, RESOLVE)
    expect(out).toEqual([{ kind: 'progressive', url: 'https://cdn.bili/a.m4s', headers: { Referer: 'https://www.bilibili.com' }, mime: 'audio/mp4' }])
    expect(c.audio).toHaveBeenCalledWith({ bvid: 'BV1xx' })
  })

  it('an av-number vid maps to an aid ref', async () => {
    const c = fakeClient()
    await new BilibiliAdapter(c as unknown as BilibiliClient).fetch({ vid: 'av12345' }, RESOLVE)
    expect(c.dash).toHaveBeenCalledWith({ aid: '12345' })
  })

  it('declines (empty) when there is no vid — dispatch is by serves-key, but a missing key is a no-op', async () => {
    const c = fakeClient()
    expect(await new BilibiliAdapter(c as unknown as BilibiliClient).fetch({}, RESOLVE)).toEqual([])
    expect(c.dash).not.toHaveBeenCalled()
  })

  it('an unknown source id of this package throws instead of silently returning nothing', async () => {
    const c = fakeClient()
    await expect(new BilibiliAdapter(c as unknown as BilibiliClient).fetch({}, { id: '@streamapp/bilibili/nope' } as unknown as SourceManifest))
      .rejects.toThrow(/unsupported source/)
  })
})

/**
 * 端到端钉子：调用点给的是**对象**输入（`{ vid, format }`），而非 builtin 成员经
 * `ResolveEngine.fetchSource(id, key, extra)` 走，`key` 是字符串。宿主把对象按字段塞进 extra
 * （`memberCallArgs`，`src/providers/invoke-types.ts`）——这条用例用真引擎 + 真 adapter 走一遍，
 * 证明 `params.vid` 真的到了 adapter 手上。少了它，adapter 单测全绿而活体上每次都 502。
 */
describe('BilibiliAdapter 经真 ResolveEngine：对象输入按字段到达 params', () => {
  it('fetchSource(id, "", { vid, format }) → adapter 拿到 vid 与 format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bili-engine-'))
    try {
      const c = fakeClient()
      const adapter = new BilibiliAdapter(c as unknown as BilibiliClient)
      const manifest = {
        schema_version: 1, id: '@streamapp/bilibili/bilibili-resolve', adapter: 'bilibili', type: 'post', description: 'd',
        topics: [], example_queries: [], capabilities: ['anchor'], auth: { type: 'none' }, params_schema: {},
        cadence_hint_seconds: 3600, discoverable: false,
      } as unknown as SourceManifest
      const engine = new ResolveEngine({
        registry: new Registry([manifest]),
        adapters: new Map([['bilibili', adapter]]),
        health: new SourceHealthStore(join(dir, 'h.json'), { errK: 2 }),
        resolveCreds: async () => ({}),
        buildParams: (m, key) => ({ [m.key_param ?? 'url']: key }),
      })
      const call = memberCallArgs({ vid: 'av777', format: 'progressive' }, undefined)
      const out = await engine.fetchSource(manifest.id, call.key, call.params)
      expect(out).toEqual([{ kind: 'progressive', url: 'https://cdn.bili/v.mp4', headers: { Referer: 'https://www.bilibili.com' } }])
      expect(c.progressive).toHaveBeenCalledWith({ aid: '777' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
