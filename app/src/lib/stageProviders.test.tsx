// 两个舞台 Provider（视频/音频）从 App.tsx 抽出来之后必须还成立的两件事：
//
// 1. **每挂一次就是一份独立实例**。主应用和工作台面板是**两个浏览器页面**，各挂各的；
//    要是谁把状态提到模块级（一个共享的单例），两页就会互相踩——一页起播把另一页的
//    activeId 也改了，而且不报错。这条正是"抽成公共模块"最容易引进来的缺陷，所以钉死它。
// 2. `play()` 真的把播放器架起来（视频）/ 真的把轨装上元素（音频）。面板此前那份
//    `INERT_STAGE` 就是"看起来能用、实际什么都不做"，没有任何一处会喊。
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { OutPortal } from './portal.ts'
import { VideoStageProvider } from './videoStageProvider.tsx'
import { AudioStageProvider } from './audioStageProvider.tsx'
import { useVideoStage } from './videoStage.ts'
import { useAudioStage, type AudioTrack } from './audioStage.ts'
import type { Item } from './types.ts'

// 真 Artplayer 在 jsdom 里挂不起来（HTMLMediaElement 没实现），换成一个把关键 prop 摊到
// DOM 上的替身——要验的是"舞台把播放器架起来了没有"，不是播放器本身。
vi.mock('../components/ArtPlayer.tsx', () => ({
  ArtPlayer: ({ variant }: { variant?: string }) => <div data-testid="art-player" data-variant={variant ?? 'default'} />,
}))
// 人物图谱要发请求；这里不验它。
vi.mock('../hooks/useSpeakerMap.ts', () => ({
  useSpeakerMap: () => ({ blocks: [], activeSpeakers: [], names: {} }),
}))

const clip: Item = {
  id: 'v1', stream_id: 'bilibili-s1', type: 'post', title: '一段视频',
  url: 'https://example.com/v1',
  content: { archetype: 'video', media: [{ kind: 'video', url: 'https://cdn.example.com/clip.mp4' }] },
  timestamp: '2026-08-17T00:00:00.000Z', fetched_at: '2026-08-17T00:00:00.000Z',
}

/** 一个把舞台状态摊到 DOM 上、并给出一个"点了就 play"按钮的探针。
 *  它还要**把播放器接出来**（`<OutPortal>`）——InPortal 渲染进的是一个游离节点，
 *  不经 OutPortal 接进文档就查不到，正如真实的消费方（Detail / PostItemRow）所做。 */
function VideoProbe({ label }: { label: string }) {
  const stage = useVideoStage()
  return (
    <>
      <button data-testid={`video-${label}`} data-active={stage.activeId ?? ''} onClick={() => stage.play(clip, { url: clip.content!.media![0].url } as never)}>
        play
      </button>
      {stage.node ? <OutPortal node={stage.node} /> : null}
    </>
  )
}

const track: AudioTrack = { id: 'ep1', kind: 'podcast', url: 'https://cdn.example.com/ep1.mp3', title: '第一期' }

function AudioProbe({ label }: { label: string }) {
  const stage = useAudioStage()
  return (
    <button data-testid={`audio-${label}`} data-current={stage.current?.id ?? ''} onClick={() => stage.play(track)}>
      play
    </button>
  )
}

describe('VideoStageProvider', () => {
  it('play() 真的把播放器架起来（不是空动作）', () => {
    render(
      <VideoStageProvider baseUrl="http://x">
        <VideoProbe label="a" />
      </VideoStageProvider>
    )
    expect(screen.queryByTestId('art-player')).toBeNull()
    fireEvent.click(screen.getByTestId('video-a'))
    expect(screen.getByTestId('art-player')).toBeTruthy()
    expect(screen.getByTestId('video-a').dataset.active).toBe('v1')
  })

  it('挂两份 = 两份独立状态（模块级单例会当场变红）', () => {
    render(
      <>
        <VideoStageProvider baseUrl="http://x"><VideoProbe label="a" /></VideoStageProvider>
        <VideoStageProvider baseUrl="http://x"><VideoProbe label="b" /></VideoStageProvider>
      </>
    )
    fireEvent.click(screen.getByTestId('video-a'))
    expect(screen.getByTestId('video-a').dataset.active).toBe('v1')
    expect(screen.getByTestId('video-b').dataset.active).toBe('')
    expect(screen.getAllByTestId('art-player')).toHaveLength(1)
  })

  it('openId 命中当前这条时播放器画成 default，否则是 thumb', () => {
    const { rerender } = render(
      <VideoStageProvider baseUrl="http://x" openId={null}><VideoProbe label="a" /></VideoStageProvider>
    )
    fireEvent.click(screen.getByTestId('video-a'))
    expect(screen.getByTestId('art-player').dataset.variant).toBe('thumb')
    rerender(
      <VideoStageProvider baseUrl="http://x" openId="v1"><VideoProbe label="a" /></VideoStageProvider>
    )
    expect(screen.getByTestId('art-player').dataset.variant).toBe('default')
  })

  it('起播要把"详情开着"这一格清掉——那一格归挂载方，只能回请它改', () => {
    const onOpenIdChange = vi.fn()
    render(
      <VideoStageProvider baseUrl="http://x" openId="other" onOpenIdChange={onOpenIdChange}>
        <VideoProbe label="a" />
      </VideoStageProvider>
    )
    fireEvent.click(screen.getByTestId('video-a'))
    expect(onOpenIdChange).toHaveBeenCalledWith(null)
  })
})

