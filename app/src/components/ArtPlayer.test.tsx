import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('artplayer', () => {
  class ArtplayerMock {
    static instances: ArtplayerMock[] = []
    static DBCLICK_TIME = 300 // real Artplayer's static double-click window
    listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
    // real Artplayer's DOM: the <video> sits inside $player. ArtPlayer.tsx owns the click
    // semantics on that surface (single = play/pause, double = fullscreen), so the mock needs
    // real elements to dispatch real clicks at.
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
    loading = { show: true } // real Artplayer's loading component; ArtPlayer flips .show=false on terminal fail
    url = '' // reassigned to retry a failed src (mirrors real Artplayer's url setter)
    config: Record<string, unknown>
    private _fullscreen = false

    constructor(config: Record<string, unknown>) {
      this.config = config
      ArtplayerMock.instances.push(this)
    }

    get fullscreen() {
      return this._fullscreen
    }
    // real Artplayer's fullscreen setter fires the 'fullscreen' event on change — mirror that so
    // tests can exercise the app's fullscreen-exit handling.
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
      // Real Artplayer exits fullscreen as a side effect of destroying a fullscreen instance —
      // but via the browser's native fullscreenchange event (screenfull's `document.addEventListener`),
      // which fires ASYNCHRONOUSLY (a later task), never synchronously inside destroy(). Defer it
      // here too so the mock doesn't hide bugs that depend on that ordering.
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

const { watchProgressGet, watchProgressPut } = vi.hoisted(() => ({ watchProgressGet: vi.fn(), watchProgressPut: vi.fn() }))
vi.mock('../lib/api.ts', () => ({ api: { watchProgressGet, watchProgressPut } }))

import Artplayer from 'artplayer'
import { toast } from './acrylic/sonner.tsx'
import { ArtPlayer } from './ArtPlayer.tsx'
import type { ServerProgressConfig } from './ArtPlayer.tsx'

/** 一条 file 计划（Stream 托管直链，planVideo 给 kind:'file'）：video:error 的
 *  终态 / 瞬态分类只在 file / hls 计划上由播放器自己接管，dash 计划走 dash.js 自己的回落。 */
const media = {
  kind: 'video' as const,
  url: '/api/xhs/video?u=mock',
  poster: '/poster.jpg',
}

describe('ArtPlayer', () => {
  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
  })

  it('uses compact controls for thumb variant', () => {
    const { container } = render(<ArtPlayer media={media} baseUrl="http://localhost:4555" variant="thumb" />)
    const instance = (Artplayer as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances[0]

    expect(instance.config.setting).toBe(true)
    expect(instance.config.playbackRate).toBe(true)
    expect(instance.config.aspectRatio).toBe(true)
    expect(instance.config.pip).toBe(true)
    expect(instance.config.fullscreenWeb).toBe(false)
    expect(instance.config.lock).toBe(true)
    expect(instance.config.controls).toBeUndefined()
    const css = container.querySelector('[data-slot="art-player"][data-variant="thumb"] style')?.textContent ?? ''
    expect(css).toContain('padding-left: 5px')
    expect(css).toContain('padding-right: 10px')
    expect(css).toContain('overflow: visible')
    expect(css).toContain('.art-video-player:not(.art-fullscreen)')
  })

  it('keeps the full control set for default variant', () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const instance = (Artplayer as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances[0]

    expect(instance.config.setting).toBe(true)
    expect(instance.config.playbackRate).toBe(true)
    expect(instance.config.aspectRatio).toBe(true)
    expect(instance.config.pip).toBe(true)
    expect(instance.config.fullscreenWeb).toBe(false)
    expect(instance.config.lock).toBe(true)
    expect(instance.config.controls).toBeUndefined()
  })

  // 挂载即开播是**默认**（影视频道、内联播放都是点了才挂上来的），但详情页那条路要按
  // 「用户点的是媒体还是正文」来定（lib/openDetail.ts）——所以这个开关必须真的走进构造选项。
  // 写死成 true 时，点帖子标题打开详情页会当场开始放视频，且哪儿都不报错。
  it('autoplay 缺省 true，显式关掉时构造选项也得跟着关', () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const instances = (Artplayer as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances
    expect(instances[0].config.autoplay).toBe(true)

    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" autoplay={false} />)
    expect(instances[instances.length - 1].config.autoplay).toBe(false)
  })
})

// 视频面上的单击/双击语义由 ArtPlayer.tsx 自己定义（Artplayer 桌面端会给双击的第一下也来一次
// play/pause，见组件内注释）：单击 = 播放/暂停，双击 = 只切全屏、播放态不动。
describe('ArtPlayer — click vs double-click on the video surface', () => {
  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  const clickVideo = (art: any) => art.template.$video.dispatchEvent(new MouseEvent('click', { bubbles: true }))

  it('double-click toggles fullscreen and leaves playback untouched', () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    art.paused = false // playing

    clickVideo(art)
    vi.advanceTimersByTime(100)
    clickVideo(art) // second click inside the double-click window
    vi.advanceTimersByTime(1000)

    expect(art.fullscreen).toBe(true)
    expect(art.paused).toBe(false) // the bug: the first click used to pause it
  })

  it('a lone click still toggles playback, without going fullscreen', () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    art.paused = false

    clickVideo(art)
    vi.advanceTimersByTime(1000)

    expect(art.paused).toBe(true)
    expect(art.fullscreen).toBe(false)
  })

  it('two slow clicks are two separate play toggles, not a double-click', () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    art.paused = false

    clickVideo(art)
    vi.advanceTimersByTime(500) // past the double-click window → the pause already landed
    expect(art.paused).toBe(true)
    clickVideo(art)
    vi.advanceTimersByTime(500)

    expect(art.paused).toBe(false)
    expect(art.fullscreen).toBe(false)
  })
})

