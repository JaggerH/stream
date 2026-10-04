import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopDriver, Rect, ScreenText, SeeElement, ImageHit, WindowCapture } from './desktop-driver.ts'
import type { LlmForTask } from '../llm/task.ts'
import { SeeCache } from './see-cache.ts'
import { regionRect, inRegion, pickText, pickTextDetailed, pickElement, toScreen, annotateMarks, cropTemplate, makeSeeResolver, parsePoint, pickHandle, TEMPLATE_MIN_SCORE } from './desktop-see.ts'

const win = { x: 100, y: 200, w: 900, h: 600 }

describe('desktop-see 纯函数', () => {
  it('regionRect：九宫格按窗口尺寸切，undefined = 整窗', () => {
    const inside = (rect: object) => ({ rect, exclude: false })
    expect(regionRect(undefined, win)).toEqual(inside({ x: 0, y: 0, w: 900, h: 600 }))
    expect(regionRect('top', win)).toEqual(inside({ x: 0, y: 0, w: 900, h: 200 }))
    expect(regionRect('top-left', win)).toEqual(inside({ x: 0, y: 0, w: 300, h: 200 }))
    expect(regionRect('bottom-right', win)).toEqual(inside({ x: 600, y: 400, w: 300, h: 200 }))
    expect(regionRect('center', win)).toEqual(inside({ x: 300, y: 200, w: 300, h: 200 }))
    // 比例矩形：排除顶上 10% 那条搜索栏（QQ 搜索结果就在它下面，not-top 会连结果一起排掉）
    expect(regionRect({ x: 0, y: 0.1, w: 1, h: 0.9 }, win)).toEqual(inside({ x: 0, y: 60, w: 900, h: 540 }))
    // 排除档 = 那一侧三分之一的补集
    expect(regionRect('not-left', win)).toEqual({ rect: { x: 0, y: 0, w: 300, h: 600 }, exclude: true })
    expect(regionRect('not-top', win)).toEqual({ rect: { x: 0, y: 0, w: 900, h: 200 }, exclude: true })
  })
  it('regionRect：dip 矩形按 scale 换成物理像素，不随窗口尺寸走；w/h 省略 = 到窗口边', () => {
    const inside = (rect: object) => ({ rect, exclude: false })
    // 微信左栏 335 逻辑像素、标题条 80 逻辑像素：同一份区域在 1600 宽 1× 和 3838 宽 2× 的窗上都罩住标题
    const bar = { unit: 'dip' as const, x: 340, y: 0, h: 80 }
    expect(regionRect(bar, { x: 0, y: 0, w: 1600, h: 900 }, 1)).toEqual(inside({ x: 340, y: 0, w: 1260, h: 80 }))
    expect(regionRect(bar, { x: 0, y: 0, w: 3838, h: 2062 }, 2)).toEqual(inside({ x: 680, y: 0, w: 3158, h: 160 }))
    // 比例矩形不吃 scale
    expect(regionRect({ x: 0.2, y: 0, w: 0.8, h: 0.1 }, win, 2)).toEqual(inside({ x: 180, y: 0, w: 720, h: 60 }))
    // 负的 x/y 从右下边往回量：底部输入栏「下沿往上 240 逻辑像素起」在两种窗高下都贴着底
    expect(regionRect({ unit: 'dip', x: 340, y: -240 }, { x: 0, y: 0, w: 1600, h: 900 }, 1)).toEqual(inside({ x: 340, y: 660, w: 1260, h: 240 }))
    expect(regionRect({ unit: 'dip', x: 340, y: -240 }, { x: 0, y: 0, w: 3838, h: 2062 }, 2)).toEqual(inside({ x: 680, y: 1582, w: 3158, h: 480 }))
    // 越出窗口就夹在窗口内，不给负宽
    expect(regionRect({ unit: 'dip', x: 1000, y: 0, w: 50 }, win, 1)).toEqual(inside({ x: 900, y: 0, w: 0, h: 600 }))
  })
  it('not-left：左栏里的不算、左栏以外任何位置都算（微信会话标题落在中间三分之一）', () => {
    const area = regionRect('not-left', win)
    expect(inRegion({ x: 100, y: 50, w: 40, h: 20 }, area)).toBe(false) // 搜索框：左栏里
    expect(inRegion({ x: 350, y: 50, w: 40, h: 20 }, area)).toBe(true) // 会话标题：中间三分之一
    expect(inRegion({ x: 800, y: 550, w: 40, h: 20 }, area)).toBe(true) // 右下角也算
    expect(inRegion({ x: 290, y: 0, w: 30, h: 10 }, area)).toBe(true) // 中心 305 > 300，已在栏外
  })
  it('inRegion 看中心点', () => {
    expect(inRegion({ x: 290, y: 0, w: 30, h: 10 }, regionRect('top-left', win))).toBe(false) // 中心 305 > 300
    expect(inRegion({ x: 280, y: 0, w: 30, h: 10 }, regionRect('top-left', win))).toBe(true)
  })
  it('pickText：全等优先于包含；多命中 → null（不猜）；region 外不算', () => {
    const texts = [
      { text: '搜索', rect: { x: 10, y: 10, w: 40, h: 20 } },
      { text: '搜索历史', rect: { x: 10, y: 400, w: 80, h: 20 } },
    ]
    expect(pickText(texts, '搜索', regionRect(undefined, win))).toEqual({ x: 10, y: 10, w: 40, h: 20 })
    expect(pickText(texts, '历史', regionRect(undefined, win))).toEqual({ x: 10, y: 400, w: 80, h: 20 })
    expect(pickText([...texts, { text: '搜索', rect: { x: 500, y: 10, w: 40, h: 20 } }], '搜索', regionRect(undefined, win))).toBeNull()
    expect(pickText(texts, '搜 索', regionRect(undefined, win))).toEqual({ x: 10, y: 10, w: 40, h: 20 }) // 去空白
    // region 是前置过滤，区域外的全等命中不否决区域内的包含命中
    expect(pickText(texts, '搜索', regionRect('bottom', win))).toEqual({ x: 10, y: 400, w: 80, h: 20 })
    expect(pickText(texts, '搜索历史', regionRect('top', win))).toBeNull() // region 外不算：命中不在 top 区域内
  })

  /**
   * `not`：**按行**排除。这是 QQ 那个「有时点到全网搜索」的根治法——两行都写着联系人名，
   * 靠位置分不开（名字长一点就错位），而"那一行里带着『进入全网搜索』"是稳定的语义区别。
   *
   * 关键在**按行**：OCR 的分段每帧都不一样，兜底行有时整段、有时被切成两半，只按段剔会
   * 留下后半段那个和目标全等的假候选（本机 2026-09-07 实录：真行 x=121，假候选 x=210）。
   */
  it('not：整行带了这几个字，这一行的段全部出局', () => {
    const area = regionRect(undefined, win)
    // 兜底行**没被切**：一整段
    const whole = [
      { text: '我的手机', rect: { x: 121, y: 104, w: 62, h: 18 } },
      { text: '进入全网搜索我的手机', rect: { x: 121, y: 175, w: 158, h: 18 } },
    ]
    expect(pickText(whole, '我的手机', area, undefined, ['进入全网搜索'])).toEqual(whole[0].rect)
    // 兜底行**被切成两段**：后半段和目标全等——只按段剔会漏掉它，按行剔不会
    const split = [
      { text: '我的手机', rect: { x: 121, y: 104, w: 62, h: 18 } },
      { text: '进入全网搜索', rect: { x: 121, y: 175, w: 99, h: 18 } },
      { text: '我的手机', rect: { x: 210, y: 175, w: 64, h: 18 } },
    ]
    expect(pickTextDetailed(split, '我的手机', area)).toEqual({ kind: 'ambiguous', count: 2, first: split[0].rect })
    expect(pickText(split, '我的手机', area, undefined, ['进入全网搜索'])).toEqual(split[0].rect)
    // 同一行的判据是纵向重叠过半，不是 y 相等：时间戳字号小、顶边差几像素，照样算同一行
    const withTime = [
      ...split,
      { text: '14:54', rect: { x: 265, y: 178, w: 32, h: 13 } },
    ]
    expect(pickText(withTime, '我的手机', area, undefined, ['进入全网搜索'])).toEqual(split[0].rect)
    // 没给 not 就什么都不排
    expect(pickText(whole, '我的手机', area, undefined, undefined)).toEqual(whole[0].rect)
  })

  /**
   * 「一个都没有」和「不止一个」是两回事，`pickText` 把两者都压成 null，于是上层分不出来。
   * 活体 2026-09-07：QQ 兜底行「进入全网搜索我的手机」被 OCR 切成两段，后半段与真会话行
   * 全等 → 两条全等 → screen 段如实拒绝，却被后面的模板段用上一轮的旧图接住点了下去。
   * 歧义必须能被上层认出来，才谈得上"歧义时不落模板段"。
   */
  it('pickTextDetailed 把「没有」和「不止一个」分开', () => {
    const area = regionRect(undefined, win)
    const one = [{ text: '我的手机', rect: { x: 121, y: 104, w: 62, h: 18 } }]
    expect(pickTextDetailed(one, '我的手机', area)).toEqual({ kind: 'hit', rect: one[0].rect })
    expect(pickTextDetailed(one, '别人', area)).toEqual({ kind: 'none' })
    // 兜底行被切开之后的真实形状：两条全等
    const split = [...one, { text: '我的手机', rect: { x: 210, y: 175, w: 64, h: 18 } }]
    // `first` = 识别层次序里的第一个，只是"其中一个"，给判据路进 trace 用（见 `Pick` 的头注）。
    expect(pickTextDetailed(split, '我的手机', area)).toEqual({ kind: 'ambiguous', count: 2, first: one[0].rect })
    // 包含档同样要报歧义，别悄悄退回 none
    const partial = [
      { text: '我的手机A', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { text: '我的手机B', rect: { x: 0, y: 50, w: 10, h: 10 } },
    ]
    expect(pickTextDetailed(partial, '我的手机', area)).toEqual({ kind: 'ambiguous', count: 2, first: partial[0].rect })
  })
  it('pickText 按小标题分节：网络建议里全等的那条不算，「功能」下面的才算', () => {
    // 微信搜索候选弹层（本机 2026-09-07 实测布局）：第一条网页建议就是你打的字本身
    const popover = [
      { text: '搜索网络结果', rect: { x: 124, y: 39, w: 140, h: 24 } },
      { text: '文件传输助手', rect: { x: 117, y: 103, w: 160, h: 27 } },
      { text: '文件传输助手打开', rect: { x: 117, y: 171, w: 200, h: 27 } },
      { text: '功能', rect: { x: 72, y: 443, w: 48, h: 24 } },
      { text: '文件传输助手', rect: { x: 161, y: 536, w: 167, h: 27 } },
      { text: '收藏', rect: { x: 72, y: 640, w: 48, h: 24 } },
      { text: '来自：文件传输助手', rect: { x: 84, y: 805, w: 200, h: 24 } },
    ]
    const all = regionRect(undefined, { x: 0, y: 0, w: 736, h: 904 })
    const sections = { below: ['联系人', '群聊', '公众号', '功能'], notBelow: ['搜索网络结果', '聊天记录', '收藏'] }
    expect(pickText(popover, '文件传输助手', all, sections)).toEqual({ x: 161, y: 536, w: 167, h: 27 })
    // 不分节：两条全等 → 不猜
    expect(pickText(popover, '文件传输助手', all)).toBeNull()
    // 只允许「联系人」：弹层里没有这一节 → 没有候选
    expect(pickText(popover, '文件传输助手', all, { below: ['联系人'], notBelow: sections.notBelow })).toBeNull()
    // 小标题上方没有任何已知小标题的段不算（弹层最顶上那条）
    expect(pickText([{ text: 'X', rect: { x: 0, y: 0, w: 10, h: 10 } }, ...popover], 'X', all, sections)).toBeNull()
  })
  it('pickElement：语义同 pickText，但**无名的元素一律不参与匹配**', () => {
    const els: SeeElement[] = [
      { rect: { x: 10, y: 10, w: 60, h: 24 }, name: '发送', kind: 'detector' },
      { rect: { x: 100, y: 10, w: 24, h: 24 }, kind: 'detector' }, // 只有图标，没名字
      { rect: { x: 10, y: 400, w: 90, h: 24 }, name: '发送文件', kind: 'text' },
    ]
    const all = regionRect(undefined, win)
    expect(pickElement(els, '发送', all)).toEqual({ x: 10, y: 10, w: 60, h: 24 }) // 全等优先
    expect(pickElement(els, '文件', all)).toEqual({ x: 10, y: 400, w: 90, h: 24 }) // 包含
    // **这一条是这个函数存在的理由**：把缺席的 name 当成空串，`''.includes('')` 与 `'' === ''`
    // 都成立，一次空查询就会静默命中那个无名图标（然后点在一个谁也说不清的地方）。
    expect(pickElement(els, '', all)).toBeNull()
    // 无名的既不命中、也不参与"多命中就拒绝"的计数——它压根不在候选里
    expect(pickElement([els[1]], 'x', all)).toBeNull()
    // 同档多命中仍然拒绝
    expect(pickElement([els[0], { ...els[0], rect: { x: 500, y: 10, w: 60, h: 24 } }], '发送', all)).toBeNull()
  })
  it('pickElement 按小标题分节：小标题自己就是元素表里的一条（落单即入表）', () => {
    // 微信候选弹层，这一次读的是**元素表**：小标题「功能」没有被任何检测器框包住，
    // 于是它自成一条 kind:'text' 的元素，名字就是那两个字——所以分节不需要再读一次文字表。
    const els: SeeElement[] = [
      { rect: { x: 124, y: 39, w: 140, h: 24 }, name: '搜索网络结果', kind: 'text' },
      { rect: { x: 117, y: 103, w: 160, h: 27 }, name: '文件传输助手', kind: 'detector' },
      { rect: { x: 72, y: 443, w: 48, h: 24 }, name: '功能', kind: 'text' },
      { rect: { x: 161, y: 530, w: 400, h: 40 }, name: '文件传输助手', kind: 'detector' },
    ]
    const all = regionRect(undefined, { x: 0, y: 0, w: 736, h: 904 })
    const sections = { below: ['联系人', '群聊', '公众号', '功能'], notBelow: ['搜索网络结果', '聊天记录', '收藏'] }
    // 命中的是「功能」下面那一条，而且拿到的是**元素框**（整行 400×40），不是文字框
    expect(pickElement(els, '文件传输助手', all, sections)).toEqual({ x: 161, y: 530, w: 400, h: 40 })
    expect(pickElement(els, '文件传输助手', all)).toBeNull() // 不分节：两条全等 → 不猜
  })
  it('toScreen 只加窗口原点，不除 scale', () => {
    expect(toScreen({ x: 10, y: 20, w: 5, h: 5 }, win)).toEqual({ x: 110, y: 220, w: 5, h: 5 })
  })
  it('annotateMarks 输出同尺寸 JPEG；cropTemplate 输出框尺寸的 PNG', async () => {
    const base = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer()
    const marked = await annotateMarks(base, [{ x: 10, y: 10, w: 50, h: 20 }, { x: 100, y: 40, w: 30, h: 30 }])
    const meta = await sharp(marked).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([200, 100, 'jpeg'])
    const tpl = await cropTemplate(base, { x: 10, y: 10, w: 50, h: 20 })
    const tm = await sharp(tpl).metadata()
    expect([tm.width, tm.height, tm.format]).toEqual([50, 20, 'png'])
  })
})

const WIN = { x: 100, y: 50, w: 300, h: 150 }
async function whiteJpeg() {
  return sharp({ create: { width: 300, height: 150, channels: 3, background: '#fff' } }).jpeg().toBuffer()
}
/** 一次读屏的两张表。`screen: null`（显式）= agent 不支持读屏；不给 = 同样不支持。 */
interface FakeScreen { texts?: ScreenText[]; elements?: SeeElement[]; window: Rect; scale: number }
function seeDriver(o: {
  find?: (q: unknown) => Array<{ ref: string; rect: Rect }>
  screen?: FakeScreen | null
  /** 第 n 次读屏换一份回执（造"两次读之间窗口尺寸变了"那一档）。 */
  screens?: Array<FakeScreen | null>
  image?: ImageHit | null
  /** 覆盖 `captureWindow` 的回执——用来造"两次抓拍之间窗口变了尺寸"那一档。 */
  capture?: WindowCapture | null
}) {
  const calls: string[] = []
  /** 每次读屏下推下去的 region（`undefined` = 整窗）——region 有没有真的下推，只有这里验得到。 */
  const regions: Array<Rect | undefined> = []
  const icons: boolean[] = []
  let reads = 0
  const next = (): FakeScreen | null => {
    const s = o.screens ? (o.screens[Math.min(reads, o.screens.length - 1)] ?? null) : (o.screen ?? null)
    reads++
    return s
  }
  const d = {
    async find(q: unknown) { calls.push('find'); return { elements: (o.find?.(q) ?? []).map((e) => ({ ...e, role: 'Button', name: '', className: '' })) } },
    async captureWindow(): Promise<WindowCapture | null> {
      calls.push('captureWindow')
      if (o.capture !== undefined) return o.capture
      return { jpeg: await whiteJpeg(), window: WIN, scale: 2 }
    },
    async readText(region?: Rect) {
      calls.push('readText'); regions.push(region)
      const s = next()
      return s && { texts: s.texts ?? [], window: s.window, scale: s.scale }
    },
    async readElements(opts?: { region?: Rect; icons?: boolean }) {
      calls.push('readElements'); regions.push(opts?.region); icons.push(opts?.icons === true)
      const s = next()
      return s && { elements: s.elements ?? [], window: s.window, scale: s.scale }
    },
    async findImage() { calls.push('findImage'); return o.image ?? null },
  } as unknown as DesktopDriver
  return { d, calls, regions, icons }
}
/** 一段文字 + 一条同框的 `kind:'text'` 元素——"落单即入表"下，两张表对同一段字的说法。 */
const both = (text: string, rect: Rect): FakeScreen => ({ texts: [{ text, rect }], elements: [{ name: text, rect, kind: 'text' }], window: WIN, scale: 2 })
/** 12 条元素（y 逐行排开，全在整窗内）——够给模型编到 12 号，parseMark 的边界才验得动。
 *  候选框现在只从元素表来，所以这里给的是元素不是文字。 */
const twelveElements = (): FakeScreen => ({
  elements: Array.from({ length: 12 }, (_, i) => ({ name: `T${i + 1}`, rect: { x: 0, y: i * 10, w: 20, h: 10 }, kind: 'text' as const })),
  window: WIN, scale: 2,
})
const READ = { allowModel: false, mode: 'read' } as const
const ACT = { allowModel: true, mode: 'action' } as const
const llmAnswer = (content: string): LlmForTask => async () => ({ content, raw: {} } as never)

describe('resolveSee 四段梯子', () => {
  it('a11y 段命中就停：不截图、不读屏', async () => {
    const { d, calls } = seeDriver({ find: () => [{ ref: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } }] })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '搜索' }, ACT)
    expect(hit).toMatchObject({ via: 'a11y', a11yRef: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } })
    expect(calls).toEqual(['find'])
  })
  it('screen 段：文字框命中 → 屏幕坐标 = 截图坐标 + 窗口原点，不除 scale', async () => {
    const { d } = seeDriver({ screen: both('搜索', { x: 10, y: 20, w: 40, h: 16 }) })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '搜索' }, READ)
    expect(hit).toMatchObject({ via: 'screen', rect: { x: 110, y: 70, w: 40, h: 16 } })
  })

  // ── 二分：查哪张表由 mode 定，而 mode 由 see 出现的位置定（spec §3） ──────────────
  it('判据只查文字表，一次元素表都不问', async () => {
    const { d, calls } = seeDriver({ screen: both('文件传输助手', { x: 10, y: 20, w: 120, h: 24 }) })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '文件传输助手' }, READ)
    expect(hit).toMatchObject({ via: 'screen' })
    expect(calls.filter((c) => c.startsWith('read'))).toEqual(['readText'])
  })
  it('动作只查元素表，拿到的是元素框（整个可点区域）不是文字框', async () => {
    // 蓝底蓝字的「发送」：文字表里那一格只圈住两个字，元素表里才是整个按钮。
    const { d, calls } = seeDriver({
      screen: {
        texts: [{ text: '发送', rect: { x: 210, y: 120, w: 28, h: 14 } }],
        elements: [{ name: '发送', rect: { x: 200, y: 112, w: 60, h: 30 }, kind: 'detector' }],
        window: WIN, scale: 2,
      },
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '发送' }, { allowModel: false, mode: 'action' })
    expect(hit).toMatchObject({ via: 'screen', rect: { x: 300, y: 162, w: 60, h: 30 } })
    expect(calls.filter((c) => c.startsWith('read'))).toEqual(['readElements'])
  })
  it('同一个 see 在两条路上各有各的缓存键：判据种的文字模板不会被动作路当靶子', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const screen: FakeScreen = {
      texts: [{ text: '发送', rect: { x: 210, y: 120, w: 28, h: 14 } }],
      elements: [{ name: '发送', rect: { x: 200, y: 112, w: 60, h: 30 }, kind: 'detector' }],
      window: WIN, scale: 2,
    }
    const r = makeSeeResolver(seeDriver({ screen }).d, 'x', { cacheDir: dir })
    await r.resolve({ text: '发送' }, READ)
    await r.resolve({ text: '发送' }, { allowModel: false, mode: 'action' })
    const cache = new SeeCache(join(dir, 'x'))
    const kRead = cache.key({ text: '发送' }, WIN, 2, 'read')
    const kAct = cache.key({ text: '发送' }, WIN, 2, 'action')
    expect(kRead).not.toBe(kAct)
    expect(cache.get(kRead)!.entry.rect).toEqual({ x: 210, y: 120, w: 28, h: 14 })
    expect(cache.get(kAct)!.entry.rect).toEqual({ x: 200, y: 112, w: 60, h: 30 })
  })
  it('动作路的 below 只读一次元素表：小标题自己就在那张表里', async () => {
    // 微信「点候选里的他」那一步：invoke + below，是动作路。plan 原本想的是"先读文字表算出
    // 允许的 y 区间、再读元素表筛"——那是两次整窗读。小标题落单即入表，所以一次就够。
    const { d, calls } = seeDriver({
      screen: {
        elements: [
          { name: '搜索网络结果', rect: { x: 124, y: 5, w: 140, h: 12 }, kind: 'text' },
          { name: '文件传输助手', rect: { x: 117, y: 20, w: 160, h: 12 }, kind: 'detector' },
          { name: '功能', rect: { x: 72, y: 60, w: 48, h: 12 }, kind: 'text' },
          { name: '文件传输助手', rect: { x: 60, y: 80, w: 200, h: 20 }, kind: 'detector' },
        ],
        window: WIN, scale: 2,
      },
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve(
      { text: '文件传输助手', below: ['联系人', '功能'], notBelow: ['搜索网络结果'] },
      { allowModel: false, mode: 'action' },
    )
    expect(hit).toMatchObject({ rect: { x: 160, y: 130, w: 200, h: 20 } })
    expect(calls.filter((c) => c.startsWith('read'))).toEqual(['readElements'])
  })
  it('无名的元素永远匹配不上：不把缺席的 name 当空串', async () => {
    const { d } = seeDriver({ screen: { elements: [{ rect: { x: 0, y: 0, w: 20, h: 20 }, kind: 'detector' }], window: WIN, scale: 2 } })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    expect(await r.resolve({ text: '发送' }, { allowModel: false, mode: 'action' })).toBeNull()
  })

  // ── region 下推 ────────────────────────────────────────────────────────────────
  it('region 下推给 agent，不在本地过滤', async () => {
    const big = { x: 0, y: 0, w: 1946, h: 1041 }
    const { d, regions, calls } = seeDriver({
      screen: { texts: [{ text: '搜索', rect: { x: 10, y: 20, w: 40, h: 16 } }], window: big, scale: 2 },
      capture: { jpeg: await whiteJpeg(), window: big, scale: 2 },
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    await r.resolve({ text: '搜索', region: { x: 0, y: 0, w: 1, h: 0.12 } }, READ)
    // 窗口宽高要先探一次（captureWindow 一次 PrintWindow，比整窗 OCR 便宜一个量级），
    // 再把比例矩形算成像素下推。
    expect(calls[0]).toBe('captureWindow')
    expect(regions[0]).toEqual({ x: 0, y: 0, w: 1946, h: 124 })
    // 九宫格档同理
    await r.resolve({ text: '搜索', region: 'top-left' }, READ)
    expect(regions[1]).toEqual({ x: 0, y: 0, w: 648, h: 347 })
  })
  it('排除档（not-left 等）下推不了——它是矩形的补集，只能整窗读 + 本地过滤', async () => {
    const { d, regions } = seeDriver({
      screen: {
        texts: [{ text: '张三', rect: { x: 10, y: 20, w: 40, h: 16 } }, { text: '张三', rect: { x: 200, y: 20, w: 40, h: 16 } }],
        window: WIN, scale: 2,
      },
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '张三', region: 'not-left' }, READ)
    expect(regions).toEqual([undefined]) // 整窗读
    expect(hit).toMatchObject({ rect: { x: 300, y: 70, w: 40, h: 16 } }) // 左栏那条被本地筛掉了
  })
  it('下推用的尺寸和实际画面对不上（窗口被缩放了）→ 按新尺寸重裁一次', async () => {
    const big = { x: 0, y: 0, w: 1000, h: 1000 }
    const small = { x: 0, y: 0, w: 500, h: 500 }
    const { d, regions } = seeDriver({
      // 探到的是大窗，两次读回来的都是小窗：第一次裁错了地方，必须按新尺寸重来一次。
      capture: { jpeg: await whiteJpeg(), window: big, scale: 2 },
      screens: [
        { texts: [], window: small, scale: 2 },
        { texts: [{ text: '搜索', rect: { x: 10, y: 20, w: 40, h: 16 } }], window: small, scale: 2 },
      ],
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '搜索', region: 'top-left' }, READ)
    expect(regions).toEqual([{ x: 0, y: 0, w: 333, h: 333 }, { x: 0, y: 0, w: 166, h: 166 }])
    expect(hit).toMatchObject({ via: 'screen', rect: { x: 10, y: 20, w: 40, h: 16 } })
  })

  it('screen 段命中顺手种模板（一次性）：下一趟 OCR 漏认时 template 段接住', async () => {
    // 活体 2026-09-07：光标停在「搜索」前面那一趟 OCR 没认出它，而模型的候选框只来自读屏——
    // 没有这张模板，一次 OCR 偶发漏认就让整条 recipe 停在第一步。
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const first = seeDriver({ screen: both('搜索', { x: 10, y: 20, w: 40, h: 16 }) })
    const r1 = makeSeeResolver(first.d, 'x', { cacheDir: dir })
    expect(await r1.resolve({ text: '搜索' }, READ)).toMatchObject({ via: 'screen' })
    expect(first.calls.filter((c) => c === 'captureWindow')).toHaveLength(1)
    // 同一趟再命中：模板已在，不再抓拍
    expect(await r1.resolve({ text: '搜索' }, READ)).toMatchObject({ via: 'screen' })
    expect(first.calls.filter((c) => c === 'captureWindow')).toHaveLength(1)
    // 下一趟 OCR 什么都没认出 → 模板接住，坐标照样是截图坐标 + 窗口原点
    const blind = seeDriver({ screen: { texts: [], window: WIN, scale: 2 }, image: { rect: { x: 10, y: 20, w: 40, h: 16 }, score: 0.97 } })
    const hit = await makeSeeResolver(blind.d, 'x', { cacheDir: dir }).resolve({ text: '搜索' }, READ)
    expect(hit).toMatchObject({ via: 'template', rect: { x: 110, y: 70, w: 40, h: 16 } })
  })
  /**
   * **多命中在两条路上是两个问题。** 动作路问"点哪一个"，两个就是不知道，必须拒；判据路问
   * "在不在"，两个照样是"在"。
   *
   * 活体 2026-09-08 的假红：消息真发出去了，正文同时命中右侧气泡和左栏会话预览（同一条消息的
   * 两处呈现），`expect` 却按动作路那条规则拒了 → recipe 报 `blocked`。**发送动作上这是最贵的
   * 一种错**——调用方看到失败会重发，于是发两遍。
   */
  it('判据路多命中 = 在（动作路照旧拒）', async () => {
    // 右侧气泡（下面那条）与左栏会话预览（上面那条）——同一条消息的两处呈现。
    // **两个框都要落在 WIN 之内**，否则 `inRegion` 会先把一个筛掉，多命中根本构造不出来。
    const bubble = { x: 180, y: 100, w: 100, h: 20 }
    const preview = { x: 10, y: 20, w: 100, h: 20 }
    const twice = {
      texts: [
        { text: '定稿0908', rect: bubble },
        { text: '定稿0908', rect: preview },
      ],
      elements: [
        { name: '定稿0908', rect: bubble, kind: 'text' as const },
        { name: '定稿0908', rect: preview, kind: 'text' as const },
      ],
      window: WIN,
      scale: 2,
    }
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const read = seeDriver({ screen: twice })
    const hit = await makeSeeResolver(read.d, 'x', { cacheDir: dir }).resolve({ text: '定稿0908' }, READ)
    // 命中，框取识别层次序里的第一个（这里是气泡那条）。**它只是"其中一个"**，判据路拿它进
    // trace 说明"在哪儿看到的"——不承诺是最靠上的那个，也不该被当成"就是这一个"去点。
    expect(hit).toMatchObject({ via: 'screen', rect: { x: 280, y: 150, w: 100, h: 20 } })
    // **不种模板**：种下去的是"其中一个"，下一轮 template 段会稳定命中它，把"在不在"偷偷
    // 变成"是不是那一个"。判据每帧现读，不需要模板兜底。判法是问后果——下一趟什么都没认出来
    // 时，若真种过模板，`findImage` 就会把它接住；没种就只能诚实地回 null。
    const later = seeDriver({ screen: { texts: [], window: WIN, scale: 2 }, image: { rect: preview, score: 0.99 } })
    expect(await makeSeeResolver(later.d, 'x', { cacheDir: dir }).resolve({ text: '定稿0908' }, READ)).toBeNull()

    // 动作路同一帧：拒绝，且不落模板段
    const act = seeDriver({ screen: twice })
    expect(await makeSeeResolver(act.d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ text: '定稿0908' }, { allowModel: false, mode: 'action' })).toBeNull()
  })
  /**
   * OCR 每帧的分段不一样：QQ 那行「进入全网搜索我的手机」有时一整段、有时被切成两段。按段
   * 匹配的判据在被切开的那些帧上**永远匹配不上**，表现成"这东西没出现"——和真的没出现一模一样。
   * 活体 2026-09-08：三轮全停在这一步，而三轮的搜索框里都好端端写着联系人名，也就是点击、
   * 焦点、打字全成了，只有判据没兑现。`not:` 早就因为同一个原因改成按行聚合，这是另一半。
   */
  it('判据路把一行拼起来再试一次（动作路不拼）', async () => {
    const split = {
      texts: [
        { text: '进入全网搜索', rect: { x: 19, y: 72, w: 60, h: 18 } },
        { text: '我的手机', rect: { x: 88, y: 75, w: 40, h: 18 } },
      ],
      elements: [
        { name: '进入全网搜索', rect: { x: 19, y: 72, w: 60, h: 18 }, kind: 'text' as const },
        { name: '我的手机', rect: { x: 88, y: 75, w: 40, h: 18 }, kind: 'text' as const },
      ],
      window: WIN,
      scale: 2,
    }
    const read = seeDriver({ screen: split })
    // 命中，框是**整行的包围盒**（两段的并）——它只进 trace 说明"在哪一行看到的"
    expect(await makeSeeResolver(read.d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ text: '进入全网搜索我的手机' }, READ))
      .toMatchObject({ via: 'screen', rect: { x: 119, y: 122, w: 109, h: 21 } })
    // 动作路不拼：拿一整行的包围盒去点，点的是行中央——那是另一回事
    const act = seeDriver({ screen: split })
    expect(await makeSeeResolver(act.d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ text: '进入全网搜索我的手机' }, { allowModel: false, mode: 'action' })).toBeNull()
  })
  it('template 段：缓存里有模板且 findImage 分数够 → 命中；分数不够 → 落到 model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const low = seeDriver({ screen: { elements: [], window: WIN, scale: 2 }, image: { rect: { x: 5, y: 5, w: 10, h: 10 }, score: TEMPLATE_MIN_SCORE - 0.01 } })
    const r0 = makeSeeResolver(low.d, 'x', { cacheDir: dir })
    // 先用 model 段把模板种进缓存
    const seeded = makeSeeResolver(seeDriver({
      screen: { elements: [{ rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'detector' }, { rect: { x: 100, y: 100, w: 20, h: 10 }, kind: 'detector' }], window: WIN, scale: 2 },
    }).d, 'x', { cacheDir: dir, llm: llmAnswer('2') })
    const first = await seeded.resolve({ icon: '右下角那个' }, ACT)
    expect(first).toMatchObject({ via: 'model', rect: { x: 200, y: 150, w: 20, h: 10 } })
    expect(seeded.modelCalls).toBe(1)
    // 第二趟：模板在，分数够 → template
    const ok = seeDriver({ screen: { elements: [], window: WIN, scale: 2 }, image: { rect: { x: 100, y: 100, w: 20, h: 10 }, score: 0.95 } })
    const hit = await makeSeeResolver(ok.d, 'x', { cacheDir: dir }).resolve({ icon: '右下角那个' }, { allowModel: false, mode: 'action' })
    expect(hit).toMatchObject({ via: 'template', rect: { x: 200, y: 150, w: 20, h: 10 } })
    // 分数不够且不许 model → null
    expect(await r0.resolve({ icon: '右下角那个' }, { allowModel: false, mode: 'action' })).toBeNull()
  })
  /**
   * 活体 2026-09-12：「文件传输助手」被选中（绿底白字）时裁的模板，下一趟在另一个被选中的会话行
   * 上匹配到 0.9 以上——绿底对绿底，字形只占一小片，分数分不出是谁——点开了别人的会话。
   * 模板救的是 OCR 漏检那一帧，不是替 OCR 认字：命中之后在那一小块上把字认回来。
   */
  it('template 命中后核字（text 目标）：那一块认出别人的名字 → 拒绝；什么都没认出来 → 按分数算命中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const row = { x: 20, y: 40, w: 90, h: 19 } // 落在 300×150 的 WIN 里
    // 第一趟 screen 段命中，顺手种下模板
    const first = seeDriver({ screen: both('文件传输助手', row) })
    expect(await makeSeeResolver(first.d, 'x', { cacheDir: dir }).resolve({ text: '文件传输助手' }, ACT)).toMatchObject({ via: 'screen' })
    // 第二趟：整窗 OCR 没有他；模板却在另一行（被选中的「陈雪韵」）上匹配到 0.95。
    // 核字那次 readText 读到的是「陈雪韵」→ 不算命中，也不许模型（optional 那种步骤）→ null。
    const other = { x: 20, y: 100, w: 90, h: 19 }
    const wrong = seeDriver({
      screens: [
        { texts: [{ text: '陈雪韵', rect: other }], elements: [{ name: '陈雪韵', rect: other, kind: 'text' }], window: WIN, scale: 2 },
        { texts: [{ text: '陈雪韵', rect: other }], window: WIN, scale: 2 }, // 核字那一读
      ],
      image: { rect: other, score: 0.95 },
    })
    expect(await makeSeeResolver(wrong.d, 'x', { cacheDir: dir }).resolve({ text: '文件传输助手' }, { allowModel: false, mode: 'action' })).toBeNull()
    // 核字那一读的范围就是命中框（外扩几个像素），不是整窗
    const probe = wrong.regions[wrong.regions.length - 1]!
    expect(probe.x).toBeLessThanOrEqual(other.x)
    expect(probe.w).toBeLessThan(WIN.w / 2)
    // 第三趟：整窗 OCR 漏了他，核字那一读也什么都没认出来 → 正是模板要救的那一帧，命中
    const blind = seeDriver({
      screens: [
        { elements: [], window: WIN, scale: 2 },
        { texts: [], window: WIN, scale: 2 },
      ],
      image: { rect: row, score: 0.95 },
    })
    expect(await makeSeeResolver(blind.d, 'x', { cacheDir: dir }).resolve({ text: '文件传输助手' }, { allowModel: false, mode: 'action' })).toMatchObject({ via: 'template' })
  })
  it('icon 目标一开始就要检测器；文字目标不要（spec §5 的成本表）', async () => {
    const screen: FakeScreen = { elements: [{ name: 'A', rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'text' }], window: WIN, scale: 2 }
    const withIcon = seeDriver({ screen })
    await makeSeeResolver(withIcon.d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ icon: 'x' }, { allowModel: false, mode: 'action' })
    expect(withIcon.icons).toEqual([true])
    const withText = seeDriver({ screen })
    await makeSeeResolver(withText.d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ text: 'A' }, { allowModel: false, mode: 'action' })
    expect(withText.icons).toEqual([false])
  })
  it('model 段的候选框来自元素表（带检测器），不是文字表', async () => {
    // 文字目标走到模型段时上一次读的是"不带检测器"的元素表——要编号就得补读一次带检测器的，
    // 否则只有图标的按钮压根不在候选里，模型只能如实答"没有"。
    const { d, icons } = seeDriver({
      screens: [
        { elements: [], window: WIN, scale: 2 },
        { elements: [{ rect: { x: 40, y: 40, w: 20, h: 10 }, kind: 'detector' }], window: WIN, scale: 2 },
      ],
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: llmAnswer('1') })
    expect(await r.resolve({ text: '看不见的' }, ACT)).toMatchObject({ via: 'model', rect: { x: 140, y: 90, w: 20, h: 10 } })
    expect(icons).toEqual([false, true])
  })
  it('model 段：没有 llm → null；模型答非编号 → null 且计数照加', async () => {
    const { d } = seeDriver({ screen: { elements: [{ name: 'A', rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'text' }], window: WIN, scale: 2 } })
    expect(await makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }).resolve({ icon: 'x' }, ACT)).toBeNull()
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: llmAnswer('看不出来') })
    expect(await r.resolve({ icon: 'x' }, ACT)).toBeNull()
    expect(r.modelCalls).toBe(1)
  })
  it('allowModel:false 永不调模型（expect 用）', async () => {
    let called = 0
    const llm: LlmForTask = async () => { called++; return { content: '1', raw: {} } as never }
    const { d, calls } = seeDriver({ screen: both('A', { x: 0, y: 0, w: 20, h: 10 }) })
    expect(await makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm }).resolve({ text: 'B' }, READ)).toBeNull()
    expect(called).toBe(0)
    // 判据这条路一次元素表都不读：检测器（2 秒）和元素合成都只为动作路存在。
    expect(calls.filter((c) => c.startsWith('read'))).toEqual(['readText'])
  })
  it('invalidate 删掉那条模板：下一次 template 段不再命中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const seeded = makeSeeResolver(seeDriver({ screen: { elements: [{ rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'detector' }], window: WIN, scale: 2 } }).d, 'x', { cacheDir: dir, llm: llmAnswer('1') })
    const hit = (await seeded.resolve({ icon: 'q' }, ACT))!
    seeded.invalidate(hit)
    const again = seeDriver({ screen: { elements: [], window: WIN, scale: 2 }, image: { rect: { x: 0, y: 0, w: 20, h: 10 }, score: 0.99 } })
    const r = makeSeeResolver(again.d, 'x', { cacheDir: dir })
    expect(await r.resolve({ icon: 'q' }, { allowModel: false, mode: 'action' })).toBeNull()
    expect(again.calls).not.toContain('findImage')
  })
  it('模型只认"整条回答就是一个数字"：夹在话里的数字不算，0 与非数字都不算', async () => {
    const mk = (answer: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'see-'))
      const { d } = seeDriver({ screen: twelveElements() })
      return { r: makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer(answer) }), dir }
    }
    // 提示词自己写着"1 到 12"，所以"第一个数字"会把前言里的 1 当成答案，静默选中 1 号框——
    // 更坏的是那一刀会被 cache.put 冻成模板，此后每一趟都命中它。
    expect(await mk('在 1 到 60 里我选 12').r.resolve({ icon: 'x' }, ACT)).toBeNull()
    expect(await mk(' 12 ').r.resolve({ icon: 'x' }, ACT)).toMatchObject({ via: 'model', rect: { x: 100, y: 160, w: 20, h: 10 } })
    expect(await mk('0').r.resolve({ icon: 'x' }, ACT)).toBeNull()
    expect(await mk('第 3 个').r.resolve({ icon: 'x' }, ACT)).toBeNull()
  })
  it('两次抓拍的窗口尺寸对不上 → 这一趟作废，什么都不缓存（不抛）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const screen = twelveElements()
    const moved = { jpeg: await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: { x: 100, y: 50, w: 200, h: 100 }, scale: 2 }
    const { d } = seeDriver({ screen, capture: moved })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer('12') })
    expect(await r.resolve({ icon: 'x' }, ACT)).toBeNull()
    const cache = new SeeCache(join(dir, 'x'))
    expect(cache.get(cache.key({ icon: 'x' }, screen.window, screen.scale, 'action'))).toBeNull()
  })
  it('窗口只是被拖走（尺寸没变）：model 段用后一张抓拍的原点，不是读屏那一刻的', async () => {
    const screen = twelveElements()
    const dragged = { jpeg: await whiteJpeg(), window: { ...WIN, x: WIN.x + 40, y: WIN.y + 7 }, scale: 2 }
    const { d } = seeDriver({ screen, capture: dragged })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: llmAnswer('12') })
    // 12 号框在截图上是 {0,110,20,10}；原点该用 dragged 那个，否则点回窗口挪走之前的位置。
    expect(await r.resolve({ icon: 'x' }, ACT)).toMatchObject({ via: 'model', rect: { x: 140, y: 167, w: 20, h: 10 } })
  })
  it('给了 region 就跳过 a11y 段：控件树查不出区域，唯一同名控件可能在别处', async () => {
    const { d, calls } = seeDriver({
      find: () => [{ ref: 'r1', rect: { x: 1, y: 2, w: 3, h: 4 } }],
      screen: both('搜索', { x: 10, y: 110, w: 40, h: 16 }),
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    const hit = await r.resolve({ text: '搜索', region: 'bottom' }, READ)
    expect(hit).toMatchObject({ via: 'screen', rect: { x: 110, y: 160, w: 40, h: 16 } })
    expect(calls).not.toContain('find')
  })
})

