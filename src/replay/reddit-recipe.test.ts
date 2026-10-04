import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { mapItem } from './interpret.ts'
import { makeStreamItem } from '../stream-pipeline.ts'
import { defaultNormalizer } from '../content/normalize.ts'

// reddit hot.json 单条 Listing child 的真实形状（2026-08-06 用户 Chrome 页内重放侦察所得）
const child = {
  kind: 't3',
  data: {
    id: '1abcdef',
    title: 'Quarter 2 Update - Revisiting Rules. Again.',
    permalink: '/r/selfhosted/comments/1abcdef/quarter_2_update_revisiting_rules_again/',
    author: 'selfhosted_mod',
    score: 1842,
    num_comments: 137,
    created_utc: 1785685150,
    selftext: 'We are revisiting the rules for Q2. Please read.',
  },
}

// 读真 recipe，不抄一份 mapping 副本进来。抄副本的测试只证明「我抄的这份是对的」，
// recipe 本身写错了它照样绿——这条测试以前就是这么漏掉正文映射错键的。
const recipe = JSON.parse(
  readFileSync(new URL('../../packages/reddit/reddit-sub.recipe.json', import.meta.url), 'utf8')
) as { mapping: Record<string, string> }

describe('reddit-sub mapping', () => {
  it('maps a Listing child to a DataItem', () => {
    const item = mapItem(child, recipe.mapping)
    expect(item.guid).toBe('1abcdef')
    expect(item.title).toBe('Quarter 2 Update - Revisiting Rules. Again.')
    expect(item.link).toBe(
      'https://www.reddit.com/r/selfhosted/comments/1abcdef/quarter_2_update_revisiting_rules_again/'
    )
    expect(item.author).toBe('selfhosted_mod')
    expect(item.like_count).toBe(1842)
    expect(item.comment_count).toBe(137)
    expect(item.pubDate).toBe(1785685150)
  })

  // 追到另一端：mapping 的产物有两个下游，两个都只认 description 这个键——
  // 归一化（stream-pipeline 的 body_text）和内容层（normalize.ts 的 content.text）。
  // selftext 落在别的键上不会有任何一处报错，只是正文静默变成空串，
  // agent 上下文、摘要、写盘、同质内容归堆全都跟着空。
  it('selftext 一路活到两个下游，而不是停在一个没人读的键上', () => {
    const mapped = mapItem(child, recipe.mapping)
    const expected = 'We are revisiting the rules for Q2. Please read.'
    expect(makeStreamItem('s1', '/reddit/sub/selfhosted', mapped).body_text).toBe(expected)
    expect(defaultNormalizer(mapped as never, {} as never).text).toBe(expected)
  })
})
