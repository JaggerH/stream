import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askMatchSpec,
  matchSpecPrompt,
  referenceEpisode,
  referenceItem,
  referenceSubscription,
  referenceWork,
  setAskChatSink,
  subscriptionRefText,
  type AskChatOp,
} from './askExtract.ts'

const toastError = vi.fn()
vi.mock('../components/acrylic/sonner.tsx', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

describe('引用的两种形态', () => {
  let ops: AskChatOp[]
  beforeEach(() => {
    ops = []
    toastError.mockClear()
    setAskChatSink((op) => { ops.push(op) })
  })

  // 屏幕上是名字、送出去的是 id。光给名字模型还得再搜一次、同名近名会搜错,
  // 而整理动的是真文件,认错一条流的代价不是重来一次。
  it('订阅：compose 一段带 id 的死文字', async () => {
    await referenceSubscription('lizhi-user-z7o4v', '春典JARGON')
    expect(ops).toEqual([{ kind: 'compose', text: '「春典JARGON」(stream:lizhi-user-z7o4v)' }])
  })

  // **不能退化成 compose 那种死文字**:一条内容要随附正文,而正文得在发送那一刻现取
  // (插完用户可能又滚了几屏)。所以插的是有身份的占位符,由 @ 引用源的 codec 现取。
  it('内容：ref-item（占位符 + codec），不是 compose', async () => {
    await referenceItem({ id: 'i1', title: '一条内容' })
    expect(ops).toEqual([{ kind: 'ref-item', id: 'i1', label: '一条内容' }])
  })

  // 引用绝不能变成"发出去":引完用户还要接着说下一句。
  it('两种引用都不发送', async () => {
    await referenceSubscription('s', 'S')
    await referenceItem({ id: 'i', title: 'I' })
    expect(ops.some((o) => o.kind === 'send')).toBe(false)
  })
})

describe('工作台之外', () => {
  beforeEach(() => { toastError.mockClear(); setAskChatSink(undefined) })

  // 深链只能把一句话**发出去**,而"发出去"恰恰是引用不想要的那个动作——所以这一档
  // 不许悄悄退化成发送,说人话拒绝。
  it('没有输入框可塞时说人话，不退化成发送', async () => {
    await referenceItem({ id: 'i1', title: '一条' })
    expect(toastError).toHaveBeenCalledTimes(1)
    // 文案的真相源是 `askExtract.ts` 那一句「<动作>要在带对话的那张页里进行」。断言只钉
    // **它指了路**这一件事，不逐字复制整句——整句里的动作名（引用 / 取正文）随调用方变。
    expect(String(toastError.mock.calls[0][0])).toContain('带对话的那张页')
  })
})

/**
 * 影视这棵树过去**一处对话入口都没有**（`MovieChannel.tsx` 2340 行里没有一次 askChat）——
 * 指着一部剧说"帮我看看它的网盘"，只能自己把片名打一遍，而同名近名模型会搜错。
 *
 * 作品和分集各一个形态，都只送标识：作品送 TMDb 坐标，分集送 leftKey（网盘那几个工具本来
 * 就说这门话）。正文不随附——这两样都不是"一段内容"，模型要什么自己去查。
 */
describe('影视的两种引用', () => {
  let ops: AskChatOp[]
  beforeEach(() => { ops = []; toastError.mockClear(); setAskChatSink((op) => { ops.push(op) }) })

  it('作品：compose 一段带 TMDb 坐标的死文字', async () => {
    await referenceWork({ id: '241453', media: 'tv', title: '星卡梦少女' })
    expect(ops).toEqual([{ kind: 'compose', text: '「星卡梦少女」(tmdb:tv:241453)' }])
  })

  it('分集：送 leftKey，标题里带上是哪一部的第几集', async () => {
    await referenceEpisode({ leftKey: 'tmdb:241453:S04E23', workTitle: '星卡梦少女', season: 4, episode: 23, title: '“弱”者的逆袭' })
    expect(ops).toEqual([{ kind: 'compose', text: '「星卡梦少女 S04E23 “弱”者的逆袭」(tmdb:241453:S04E23)' }])
  })

  it('两种都不发送——引完用户还要接着说', async () => {
    await referenceWork({ id: '1', media: 'movie', title: 'M' })
    await referenceEpisode({ leftKey: 'tmdb:1:S01E01', workTitle: 'W', season: 1, episode: 1, title: 'E' })
    expect(ops.some((o) => o.kind === 'send')).toBe(false)
  })
})

/**
 * 「AI 匹配」——程序配不上时用户唯一的出路。它**是发送**（和引用相反）：这一句本身就是一个
 * 任务，用户点它就是要模型去干活。明写工具名，理由同 `extractPrompt`：这一句的全部目的
 * 就是那几次工具调用。
 */
describe('AI 匹配', () => {
  let ops: AskChatOp[]
  beforeEach(() => { ops = []; setAskChatSink((op) => { ops.push(op) }) })

  it('发出去，且带上 setId 和那三个工具名', () => {
    const text = matchSpecPrompt('map_be9787', '星卡梦少女')
    expect(text).toContain('map_be9787')
    expect(text).toContain('星卡梦少女')
    for (const tool of ['netdisk_residue', 'netdisk_preview_spec', 'netdisk_apply_spec']) expect(text).toContain(tool)
  })

  it('走 send 不走 compose', async () => {
    await askMatchSpec({ baseUrl: 'http://x' } as never, 'map_1', '某剧')
    expect(ops.map((o) => o.kind)).toEqual(['send'])
  })
})

describe('两个入口拼出来的引用文字必须一模一样', () => {
  // 工作台输入框里 `@` 出来的那串字由插件侧的 subscriptionRefText 拼(dsh-plugin-stream-ui)。
  // 同一个东西两个入口拼出两种写法,模型读到的就是两种引用,而两边单看都正常。
  it('形状钉死：「名字」(stream:id)', () => {
    expect(subscriptionRefText('abc', '名字')).toBe('「名字」(stream:abc)')
  })
})