describe('parsePoint', () => {
  const w = { x: 0, y: 0, w: 1000, h: 800 }

  it("认 UI-TARS 的 click(start_box='[x1,y1,x2,y2]')，取框心", () => {
    expect(parsePoint("Thought: 我看到了\nAction: click(start_box='[100,200,140,240]')", w))
      .toEqual({ x: 110, y: 210, w: 20, h: 20 })
  })

  it('认 <point>x y</point>', () => {
    expect(parsePoint("click(point='<point>320 480</point>')", w)).toEqual({ x: 310, y: 470, w: 20, h: 20 })
  })

  it('认裸的一对坐标', () => {
    expect(parsePoint('它在 (320, 480)', w)).toEqual({ x: 310, y: 470, w: 20, h: 20 })
  })

  it('值超过窗口边长 → 按 0-1000 千分比折算（这些模型在归一化档上只吐 0-1000）', () => {
    const small = { x: 0, y: 0, w: 400, h: 300 }
    expect(parsePoint("click(point='<point>500 500</point>')", small)).toEqual({ x: 190, y: 140, w: 20, h: 20 })
  })

  it('认裸的中括号——四个数当框取心（活体实测：换一句提示词输出就变成这个形状）', () => {
    expect(parsePoint('[300, 600, 900, 650]', w)).toEqual({ x: 590, y: 615, w: 20, h: 20 })
  })

  it('认裸的中括号——两个数当点', () => {
    expect(parsePoint('[320, 480]', w)).toEqual({ x: 310, y: 470, w: 20, h: 20 })
  })

  it('括号没闭合 → null，不抢救。格式坏掉是模型不确定的信号，救回来等于把「我不知道」翻译成「就是这儿」', () => {
    // 活体 2026-09-08 实录：`click(start_box='[338, 703, 885, 742')` —— 右括号没闭合，而且
    // y=703/742 在一个高 653 的窗口里根本不成立。那一次它是真不确定（换个说法就直接回「没找到」）。
    expect(parsePoint("click(start_box='[338, 703, 885, 742'", w)).toBeNull()
  })

  it('中括号里没有数字 → 不当坐标', () => {
    expect(parsePoint('我在图里 [没有] 看到它', w)).toBeNull()
  })

  it('两个数都超过 1000 → null（既不是像素也不是千分比，说不清就别猜）', () => {
    expect(parsePoint('(5000, 5000)', w)).toBeNull()
  })

  it('抠不出坐标 → null。「模型说没找到」是一个合法答案，不许补一个默认坐标', () => {
    expect(parsePoint('我在这张图里没有看到消息输入框。', w)).toBeNull()
    expect(parsePoint(undefined, w)).toBeNull()
    expect(parsePoint('', w)).toBeNull()
  })

  it('负坐标 → null', () => {
    expect(parsePoint('(-10, 20)', w)).toBeNull()
  })
})

