import { describe, expect, it, vi } from 'vitest'
import { DETAIL_SOURCE, makeDetailEnricher } from './detail.ts'

const PERMALINK = 'https://xueqiu.com/2882140015/402749359'

describe('xueqiu-detail enricher', () => {
  it('跑本包的 detail recipe，拿详情页渲染后的全文，剥掉站方注入的出处前缀', async () => {
    const readSource = vi.fn().mockResolvedValue([
      { id: '402749359', text: '来源：雪球App，作者： 须臾流年，（https://xueqiu.com/2882140015/402749359）大道好，今天与朋友讨论了一个问题…完整正文' },
    ])
    const enrich = makeDetailEnricher({ readSource })[DETAIL_SOURCE]!
    const e = await enrich({ source: DETAIL_SOURCE, permalink: PERMALINK })
    // 裸名：`ctx.readSource` 按本包名限定成全名，包自己不写 npm 前缀
    expect(readSource).toHaveBeenCalledWith(DETAIL_SOURCE, { permalink: PERMALINK }, { signal: undefined })
    expect(e).toEqual({ article: { sourceUrl: PERMALINK, text: '大道好，今天与朋友讨论了一个问题…完整正文' } })
  })

  it('取消信号原样传给 readSource（WS 现取里新点击顶掉旧的靠它）', async () => {
    const readSource = vi.fn().mockResolvedValue([])
    const ac = new AbortController()
    await makeDetailEnricher({ readSource })[DETAIL_SOURCE]!({ permalink: PERMALINK }, ac.signal)
    expect(readSource).toHaveBeenCalledWith(DETAIL_SOURCE, { permalink: PERMALINK }, { signal: ac.signal })
  })

  it('详情条目没有 text → 空富化（调用方留着那段被截断的原帖）', async () => {
    const readSource = vi.fn().mockResolvedValue([{ id: '1' }])
    expect(await makeDetailEnricher({ readSource })[DETAIL_SOURCE]!({ permalink: 'https://xueqiu.com/1/1' })).toEqual({})
  })

  // recipe 会把本站 facility 的真标签页导航到这个地址——客户端给的任意 URL 绝不能放过去。
  it.each([
    ['缺 permalink', {}],
    ['别的站', { permalink: 'https://evil.example.com/1/1' }],
    ['http 不是 https', { permalink: 'http://xueqiu.com/1/1' }],
    ['前缀伪装', { permalink: 'https://xueqiu.com.evil.example/1/1' }],
  ])('%s → ValidationError，不跑 recipe', async (_label, query) => {
    const readSource = vi.fn()
    await expect(makeDetailEnricher({ readSource })[DETAIL_SOURCE]!(query as Record<string, string>)).rejects.toMatchObject({
      name: 'ValidationError',
    })
    expect(readSource).not.toHaveBeenCalled()
  })
})
