import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { parseRefs } from '../src/client/chat/refs.ts'
import { UserMessageNodeView } from '../src/client/chat/UserMessageNodeView.tsx'
import { plainTextOf } from '../src/client/chat/UserMessage.tsx'
import { __resetRefSnapshots } from '../src/client/chat/ref-snapshots.ts'

const ASK = '请对「现在买入....一定爆赚！2026年10月新番导视！【泛式】」(item:966e7273ce5b3aae) 调用 extract 转成文字（音视频走转写、图片/PDF 走 OCR），取到后简述要点。'

describe('parseRefs', () => {
  it('认出内容引用，前后的字原样留着', () => {
    const segs = parseRefs(ASK)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'item', 'text'])
    expect(segs[1]).toMatchObject({ kind: 'item', label: '现在买入....一定爆赚！2026年10月新番导视！【泛式】', id: '966e7273ce5b3aae' })
    // 拼回去必须逐字等于原文——这是"结构藏在文本里"的全部前提。
    expect(segs.map((s) => s.text).join('')).toBe(ASK)
  })

  it('订阅引用同一套文法；一句里多条也认得出', () => {
    const segs = parseRefs('把「春典」(stream:s1) 和「泛式」(item:i1) 对一下')
    expect(segs.filter((s) => s.kind !== 'text').map((s) => `${s.kind}:${(s as { id: string }).id}`)).toEqual(['stream:s1', 'item:i1'])
  })

  it('网盘绑定那种带冒号的句柄也认（`tmdb:99:S01E02`）', () => {
    const segs = parseRefs('「某剧 S01E02」(item:tmdb:99:S01E02) 转成文字')
    expect(segs[0]).toMatchObject({ kind: 'item', id: 'tmdb:99:S01E02' })
  })

  it('没有引用 → 一段原样的字（不返回空数组，调用方直接渲染）', () => {
    expect(parseRefs('普通一句话')).toEqual([{ kind: 'text', text: '普通一句话' }])
    expect(parseRefs('')).toEqual([{ kind: 'text', text: '' }])
  })

  it('长得像但不是的不误认——右括号是终结符，不许吃掉后面整段', () => {
    expect(parseRefs('「标题」(itemx:1)').every((s) => s.kind === 'text')).toBe(true)
    expect(parseRefs('「标题」(item:a b)').every((s) => s.kind === 'text')).toBe(true)
  })

  // 正则是模块级常量、带 `g`（有可变的 lastIndex）。忘了重置就会"有时认得出有时认不出"。
  it('连续调用互不干扰（正则的 lastIndex 不许漏出来）', () => {
    expect(parseRefs(ASK)).toEqual(parseRefs(ASK))
  })
})

// **正文在 node.data.content**，不在 node.content —— 上一版夹具照错假设写，于是渲染件
// 读错那一格、tsc 和这批测试全绿，活体是个空气泡。夹具的形状必须跟着真身走。
const nodeOf = (text: string) => ({ data: { content: [{ type: 'text', text }] } })

