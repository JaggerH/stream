import { describe, it, expect } from 'vitest'
import { makeFoldTextSource } from './text-source.ts'
import { ConversionStore } from '../conversions/store.ts'
import type { StoredItem } from '../item-store.ts'

const mediaItem = (id: string, seconds = 60): StoredItem =>
  ({ id, content: { media: [{ kind: 'video', url: 'https://x/a.mp4', duration_s: seconds }] } }) as unknown as StoredItem

function rig(items: Record<string, StoredItem>) {
  const store = new ConversionStore(':memory:')
  const requested: string[] = []
  const src = makeFoldTextSource({
    conversions: store,
    requestExtract: (item) => requested.push(item.id),
    itemOf: (id) => items[id],
  })
  return { store, src, requested }
}

describe('makeFoldTextSource', () => {
  it('没有记录 → 排一次、回 pending', async () => {
    const { src, requested } = rig({ a: mediaItem('a') })
    expect(await src.textFor('a')).toBe('pending')
    expect(requested).toEqual(['a'])
  })

  it('记录 done 且有正文 → 直接给，不重复排', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    const rec = store.create({ kind: 'extract', itemId: 'a' })
    store.update(rec.id, { status: 'done', result: { text: '一段正文', branch: 'stt' } })
    expect(await src.textFor('a')).toEqual({ text: '一段正文', source: 'stt' })
    expect(requested).toEqual([])
  })

  it('记录 queued/running → pending，不重复排', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    store.create({ kind: 'extract', itemId: 'a' })
    expect(await src.textFor('a')).toBe('pending')
    expect(requested).toEqual([])
  })

  // 作品已被作者删除的那一类：每排一次 extract 就要在用户的浏览器里开一次作品页，
  // 而结果每次都是同一句「无法观看」。与 fp-source 同一条规矩：重试归 runner。
  it('记录 error → null（取过了但失败，不再排；runner 的 retry 归 runner）', async () => {
    const { store, src, requested } = rig({ a: mediaItem('a') })
    const rec = store.create({ kind: 'extract', itemId: 'a' })
    store.update(rec.id, { status: 'error', error: { code: 'internal_error', message: '作品已删除' } })
    expect(await src.textFor('a')).toBe(null)
    expect(requested).toEqual([])
  })

  it('太长的媒体 → null，一次都不排', async () => {
    const { src, requested } = rig({ a: mediaItem('a', 3 * 3600) })
    expect(await src.textFor('a')).toBe(null)
    expect(requested).toEqual([])
  })
})