describe('pickHandle', () => {
  const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

  it('挑重叠最多的那条 a11y 元素的名字', () => {
    expect(pickHandle([
      { rect: R(0, 0, 50, 50), name: '远处的', kind: 'a11y' },
      { rect: R(100, 100, 60, 30), name: '消息输入框', kind: 'a11y' },
    ], R(110, 105, 20, 20))).toBe('消息输入框')
  })

  it('重叠更多的那个赢', () => {
    expect(pickHandle([
      { rect: R(100, 100, 12, 40), name: '窄的', kind: 'a11y' },
      { rect: R(100, 100, 60, 40), name: '宽的', kind: 'a11y' },
    ], R(105, 105, 40, 20))).toBe('宽的')
  })

  it('只认 a11y 那一档——检测器和文字段的框没有可拿去查树的名字', () => {
    expect(pickHandle([
      { rect: R(100, 100, 60, 30), name: '看着像', kind: 'detector' },
      { rect: R(100, 100, 60, 30), name: '也像', kind: 'text' },
    ], R(110, 105, 20, 20))).toBeNull()
  })

  it('无名的 a11y 元素不算句柄——空名字查回来是全窗第一个，比没有句柄坏得多', () => {
    expect(pickHandle([{ rect: R(100, 100, 60, 30), kind: 'a11y' }], R(110, 105, 20, 20))).toBeNull()
  })

  it('完全不重叠 → null', () => {
    expect(pickHandle([{ rect: R(0, 0, 10, 10), name: '别处', kind: 'a11y' }], R(500, 500, 20, 20))).toBeNull()
  })

  it('只贴着边、没有面积 → null（相邻不是重叠）', () => {
    expect(pickHandle([{ rect: R(0, 0, 100, 100), name: '贴边', kind: 'a11y' }], R(100, 0, 20, 20))).toBeNull()
  })
})

