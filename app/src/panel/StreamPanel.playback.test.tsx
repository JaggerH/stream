// 面板里的播放**真的接到了舞台上**。
//
// 这条守卫就是这次任务本身：面板此前挂的是一份显式的空舞台，点播放什么都不会发生，
// 而**没有任何一处会喊**——按钮画得出来、点得动、没有报错。所以判据只看**副作用**：
// 那个全局 `<audio>` 的 src 有没有真的换成这一条的地址。断言"渲染出了播放按钮"是不够的，
// 空舞台年代按钮也在（那时甚至连按钮都没有——音频舞台缺席时 onAudioActivate 是 undefined，
// 所以这条用例在回退到空舞台时会以"找不到播放键"变红，同样有牙）。
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { StreamPanel } from './StreamPanel.tsx'
import { api } from '../lib/api.ts'
import type { Item } from '../lib/types.ts'

beforeEach(() => {
  vi.spyOn(api, 'enrich').mockResolvedValue({ comments: [], total: 0 })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

/** 一条播客单集：直链音频、没有平台 track 引用 → toTrack 直接拿 media.url 当可播地址。 */
function episode(id: string, title: string, url: string): Item {
  return {
    id,
    stream_id: 'panel-podcast',
    type: 'post',
    title,
    author: '某播客',
    url: `https://example.com/${id}`,
    content: {
      archetype: 'audio',
      media: [{ kind: 'audio', url, duration_s: 1800 }],
    },
    timestamp: '2026-08-17T00:00:00Z',
    fetched_at: '2026-08-17T00:00:00Z',
  } as Item
}

test('点面板里一条播客的播放键 → 那一页的 <audio> 真的装上了它', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({
    items: [
      episode('ep1', '第一期', 'https://cdn.example.com/ep1.mp3'),
      episode('ep2', '第二期', 'https://cdn.example.com/ep2.mp3'),
    ],
  })
  const { container } = render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第一期')).toBeTruthy())

  // 起手是空的：舞台在，但还没人点。
  expect(container.querySelector('audio')?.getAttribute('src')).toBeFalsy()

  fireEvent.click(screen.getAllByLabelText('播放')[0])

  await waitFor(() =>
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('https://cdn.example.com/ep1.mp3')
  )
})

test('起播的是队列不是单条——后面那几期排在它后面（自动续播才有得走）', async () => {
  vi.spyOn(api, 'channelItems').mockResolvedValue({
    items: [
      episode('ep1', '第一期', 'https://cdn.example.com/ep1.mp3'),
      episode('ep2', '第二期', 'https://cdn.example.com/ep2.mp3'),
    ],
  })
  const { container } = render(<StreamPanel />)
  await waitFor(() => expect(screen.getByText('第二期')).toBeTruthy())

  fireEvent.click(screen.getAllByLabelText('播放')[0])
  const audio = container.querySelector('audio')!
  await waitFor(() => expect(audio.getAttribute('src')).toBe('https://cdn.example.com/ep1.mp3'))

  // 第一期播完 → 自动落到第二期。只有"生产者把整批按列表顺序排进了队列"时这一步才成立；
  // 接成单条播放（stage.play(track)）时队列里只有它自己，这里会当场变红。
  fireEvent.ended(audio)
  await waitFor(() => expect(audio.getAttribute('src')).toBe('https://cdn.example.com/ep2.mp3'))
})
