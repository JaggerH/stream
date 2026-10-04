import { describe, it, expect } from 'vitest'
import { makeArticleFetchDep, type ArticleFetchInvoker } from './article-fetch-dep.ts'
import type { InvokeResult } from '../../providers/executor.ts'

// makeArticleFetchDep 是 article 分支 `fetch` dep 的真实实现——把 `article-extract` 行一次
// invoke 的结果翻译成 `{ text?, ladder }`。这几条用例对应文档里的判据：
//  1) 两档都干净 decline（Defuddle 认不出正文结构、Firecrawl 没配/没跑）→ text 缺失但不抛错，
//     上层（extract.ts）落成「抓到了页面，但没有可用正文」——此时这句话是真的。
//  2) 有成员真的失败（如 Firecrawl 抛 rate_limited，miss 带 stack）→ 必须抛出真实原因，
//     不能被抹平成和情况 1 一样的"没有 text"，那会让限流被说成假话。
//  3) 正常取到正文不能回归。
const fakeInvoker = (invoke: ArticleFetchInvoker['invoke']): ArticleFetchInvoker => ({ invoke })

describe('makeArticleFetchDep', () => {
  it('两档都干净 decline → text 缺失、不抛错（上层落成"没有可用正文"，这句话是真的）', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'article-extract', value: null, via: null,
      misses: [
        { member: 'article-defuddle', reason: 'declined (no result)' },
        { member: 'article-firecrawl', reason: 'declined (no result)' },
      ],
      timings: [],
    }
    const fetch = makeArticleFetchDep(fakeInvoker(async () => res))
    const got = await fetch('https://example.com/a')
    expect(got.text).toBeUndefined()
  })

  // 修复前：`fetch` 直接把 `won?.text` 原样返回，不看 misses 有没有真失败——Firecrawl 429
  // 限流被和"两档都 decline"共用同一句"没有可用正文"。这条用例在修复前是红的：
  // fetch() 会 resolve({ text: undefined, ... }) 而不是 reject。
  it('Firecrawl 抛 rate_limited（miss 带 stack）→ 抛出限流原因，不是"没有可用正文"', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'article-extract', value: null, via: null,
      misses: [
        { member: 'article-defuddle', reason: 'declined (no result)' },
        {
          member: 'article-firecrawl',
          reason: 'HTTP 429 —— 限流或额度耗尽',
          stack: 'Error: rate_limited\n    at x',
        },
      ],
      timings: [],
    }
    const fetch = makeArticleFetchDep(fakeInvoker(async () => res))
    await expect(fetch('https://example.com/a')).rejects.toThrow(/限流或额度耗尽/)
    await expect(fetch('https://example.com/a')).rejects.not.toThrow(/没有可用正文/)
  })

  it('取到正文 → 返回 text（不能回归）', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'article-extract', value: { text: '网页正文' }, via: 'article-defuddle',
      misses: [],
      timings: [],
    }
    const fetch = makeArticleFetchDep(fakeInvoker(async () => res))
    const got = await fetch('https://example.com/a')
    expect(got.text).toBe('网页正文')
  })

  it('梯子走法（ladder）原样带出——即便真失败也要带出走法（失败恰恰最需要它）', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'article-extract', value: null, via: null,
      misses: [{ member: 'article-firecrawl', reason: 'boom', stack: 'Error: boom' }],
      timings: [{ member: 'article-firecrawl', source: 'article-firecrawl', ms: 5, outcome: 'error' }],
    }
    const fetch = makeArticleFetchDep(fakeInvoker(async () => res))
    try {
      await fetch('https://example.com/a')
      throw new Error('应该抛错但没抛')
    } catch (e) {
      expect((e as { ladder?: unknown }).ladder).toEqual({
        via: null,
        rungs: [{ member: 'article-firecrawl', source: 'article-firecrawl', ms: 5, outcome: 'error', reason: 'boom' }],
      })
    }
  })
})