// The player owns video:error for file/hls sources: a 4xx is terminal (report once, never retry),
// anything else gets exactly one silent retry and reports only if that also fails; a recovered retry
// stays silent. (User feedback 2026-07-20: don't retry a definitive 404, and don't cry wolf while a
// retry is still in flight.) `media` above is a file plan (Stream-managed direct url).
describe('ArtPlayer — play failure: terminal vs transient', () => {
  const err = () => toast.error as unknown as ReturnType<typeof vi.fn>
  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
    err().mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('terminal 404 → one toast with the reason, zero retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ detail: '作品不可用：作品不见了' }),
    })))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    const urlBefore = art.url
    art.emit('video:error')
    await waitFor(() => expect(err()).toHaveBeenCalledTimes(1))
    expect(err().mock.calls[0][1].description).toMatch(/作品不可用/)
    expect(art.url).toBe(urlBefore) // never reassigned → no retry
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1) // only the one diag classify
  })

  it('transient error that recovers → one silent retry, no toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, headers: { get: () => 'video/mp4' }, body: { cancel: async () => {} } })))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    art.emit('video:error')
    await waitFor(() => expect(art.url).toBe('http://localhost:4555/api/xhs/video?u=mock')) // retried (src reloaded)
    art.emit('video:playing') // the retry played
    await new Promise((r) => setTimeout(r, 0))
    expect(err()).not.toHaveBeenCalled()
  })

  it('transient error whose retry also fails → generic toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, headers: { get: () => 'video/mp4' }, body: { cancel: async () => {} } })))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: any[] }).instances[0]
    art.emit('video:error')
    await waitFor(() => expect(art.url).toBe('http://localhost:4555/api/xhs/video?u=mock')) // first: retried
    art.emit('video:error') // the retry errored too
    await waitFor(() => expect(err()).toHaveBeenCalledTimes(1))
    expect(err().mock.calls[0][1].description).toMatch(/重试后仍失败/)
  })
})

// 一集只有一份可播文件（同集的其余画质由整理判删，不再作为切换候选），所以 resolve 的 JSON
// 只有 mode/url —— 播放器没有画质菜单可开。
describe('ArtPlayer — netdisk 全屏退出', () => {
  const netdiskMedia = { kind: 'video' as const, url: '/api/media/videos/resolve?key=tmdb:1:S01E01' }

  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('用户真的退出全屏 → onFullscreenExit 照常触发', async () => {
    const onFullscreenExit = vi.fn()
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" autoFullscreen onFullscreenExit={onFullscreenExit} />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    const first = instances[0]
    first.emit('ready')
    expect(first.fullscreen).toBe(true)

    first.fullscreen = false // user pressed Esc / clicked the exit-fullscreen control

    expect(onFullscreenExit).toHaveBeenCalledTimes(1)
  })
})

