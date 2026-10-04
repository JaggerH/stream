import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueueSheet } from './QueueSheet.tsx'
import { AudioStageContext, type AudioStage } from '../lib/audioStage.ts'
import { toTrack } from '../lib/audioTrack.ts'
import type { Item } from '../lib/types.ts'

// 这条测的是**整条链**，不是某一个函数：源站原图 → toTrack → 队列面板真渲染出来的那个 `<img src>`。
// 之所以要端到端地钉一次：`AudioTrack.poster` 的契约（展示就绪）只有产出端在守，而消费端
// 一旦改成"自己从别处再取一次原始地址"就会静默地绕开代理——防盗链图床返回一张空白图，
// 不报错、不降级、控制台一个字都没有。单测产出端抓不到那种回退。
const BASE = 'http://127.0.0.1:8900'
const COVER = 'https://p2.music.126.net/cover.jpg'
const PROXIED = `${BASE}/api/media/image?url=${encodeURIComponent(COVER)}`

const item: Item = {
  id: 'itm1',
  stream_id: 's1',
  type: 'post',
  title: '某首歌',
  content: { archetype: 'audio', media: [{ kind: 'audio', platform: 'netease', track_id: '186016', poster: COVER }] },
  timestamp: '2026-08-18T00:00:00.000Z',
  fetched_at: '2026-08-18T00:00:00.000Z',
}

function stageWith(): AudioStage {
  const track = toTrack(item, BASE)!
  return {
    current: track, playing: false, duration: 0, activeKind: 'music',
    queues: { music: [track], podcast: [] }, queue: [track],
    play: vi.fn(), playQueue: vi.fn(), playAt: vi.fn(), toggle: vi.fn(), seek: vi.fn(), stop: vi.fn(),
    getVolume: () => 0.5, setVolume: vi.fn(),
  }
}

describe('QueueSheet 封面', () => {
  it('队列行的封面是后端图片代理地址，不是源站原图', () => {
    const { getByLabelText, container } = render(
      <AudioStageContext.Provider value={stageWith()}>
        <QueueSheet />
      </AudioStageContext.Provider>,
    )
    fireEvent.click(getByLabelText('播放队列'))

    const imgs = [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src'))
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of imgs) {
      expect(img.getAttribute('src')).toBe(PROXIED)
      expect(img.getAttribute('src')).not.toBe(COVER)
    }
    expect(container).toBeTruthy()
  })
})
