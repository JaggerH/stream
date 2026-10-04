// 瀑布流卡片的契约:它只承担"这条值不值得点开"的判断,不是列表行的窄版。
// 三条:无图条目画成纯文字卡(不造假封面)、视频只出封面不内联播放、点卡片开详情。
// 另加一条:不渲染条目类型 badge。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PostCard } from './PostCard.tsx'
import { AudioStageContext, type AudioStage } from '../../lib/audioStage.ts'
import { DEFAULT_MEDIA_ASPECT, DEFAULT_MEDIA_RATIO, MEDIA_RATIO_MAX, MEDIA_RATIO_MIN } from '../../lib/masonry.ts'
import { clearMediaSizes } from '../../lib/mediaSize.ts'
import type { Item } from '../../lib/types.ts'

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'i1', stream_id: 's1', type: 'rss', title: '标题',
    author: '作者', timestamp: '2026-07-29T00:00:00.000Z', fetched_at: '2026-07-29T00:00:00.000Z',
    ...over,
  } as Item
}

// 和 PostItemRow.audio.test.tsx / postPresentation.test.tsx 同一份 stub——真实的
// AudioStageContext 值，而不是绕开 hook 手写一份音频轨播放开关。
function makeStage(over: Partial<AudioStage> = {}): AudioStage {
  return {
    current: null, playing: false, duration: 0, activeKind: 'music',
    queues: { music: [], podcast: [] }, queue: [],
    play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {},
    getVolume: () => 1, setVolume: () => {},
    ...over,
  }
}

const noop = () => {}

const renderCard = (item: Item, over: Partial<Parameters<typeof PostCard>[0]> = {}) =>
  render(<PostCard item={item} onOpen={noop} {...over} />)

// 音频条目要经过真实的 AudioStageContext 才会产出播放控件（usePostPresentation 在没有
// 舞台时直接把 audioTrack 置空——PostCard.test.tsx 其余用例故意留在 provider 外，
// 这里显式包一层）。
const renderAudioCard = (item: Item, over: Partial<Parameters<typeof PostCard>[0]> = {}, stage: AudioStage = makeStage()): ReturnType<typeof render> =>
  render(
    <AudioStageContext.Provider value={stage}>
      <PostCard item={item} onOpen={noop} {...over} />
    </AudioStageContext.Provider>
  )

function makeAudioItem(over: Partial<Item> = {}): Item {
  return makeItem({
    content: {
      archetype: 'audio',
      media: [{ kind: 'audio', url: 'https://x/ep.mp3', poster: 'https://x/cover.jpg' }],
    } as never,
    ...over,
  })
}

// 没有 poster 的播客单集——播客 RSS 里这是常态,不是边角料。makeAudioItem 一直带着封面,
// 于是"封面分支之外还有没有播放入口"这件事从来没被测过。
function makeCoverlessAudioItem(over: Partial<Item> = {}): Item {
  return makeItem({
    content: {
      archetype: 'audio',
      media: [{ kind: 'audio', url: 'https://x/ep.mp3', duration_s: 125 }],
    } as never,
    ...over,
  })
}

// 尺寸缓存是模块级 Map，会跨用例串味（前一条学到的比例让后一条不再走占位分支）。
beforeEach(() => clearMediaSizes())