// 这一组钉的是「页面的源 ≠ 后端的源」那一档（工作台面板住在 DSH 那一页）。resolve 的 JSON 常常回一个**根相对**的后端路由（网盘条目在
// packages/alist/normalizer.ts 里就存成 `/api/media/netdisk-play?path=…`），交给 <video> 之前必须吃
// baseUrl。不吃的话浏览器按页面自己的源解析 → 打到一个没有这条路由的源上 → 404 →
// MEDIA_ERR_SRC_NOT_SUPPORTED。**这条在网页档的主应用里永远绿**（那里两个源碰巧相同），
// 所以判据只能盯「最终交给播放器的那个 url 长什么样」，不能盯"能不能播"。
describe('ArtPlayer — resolve 回来的地址必须落在后端那个源上', () => {
  const netdiskMedia = { kind: 'video' as const, url: '/api/media/videos/resolve?key=tmdb:1:S01E01' }
  const backend = 'http://127.0.0.1:8900'
  const instancesOf = () => (Artplayer as unknown as { instances: Array<{ config: Record<string, unknown> }> }).instances

  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  it('根相对的解析结果吃 baseUrl（此前它被当成「已经绝对了」直接放行）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: 'native', url: '/api/media/netdisk-play?path=%2Fquark%2Fa.mp4' }),
    })))
    render(<ArtPlayer media={netdiskMedia} baseUrl={backend} />)

    await waitFor(() => expect(instancesOf().length).toBe(1))
    expect(instancesOf()[0].config.url).toBe(`${backend}/api/media/netdisk-play?path=%2Fquark%2Fa.mp4`)
  })

  it('已经指名了源的解析结果原样用，不被再拼一次前缀', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: 'native', url: 'https://cdn.example.com/a.mp4' }),
    })))
    render(<ArtPlayer media={netdiskMedia} baseUrl={backend} />)

    await waitFor(() => expect(instancesOf().length).toBe(1))
    expect(instancesOf()[0].config.url).toBe('https://cdn.example.com/a.mp4')
  })
})

