// src/agent/search/verify.test.ts
import { describe, it, expect, vi } from 'vitest'
import { verifyHits } from './verify.ts'
import type { NetdiskHit } from './types.ts'

const hit = (over: Partial<NetdiskHit> = {}): NetdiskHit => ({
  link: 'https://pan.quark.cn/s/aaa111', netdisk: 'quark', sourceId: 'hub1', snippet: '某个帖子里的文字', ...over,
})
const parseShareLink = (link: string) => {
  const m = /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/.exec(link)
  return m ? { netdisk: 'quark', pwd_id: m[1] } : null
}
const alive = (...names: string[]) => ({ validity: 'alive', files: names.map((name) => ({ name })) })
const dead = { validity: 'not-usable', files: [] }

describe('verifyHits', () => {
  it('attaches what a live share really contains — the signal that beats the snippet', async () => {
    const verifyShare = vi.fn(async () => alive('黄 粱 一 梦', '第二集'))
    const r = await verifyHits([hit()], { verifyShare, parseShareLink })
    expect(r.hits[0].files).toEqual(['黄 粱 一 梦', '第二集'])
    expect(r.hits[0].snippet).toBe('某个帖子里的文字') // kept: the file list adds to it, doesn't replace it
    expect(r).toMatchObject({ alive: 1, dead: 0, unchecked: 0 })
  })

  // A dead share isn't a weak answer, it's no answer — there is nothing a caller can do with it.
  it('drops a dead share entirely rather than sinking it to a low score', async () => {
    const verifyShare = vi.fn(async () => dead)
    const r = await verifyHits([hit()], { verifyShare, parseShareLink })
    expect(r.hits).toEqual([])
    expect(r).toMatchObject({ alive: 0, dead: 1 })
  })

  // Every branch below is the same rule: "we didn't look" must not be returned as a verdict —
  // neither as "fine" (no files invented) nor as dead (not dropped).
  it('keeps a link whose netdisk has no verify Provider (null), unenriched', async () => {
    const verifyShare = vi.fn(async () => null)
    const r = await verifyHits([hit({ link: 'https://pan.baidu.com/s/x', netdisk: 'baidu' })], { verifyShare, parseShareLink })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].files).toBeUndefined()
    expect(r).toMatchObject({ alive: 0, dead: 0, unchecked: 1 })
  })

  it('keeps a link when the probe itself throws — an outage is not a verdict', async () => {
    const verifyShare = vi.fn(async () => { throw new Error('ECONNRESET') })
    const r = await verifyHits([hit()], { verifyShare, parseShareLink })
    expect(r.hits).toHaveLength(1)
    expect(r).toMatchObject({ dead: 0, unchecked: 1 })
  })

  it('keeps a needs-login link — an expired session is our problem, not the share´s', async () => {
    const verifyShare = vi.fn(async () => ({ validity: 'needs-login', files: [] }))
    const r = await verifyHits([hit()], { verifyShare, parseShareLink })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].files).toBeUndefined()
    expect(r).toMatchObject({ dead: 0, unchecked: 1 })
  })

  it('keeps an unparseable link without calling the Provider', async () => {
    const verifyShare = vi.fn(async () => alive('x'))
    const r = await verifyHits([hit({ link: 'magnet:?xt=urn:btih:aaaa', netdisk: 'magnet' })], { verifyShare, parseShareLink })
    expect(r.hits).toHaveLength(1)
    expect(verifyShare).not.toHaveBeenCalled()
    expect(r).toMatchObject({ unchecked: 1 })
  })

  it('sorts a mixed batch into kept-with-files / dropped / kept-unchecked', async () => {
    const verifyShare = vi.fn(async (_n: string, pwd: string) =>
      pwd === 'live' ? alive('要的东西') : pwd === 'gone' ? dead : null)
    const r = await verifyHits(
      [
        hit({ link: 'https://pan.quark.cn/s/live' }),
        hit({ link: 'https://pan.quark.cn/s/gone' }),
        hit({ link: 'https://pan.quark.cn/s/dunno' }),
      ],
      { verifyShare, parseShareLink },
    )
    expect(r).toMatchObject({ alive: 1, dead: 1, unchecked: 1 })
    expect(r.hits.map((h) => h.link)).toEqual(
      expect.arrayContaining(['https://pan.quark.cn/s/live', 'https://pan.quark.cn/s/dunno']),
    )
    expect(r.hits.some((h) => h.link.endsWith('/gone'))).toBe(false)
  })

  it('verifies a batch larger than the pool, once each', async () => {
    const verifyShare = vi.fn(async () => alive('x'))
    const hits = Array.from({ length: 20 }, (_, i) => hit({ link: `https://pan.quark.cn/s/n${i}` }))
    const r = await verifyHits(hits, { verifyShare, parseShareLink })
    expect(verifyShare).toHaveBeenCalledTimes(20)
    expect(r.alive).toBe(20)
  })

  it('is a no-op on an empty batch', async () => {
    const verifyShare = vi.fn(async () => alive('x'))
    expect(await verifyHits([], { verifyShare, parseShareLink })).toEqual({ hits: [], alive: 0, dead: 0, unchecked: 0 })
    expect(verifyShare).not.toHaveBeenCalled()
  })
})
