import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import {
  seasonsToPickerEpisodes,
  itemsToPickerEpisodes,
  EpisodePickerPanel,
  PlayerRightPanel,
  playerRightPanelHasContent,
} from './MovieChannel.tsx'
import type { SeasonGroup, Item } from '../lib/types.ts'
import type { useSpeakerMap } from '../hooks/useSpeakerMap.ts'

// 选集面板:播放时不用退出去就能切季/切集。数据两种形状——TMDb 分季(SeasonGroup[])与本地采集
// 条目(Item[])——都摊平成同一个 PickerEpisode,面板照它渲染、点了原地换源。

const SEASONS: SeasonGroup[] = [
  {
    season: 1,
    episodes: [
      { season: 1, episode: 1, title: '第一集', leftKey: 'tmdb:1:S01E01', playable: true, still: '/s1e1.jpg' },
      { season: 1, episode: 2, title: '第二集', leftKey: 'tmdb:1:S01E02', playable: false }, // 没配上文件
    ],
  },
  {
    season: 2,
    episodes: [{ season: 2, episode: 1, title: '二季首集', leftKey: 'tmdb:1:S02E01', playable: true, still: '/s2e1.jpg' }],
  },
]

describe('seasonsToPickerEpisodes — TMDb 分季摊平', () => {
  it('可播的集带上 resolve media + leftKey,不可播的 media 为空', () => {
    const eps = seasonsToPickerEpisodes(SEASONS, 'http://x')
    expect(eps).toHaveLength(3)
    const e1 = eps[0]
    expect(e1.key).toBe('tmdb:1:S01E01')
    expect(e1.season).toBe(1)
    expect(e1.playable).toBe(true)
    expect(e1.media).toEqual({ kind: 'video', url: '/api/media/videos/resolve?key=tmdb%3A1%3AS01E01', resolveOnly: true })
    expect(eps[1].playable).toBe(false)
    expect(eps[1].media).toBeUndefined()
  })
})

describe('itemsToPickerEpisodes — 本地采集条目摊平', () => {
  it('有 resolveOnly video 的可播,key=item id', () => {
    const items: Item[] = [
      {
        id: 'itm-1', title: 'EP1', source: 's', channel: 'video', season: 1,
        content: { media: [{ kind: 'video', url: 'u', resolveOnly: true }] },
      } as unknown as Item,
      { id: 'itm-2', title: 'EP2', source: 's', channel: 'video', season: 1, content: {} } as unknown as Item,
    ]
    const eps = itemsToPickerEpisodes(items, 'http://x')
    expect(eps[0].key).toBe('itm-1')
    expect(eps[0].playable).toBe(true)
    expect(eps[1].playable).toBe(false)
  })
})

describe('EpisodePickerPanel — 渲染 + 交互', () => {
  it('列出集;点可播的集调 onPick;当前集高亮;不可播的点不动', () => {
    const onPick = vi.fn()
    const eps = seasonsToPickerEpisodes(SEASONS, 'http://x')
    render(<EpisodePickerPanel episodes={eps} currentKey="tmdb:1:S01E01" onPick={onPick} />)

    // 默认停在当前在播那一集所属的季(S01),当前集标出「在播」
    expect(screen.getByText('第一集').closest('[data-current="true"]')).toBeTruthy()

    // 点不可播的集不触发(第二集在 S01,可见)
    fireEvent.click(screen.getByText('第二集'))
    expect(onPick).toHaveBeenCalledTimes(0)

    // 切到第二季 → 点二季首集(可播)→ onPick 带上它
    fireEvent.click(screen.getByRole('button', { name: '第 2 季' }))
    fireEvent.click(screen.getByText('二季首集'))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].key).toBe('tmdb:1:S02E01')
  })
})

function fakeMap(): ReturnType<typeof useSpeakerMap> {
  return {
    blocks: [], people: [], activeSpeakers: null, toggleSpeaker: vi.fn(), soloSpeaker: vi.fn(),
    refresh: vi.fn(), names: {}, unnamed: new Set(), pending: {},
  }
}

// 说话人那半现在关着(MovieChannel.tsx 的 SPEAKER_PANEL_ENABLED)。这一栏于是只剩选集:
// 多集 → 直接就是选集面板、没有分段切换(只能选自己的切换器是噪音);无分集 → 整栏不画。
// SpeakerSegmentPanel 自己的行为仍由 MovieChannel.speaker-panel.test.tsx 钉着——组件没删,
// 开关翻回 true 那些用例就还在原地等着。
describe('PlayerRightPanel — 说话人关掉后只剩选集', () => {
  const common = { itemId: 'tmdb:1:S01E01', map: fakeMap(), onSeek: vi.fn(), currentTime: 0, duration: 100 }

  it('多集 → 直接画选集,不出分段切换、不出说话人', () => {
    const eps = seasonsToPickerEpisodes(SEASONS, 'http://x')
    render(<PlayerRightPanel {...common} episodes={eps} onPickEpisode={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '选集' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: '识别发言人' })).toBeNull()
    expect(screen.queryByText('谁在说话')).toBeNull()
  })

  it('点某集照常换源(选集这条线没被这次隐藏碰到)', () => {
    const onPick = vi.fn()
    const eps = seasonsToPickerEpisodes(SEASONS, 'http://x')
    render(<PlayerRightPanel {...common} episodes={eps} onPickEpisode={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: '第 2 季' }))
    fireEvent.click(screen.getByText('二季首集'))
    expect(onPick.mock.calls[0][0].key).toBe('tmdb:1:S02E01')
  })

  it('单集/无分集 → 这一栏什么都不画', () => {
    const { container } = render(<PlayerRightPanel {...common} episodes={[]} onPickEpisode={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })
})

// DetailShell 靠 `panel` 是不是空来决定留不留那一列——判据必须在给它元素**之前**算完,
// 否则「渲染出来是 null」的面板会换来一条空白栏。
describe('playerRightPanelHasContent — 该不该留出右侧那一列', () => {
  it('没有身份 → 没有', () => {
    expect(playerRightPanelHasContent(undefined, seasonsToPickerEpisodes(SEASONS, 'http://x'), vi.fn())).toBe(false)
  })
  it('多集 → 有(选集)', () => {
    expect(playerRightPanelHasContent('k', seasonsToPickerEpisodes(SEASONS, 'http://x'), vi.fn())).toBe(true)
  })
  it('单集 → 没有(说话人关着,这一栏空了)', () => {
    expect(playerRightPanelHasContent('k', [], vi.fn())).toBe(false)
    expect(playerRightPanelHasContent('k')).toBe(false)
  })
})
