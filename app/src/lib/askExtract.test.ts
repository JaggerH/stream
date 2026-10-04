import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const errorMock = vi.hoisted(() => vi.fn())
vi.mock('./api.ts', () => ({
  api: {},
  LOCAL: { base: '', token: null },
}))
vi.mock('../components/acrylic/sonner.tsx', () => ({ toast: { error: errorMock, success: vi.fn() } }))

import { askExtract, askReconcile, extractPrompt, reconcilePrompt, setAskChatSink } from './askExtract.ts'

const CONN = { base: '', token: null } as never
const ITEM = { id: 'abc123', title: '一条播客', author: '主播', url: 'https://example.com/x' }

describe('extractPrompt', () => {
  it('明写工具名和 item id——这一句的全部目的就是那一次工具调用', () => {
    const text = extractPrompt(ITEM)
    expect(text).toContain('extract')
    expect(text).toContain('abc123')
    expect(text).toContain('一条播客')
  })

  it('不提 full——模型面没有全文开关(digest-authority),全文由卡片自己从 API 取给人看', () => {
    expect(extractPrompt(ITEM)).not.toContain('full')
  })

  it('不随附正文摘要：随附了模型就直接答完，不去取全文', () => {
    // `@` 引用那条路才随附（目的是零工具调用问答）。这里出现「正文：」就是两条路被合并了。
    expect(extractPrompt(ITEM)).not.toContain('正文：')
  })

  it('只有句柄和标题：作者/来源/链接一格都不进——它们不是 extract 的入参', () => {
    const text = extractPrompt({ ...ITEM, source_id: 'douyin-follow' })
    expect(text).not.toContain('主播')
    expect(text).not.toContain('douyin-follow')
    expect(text).not.toContain('https://example.com/x')
  })

  it('是一行，且不因链接长而膨胀（抖音分享链接单条 500+ 字符）', () => {
    // 这条钉的是**长度本身**：条目元信息一旦倒进这一句，用户在对话里看到的就是一屏 query
    // string。条目身份归 ExtractCard 从回执的 snapshot 画。
    const text = extractPrompt({
      ...ITEM,
      url: `https://www.iesdouyin.com/share/video/7679342424015080730/?${'x=1&'.repeat(120)}`,
    })
    expect(text.split('\n')).toHaveLength(1)
    expect(text.length).toBeLessThan(120)
  })
})

describe('askExtract', () => {
  beforeEach(() => {
    errorMock.mockReset()
    setAskChatSink(undefined)
  })
  afterEach(() => { setAskChatSink(undefined) })

  it('面板里：直接走壳递进来的通道，不问工作台、不开新标签', async () => {
    const sink = vi.fn()
    setAskChatSink(sink)
    await askExtract(CONN, ITEM)
    expect(sink).toHaveBeenCalledWith({ kind: 'send', text: extractPrompt(ITEM) })
  })

  it('独立前端：没有对话面 → 说人话拒绝，不开标签、不静默', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    await askExtract(CONN, ITEM)
    expect(open).not.toHaveBeenCalled()
    expect(errorMock).toHaveBeenCalledTimes(1)
    expect(String(errorMock.mock.calls[0][0])).toContain('转成文字')
    vi.unstubAllGlobals()
  })
})

describe('reconcilePrompt / askReconcile —— 「让 AI 整理」（卡片→对话上下文桥）', () => {
  beforeEach(() => {
    setAskChatSink(undefined)
  })
  afterEach(() => { setAskChatSink(undefined) })

  it('明写三个工具名和 show id——这一句的全部目的就是那几次工具调用', () => {
    const text = reconcilePrompt('fafa', '发发大王')
    expect(text).toContain('reconcile_status')
    expect(text).toContain('reconcile_decide')
    expect(text).toContain('reconcile_execute')
    expect(text).toContain('fafa')
    expect(text).toContain('发发大王')
  })

  it('裁决纪律不在提示里重复——分层判据的真相源是工具描述，抄一份就是两个会漂移的真相源', () => {
    const text = reconcilePrompt('fafa', '发发大王')
    expect(text).not.toContain('字节')
    expect(text).not.toContain('硬证据')
  })

  it('面板里：走壳递进来的同一条通道（与转成文字共用 sendToChat）', async () => {
    const sink = vi.fn()
    setAskChatSink(sink)
    await askReconcile(CONN, 'fafa', '发发大王')
    expect(sink).toHaveBeenCalledWith({ kind: 'send', text: reconcilePrompt('fafa', '发发大王') })
  })
})
