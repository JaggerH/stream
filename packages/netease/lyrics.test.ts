import { describe, expect, it } from 'vitest'
import { bestMatch, NeteaseLyricsAdapter, normalize, similarity } from './lyrics.ts'

const manifest = { id: 'netease-lyrics', adapter: 'netease-lyrics', key_param: 'input' } as never

describe('normalize', () => {
  it('strips parentheticals, punctuation, and casing', () => {
    expect(normalize('Faded (Radio Edit)')).toBe('faded')
    expect(normalize('Faded')).toBe('faded')
  })
  it('keeps CJK characters', () => {
    expect(normalize('青花瓷')).toBe('青花瓷')
  })
})

describe('similarity', () => {
  it('is 1 for identical normalized strings', () => {
    expect(similarity('Faded', 'faded (radio edit)')).toBe(1)
  })
  it('is 0 when either side is empty', () => {
    expect(similarity('', 'faded')).toBe(0)
    expect(similarity('faded', '')).toBe(0)
  })
  it('is partial for a near match', () => {
    const s = similarity('Faded', 'Fade')
    expect(s).toBeGreaterThan(0.5)
    expect(s).toBeLessThan(1)
  })
})

describe('bestMatch', () => {
  const songs = [
    { id: 1, name: '青花瓷', artists: [{ name: '林俊杰' }] },
    { id: 2, name: '青花瓷', artists: [{ name: '周杰伦' }] },
  ]
  it('picks the candidate with the best combined title+artist score', () => {
    expect(bestMatch('青花瓷', '周杰伦', songs)).toEqual({ id: '2', score: 1 })
  })
  it('returns undefined when nothing clears the 50% threshold', () => {
    expect(bestMatch('完全不相关的标题', '完全不相关的歌手', songs)).toBeUndefined()
  })
})

describe('NeteaseLyricsAdapter', () => {
  it('key 是本家平台前缀 → 直取歌词，不走搜索', async () => {
    const calls: string[] = []
    const fetchStub = (async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ lrc: { lyric: '[00:00.00]x' } }) }
    }) as unknown as typeof fetch
    const a = new NeteaseLyricsAdapter({ fetch: fetchStub })
    expect(await a.fetch({ input: 'netease:123' }, manifest)).toEqual([{ matched: true, songId: '123', lrc: '[00:00.00]x' }])
    expect(calls.every((u) => u.includes('/api/song/lyric'))).toBe(true)
  })

  it('key 是别家平台前缀 → decline（空数组），让给梯子的下一档', async () => {
    const a = new NeteaseLyricsAdapter({ fetch: (async () => { throw new Error('不该发请求') }) as unknown as typeof fetch })
    expect(await a.fetch({ input: 'qqmusic:9' }, manifest)).toEqual([])
  })

  it('key 是 "<title>::<artist>" → 模糊搜再取歌词', async () => {
    const calls: string[] = []
    const fetchStub = (async (url: string) => {
      calls.push(url)
      if (url.includes('/api/search/get')) {
        return { ok: true, json: async () => ({ result: { songs: [{ id: 42, name: '青花瓷', artists: [{ name: '周杰伦' }] }] } }) }
      }
      return { ok: true, json: async () => ({ lrc: { lyric: '[00:00.00]hi' } }) }
    }) as unknown as typeof fetch
    const a = new NeteaseLyricsAdapter({ fetch: fetchStub })
    expect(await a.fetch({ input: '青花瓷::周杰伦' }, manifest)).toEqual([{ matched: true, songId: '42', lrc: '[00:00.00]hi' }])
    expect(calls[0]).toContain('/api/search/get?s=')
    expect(calls[1]).toContain('/api/song/lyric?id=42')
  })

  // decline 那条判据差点把普通歌名吃掉：`Song: Reprise` 是冒号 + 空格，不是平台前缀。
  // 判成 decline 的话它连模糊搜都不走，歌词静默不出。
  it('歌名里带冒号 + 空格（Song: Reprise）→ 走模糊搜，不是 decline', async () => {
    const calls: string[] = []
    const fetchStub = (async (url: string) => {
      calls.push(url)
      if (url.includes('/api/search/get')) {
        return { ok: true, json: async () => ({ result: { songs: [{ id: 7, name: 'Song: Reprise', artists: [{ name: '' }] }] } }) }
      }
      return { ok: true, json: async () => ({ lrc: { lyric: '[00:00.00]r' } }) }
    }) as unknown as typeof fetch
    const a = new NeteaseLyricsAdapter({ fetch: fetchStub })
    expect(await a.fetch({ input: 'Song: Reprise' }, manifest)).toEqual([{ matched: true, songId: '7', lrc: '[00:00.00]r' }])
    expect(calls[0]).toContain('/api/search/get?s=')
  })

  it('没有候选过 50% 的线 → matched:false，不再去取歌词', async () => {
    const calls: string[] = []
    const fetchStub = (async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ result: { songs: [{ id: 1, name: '不相关', artists: [{ name: '不相关' }] }] } }) }
    }) as unknown as typeof fetch
    const a = new NeteaseLyricsAdapter({ fetch: fetchStub })
    expect(await a.fetch({ input: '青花瓷::周杰伦' }, manifest)).toEqual([{ matched: false }])
    expect(calls).toHaveLength(1)
  })

  it('input 为空 → 返回 [{matched:false}]', async () => {
    const a = new NeteaseLyricsAdapter({ fetch: (async () => { throw new Error('不该发请求') }) as unknown as typeof fetch })
    expect(await a.fetch({ input: '' }, manifest)).toEqual([{ matched: false }])
  })
})
