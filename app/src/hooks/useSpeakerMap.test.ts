import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSpeakerMap } from './useSpeakerMap.ts'
import { api } from '../lib/api.ts'

const BLOCKS = [
  { start: 0, end: 100, label: '林简七' },
  { start: 100, end: 200, label: 'SPEAKER_03' },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api.voiceprint, 'blocks').mockResolvedValue(BLOCKS)
})

describe('useSpeakerMap', () => {
  it('fetches the item blocks at the 30s floor and starts unfiltered', async () => {
    const { result } = renderHook(() => useSpeakerMap('tmdb:1:S03E02'))
    await waitFor(() => expect(result.current.blocks).toEqual(BLOCKS))
    expect(result.current.activeSpeakers).toBeNull() // null = show everyone, don't skip
    // 120s 曾把真实说话人整个筛没:徐不弃在 S03E02 说了 310s,拆成 74/84/77 三段,一段都够不到 120。
    expect(api.voiceprint.blocks).toHaveBeenCalledWith(expect.anything(), 'tmdb:1:S03E02', { minSeconds: 30 })
  })

  it('clears blocks and skips fetching when there is no item', async () => {
    const { result } = renderHook(() => useSpeakerMap(null))
    await waitFor(() => expect(result.current.blocks).toEqual([]))
    expect(api.voiceprint.blocks).not.toHaveBeenCalled()
  })

  it('toggle adds then removes a label, collapsing an empty set back to null', async () => {
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    act(() => result.current.toggleSpeaker('林简七'))
    expect(result.current.activeSpeakers).toEqual(['林简七'])
    act(() => result.current.toggleSpeaker('林简七'))
    expect(result.current.activeSpeakers).toBeNull() // back to "no filter", not an empty array
  })

  it('solo replaces the whole selection with one label', async () => {
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    act(() => result.current.toggleSpeaker('SPEAKER_03'))
    act(() => result.current.soloSpeaker('林简七'))
    expect(result.current.activeSpeakers).toEqual(['林简七'])
  })

  it('drops the selection when the item changes (a filter must not leak across episodes)', async () => {
    const { result, rerender } = renderHook(({ id }) => useSpeakerMap(id), {
      initialProps: { id: 'ep1' as string | null },
    })
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    act(() => result.current.soloSpeaker('林简七'))
    expect(result.current.activeSpeakers).toEqual(['林简七'])
    rerender({ id: 'ep2' })
    await waitFor(() => expect(result.current.activeSpeakers).toBeNull())
  })

  it('groups blocks by person, longest talker first', async () => {
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    expect(result.current.people).toEqual([
      { label: '林简七', seconds: 100, blocks: [BLOCKS[0]] },
      { label: 'SPEAKER_03', seconds: 100, blocks: [BLOCKS[1]] },
    ])
  })
})

// 名单（这一集有谁）来自 /clusters 的**真实总时长**,不是「有没有超长发言块」。
// 这一集真有 12 个人说话,却因为块下限只列出 3 个——「谁在说话」不该是「谁有超长独白」。
describe('useSpeakerMap — 名单按簇的总时长出', () => {
  const CLUSTERS = [
    { cluster: '林简七', seconds: 799, sampleAt: 0, personName: '林简七' },
    { cluster: 'SPEAKER_17', seconds: 310, sampleAt: 600 }, // 块全 <120s,旧口径整个人消失
    { cluster: 'SPEAKER_03', seconds: 402, sampleAt: 100 },
    { cluster: 'SPEAKER_25', seconds: 1, sampleAt: 1600 },  // 碎渣
  ]

  it('列出总时长够的人(哪怕他没有一个长块),按总时长排序', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockResolvedValue(CLUSTERS)
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.people.map((p) => p.label)).toEqual(['林简七', 'SPEAKER_03', 'SPEAKER_17']))
    expect(result.current.people.map((p) => p.seconds)).toEqual([799, 402, 310])
    // 有块的人照常挂上自己的块(时间轴要用);没块的人是空数组,不是崩
    expect(result.current.people[2].blocks).toEqual([])
    expect(result.current.people[1].blocks).toEqual([BLOCKS[1]])
  })

  it('碎渣簇(1-2 秒)不进名单', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockResolvedValue(CLUSTERS)
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.people).toHaveLength(3))
    expect(result.current.people.some((p) => p.label === 'SPEAKER_25')).toBe(false)
  })

  it('带待确认的簇无条件进名单——问了就必须答得上', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockResolvedValue([
      ...CLUSTERS,
      { cluster: 'SPEAKER_31', seconds: 4, sampleAt: 30, pending: { name: '余仔', evidence: '我是余仔' } },
    ])
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.people.map((p) => p.label)).toContain('SPEAKER_31'))
  })

  it('簇信息拿不到(声纹库 503)时退回按块聚合,面板不至于空白', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockRejectedValue(new Error('503'))
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.people.map((p) => p.label)).toEqual(['林简七', 'SPEAKER_03']))
    expect(result.current.people[0].seconds).toBe(100) // 块口径
  })
})

describe('useSpeakerMap — 待确认的抽名', () => {
  it('把 /clusters 上的 pending 按 label 摊平出来给面板用', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockResolvedValue([
      { cluster: '林简七', seconds: 100, sampleAt: 0, personName: '林简七' },
      { cluster: 'SPEAKER_03', seconds: 100, sampleAt: 100, pending: { name: '多多', evidence: '大家好我叫多多' } },
    ])
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() =>
      expect(result.current.pending).toEqual({ SPEAKER_03: { name: '多多', evidence: '大家好我叫多多' } })
    )
  })

  it('声纹库 503 / 没有待确认时是空对象，不是 undefined', async () => {
    vi.spyOn(api.voiceprint, 'listClusters').mockRejectedValue(new Error('503'))
    const { result } = renderHook(() => useSpeakerMap('ep'))
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    expect(result.current.pending).toEqual({})
  })
})

describe('useSpeakerMap — solo for an item that is not active yet', () => {
  it('honors an explicit forItemId so the selection survives the switch to that item', async () => {
    const { result, rerender } = renderHook(({ id }) => useSpeakerMap(id), {
      initialProps: { id: 'ep1' as string | null },
    })
    await waitFor(() => expect(result.current.blocks).toHaveLength(2))
    // 「只看TA」on an item that is about to become active — activeVideo hasn't switched yet
    act(() => result.current.soloSpeaker('林简七', 'ep2'))
    expect(result.current.activeSpeakers).toBeNull() // not ep1's selection
    rerender({ id: 'ep2' })
    await waitFor(() => expect(result.current.activeSpeakers).toEqual(['林简七']))
  })
})
