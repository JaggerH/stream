import { describe, expect, it, vi } from 'vitest'
import { VideoEnrichQueue } from './enrich-queue.ts'
import type { VideoDetail } from './types.ts'
import type { StreamItem } from '../types.ts'

const NOW = 1_700_000_000_000

function item(over: Partial<StreamItem> = {}): StreamItem {
  return {
    id: 'i1', stream_id: 'kids-emmy', source_route: 'wikipedia/award', title: 'Ada Twist, Scientist',
    url: 'https://en.wikipedia.org/wiki/Ada_Twist,_Scientist', published_at: '2026-01-01T00:00:00Z',
    raw: {}, videoRef: { title: 'Ada Twist, Scientist', externalIds: { imdb: 'tt13241650' } },
    ...over,
  } as StreamItem
}

function detail(over: Partial<VideoDetail> = {}): VideoDetail {
  return {
    cacheKey: 'imdb:tt13241650', identity: { title: 'x', externalIds: {} }, images: {}, imageCandidates: [],
    failures: [], fetchedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(),
    ...over,
  }
}

function harness(over: { peek?: () => VideoDetail | null; streams?: string[] } = {}) {
  const get = vi.fn(async () => ({ detail: detail(), cache: 'miss' as const }))
  const peek = vi.fn(over.peek ?? (() => null))
  const q = new VideoEnrichQueue({
    details: { peek, get },
    videoStreamIds: () => new Set(over.streams ?? ['kids-emmy']),
    now: () => NOW,
  })
  return { q, get, peek }
}

describe('VideoEnrichQueue', () => {
  it('视频频道的流:落库即富化', async () => {
    const { q, get } = harness()
    q.consider(item())
    await q.idle()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('不属于视频频道的流不碰——用户拍的板:别为一张海报去打 TMDb', async () => {
    const { q, get } = harness({ streams: ['some-other-channel-stream'] })
    q.consider(item())
    await q.idle()
    expect(get).not.toHaveBeenCalled()
  })

  it('没有 videoRef 的条目直接跳过（非视频源）', async () => {
    const { q, get } = harness()
    q.consider(item({ videoRef: undefined }))
    await q.idle()
    expect(get).not.toHaveBeenCalled()
  })

  it('缓存还新鲜就连队列都不进', async () => {
    // collection 流每轮采集把整份快照重放一遍;不先挡这一道,一份 192 条的名单每周白排 192 次。
    const { q, get } = harness({ peek: () => detail() })
    q.consider(item())
    await q.idle()
    expect(get).not.toHaveBeenCalled()
  })

  it('缓存里是「没认出来」而这次多了个标识符 → 不等 TTL，当场重试', async () => {
    // 实撞过：给名单接上 Wikidata 之后 8 部作品当场能认，重跑采集却一部都没变——它们各自压着
    // 一份没过期的 miss，而缓存键按片名算、不因新证据改变，新证据就被自己那次失败挡了一整周。
    const missed = detail({
      canonical: { status: 'miss', provider: 'video-canonical' },
      identity: { title: 'Fun Song Factory', externalIds: {} },
    })
    const { q, get } = harness({ peek: () => missed })
    q.consider(item({ videoRef: { title: 'Fun Song Factory', externalIds: { wikidata: 'Q5508684' } } }))
    await q.idle()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('同样是 miss，但标识符一个没多 → 照旧按 TTL 节流，别每条 item 问一次', async () => {
    const missed = detail({
      canonical: { status: 'miss', provider: 'video-canonical' },
      identity: { title: 'Fun Song Factory', externalIds: { wikidata: 'Q5508684' } },
    })
    const { q, get } = harness({ peek: () => missed })
    q.consider(item({ videoRef: { title: 'Fun Song Factory', externalIds: { wikidata: 'Q5508684' } } }))
    await q.idle()
    expect(get).not.toHaveBeenCalled()
  })

  it('已经认出来的那份不会因为多了个标识符被重跑', async () => {
    const resolved = detail({
      canonical: { status: 'resolved', provider: 'video-canonical', member: 'tmdb-canonical', source: 'tmdb-canonical', externalIds: { tmdb: '1' } },
      identity: { title: 'x', externalIds: { tmdb: '1' } },
    })
    const { q, get } = harness({ peek: () => resolved })
    q.consider(item({ videoRef: { title: 'x', externalIds: { tmdb: '1', wikidata: 'Q9' } } }))
    await q.idle()
    expect(get).not.toHaveBeenCalled()
  })

  it('缓存过期了就重新富化', async () => {
    const { q, get } = harness({ peek: () => detail({ expiresAt: new Date(NOW - 1).toISOString() }) })
    q.consider(item())
    await q.idle()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('同一部作品的多集只富化一次(按 cacheKey 去重)', async () => {
    const { q, get } = harness()
    q.consider(item({ id: 'e1' }))
    q.consider(item({ id: 'e2' }))
    q.consider(item({ id: 'e3' }))
    await q.idle()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('并发有上限——TMDb 不是我们的资源', async () => {
    let peakInFlight = 0
    let inFlight = 0
    const get = vi.fn(async () => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return { detail: detail(), cache: 'miss' as const }
    })
    const q = new VideoEnrichQueue({
      details: { peek: () => null, get },
      videoStreamIds: () => new Set(['kids-emmy']),
      concurrency: 2,
      now: () => NOW,
    })
    for (let i = 0; i < 10; i += 1) {
      q.consider(item({ id: `i${i}`, videoRef: { title: `作品 ${i}`, externalIds: { imdb: `tt${i}` } } }))
    }
    await q.idle()
    expect(get).toHaveBeenCalledTimes(10)
    expect(peakInFlight).toBeLessThanOrEqual(2)
  })

  it('一条失败不拖住队列,也不往上抛', async () => {
    const errors: string[] = []
    const get = vi.fn(async () => { throw new Error('TMDb 502') })
    const q = new VideoEnrichQueue({
      details: { peek: () => null, get },
      videoStreamIds: () => new Set(['kids-emmy']),
      now: () => NOW,
      onError: (m) => errors.push(m),
    })
    q.consider(item({ id: 'a', videoRef: { title: 'A', externalIds: { imdb: 'tt1' } } }))
    q.consider(item({ id: 'b', videoRef: { title: 'B', externalIds: { imdb: 'tt2' } } }))
    await q.idle()
    expect(get).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('TMDb 502')
  })
})
