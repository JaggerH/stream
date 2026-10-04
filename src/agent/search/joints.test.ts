// src/agent/search/joints.test.ts
import { describe, it, expect, vi } from 'vitest'
import { classifyHits, proposeQueries, extractJson, netdiskOf, hubKindOf } from './joints.ts'
import { netdiskDomain, scoreTopicality } from './domains/netdisk.ts'

// 关节自己的用例照旧用网盘口径（它们验的是解析与判定，不是提示词内容）。
const FRAMING = netdiskDomain({}).framing
import type { ChatResult } from '../../llm/client.ts'
import type { NetdiskHit, WebHit } from './types.ts'

const reply = (content: string | null): ChatResult => ({ content, raw: {} })
const hit = (over: Partial<NetdiskHit>): NetdiskHit => ({ link: 'l', netdisk: 'quark', sourceId: 'pansou', ...over })

describe('extractJson', () => {
  it('parses a fenced json array', () => {
    expect(extractJson('```json\n[{"i":0,"score":3}]\n```')).toEqual([{ i: 0, score: 3 }])
  })
  it('parses a bare array embedded in prose', () => {
    expect(extractJson('这是结果： [1,2,3] 完毕')).toEqual([1, 2, 3])
  })
  it('returns null on garbage', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson(null)).toBeNull()
  })
})

describe('scoreTopicality', () => {
  it('maps scores onto hits by index and calls the LLM once', async () => {
    const chat = vi.fn(async () => reply('[{"i":0,"score":3},{"i":1,"score":1}]'))
    const out = await scoreTopicality('怡楽播客', [hit({ title: 'A' }), hit({ title: 'B' })], chat)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(out.map((h) => h.topicality)).toEqual([3, 1])
  })
  it('missing or malformed → topicality 0, hit kept (sink not drop)', async () => {
    const chat = vi.fn(async () => reply('garbage'))
    const out = await scoreTopicality('g', [hit({ title: 'A' })], chat)
    expect(out).toHaveLength(1)
    expect(out[0].topicality).toBe(0)
  })
  it('empty hits → no LLM call', async () => {
    const chat = vi.fn(async () => reply('[]'))
    const out = await scoreTopicality('g', [], chat)
    expect(out).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })
})

describe('netdiskOf / hubKindOf', () => {
  it('recognizes netdisk share domains', () => {
    expect(netdiskOf('https://pan.quark.cn/s/abc')).toBe('quark')
    expect(netdiskOf('https://pan.baidu.com/s/x')).toBe('baidu')
    expect(netdiskOf('https://www.xiaoyuzhoufm.com/podcast/1')).toBe('')
  })
  it('classifies hub kinds by domain', () => {
    expect(hubKindOf('https://t.me/fulibas/4401')).toBe('telegram')
    expect(hubKindOf('https://cn.tgstat.com/channel/@fulibas/4401')).toBe('telegram')
    expect(hubKindOf('https://linux.do/t/topic/1166006')).toBe('community')
    expect(hubKindOf('https://fuliba2023.net/bkhj.html')).toBe('community') // known netdisk-resource hub
    expect(hubKindOf('https://random-blog.example/x')).toBe('site')
  })
})

const web = (over: Partial<WebHit>): WebHit => ({ title: 't', url: 'https://example.com', ...over })

describe('classifyHits', () => {
  it('pulls direct netdisk links (trusting the url over the label) and collects hubs + vocab', async () => {
    const hits: WebHit[] = [
      web({ title: '怡楽 合集', url: 'https://pan.quark.cn/s/abc' }), // netdisk by url
      web({ title: '福利吧', url: 'https://cn.tgstat.com/channel/@fulibas/4401' }), // hub
      web({ title: '小宇宙', url: 'https://www.xiaoyuzhoufm.com/podcast/1' }), // noise
    ]
    const chat = vi.fn(async () =>
      reply('{"items":[{"i":0,"kind":"netdisk"},{"i":1,"kind":"hub"},{"i":2,"kind":"noise"}],"vocab":["付费合集","福利吧"]}')
    )
    const out = await classifyHits('怡楽播客', hits, chat, FRAMING)
    expect(out.directLinks).toHaveLength(1)
    expect(out.directLinks[0]).toMatchObject({ netdisk: 'quark', sourceId: 'web-search' })
    expect(out.hubs).toHaveLength(1)
    expect(out.hubs[0]).toMatchObject({ kind: 'telegram' })
    expect(out.vocab).toEqual(['付费合集', '福利吧'])
  })

  it('a hub whose url is actually a netdisk link becomes a direct link, not a hub', async () => {
    const hits = [web({ url: 'https://pan.quark.cn/s/z' })]
    const chat = vi.fn(async () => reply('{"items":[{"i":0,"kind":"hub"}],"vocab":[]}'))
    const out = await classifyHits('g', hits, chat, FRAMING)
    expect(out.directLinks).toHaveLength(1)
    expect(out.hubs).toHaveLength(0)
  })

  it('empty hits → no LLM call; parse failure → all noise', async () => {
    const noCall = vi.fn(async () => reply('{}'))
    expect(await classifyHits('g', [], noCall, FRAMING)).toEqual({ directLinks: [], hubs: [], vocab: [] })
    expect(noCall).not.toHaveBeenCalled()
    const garbage = vi.fn(async () => reply('sorry'))
    const out = await classifyHits('g', [web({ url: 'https://example.com/x' })], garbage, FRAMING)
    expect(out).toEqual({ directLinks: [], hubs: [], vocab: [] })
  })
})

describe('proposeQueries', () => {
  it('returns the query array and drops already-tried ones', async () => {
    const chat = vi.fn(async () => reply('["怡乐播客 网盘","付费播客 网盘 合集","怡乐播客 网盘"]'))
    const out = await proposeQueries('怡楽播客', ['怡乐播客 网盘'], ['付费合集'], ['网盘'], chat, FRAMING)
    expect(out).toEqual(['付费播客 网盘 合集']) // first + third deduped/tried-filtered
  })
  it('parse failure → empty array', async () => {
    const chat = vi.fn(async () => reply('nope'))
    expect(await proposeQueries('g', [], [], ['网盘'], chat, FRAMING)).toEqual([])
  })
})