describe('第五档 point', () => {
  /** 读屏读到空表 = 前四档全落空（a11y 没 text 可查、两张表空、没有模板）。 */
  const empty = (): FakeScreen => ({ texts: [], elements: [], window: WIN, scale: 2 })

  it('前四档全落空 + see.point → 问模型要坐标，回执落在 via:point 上', async () => {
    const seen: string[] = []
    const llm: LlmForTask = async (id) => { seen.push(id); return { content: "click(start_box='[100,60,140,100]')", raw: {} } as never }
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm })
    const hit = await r.resolve({ point: '消息输入框' }, ACT)
    expect(hit?.via).toBe('point')
    expect(seen).toContain('desktop.point')
    // 窗口坐标 (120,80) → 屏幕坐标要加窗口原点 (100,50)
    expect(hit?.rect).toEqual({ x: 210, y: 120, w: 20, h: 20 })
  })

  it('判据路不许走这一档——allowModel:false 时一次模型都不调', async () => {
    const seen: string[] = []
    const llm: LlmForTask = async (id) => { seen.push(id); return { content: "click(start_box='[10,10,20,20]')", raw: {} } as never }
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm })
    expect(await r.resolve({ point: '消息输入框' }, READ)).toBeNull()
    expect(seen).toEqual([])
  })

  it('没写 see.point 就不走这一档——有 text 能指的东西不该白付一次模型钱', async () => {
    const seen: string[] = []
    const llm: LlmForTask = async (id) => { seen.push(id); return { content: '1', raw: {} } as never }
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm })
    await r.resolve({ text: '发送' }, ACT)
    expect(seen).not.toContain('desktop.point')
  })

  it('模型说没找到 → null，不许补坐标', async () => {
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: llmAnswer('我没有在图里看到它') })
    expect(await r.resolve({ point: '消息输入框' }, ACT)).toBeNull()
  })

  it('模型指到 region 之外 → 拒绝。「指错了」和「这儿没有」在下游长得一样，必须在这里分开', async () => {
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: llmAnswer("click(start_box='[10,10,14,14]')") })
    // region 只圈下半窗（y ≥ 75），模型指的 (12,12) 在上半窗
    expect(await r.resolve({ point: '输入框', region: { x: 0, y: 0.5, w: 1, h: 0.5 } }, ACT)).toBeNull()
  })

  it('没配模型（deps.llm 缺席）→ null，不抛', async () => {
    const { d } = seeDriver({ screen: empty() })
    const r = makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) })
    expect(await r.resolve({ point: '消息输入框' }, ACT)).toBeNull()
  })
})

