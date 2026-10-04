import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// 真 Artplayer 在 jsdom 里挂不起来（HTMLMediaElement 没实现），用与 ArtPlayer.test.tsx 同款的
// 最小可运行 mock——只需要 on/once/off/emit/destroy 和一个带 $player/$video 的 template，
// 挂载期间的副作用（bindEvents 等）才不会抛。
vi.mock('artplayer', () => {
  class ArtplayerMock {
    static instances: ArtplayerMock[] = []
    static DBCLICK_TIME = 300
    listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    template = (() => {
      const $player = document.createElement('div')
      const $video = document.createElement('video')
      $player.appendChild($video)
      return { $player, $video }
    })()
    contextmenu = { show: false }
    video = {
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      muted: false,
      videoWidth: 0,
      videoHeight: 0,
    }
    dash = { reset: vi.fn() }
    duration = 0
    currentTime = 0
    volume = 0.7
    paused = true
    setting = { add: vi.fn() }
    subtitle = { switch: vi.fn() }
    loading = { show: true }
    url = ''
    config: Record<string, unknown>
    private _fullscreen = false

    constructor(config: Record<string, unknown>) {
      this.config = config
      ArtplayerMock.instances.push(this)
    }

    get fullscreen() {
      return this._fullscreen
    }
    set fullscreen(v: boolean) {
      this._fullscreen = v
      this.emit('fullscreen', v)
    }

    on(event: string, cb: (...a: unknown[]) => void) {
      ;(this.listeners[event] ??= []).push(cb)
    }
    once(event: string, cb: (...a: unknown[]) => void) {
      this.on(event, cb)
    }
    off(event: string, cb?: (...a: unknown[]) => void) {
      if (!cb) delete this.listeners[event]
      else this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== cb)
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners[event] ?? []) cb(...args)
    }
    destroy() {
      if (this._fullscreen) queueMicrotask(() => { this.fullscreen = false })
      this.emit('destroy')
    }
    play() {
      this.paused = false
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    toggle() {
      if (this.paused) void this.play()
      else this.pause()
    }
  }

  return { default: ArtplayerMock }
})

vi.mock('./acrylic/sonner.tsx', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import Artplayer from 'artplayer'
import { ArtPlayer } from './ArtPlayer.tsx'

// 渐进式 file 档（Stream 托管直链 url 走这条；带 (provider, vid) 的平台走 dash 档，不在本测试范围）。
const media = { kind: 'video' as const, url: '/api/video/mock.mp4', poster: '/poster.jpg' }

describe('ArtPlayer — 简介浮层', () => {
  it('给了 blurb 就画一层，显隐挂在控制条那个开关上（不是 CSS hover）', () => {
    render(<ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} blurb="一段简介" />)
    const box = screen.getByTestId('blurb-overlay')
    expect(box).toBeTruthy()
    const cls = box.parentElement?.className ?? ''
    expect(cls).toContain('group-data-[controls=on]/player:opacity-100')
    // 这一条是这次修的那个 bug 本身：鼠标停在简介上时 `$player` 已经 mouseleave，控制条会
    // 自己收起来而外层 `:hover` 仍为真——简介于是悬在半空。别把 hover 驱动加回来。
    expect(cls).not.toContain('group-hover/player')
  })

  it('控制条收起 → 简介跟着走；再回来 → 一起回来', async () => {
    render(<ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} blurb="一段简介" />)
    const player = document.querySelector('[data-slot="art-player"]')!
    // 建好那一刻控制条是显示的：初值必须自己铺，`control` 只在变化时发。
    expect(player.getAttribute('data-controls')).toBe('on')
    const art = (Artplayer as unknown as { instances: Array<{ emit: (e: string, v: boolean) => void }> })
      .instances.at(-1)!
    await act(async () => art.emit('control', false))
    expect(player.getAttribute('data-controls')).toBe('off')
    await act(async () => art.emit('control', true))
    expect(player.getAttribute('data-controls')).toBe('on')
  })

  it('控制条没显示时包裹层不可点击（opacity 和 pointer-events 是两个独立的轴，两个都得跟着切）', () => {
    render(<ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} blurb="一段简介" />)
    const wrapperClass = screen.getByTestId('blurb-overlay').parentElement?.className ?? ''
    expect(wrapperClass).toContain('pointer-events-none')
    expect(wrapperClass).toContain('group-data-[controls=on]/player:pointer-events-auto')
  })

  it('没有 blurb 就不画', () => {
    render(<ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} />)
    expect(screen.queryByTestId('blurb-overlay')).toBeNull()
  })

  // 播放器实例是全局共享的：同一个实例经 portal 也渲染进时间线卡片（feed/PostItemRow 的
  // MediaBoxPlayer），而那张卡自己已经用 line-clamp-3 画了同一段文字、内联播放器又矮。
  // 设计只打算动详情页那台媒体，`thumb` 就是内联那一档。
  it('内联缩略档（variant=thumb）不画简介——同一段话时间线卡片自己已经有了', () => {
    render(<ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} variant="thumb" blurb="一段简介" />)
    expect(screen.queryByTestId('blurb-overlay')).toBeNull()
  })

  // 画面底部这一叠自下而上：控制条 → speaker-marks（bottom-14，高 20px）→ 简介。
  // 两层同位不报错，只是说话人圆点和名字压在简介最后一行上。
  it('有说话人标记时简介让到它之上，没有才落回控制条上沿', async () => {
    const blocks = [{ label: 'SPEAKER_00', start: 10, end: 80 }]
    const { rerender } = render(
      <ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} blurb="一段简介" />
    )
    expect(screen.getByTestId('blurb-overlay').parentElement?.className).toContain('bottom-14')

    // marks 要 duration>0 才画：喂一次 loadedmetadata，播放器才知道片长。
    rerender(
      <ArtPlayer media={media} baseUrl="http://x" onExpand={() => {}} blurb="一段简介" speakerBlocks={blocks} />
    )
    const art = (Artplayer as unknown as { instances: Array<{ duration: number; emit: (e: string) => void }> })
      .instances.at(-1)!
    art.duration = 120
    await act(async () => art.emit('video:loadedmetadata'))

    expect(document.querySelector('[data-slot="speaker-marks"]')).toBeTruthy()
    const cls = screen.getByTestId('blurb-overlay').parentElement?.className ?? ''
    expect(cls).toContain('bottom-[76px]')
    expect(cls).not.toContain('bottom-14')
  })
})
