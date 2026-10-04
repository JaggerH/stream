// usePostPresentation 是两种布局共用的派生层。这里只钉住"有真逻辑"的那几处：占位标题剔除、
// 动作条可见性、以及音频分支必须让位给视频(视频帖不该冒出播放按钮)。渲染层的行为由
// PostItemRow 自己的用例守。
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { usePostPresentation } from './postPresentation.ts'
import { normalizePostTitle } from './feedPresent.ts'
import { AudioStageContext, type AudioStage } from './audioStage.ts'
import type { Item } from './types.ts'

function makeStage(over: Partial<AudioStage> = {}): AudioStage {
  return {
    current: null, playing: false, duration: 0, activeKind: 'music',
    queues: { music: [], podcast: [] }, queue: [],
    play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
    getVolume: () => 1, setVolume: () => {},
    ...over,
  }
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    stream_id: 's1',
    type: 'rss',
    title: '真标题',
    timestamp: '2026-07-29T00:00:00.000Z',
    fetched_at: '2026-07-29T00:00:00.000Z',
    ...over,
  } as Item
}

describe('normalizePostTitle', () => {
  it('剥掉管线的占位标题,留空字符串', () => {
    expect(normalizePostTitle(makeItem({ title: '(无标题)' }))).toBe('')
    expect(normalizePostTitle(makeItem({ title: '（无标题）' }))).toBe('')
    expect(normalizePostTitle(makeItem({ title: '(untitled)' }))).toBe('')
    expect(normalizePostTitle(makeItem({ title: '  ' }))).toBe('')
  })

  it('真标题原样保留并去掉首尾空白', () => {
    expect(normalizePostTitle(makeItem({ title: '  真标题  ' }))).toBe('真标题')
  })
})

describe('usePostPresentation', () => {
  it('没有 AudioStage provider 时不产出音频轨(PreviewModal 就是这个场景)', () => {
    const item = makeItem({ content: { archetype: 'audio', media: [{ kind: 'audio', url: 'https://x/a.mp3' }] } as never })
    const { result } = renderHook(() => usePostPresentation(item))
    expect(result.current.audioTrack).toBeNull()
    expect(result.current.onAudioActivate).toBeUndefined()
  })

  describe('音频分支必须让位给视频', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AudioStageContext.Provider value={makeStage()}>{children}</AudioStageContext.Provider>
    )

    it('视频帖即使有舞台也不产出音频轨(不该冒出播放按钮)', () => {
      // 媒体里故意同时放 video 和 audio 两条:若只有 video 条目,toTrack 对它本来就返回
      // null(它只认 kind:'audio'/'link'),那样这条测试删掉 hook 里的 `!video && !isVideoNote`
      // 守卫也照样通过,钉不住任何东西。加一条 audio 条目让 toTrack 在没有守卫时确实能产出
      // 音频轨,这样"video 帖不出音频"才是守卫本身在起作用,而不是 toTrack 顺便帮了忙。
      const item = makeItem({
        content: {
          archetype: 'video',
          media: [
            { kind: 'video', url: 'https://x/a.mp4', poster: 'https://x/a.jpg' },
            { kind: 'audio', url: 'https://x/a.mp3' },
          ],
        } as never,
      })
      const { result } = renderHook(() => usePostPresentation(item), { wrapper })
      expect(result.current.audioTrack).toBeNull()
      expect(result.current.onAudioActivate).toBeUndefined()
    })

    it('音频帖在有舞台时确实产出音频轨(反证上一条不是 stub 坏掉)', () => {
      const item = makeItem({ content: { archetype: 'audio', media: [{ kind: 'audio', url: 'https://x/a.mp3' }] } as never })
      const { result } = renderHook(() => usePostPresentation(item), { wrapper })
      expect(result.current.audioTrack).not.toBeNull()
      expect(result.current.onAudioActivate).toBeDefined()
    })
  })

  // avatar 是 `string` 而空串代表"没有头像"(见 PostPresentation.avatar 的 JSDoc)。这条断言
  // 放在这一层而不是 PostCard 那一层:Radix 的 AvatarImage 只在图片 loaded 后才吐 <img>,
  // jsdom 永远不触发 load,所以在组件层断言"没有 <img>"是永远失败不了的。
  describe('avatar', () => {
    it('既没有 author_avatar 也没有 url 时,avatar 是空串而不是 undefined', () => {
      const { result } = renderHook(() =>
        usePostPresentation(makeItem({ author_avatar: undefined, url: undefined }))
      )
      expect(result.current.avatar).toBe('')
    })

    it('有 author_avatar 时原样带出', () => {
      const { result } = renderHook(() =>
        usePostPresentation(makeItem({ author_avatar: 'https://x/me.jpg' }))
      )
      expect(result.current.avatar).toBe('https://x/me.jpg')
    })

    it('url 是相对路径时不再打成片 404——faviconUrl 拒绝它,avatar 走字母 fallback', () => {
      // 部分源产出的 item.url 只是路径（如 /1247347556/404054602），后端 resolveFavicon 解析
      // 不出站点 → 404。三级回退里 faviconUrl 这级必须把它拦在门外（返回 undefined），
      // avatar 最终是空串，渲染端显示字母块而不是发一个注定 404 的请求。
      const { result } = renderHook(() =>
        usePostPresentation(makeItem({ author_avatar: undefined, url: '/1247347556/404054602' }))
      )
      expect(result.current.avatar).toBe('')
    })

    it('stream_id 命中品牌表时用订阅源品牌图标(同源共享同一 URL,可缓存)', () => {
      // 主修：头像回退优先查 SOURCE_META（bilibili → https://www.bilibili.com）。
      // 同一 stream 的所有行共享这一个 URL → 浏览器 HTTP 缓存真正命中。
      const { result } = renderHook(() =>
        usePostPresentation(makeItem({ stream_id: 'rsshub:bilibili/user/video/1', url: '/rel/path' }))
      )
      expect(result.current.avatar).toBe('/api/media/image?site=https%3A%2F%2Fwww.bilibili.com')
    })
  })
})