describe('句柄固化', () => {
  const empty = (): FakeScreen => ({ texts: [], elements: [], window: WIN, scale: 2 })
  /** 定位命中后那一次回读：控件树里有个带名字的元素罩着模型指的位置。 */
  const withHandle = (): FakeScreen => ({
    texts: [], window: WIN, scale: 2,
    elements: [{ rect: { x: 100, y: 50, w: 80, h: 60 }, name: '我的手机', kind: 'a11y' }],
  })
  const SEE = { point: '消息输入框' } as const

  it('point 命中后回读元素表，把控件名固化下来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    // 第一次读屏 = 空表（前四档全落空）；第二次 = 固化那一次的回读
    const { d } = seeDriver({ screens: [empty(), withHandle()] })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer("click(start_box='[110,60,150,100]')") })
    const hit = await r.resolve(SEE, ACT)
    expect(hit?.via).toBe('point')
    expect(new SeeCache(join(dir, 'x')).peekHandle(SEE)).toBe('我的手机')
  })

  it('下一趟从第一档就走完——拿句柄查控件树，一次模型都不调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const seen: string[] = []
    const llm: LlmForTask = async (id) => { seen.push(id); return { content: '没找到', raw: {} } as never }
    new SeeCache(join(dir, 'x')).putHandle(SEE, '我的手机')
    const { d, calls } = seeDriver({
      screen: empty(),
      find: (q) => ((q as { name?: string }).name === '我的手机' ? [{ ref: 'r1', rect: { x: 5, y: 6, w: 7, h: 8 } }] : []),
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm })
    const hit = await r.resolve(SEE, ACT)
    // **记成 `pinned` 而不是 `a11y`**：两者都查了一次树，但一个是拿 recipe 里写的文字查、
    // 一个是拿上一趟固化的句柄查，陈旧时的处置不一样，合并之后就看不出走的是哪条路。
    expect(hit).toMatchObject({ via: 'pinned', rect: { x: 5, y: 6, w: 7, h: 8 } })
    expect(seen).toEqual([])
    // 连读屏都省了——那才是省下的大头（整窗一次 OCR 1–3.4 秒）
    expect(calls).not.toContain('readText')
    expect(calls).not.toContain('readElements')
  })

  it('作废一个 pinned 命中 → 丢的是句柄，不是模板文件（两个库，走错一边等于没作废）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(join(dir, 'x'))
    c.putHandle(SEE, '我的手机')
    const { d } = seeDriver({ screen: empty(), find: () => [{ ref: 'r1', rect: { x: 5, y: 6, w: 7, h: 8 } }] })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir })
    const hit = await r.resolve(SEE, ACT)
    expect(hit?.via).toBe('pinned')
    r.invalidate(hit!)
    expect(c.peekHandle(SEE)).toBeNull()
  })

  it('句柄查回来两条 → 不用它，落回梯子（"是哪一个"没有答案时不许猜）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    new SeeCache(join(dir, 'x')).putHandle(SEE, '我的手机')
    const { d } = seeDriver({
      screen: empty(),
      find: () => [{ ref: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } }, { ref: 'b', rect: { x: 5, y: 5, w: 1, h: 1 } }],
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer('没找到') })
    expect(await r.resolve(SEE, ACT)).toBeNull()
  })

  it('句柄查回来 0 条（界面变了）→ 落回梯子重新定位，不是当场失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    new SeeCache(join(dir, 'x')).putHandle(SEE, '旧名字')
    const { d } = seeDriver({ screens: [empty(), withHandle()], find: () => [] })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer("click(start_box='[110,60,150,100]')") })
    expect((await r.resolve(SEE, ACT))?.via).toBe('point')
  })

  it('那个位置没有带名字的控件 → 不固化，也不报错（纯画出来的界面本来就没句柄）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const noName = (): FakeScreen => ({ texts: [], window: WIN, scale: 2, elements: [{ rect: { x: 100, y: 50, w: 80, h: 60 }, kind: 'a11y' }] })
    const { d } = seeDriver({ screens: [empty(), noName()] })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir, llm: llmAnswer("click(start_box='[110,60,150,100]')") })
    expect((await r.resolve(SEE, ACT))?.via).toBe('point')
    expect(new SeeCache(join(dir, 'x')).peekHandle(SEE)).toBeNull()
  })

  it('句柄不吃窗口尺寸——拖一次窗口不该把固化的成果作废（那正是要消掉的成本）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(dir)
    c.putHandle(SEE, '我的手机')
    expect(c.peekHandle(SEE)).toBe('我的手机')
    expect(c.peekHandle({ point: '别的框' })).toBeNull()
  })

  it('只有 point 目标走句柄——text 目标查树查的是它自己那段文字，不是别人固化的句柄', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    // 就算库里躺着一条同 see 的句柄，text 目标也不该拿它去查
    new SeeCache(join(dir, 'x')).putHandle({ text: '发送' }, '我的手机')
    const asked: unknown[] = []
    const { d } = seeDriver({
      screen: both('发送', { x: 10, y: 20, w: 40, h: 16 }),
      find: (q) => { asked.push((q as { name?: string }).name); return [] },
    })
    const r = makeSeeResolver(d, 'x', { cacheDir: dir })
    expect((await r.resolve({ text: '发送' }, ACT))?.via).toBe('screen')
    expect(asked).toEqual(['发送'])
  })
})