describe('UserMessageNodeView', () => {
  it('引用画成标记，**id 仍在 DOM 里**——复制走的就是这段字', () => {
    const { container } = render(<UserMessageNodeView node={nodeOf(ASK)} />)
    const chip = container.querySelector('[data-stream-ref="item"]')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('(item:966e7273ce5b3aae)')
    // 整个气泡的文本必须逐字等于原消息：粘到别的对话里还原得回同一张卡。
    expect(container.querySelector('[data-stream-user-bubble]')!.textContent).toBe(ASK)
  })

  it('没有引用的普通消息照常显示', () => {
    render(<UserMessageNodeView node={nodeOf('帮我看看这个')} />)
    expect(screen.getByText('帮我看看这个')).toBeTruthy()
  })

  it('图片块照画——气泡是我们接管的，漏掉它就是"用户发的图不见了"', () => {
    const { container } = render(<UserMessageNodeView node={{ data: { content: [{ type: 'image', url: 'blob:x' }] } }} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:x')
  })

  it('不认识的块留一个看得见的占位，不静静吞掉', () => {
    render(<UserMessageNodeView node={{ data: { content: [{ type: 'audio' }] } }} />)
    expect(screen.getByText('[audio]')).toBeTruthy()
  })

  // 这条是这个文件存在的第二个理由。活体 2026-08-31：气泡的壳、圆角、配色全画对，
  // 里面一个字都没有，零报错——因为渲染件读的是 node.content（真身在 node.data.content）。
  // **静默的空是这条路上最坏的失败形状**：它和"消息本来就没内容"长得一模一样。
  it('一条内容都取不出来 → 露出一句话，绝不画空气泡', () => {
    const { container } = render(<UserMessageNodeView node={{ data: { content: [] } }} />)
    const bubble = container.querySelector('[data-stream-user-bubble]')
    expect(bubble!.textContent!.trim()).not.toBe('')
    // 读错那一格（老写法 node.content）也必须落到这一档，而不是安静地空着
    const wrong = render(<UserMessageNodeView node={{ content: [{ type: 'text', text: 'x' }] } as never} />)
    expect(wrong.container.querySelector('[data-stream-user-bubble]')!.textContent!.trim()).not.toBe('')
  })

  // 接管 `conversation.chat.node` 是**整行**的座位，DSH 挂在里面的操作行（时间 + 复制）
  // 随接管一起消失，不报错。上一版就这么把复制按钮弄丢了，而 tsc、全部单测、以及我在活体
  // 拍的 DOM 快照三处都没喊——快照是在接管**之后**拍的，看到的正是删完的样子。
  it('气泡下面那一行操作必须还在——坐了整行的座位就得把它画回来', () => {
    const { container } = render(<UserMessageNodeView node={{ data: { content: [{ type: 'text', text: ASK }], time: 1756612500000 } }} />)
    const actions = container.querySelector('[data-stream-bubble-actions]')
    expect(actions).toBeTruthy()
    expect(actions!.querySelector('button')).toBeTruthy()
  })

  // 送进剪贴板的**必须是原文**，不是屏幕上那段被画淡过的字——粘到另一个对话里才还原得回
  // 同一张卡。剪贴板本身是 DSH 的实现，我们只钉自己递过去的那个值。
  it('复制取的是 content 里的原文，不是 DOM 的 textContent', () => {
    expect(plainTextOf({ data: { content: [{ type: 'text', text: ASK }] } })).toBe(ASK)
    // 图片等非文字块不进复制（同 DSH 的 contentParts().text）
    expect(plainTextOf({ data: { content: [{ type: 'image', url: 'blob:x' }, { type: 'text', text: '看这个' }] } })).toBe('看这个')
    expect(plainTextOf({})).toBe('')
  })

  // 引用画成带封面的卡片（用户 2026-08-31：「转成文字那张卡的封面+标题+来源更好」）。
  // 封面不在消息里、也**故意不进工具回执**（封面 URL 几百字符，进回执就是拿模型上下文换
  // 像素），所以按 id 现取 —— 见 ref-snapshots.ts。
  describe('引用画成卡片', () => {
    beforeEach(() => {
      __resetRefSnapshots()
      ;(globalThis as Record<string, unknown>).__STREAM_UI__ = { backendUrl: 'http://127.0.0.1:8900' }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        refs: { '966e7273ce5b3aae': { title: '泛式的新番导视', source: 'bilibili', url: 'https://b/1', poster: 'https://cdn/cover.jpg' } },
      }), { headers: { 'content-type': 'application/json' } })))
    })
    afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as Record<string, unknown>).__STREAM_UI__ })

    it('取到了 → 画封面 + 标题 + 来源', async () => {
      const { container } = render(<UserMessageNodeView node={nodeOf(ASK)} />)
      await waitFor(() => expect(container.querySelector('[data-stream-ref-card]')).toBeTruthy())
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn/cover.jpg')
      expect(screen.getByText('泛式的新番导视')).toBeTruthy()
      expect(screen.getByText('bilibili')).toBeTruthy()
    })

    // 拖选复制取的是**选区**，而选区跳过 user-select:none。所以卡片上好看的那几格必须不进
    // 选区、原文那段字必须进——两边都算就会复制出重复的标题，一边都不算就丢了 id。
    // jsdom 不做选区，只能钉这两个结构性前提。
    it('原文那段字还在 DOM 里，且卡片上的装饰不进选区', async () => {
      const { container } = render(<UserMessageNodeView node={nodeOf(ASK)} />)
      await waitFor(() => expect(container.querySelector('[data-stream-ref-card]')).toBeTruthy())
      const card = container.querySelector('[data-stream-ref-card]')!
      expect(card.textContent).toContain('「现在买入....一定爆赚！2026年10月新番导视！【泛式】」(item:966e7273ce5b3aae)')
      // `NodeListOf` 在这份 tsconfig 的 target/lib 下不可迭代，`Array.from` 是它的取数方式。
      for (const el of Array.from(card.querySelectorAll('img, [style*="user-select"]'))) {
        expect((el as HTMLElement).style.userSelect).toBe('none')
      }
    })

    it('后端说没有这条 → 退回纯文字标记，不画错误', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ refs: {} }), { headers: { 'content-type': 'application/json' } })))
      const { container } = render(<UserMessageNodeView node={nodeOf(ASK)} />)
      await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0))
      expect(container.querySelector('[data-stream-ref-card]')).toBeNull()
      expect(container.querySelector('[data-stream-user-bubble]')!.textContent).toBe(ASK)
    })
  })

  it('内容缺席/坏形状不抛（渲染件抛错会被 DSH 记成崩溃并把这一格退出去）', () => {
    expect(() => render(<UserMessageNodeView node={{}} />)).not.toThrow()
    expect(() => render(<UserMessageNodeView node={{ data: { content: ['nope' as unknown] } }} />)).not.toThrow()
  })
})