describe('AudioStageProvider', () => {
  it('play() 真的把轨装上 <audio>', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { container } = render(
      <AudioStageProvider><AudioProbe label="a" /></AudioStageProvider>
    )
    fireEvent.click(screen.getByTestId('audio-a'))
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(track.url)
    expect(screen.getByTestId('audio-a').dataset.current).toBe('ep1')
  })

  it('挂两份 = 两个各自的 <audio> + 两份独立队列', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { container } = render(
      <>
        <AudioStageProvider><AudioProbe label="a" /></AudioStageProvider>
        <AudioStageProvider><AudioProbe label="b" /></AudioStageProvider>
      </>
    )
    expect(container.querySelectorAll('audio')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('audio-a'))
    expect(screen.getByTestId('audio-a').dataset.current).toBe('ep1')
    expect(screen.getByTestId('audio-b').dataset.current).toBe('')
  })

  it('stageRef 拿到的是当前那一份 stage（住在 Provider 外面的队列生产者靠它）', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const stageRef = { current: null } as { current: import('./audioStage.ts').AudioStage | null }
    const { container } = render(
      <AudioStageProvider stageRef={stageRef}><AudioProbe label="a" /></AudioStageProvider>
    )
    expect(stageRef.current).not.toBeNull()
    act(() => stageRef.current!.playQueue([track], 0, 'podcast'))
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(track.url)
    // 回填必须跟着 stage 一起换新：读到的 current 得是**这一次**的状态，不是首帧那一份。
    expect(stageRef.current!.current?.id).toBe('ep1')
  })

  it('子组件自己的挂载 effect 里就能读到 stageRef——回填不能晚于挂载 effect（装配期回填的病灶）', () => {
    // AGENTS.md「装配期取的值 = 冻住的答案」的"前向 let + 回填"specimen：回填若挂在
    // Provider 自己的 effect 里，跑在**子组件挂载 effect之后**（同层 effect 按声明/挂载
    // 顺序执行，Provider 的 useEffect 声明在 children 渲染完之后），子组件此刻读到的
    // 是回填之前那一份——多半是 null。改成渲染期（useMemo 内）写，子组件挂载 effect
    // 执行时这次渲染早就写完了。
    const stageRef = { current: null } as { current: import('./audioStage.ts').AudioStage | null }
    let seenAtMount: unknown = 'not-yet'
    function MountEffectProbe() {
      useEffect(() => {
        seenAtMount = stageRef.current
      }, [])
      return null
    }
    render(
      <AudioStageProvider stageRef={stageRef}>
        <MountEffectProbe />
      </AudioStageProvider>
    )
    expect(seenAtMount).not.toBe('not-yet')
    expect(seenAtMount).not.toBeNull()
  })

  it('借出去的 <audio> 就是挂载方递进来的那个 ref（诊断记录器靠它取样）', () => {
    const elementRef = { current: null } as { current: HTMLAudioElement | null }
    const { container } = render(
      <AudioStageProvider elementRef={elementRef}><AudioProbe label="a" /></AudioStageProvider>
    )
    expect(elementRef.current).toBe(container.querySelector('audio'))
  })

  it('onMediaEvent 转发的 media 事件集合是钉死的这七个——多一个少一个都要变红', () => {
    // 「名单要有一个钉住数字的测试」（AGENTS.md）：把 <audio> 支持的原生事件全打一遍
    // （不止转发的那七个），只看 onMediaEvent 实际收到了哪些名字。少了一个 = 有人删漏了
    // 某个 onXxx；多了一个（比如有人顺手把 onPause 也接了上去）= 有人加了没人审的转发，
    // OOM 飞行记录器要么丢了判据、要么混进噪音。
    const forwarded: string[] = []
    const onMediaEvent = vi.fn((name: string) => forwarded.push(name))
    const { container } = render(
      <AudioStageProvider onMediaEvent={onMediaEvent}><AudioProbe label="a" /></AudioStageProvider>
    )
    const audio = container.querySelector('audio')!
    const nativeMediaEvents = [
      'loadstart', 'loadedmetadata', 'playing', 'waiting', 'stalled', 'suspend', 'error',
      // 这几个 <audio> 也支持、但**不**该被转发（播放语义已经有别的通路，onMediaEvent
      // 只该是诊断旁路）——同一遍扫过去，顺手验证它们没被误接。
      'play', 'pause', 'timeupdate', 'durationchange', 'ended', 'canplay', 'seeking',
    ]
    for (const kind of nativeMediaEvents) fireEvent(audio, new Event(kind))
    expect(new Set(forwarded)).toEqual(
      new Set(['loadstart', 'loadedmetadata', 'playing', 'waiting', 'stalled', 'suspend', 'error'])
    )
  })
})
