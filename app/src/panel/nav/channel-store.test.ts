/**
 * 频道/空间名录的模块级 store。
 *
 * 钉的是"两个 React root 共读同一份真相"这件事的三个前提：名录到货后快照里两样都在、
 * 一次取数失败不把另一样一起吞掉、以及 setActive 只受理名录里画得出来的那些 id
 * （第二道闸——导航把不支持的灰掉是第一道）。
 */
import { beforeEach, expect, test, vi } from 'vitest'
import { channelStore } from './channel-store.ts'
import { api } from '../../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView, type SpaceView } from '../../lib/types.ts'

function channel(id: string, label: string, present: ChannelView['present']): ChannelView {
  return { id, label, present, system: false, kind: 'timeline', streams: [], space_id: 'default-space' } as ChannelView
}

const CHANNELS = [
  channel(DEFAULT_TIMELINE_CHANNEL_ID, '时间线', 'timeline'),
  channel('reading', '阅读', 'timeline'),
  channel('search', '资源搜索', 'search'),
]
const SPACES: SpaceView[] = [
  { id: 'space-研究', label: '研究', position: 2 },
  { id: 'default-space', label: 'Default', position: 1, system: true },
]

beforeEach(() => {
  channelStore.reset()
  vi.restoreAllMocks()
})

test('load() 之后快照里频道与空间都在，空间按 position 排', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  await channelStore.load()
  const s = channelStore.getSnapshot()
  expect(s.channels.map((c) => c.id)).toEqual([DEFAULT_TIMELINE_CHANNEL_ID, 'reading', 'search'])
  expect(s.spaces.map((x) => x.id)).toEqual(['default-space', 'space-研究'])
  expect(s.loaded).toBe(true)
})

// 两条独立的 catch：空间读不到只该让导航少一层分组，不该把频道名录一起吞掉。
test('空间拉不到时频道照样到货', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockRejectedValue(new Error('空间挂了'))
  await channelStore.load()
  expect(channelStore.getSnapshot().channels.length).toBe(3)
  expect(channelStore.getSnapshot().spaces).toEqual([])
})

// 名录整个拉不到时保留上一份：闪一次空名录会让导航整棵树消失又回来。
test('取数失败保留旧值', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  await channelStore.load()
  vi.spyOn(api, 'channels').mockRejectedValue(new Error('名录挂了'))
  vi.spyOn(api, 'spaces').mockRejectedValue(new Error('空间挂了'))
  await channelStore.load()
  expect(channelStore.getSnapshot().channels.length).toBe(3)
  expect(channelStore.getSnapshot().spaces.length).toBe(2)
})

test('setActive 认识的 id 生效并叫醒订阅者', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  await channelStore.load()
  const seen = vi.fn()
  const stop = channelStore.subscribe(seen)
  channelStore.setActive('reading')
  expect(channelStore.getSnapshot().active).toBe('reading')
  expect(seen).toHaveBeenCalled()
  stop()
})

test('setActive 不认识的 id 静默不动', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  await channelStore.load()
  channelStore.setActive('unknown')
  expect(channelStore.getSnapshot().active).toBe(DEFAULT_TIMELINE_CHANNEL_ID)
})

// 第二道闸：外面递来一个面板画不了的频道 id，静默不动比切进坏页诚实。
test('setActive 不受理面板伺候不了的频道', async () => {
  vi.spyOn(api, 'channels').mockResolvedValue(CHANNELS)
  vi.spyOn(api, 'spaces').mockResolvedValue(SPACES)
  await channelStore.load()
  channelStore.setActive('search')
  expect(channelStore.getSnapshot().active).toBe(DEFAULT_TIMELINE_CHANNEL_ID)
})

// getSnapshot 的引用必须只在真变了时才换——useSyncExternalStore 每次渲染都调它，
// 每次给个新对象就是无限重渲染。
test('没有变化时快照引用不变', () => {
  const first = channelStore.getSnapshot()
  channelStore.setActive('unknown')
  expect(channelStore.getSnapshot()).toBe(first)
})

test('attention：setAttention 换引用；同一份内容再 set 不换引用（useSyncExternalStore 的前提）', () => {
  const before = channelStore.getSnapshot()
  expect(before.attention.size).toBe(0)
  channelStore.setAttention(['c1', 'c2'])
  const after = channelStore.getSnapshot()
  expect(after).not.toBe(before)
  expect([...after.attention].sort()).toEqual(['c1', 'c2'])
  channelStore.setAttention(['c2', 'c1'])
  expect(channelStore.getSnapshot()).toBe(after)
})