describe('PostCard', () => {
  it('无图条目画成纯文字卡:没有封面框,标题和摘要还在', () => {
    const { container } = renderCard(makeItem({ body_text: '一段正文' }))
    expect(container.querySelector('[data-slot="card-media"]')).toBeNull()
    expect(screen.getByText('标题')).toBeTruthy()
    expect(screen.getByText(/一段正文/)).toBeTruthy()
  })

  it('有图条目渲染封面框,且封面带上原图宽高比(瀑布流靠它定列高,不能等图片加载完才定)', () => {
    // mediaPreviews 读的是 w/h，不是 width/height（feedPresent.ts）——原 fixture 用错了
    // 字段名，ratio 在 usePostPresentation 里全程是 undefined，aspect-ratio 这条路径
    // 一次都没跑过。瀑布流一旦漏了 aspect-ratio，列高度会等图片真正加载完才跳一下，
    // 这正是瀑布流布局最怕的抖动。
    const item = makeItem({ content: { media: [{ kind: 'image', url: 'https://x/a.jpg', w: 800, h: 600 }] } as never })
    const { container } = renderCard(item)
    const media = container.querySelector('[data-slot="card-media"]') as HTMLElement | null
    expect(media).toBeTruthy()
    expect(media!.style.aspectRatio).toBe('800 / 600')
  })

  // 活体量出来的坑:134 张有封面的卡里 78 张没有内建宽高。当时渲染端对这些卡不传 ratio,
  // 框子塌成 auto(图没加载完就是 0 高,实测 60 张当场为 0),而估高器已经按默认比例
  // 274×1.25≈342px 记了账——列高实测最多差 2429px(23.8%),且图片加载完成时整列会跳一下。
  // 所以这条钉的是**两端用同一个默认比例**,不是"有没有 aspect-ratio"。
  it('封面缺内建宽高时退到估高器同款默认比例(不能让框子塌成 auto)', () => {
    const item = makeItem({ content: { media: [{ kind: 'image', url: 'https://x/a.jpg' }] } as never })
    const { container } = renderCard(item)
    const media = container.querySelector('[data-slot="card-media"]') as HTMLElement | null
    expect(media).toBeTruthy()
    expect(media!.style.aspectRatio).toBe(DEFAULT_MEDIA_ASPECT)
    // 同一个数:估高器给缺尺寸的图预留 colWidth × DEFAULT_MEDIA_RATIO,CSS 侧就得占住同样的高。
    const [w, h] = DEFAULT_MEDIA_ASPECT.split('/').map((n) => Number(n.trim()))
    expect(h / w).toBeCloseTo(DEFAULT_MEDIA_RATIO, 5)
  })

  // 比例三档：学到的 > 声明的 > 占位。学到的必须压过声明的——实测有条目把短视频的
  // 1080×1920 挂到了 4:3 的封面图上，照声明画就是把图裁成不属于它的形状。
  it('图片加载后用真实比例覆盖条目声明的尺寸(声明的那份被证伪过)', () => {
    const item = makeItem({
      content: { media: [{ kind: 'image', url: 'https://x/wrong.jpg', w: 1080, h: 1920 }] } as never,
    })
    const { container } = renderCard(item)
    const media = () => container.querySelector('[data-slot="card-media"]') as HTMLElement
    // 加载前：先信声明的（竖版 1.78，出带，夹到上界）
    expect(media().style.aspectRatio).toBe(`1 / ${MEDIA_RATIO_MAX}`)
    const img = media().querySelector('img') as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 1600, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true })
    fireEvent.load(img)
    // 加载后：真实的横版赢
    expect(media().style.aspectRatio).toBe('1600 / 1200')
  })

  it('学到的尺寸进缓存,同一张图第二次渲染直接就位(只重排一次)', () => {
    const item = makeItem({ content: { media: [{ kind: 'image', url: 'https://x/learn.jpg' }] } as never })
    const first = renderCard(item)
    const m1 = first.container.querySelector('[data-slot="card-media"]') as HTMLElement
    // 没有任何尺寸时先用占位比例
    expect(m1.style.aspectRatio).toBe(DEFAULT_MEDIA_ASPECT)
    const img = m1.querySelector('img') as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 900, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true })
    fireEvent.load(img)
    expect(m1.style.aspectRatio).toBe('900 / 600')
    // 第二次渲染（换个卡片实例，同一个 src）——直接命中缓存，不再从占位比例跳一次
    first.unmount()
    const second = renderCard(item)
    const m2 = second.container.querySelector('[data-slot="card-media"]') as HTMLElement
    expect(m2.style.aspectRatio).toBe('900 / 600')
  })

  // 封面比例带：全量实测分布是双峰(横版 16:9 一带 45%、竖版 9:16 一带 36%、正方形 0 张),
  // 所以不固定成一个比例;但也不能放任——9:16 原样长出来就是 266px 的列里一根 472px 的塔。
  const aspectOf = (item: Item) => {
    const { container } = renderCard(item)
    return (container.querySelector('[data-slot="card-media"]') as HTMLElement).style.aspectRatio
  }
  const imgItem = (w: number, h: number, url: string) =>
    makeItem({ content: { media: [{ kind: 'image', url, w, h }] } as never })

  it('竖屏短视频封面(9:16)夹到带的上界——它是最需要被夹的那一族(占 36%)', () => {
    expect(aspectOf(imgItem(1080, 1920, 'https://x/v.jpg'))).toBe(`1 / ${MEDIA_RATIO_MAX}`)
  })

  it('横版 16:9 正好落在带的下界,一刀不裁(占 45%,不能为了整齐把它切了)', () => {
    expect(aspectOf(imgItem(1920, 1080, 'https://x/h.jpg'))).toBe('1920 / 1080')
  })

  it('比 16:9 还扁的横幅图夹到下界,不许缩成一条缝', () => {
    expect(aspectOf(imgItem(3000, 500, 'https://x/banner.jpg'))).toBe(`1 / ${MEDIA_RATIO_MIN}`)
  })

  it('带内的比例原样还原(带的意义是收窄范围,不是把所有图变成同一个形状)', () => {
    expect(aspectOf(imgItem(1000, 750, 'https://x/mid.jpg'))).toBe('1000 / 750')   // 0.75 = 中位数
  })

  it('视频条目只出封面 + 视频角标,不挂 <video>(网格里不内联播放)', () => {
    const item = makeItem({
      content: { archetype: 'video', media: [{ kind: 'video', url: 'https://x/a.mp4', poster: 'https://x/p.jpg' }] } as never,
    })
    const { container } = renderCard(item)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('[data-slot="post-card-video-badge"]')).toBeTruthy()
  })

  it('点卡片打开详情', () => {
    const onOpen = vi.fn()
    renderCard(makeItem(), { onOpen })
    fireEvent.click(screen.getByRole('button', { name: /标题/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  // 原稿断言 textContent !== 'rss':哪怕卡片渲了一个内容是别的字符串的 badge 也会通过,
  // 测不出"有没有 badge"这件事本身。这里直接断言整个 badge slot 不存在——真的会随实现
  // "加了个 badge" 而失败,对齐设计意图"一屏 30 个 badge 是噪音,直接砍掉"。
  it('不渲染条目类型 badge(一屏 30 个 badge 是噪音)', () => {
    const { container } = renderCard(makeItem({ type: 'rss' as never }))
    expect(container.querySelector('[data-slot="badge"]')).toBeNull()
  })

  it('没有封面的音频条目照样有播放按钮和时长(播放能力不能挂在"有没有图"上)', () => {
    const play = vi.fn()
    const { container } = renderAudioCard(makeCoverlessAudioItem(), {}, makeStage({ play }))
    // 前提:这确实是一张没有封面框的卡——否则下面测到的是封面分支里那个按钮
    expect(container.querySelector('[data-slot="card-media"]')).toBeNull()
    fireEvent.click(screen.getByLabelText('播放'))
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2:05')).toBeTruthy()
  })

  it('视频卡的时长角标读条目自己的 video 媒体(audioTrack 在视频上恒为 null,读它永远画不出来)', () => {
    const item = makeItem({
      content: {
        archetype: 'video',
        media: [{ kind: 'video', url: 'https://x/a.mp4', poster: 'https://x/p.jpg', duration_s: 125 }],
      } as never,
    })
    const { container } = renderCard(item)
    expect(container.querySelector('[data-slot="post-card-video-badge"]')).toBeTruthy()
    expect(screen.getByText('2:05')).toBeTruthy()
  })

  // 短标题曾经飘在卡片中间：acrylic 的 CardTitle 自带 self-center（为 CardHeader 的横排设计），
  // 到了 flex-col 的卡片里交叉轴是水平的，标题盒子缩到文字宽再居中——实测 leftGap 40.7px，
  // 而摘要/作者行都是 12px。jsdom 量不出 flex 布局，所以这条钉的是"覆盖类还在不在"。
  it('标题左对齐:必须覆盖掉 CardTitle 自带的 self-center', () => {
    const { container } = renderCard(makeItem({ title: '短' }))
    const title = container.querySelector('[data-slot="card-title"]')!
    expect(title.className).toContain('self-stretch')
  })

  // 转发帖（雪球的 timeline 实测 55/55 条都是转发/回复）：本帖只是一句评论，被转发的原帖
  // 才是它在说什么。原来卡片只画本帖那句，原帖整个不见——一句"你好好看看王宁自己说的吧"
  // 脱离原帖就是一张读不懂的卡。所以画成卡中卡（acrylic 的 nestedSurface 机制，不是自描边）。
  it('转发帖把原帖画成嵌套引用卡:作者和原文都在，且确实是一层更深的 Card', () => {
    const item = makeItem({
      title: '',
      content: { archetype: 'forward', text: '我的评论', quoted: { author: '原作者', text: '原帖正文' } } as never,
    })
    const { container } = renderCard(item)
    const quote = container.querySelector('[data-post-card-quote]')
    expect(quote).toBeTruthy()
    // 嵌套着色是 `[data-nested-surface="true"] [data-slot="card"]` 这条 CSS 规则给的，
    // 两个条件缺一就退成"和外卡同色=看不见"。所以两端都钉住:引用块自己必须是一张真 Card
    // (data-slot 不能被覆盖掉)，且外面得有一层声明过的面。
    expect(quote!.getAttribute('data-slot')).toBe('card')
    expect(quote!.parentElement!.closest('[data-nested-surface="true"]')).toBeTruthy()
    expect(quote!.textContent).toContain('原作者')
    expect(quote!.textContent).toContain('原帖正文')
    // 本帖那句还在正文位置，没被引用块挤掉
    expect(screen.getByText(/我的评论/)).toBeTruthy()
  })

  it('转发语为空时原帖只出现一次(摘要会回落到原帖正文,回落的那份必须让位给引用卡)', () => {
    const item = makeItem({
      title: '',
      content: { archetype: 'forward', quoted: { author: '原作者', text: '原帖正文' } } as never,
    })
    const { container } = renderCard(item)
    expect(container.querySelectorAll('[data-post-card-quote]')).toHaveLength(1)
    expect(screen.getAllByText(/原帖正文/)).toHaveLength(1)
    expect(container.querySelector('[data-slot="card-description"]')).toBeNull()
  })

  it('不是转发的条目不画引用卡', () => {
    const { container } = renderCard(makeItem({ body_text: '一段正文' }))
    expect(container.querySelector('[data-post-card-quote]')).toBeNull()
  })

  // 「没有头像时不渲染空 src 的 <img>」这条**故意不在这里测**:Radix 的 AvatarImage 只在
  // 图片 loaded 后才吐 <img>,而 jsdom 永远不触发 load——所以在这一层断言"没有 <img>",
  // 加不加 avatar 守卫都会通过,是一条永远失败不了的用例。真正能失败的断言在
  // lib/postPresentation.test.tsx:「没有头像也没有 url 时 avatar 是空串」。
})

// Critical(finding 1):根节点 onKeyDown 原来只看 event.key,不看 event.target——嵌套的音频
// 按钮/外链拿到焦点后按 Enter/Space,keydown 冒泡到根节点,根节点会 preventDefault 并直接
// onOpen(item),把嵌套控件自己的原生激活语义(链接跳转、按钮点击)整个吃掉。这里的用例既
// 钉键盘路径也钉鼠标路径,四个都要绿:鼠标点击本就该被各自的 onClick stopPropagation 挡住
// (对着旧代码也早已成立,不是这次修的);键盘 Enter 才是这次修的东西——对着旧代码运行会
// 失败(见 fix pass 1 报告里贴的 revert 验证)。
describe('PostCard — 嵌套控件不该被卡片根节点的键盘/点击处理抢走', () => {
  it('点音频播放按钮:音频真的开始播放,且不打开详情', () => {
    const onOpen = vi.fn()
    const play = vi.fn()
    renderAudioCard(makeAudioItem(), { onOpen }, makeStage({ play }))
    fireEvent.click(screen.getByLabelText('播放'))
    expect(play).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('在音频播放按钮上按 Enter 不打开详情', () => {
    const onOpen = vi.fn()
    renderAudioCard(makeAudioItem(), { onOpen })
    fireEvent.keyDown(screen.getByLabelText('播放'), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  // 封面上那个 hover 浮出的外链已经搬进右键菜单（见 itemActions.test.tsx），所以这里不再有
  // 「点外链/在外链上按 Enter」两条。**上面音频按钮那两条守的是同一个不变量**（根节点的 keydown
  // 必须用 event.target 守卫，否则会吃掉嵌套控件自己的激活语义），它没有跟着一起没。
})