describe('ArtPlayer — netdisk subtitle', () => {
  const netdiskMedia = { kind: 'video' as const, url: '/api/media/videos/resolve?key=tmdb:1:S01E01' }

  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to the 简体中文 track and offers a language switcher for the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? {
              ok: true,
              json: async () => ({
                tracks: [
                  { id: 'embed:2', index: 2, lang: 'chi', title: '简体中文' },
                  { id: 'embed:3', index: 3, lang: 'chi', title: '繁體中文' },
                  { id: 'file:Subs/e1.eng.srt', lang: 'eng', title: 'English（外挂）' },
                ],
              }),
            }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    const first = instances[0]

    expect(first.config.subtitle).toEqual({
      url: 'http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=embed%3A2',
      type: 'vtt',
    })

    const settingCall = first.setting.add.mock.calls[0][0]
    expect(settingCall.html).toBe('字幕')
    // 「关闭」永远排第一；高置信轨在时它不是默认项（简体中文才是）
    expect(settingCall.selector.map((s: any) => s.html)).toEqual(['关闭', '简体中文', '繁體中文', 'English（外挂）'])
    expect(settingCall.selector.find((s: any) => s.html === '关闭').default).toBe(false)
    expect(settingCall.selector.find((s: any) => s.html === '简体中文').default).toBe(true)
    const traditional = settingCall.selector.find((s: any) => s.html === '繁體中文')
    expect(settingCall.onSelect(traditional)).toBe('繁體中文')
    expect(first.subtitle.switch).toHaveBeenCalledWith(
      'http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=embed%3A3',
      { type: 'vtt' },
    )
    // sibling file track: the id is threaded through OPAQUELY (url-encoded), never parsed client-side
    const external = settingCall.selector.find((s: any) => s.html === 'English（外挂）')
    settingCall.onSelect(external)
    expect(first.subtitle.switch).toHaveBeenCalledWith(
      `http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('file:Subs/e1.eng.srt')}`,
      { type: 'vtt' },
    )
  })

  // Real-world release found via live verification against tmdb:296286:S01E01 (see
  // docs/superpowers/specs/2026-07-22-netdisk-subtitle-audio-extraction-design.md): some releases tag
  // their simplified/traditional tracks in English ("Simplified"/"Traditional"), not Chinese
  // ("简体中文"/"繁體中文") — the default-pick must not silently fall back to the first (unrelated,
  // e.g. English) track just because the title has no '简' character in it.
  it('defaults to an English-titled "Simplified" track when the file uses that naming convention', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? {
              ok: true,
              json: async () => ({
                tracks: [
                  { id: 'embed:2', index: 2, lang: 'eng', title: 'English' },
                  { id: 'embed:3', index: 3, lang: 'chi', title: 'Simplified' },
                  { id: 'embed:4', index: 4, lang: 'chi', title: 'Traditional' },
                ],
              }),
            }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    expect(instances[0].config.subtitle).toEqual({
      url: 'http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=embed%3A3',
      type: 'vtt',
    })
  })

  // Live finding (tmdb:286709 The Westies): the file embeds only ita/eng tracks while the CHINESE
  // sub is the sibling external ass ('外挂字幕', no lang suffix) — the default pick must prefer the
  // external track over an unrelated foreign-language embedded one, else the player opens with
  // Italian "Forced" subs on a Chinese release.
  it('defaults to the external sibling track when no embedded track is Chinese', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? {
              ok: true,
              json: async () => ({
                tracks: [
                  { id: 'embed:3', index: 3, lang: 'ita', title: 'Forced' },
                  { id: 'embed:5', index: 5, lang: 'eng' },
                  { id: 'file:e1.ass', title: '外挂字幕' },
                ],
              }),
            }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    expect(instances[0].config.subtitle).toEqual({
      url: `http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('file:e1.ass')}`,
      type: 'vtt',
    })
  })

  it('does not add a subtitle setting entry when the file has no subtitle tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? { ok: true, json: async () => ({ tracks: [] }) }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    expect(instances[0].config.subtitle).toBeUndefined()
    expect(instances[0].setting.add).not.toHaveBeenCalled()
  })

  // 真实事故（喜剧之王单口季，纯享无内嵌轨）：本地既无 embed 也无 sibling → 掉进在线搜刮兜底，
  // 返回一堆 `scrape:` 模糊匹配（迅雷/射手）。旧代码把第一条当默认挂上、且只在 >1 轨时给切换、
  // 没有「关闭」——于是一条随机错配花字字幕关不掉、满屏像弹幕。修复：搜刮轨绝不自动挂、菜单永远
  // 有「关闭」且默认选中。
  it('never auto-enables scraped tracks — starts off, but still lists them with 关闭 default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? {
              ok: true,
              json: async () => ({
                tracks: [
                  { id: 'scrape:aaa', title: '字幕（在线）' },
                  { id: 'scrape:bbb', title: '字幕（在线）' },
                ],
              }),
            }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    const first = instances[0]

    // no track turned on at construction (scraped = low confidence)
    expect(first.config.subtitle).toBeUndefined()
    // but the menu still appears so the user can opt in — 关闭 present and default-selected
    await waitFor(() => expect(first.setting.add).toHaveBeenCalled())
    const settingCall = first.setting.add.mock.calls[0][0]
    expect(settingCall.selector.map((s: any) => s.html)).toEqual(['关闭', '字幕（在线）', '字幕（在线）'])
    expect(settingCall.selector.find((s: any) => s.html === '关闭').default).toBe(true)

    // opting into a scraped track switches it on
    settingCall.onSelect(settingCall.selector[1])
    expect(first.subtitle.switch).toHaveBeenCalledWith(
      `http://localhost:4555/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('scrape:aaa')}`,
      { type: 'vtt' },
    )
    expect(first.subtitle.show).toBe(true)
  })

  it('the 关闭 entry hides the current subtitle without switching tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('netdisk-subtitle-list')
          ? { ok: true, json: async () => ({ tracks: [{ id: 'embed:2', index: 2, lang: 'chi', title: '简体中文' }] }) }
          : { ok: true, json: async () => ({ mode: 'native', url: '/x/1080.mp4' }) },
      ),
    )
    render(<ArtPlayer media={netdiskMedia} baseUrl="http://localhost:4555" />)

    const instances = (Artplayer as unknown as { instances: any[] }).instances
    await waitFor(() => expect(instances.length).toBe(1))
    const first = instances[0]
    // a single confident track auto-enables AND still gets a menu with an 关闭 escape hatch
    expect(first.config.subtitle).toBeDefined()
    const settingCall = first.setting.add.mock.calls[0][0]
    expect(settingCall.selector.map((s: any) => s.html)).toEqual(['关闭', '简体中文'])

    settingCall.onSelect(settingCall.selector.find((s: any) => s.html === '关闭'))
    expect(first.subtitle.show).toBe(false)
    expect(first.subtitle.switch).not.toHaveBeenCalled()
  })
})

// 说话人图谱在播放器里 = 跳转点 + 名字。名字回来了(曾以「与右侧面板冗余」删掉):光靠颜色
// 认不出人,而右侧面板离进度条很远,对不上号。名字用 nameableMarks 定位——每人至多一次、
// 挨太近的让位,所以这里既验点也验「名字不重复、密集时不糊」。勾选/独看的交互仍归右侧面板。
type Any = any

