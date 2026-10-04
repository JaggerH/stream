import { describe, it, expect } from 'vitest'
import { makeFoldFpSource } from './fp-source.ts'
import { encodeFingerprint } from '../media/audio-fingerprint.ts'
import { ConversionStore } from '../conversions/store.ts'
import type { StoredItem } from '../item-store.ts'

const mediaItem = (id: string): StoredItem =>
  ({ id, content: { media: [{ kind: 'audio', url: 'https://x/a.mp3', duration_s: 7200 }] } }) as unknown as StoredItem
const textItem = (id: string): StoredItem => ({ id, content: { media: [] } }) as unknown as StoredItem

function rig(items: Record<string, StoredItem>) {
  const store = new ConversionStore(':memory:')
  const requested: string[] = []
  const src = makeFoldFpSource({
    conversions: store,
    requestFp: (item) => requested.push(item.id),
    itemOf: (id) => items[id],
    available: () => true,
  })
  return { store, src, requested }
}

describe('makeFoldFpSource', () => {
  it('没有记录 → 排一次、回 pending', async () => {
    const { src, requested } = rig({ a: mediaItem('a') })
    expect(await src.fpFor('a')).toBe('pending')
    expect(requested).toEqual(['a'])
  })

  it('记录 done → 解码返回指纹与 totalS，不重复排', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    const rec = store.create({ kind: 'audio-fp', itemId: 'a' })
    store.update(rec.id, { status: 'done', result: { fp: encodeFingerprint(new Uint32Array([5, 6])), items: 2, totalS: 7200 } })
    const got = await src.fpFor('a')
    expect(got).toEqual({ fp: new Uint32Array([5, 6]), totalS: 7200 })
    expect(requested).toEqual([])
  })

  it('记录 queued/running → pending，不重复排', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    store.create({ kind: 'audio-fp', itemId: 'a' })
    expect(await src.fpFor('a')).toBe('pending')
    expect(requested).toEqual([])
  })

  it('记录 error → null（算过了但失败，不无限重排；runner 的 retry 归 runner）', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    const rec = store.create({ kind: 'audio-fp', itemId: 'a' })
    store.update(rec.id, { status: 'error', error: { code: 'fp_failed', message: 'x' } })
    expect(await src.fpFor('a')).toBe(null)
    expect(requested).toEqual([])
  })

  it('不是媒体的条目 → null，一次都不排', async () => {
    const { src, requested } = rig({ t: textItem('t') })
    expect(await src.fpFor('t')).toBe(null)
    expect(requested).toEqual([])
  })

  it('hasFingerprintableMedia：媒体 true / 非媒体 false，两种都不排队', () => {
    const { src, requested } = rig({ a: mediaItem('a'), t: textItem('t') })
    expect(src.hasFingerprintableMedia('a')).toBe(true)
    expect(src.hasFingerprintableMedia('t')).toBe(false)
    expect(src.hasFingerprintableMedia('missing')).toBe(false)
    expect(requested).toEqual([])
  })

  it('引擎不可用 → null，一次都不排', async () => {
    const store = new ConversionStore(':memory:')
    const requested: string[] = []
    const src = makeFoldFpSource({
      conversions: store, requestFp: (i) => requested.push(i.id),
      itemOf: () => mediaItem('a'), available: () => false,
    })
    expect(await src.fpFor('a')).toBe(null)
    expect(requested).toEqual([])
  })
})
