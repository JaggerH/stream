import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { FirecrawlAdapter } from './adapter.ts'
import * as client from './client.ts'

afterEach(() => vi.restoreAllMocks())

const PAGE: client.FirecrawlPage = { markdown: '正文', finalUrl: 'https://e.com/a', creditsUsed: 1 }
const MANIFEST = { id: '@streamapp/firecrawl/article-firecrawl', adapter: 'firecrawl' } as SourceManifest
const noKey = { runtimeConfig: {} }

describe('FirecrawlAdapter', () => {
  it('adapter id 就是 manifest 里写的那个名字', () => {
    expect(new FirecrawlAdapter().id).toBe('firecrawl')
  })

  it('产出归形成行合同 { text }（text 即 markdown），不是裸 FirecrawlPage', async () => {
    vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    // 行合同是 { text }——梯子的分支只读 text。裸交 FirecrawlPage 会让这一档
    // "赢了梯子、分支读 .text 却是 undefined"，正是 fetch-url 事故的形状。
    expect(await new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST, noKey)).toEqual([
      { text: '正文', finalUrl: 'https://e.com/a', creditsUsed: 1 },
    ])
  })

  it('keyless：配置里没有 key 时照常调用，apiKey 传 null', async () => {
    const spy = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    await new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST, noKey)
    expect(spy.mock.calls[0][1]).toMatchObject({ apiKey: null })
    // 没有执行上下文（宿主没给配置）也一样是 keyless，不是崩
    await new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST)
    expect(spy.mock.calls[1][1]).toMatchObject({ apiKey: null })
  })

  // 钥匙是宿主派发的：manifest 的 runtime_config.ref 那一格，宿主在调用前解析好放进
  // context.runtimeConfig。包自己不去任何地方取。
  it('有 key 时用宿主递进来的 runtimeConfig.apiKey', async () => {
    const spy = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    await new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST, { runtimeConfig: { apiKey: 'fc-999' } })
    expect(spy.mock.calls[0][1]).toMatchObject({ apiKey: 'fc-999' })
  })

  // 执行器把 `$input` 洞填进成员 params，引擎又把调用键并进 params——行上写 `{url:'$input'}`，
  // URL 就在 params.url。
  it('URL 从 params.url 取', async () => {
    const spy = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    await new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST, noKey)
    expect(spy.mock.calls[0][0]).toBe('https://e.com/a')
  })

  it('params.baseUrl 透传（自托管留的口子）', async () => {
    const spy = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    await new FirecrawlAdapter().fetch({ url: 'https://e.com/a', baseUrl: 'http://127.0.0.1:3002' }, MANIFEST, noKey)
    expect(spy.mock.calls[0][1]).toMatchObject({ baseUrl: 'http://127.0.0.1:3002' })
  })

  it('输入不是 http(s) URL → decline（[]），不去打网络', async () => {
    const spy = vi.spyOn(client, 'scrapeWithFirecrawl').mockResolvedValue(PAGE)
    const a = new FirecrawlAdapter()
    expect(await a.fetch({}, MANIFEST, noKey)).toEqual([])
    expect(await a.fetch({ url: 'ftp://e.com/a' }, MANIFEST, noKey)).toEqual([])
    expect(await a.fetch({ url: '随便一段文字' }, MANIFEST, noKey)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  // 这条是纪律：抓取失败**必须抛**，不能 decline——decline 的语义是「让位」，不是「试了失败」。
  // 混用会把限流记成弃权，ladder/misses 里就分不出「没轮到」和「试了挂了」，排查方向完全相反。
  it('抓取失败原样抛出，不吞成 decline', async () => {
    vi.spyOn(client, 'scrapeWithFirecrawl').mockRejectedValue(new client.FirecrawlError('rate_limited', 'boom'))
    await expect(new FirecrawlAdapter().fetch({ url: 'https://e.com/a' }, MANIFEST, noKey)).rejects.toMatchObject({
      kind: 'rate_limited',
    })
  })
})