describe('ArtPlayer speaker marks + skip wiring', () => {
  const speakerBlocks = [
    { start: 0, end: 10, label: 'A' },
    { start: 10, end: 20, label: 'B' },
    { start: 20, end: 30, label: 'A' },
  ]

  it('renders one dot per block start, not a filled span', async () => {
    const { container } = render(
      <ArtPlayer media={media} baseUrl="http://localhost:4555" speakerBlocks={speakerBlocks} />,
    )
    const art = (Artplayer as unknown as { instances: Any[] }).instances.at(-1)!
    art.duration = 30
    art.emit('video:loadedmetadata')
    await waitFor(() => {
      const dots = container.querySelectorAll('[data-slot="speaker-mark-dot"]')
      expect(dots.length).toBe(3)
      // 点:固定尺寸 + 圆形,没有按时长算出来的 width
      expect((dots[0] as HTMLElement).className).toContain('rounded-full')
      expect((dots[0] as HTMLElement).style.width).toBe('')
    })
  })

  it('names each speaker once next to their dot, using the shared display names', async () => {
    const { container } = render(
      <ArtPlayer
        media={media}
        baseUrl="http://localhost:4555"
        speakerBlocks={speakerBlocks}
        speakerNames={{ A: '林简七', B: '说话人 2' }}
      />,
    )
    const art = (Artplayer as unknown as { instances: Any[] }).instances.at(-1)!
    art.duration = 30
    art.emit('video:loadedmetadata')
    await waitFor(() => {
      const names = [...container.querySelectorAll('[data-slot="speaker-mark-name"]')].map((n) => n.textContent)
      // A 有两个块(0s / 20s)但只写一次名;两人都拿到面板同款名字,而不是原始 label
      expect(names).toEqual(['林简七', '说话人 2'])
    })
  })

  it('falls back to the raw label when no display name was supplied', async () => {
    const { container } = render(
      <ArtPlayer media={media} baseUrl="http://localhost:4555" speakerBlocks={speakerBlocks} />,
    )
    const art = (Artplayer as unknown as { instances: Any[] }).instances.at(-1)!
    art.duration = 30
    art.emit('video:loadedmetadata')
    await waitFor(() => {
      const names = [...container.querySelectorAll('[data-slot="speaker-mark-name"]')].map((n) => n.textContent)
      expect(names).toEqual(['A', 'B'])
    })
  })

  it('video:timeupdate seeks to the next active block when playback drifts into an excluded one', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" speakerBlocks={speakerBlocks} activeSpeakers={['A']} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances.at(-1)!
    await waitFor(() => expect(art.listeners['video:timeupdate']?.length).toBeTruthy())
    art.currentTime = 15
    art.emit('video:timeupdate')
    expect(art.currentTime).toBe(20)
  })

  it('video:timeupdate does not skip when not filtering (activeSpeakers unset)', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" speakerBlocks={speakerBlocks} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances.at(-1)!
    await waitFor(() => expect(art.listeners['video:timeupdate']?.length).toBeTruthy())
    art.currentTime = 15
    art.emit('video:timeupdate')
    expect(art.currentTime).toBe(15)
  })
})

