/**
 * 「用户此刻在看哪条」跨 bundle 推给壳的那条通路（对话输入框的 `@` 引用候选就吃它）。
 *
 * 这条通路的失败方式是**安静的**：不推、推空、或推的是没截断的整篇，都不会有任何一处
 * 报错，只表现成"打 @ 没候选"或"模型拿半截当全文"。所以这里既钉投影本身（toItemRef），
 * 也钉面板确实推了。
 */
import { render, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { EXCERPT_LIMIT, toItemRef, type PanelItemContextState } from './itemRef.ts'
import { api } from '../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type Item } from '../lib/types.ts'

beforeEach(() => {
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
})

function item(id: string, title: string, over: Partial<Item> = {}): Item {
  return {
    id,
    stream_id: 'panel-test',
    type: 'post',
    title,
    url: `https://example.com/${id}`,
    timestamp: '2026-08-17T00:00:00Z',
    fetched_at: '2026-08-17T00:00:00Z',
    published_at: '2026-08-17T00:00:00Z',
    ...over,
  } as Item
}

const CHANNELS: ChannelView[] = [
  { id: DEFAULT_TIMELINE_CHANNEL_ID, label: '时间线', present: 'timeline', space_id: 'default-space', system: true, kind: 'timeline', streams: [] } as ChannelView,
]

test('投影：正文取 content.text，超长截断并标记', () => {
  const long = 'x'.repeat(EXCERPT_LIMIT + 50)
  const ref = toItemRef(item('a', '标题', { content: { archetype: 'text', text: long }, author: '作者' }))
  expect(ref.excerpt).toHaveLength(EXCERPT_LIMIT)
  expect(ref.truncated).toBe(true)
  expect(ref.author).toBe('作者')
  expect(ref.streamId).toBe('panel-test')
})

test('投影：不超长就不打截断标记——凭空说"截断了"会诱导模型多跑一次 extract', () => {
  const ref = toItemRef(item('a', '标题', { body_text: '短正文' }))
  expect(ref.excerpt).toBe('短正文')
  expect(ref.truncated).toBeUndefined()
})

test('投影：空白正文当作没有正文，别推一个只有空格的 excerpt', () => {
  expect(toItemRef(item('a', '标题', { body_text: '   ' })).excerpt).toBeUndefined()
})

test('面板把当前这一批推出去；`open` 在没开详情时是 null', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'channelItems').mockResolvedValue({ items: [item('a', '第一条'), item('b', '第二条')] })
  const states: PanelItemContextState[] = []
  render(<StreamPanel onItemContext={(s) => states.push(s)} />)

  await waitFor(() => expect(states.at(-1)?.recent).toHaveLength(2))
  const last = states.at(-1)!
  expect(last.recent.map((r) => r.id)).toEqual(['a', 'b'])
  expect(last.open).toBeNull()
  // 没开详情、也没在看片：主区没被占满，壳据此把对话列留着。
  expect(last.fullscreen).toBe(false)
})
