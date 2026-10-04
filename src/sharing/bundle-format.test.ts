import { describe, it, expect } from 'vitest'
import { parseBundle, serializeBundle, deserializeBundle, STREAM_BUNDLE_FORMAT, type StreamBundleV1 } from './bundle-format.ts'

const minimal = {
  format: STREAM_BUNDLE_FORMAT,
  meta: { title: '我的流', created: '2026-07-18', revision: '1.0.0' },
  channels: [{ id: 'c1', label: 'C', variant: 'timeline', stream_ids: ['s1'], options: {} }],
  streams: [{ id: 's1', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} }],
  providers: [],
  requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
  embedded: { recipes: {} },
}

describe('parseBundle', () => {
  it('接受合法包', () => {
    const r = parseBundle(minimal)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bundle.streams[0].id).toBe('s1')
  })
  it('拒绝未知 format 且不抛（可读错误）', () => {
    const r = parseBundle({ ...minimal, format: 'stream-bundle/v2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/格式版本|unsupported|不受支持/i)
  })
  it('拒绝三数组全空', () => {
    const r = parseBundle({ ...minimal, channels: [], streams: [], providers: [] })
    expect(r.ok).toBe(false)
  })
  it('拒绝缺 requires/embedded 的坏结构', () => {
    const bad = { ...minimal } as Record<string, unknown>
    delete bad.requires
    expect(parseBundle(bad).ok).toBe(false)
  })

  it('v1 旧包无 providers/providerBindings 块照常解析（向后兼容）', () => {
    const legacy = {
      format: STREAM_BUNDLE_FORMAT,
      meta: { title: 'Old', created: '2026-07-18', revision: '1.0.0' },
      channels: [{ id: 'c', label: 'C', variant: 'timeline', stream_ids: [], options: {} }],
      streams: [],
      requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
      embedded: { recipes: {} },
      // 注意：故意不含 providers、也不含 providerBindings
    }
    const r = parseBundle(legacy)
    expect(r.ok).toBe(true)
  })

  it('providerBindings 可选块被保留', () => {
    const withCaps = {
      format: STREAM_BUNDLE_FORMAT,
      meta: { title: 'Caps', created: '2026-07-18', revision: '1.0.0' },
      channels: [], streams: [],
      providers: [{ id: 'p1', label: 'P1', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
      providerBindings: [{ callsiteId: 'netdisk.share.verify', providerIds: ['p1'] }],
      requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
      embedded: { recipes: {} },
    }
    const r = parseBundle(withCaps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bundle.providerBindings?.[0].callsiteId).toBe('netdisk.share.verify')
  })
})

describe('netdiskBindings 顶层可选块', () => {
  const base = (extra: Partial<StreamBundleV1> = {}): StreamBundleV1 => ({
    format: STREAM_BUNDLE_FORMAT,
    meta: { title: 't', created: '2026-07-19', revision: '1.0.0' },
    channels: [], streams: [],
    requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
    embedded: { recipes: {} },
    ...extra,
  })

  it('缺块的包照常 round-trip（v1/A 兼容）', () => {
    const b = base({ streams: [{ id: 's1', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} }] })
    expect(deserializeBundle(serializeBundle(b)).ok).toBe(true)
  })

  it('带 netdiskBindings（tmdb-left + matchSpec + corrected entry）round-trip 等价', () => {
    const b = base({
      netdiskBindings: [{
        left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权游' },
        matchSpec: { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.6, margin: 0.1 }] } as never,
        entries: [{ leftKey: 'tmdb:1399:S01E01', leftTitle: '第一集', rightFile: 'S01E01.mkv', status: 'confirmed', corrected: { at: '2026-07-19', autoFile: null } }] as never,
        shareUrl: 'https://pan.quark.cn/s/abc',
      }],
    })
    const r = deserializeBundle(serializeBundle(b))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bundle.netdiskBindings?.[0].matchSpec?.version).toBe(2)
  })

  it('只含 netdiskBindings 的包不被判空而拒（refine 计入新块）', () => {
    const r = parseBundle(base({ netdiskBindings: [{ left: { kind: 'tmdb', id: '9', media: 'movie', title: 'X' } }] }))
    expect(r.ok).toBe(true)
  })
})