// serverProgress's mere PRESENCE is the switch to the server-backed path (see ArtPlayer.tsx's
// ServerProgressConfig doc) — the Timeline (Detail.tsx/App.tsx) never passes it, so it never
// exercises this branch; only the video channel (MovieChannel.tsx) does.
describe('ArtPlayer — serverProgress (video channel)', () => {
  const sp: ServerProgressConfig = {
    key: 'tmdb:1:S01E01',
    workKey: 'tmdb:1',
    workTitle: 'Some Show',
    workPoster: '/poster.jpg',
    epLabel: 'S01E01',
    conn: { baseUrl: 'http://localhost:4555' },
  }

  beforeEach(() => {
    ;(Artplayer as unknown as { instances: unknown[] }).instances.length = 0
    watchProgressGet.mockReset().mockResolvedValue(null)
    watchProgressPut.mockReset().mockResolvedValue({})
  })

  it('ready: resumes from the server position (not localStorage), guarded by the existing seek window', async () => {
    watchProgressGet.mockResolvedValue({ position: 42, duration: 100, workKey: 'tmdb:1', workTitle: 'Some Show', updatedAt: 0 })
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.emit('ready')
    await waitFor(() => expect(watchProgressGet).toHaveBeenCalledWith(sp.conn, sp.key))
    await waitFor(() => expect(art.currentTime).toBe(42))
  })

  it('ready: a user seek arriving before the GET resolves wins — the resumed position is discarded', async () => {
    let resolveGet!: (v: unknown) => void
    watchProgressGet.mockImplementation(() => new Promise((res) => { resolveGet = res }))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.emit('ready')
    await waitFor(() => expect(watchProgressGet).toHaveBeenCalled())
    // the user drags the scrubber (Artplayer's own 'seek' event) while the GET is still in flight
    art.currentTime = 55
    art.emit('seek', 55, 55)
    resolveGet({ position: 42, duration: 100, workKey: 'tmdb:1', workTitle: 'Some Show', updatedAt: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(art.currentTime).toBe(55) // NOT clobbered back to the server's 42
  })

  it('ready: a user pause arriving before the GET resolves also wins', async () => {
    let resolveGet!: (v: unknown) => void
    watchProgressGet.mockImplementation(() => new Promise((res) => { resolveGet = res }))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.emit('ready')
    await waitFor(() => expect(watchProgressGet).toHaveBeenCalled())
    art.currentTime = 3 // user paused almost immediately, still near 0
    art.emit('pause')
    resolveGet({ position: 42, duration: 100, workKey: 'tmdb:1', workTitle: 'Some Show', updatedAt: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(art.currentTime).toBe(3)
  })

  it('ready: a failed fetch starts at 0 and never throws', async () => {
    watchProgressGet.mockRejectedValue(new Error('network'))
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.emit('ready')
    await waitFor(() => expect(watchProgressGet).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(art.currentTime).toBe(0)
  })

  it('video:timeupdate throttles to 15s (not the localStorage 5s) and PUTs work metadata', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 6
    art.emit('video:timeupdate') // < 15s since lastSave=0 → no report yet
    expect(watchProgressPut).not.toHaveBeenCalled()
    art.currentTime = 16
    art.emit('video:timeupdate')
    await waitFor(() => expect(watchProgressPut).toHaveBeenCalledWith(
      sp.conn, sp.key,
      { position: 16, duration: 100, workKey: 'tmdb:1', workTitle: 'Some Show', workPoster: '/poster.jpg', epLabel: 'S01E01' },
      undefined,
    ))
  })

  it('video:pause reports once', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 8
    art.emit('video:pause')
    await waitFor(() => expect(watchProgressPut).toHaveBeenCalledTimes(1))
  })

  it('video:pause advances the throttle marker — a timeupdate tick just after it within the 15s window does not double-report', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 8
    art.emit('video:pause')
    await waitFor(() => expect(watchProgressPut).toHaveBeenCalledTimes(1))
    art.currentTime = 10 // resumed playback, still well inside 15s of the pause's position
    art.emit('video:timeupdate')
    expect(watchProgressPut).toHaveBeenCalledTimes(1) // no second PUT
  })

  it('video:ended reports but does NOT clear the record (unlike localStorage mode)', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 99
    art.emit('video:ended')
    await waitFor(() => expect(watchProgressPut).toHaveBeenCalledTimes(1))
    expect(watchProgressPut.mock.calls[0][1]).toBe(sp.key)
  })

  it('unmount reports once, keepalive', async () => {
    const { unmount } = render(<ArtPlayer media={media} baseUrl="http://localhost:4555" serverProgress={sp} />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 30
    unmount()
    await waitFor(() => expect(watchProgressPut).toHaveBeenCalledWith(
      sp.conn, sp.key,
      { position: 30, duration: 100, workKey: 'tmdb:1', workTitle: 'Some Show', workPoster: '/poster.jpg', epLabel: 'S01E01' },
      { keepalive: true },
    ))
  })

  it('without serverProgress, localStorage-mode behavior is unaffected: no server calls at all', async () => {
    render(<ArtPlayer media={media} baseUrl="http://localhost:4555" />)
    const art = (Artplayer as unknown as { instances: Any[] }).instances[0]
    art.duration = 100
    art.currentTime = 20
    art.emit('ready')
    art.emit('video:timeupdate')
    art.emit('video:pause')
    art.emit('video:ended')
    await new Promise((r) => setTimeout(r, 0))
    expect(watchProgressGet).not.toHaveBeenCalled()
    expect(watchProgressPut).not.toHaveBeenCalled()
  })
})
