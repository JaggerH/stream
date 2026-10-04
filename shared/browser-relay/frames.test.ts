import { describe, it, expect } from 'vitest'
import { listFrames, resolveFrame, frameOffset, makeFrameRawPage, inventoryAcrossFrames, frameOfRef, type FrameRelay } from './frames.ts'

/**
 * 一张假标签：顶层 TOP（主会话），里面一个同站 iframe SAME（同进程，主会话的树里），
 * 一个跨站 iframe OOP（另一个进程：主会话树里只有占位，真身在子会话 S1）。
 *
 * 这些形状（占位 + 子会话根、同进程 frame 要建隔离世界、盒模型相对会话根视口）是对着真
 * Chromium 的原始 CDP 量出来的（flatten 子会话，与 chrome.debugger 的 {tabId, sessionId} 同形）；
 * 这里钉的是 frames.ts 对这些形状的处理，不是 Chromium 本身。
 */
function fakeRelay() {
  const calls: Array<{ method: string; params: any; sessionId?: string }> = []
  const docs: Record<string, { seq: number; has: number[] }> = { TOP: { seq: 3, has: [1] }, SAME: { seq: 0, has: [] }, OOP: { seq: 9, has: [9] } }
  const relay: FrameRelay = {
    frameSessions: async () => [{ sessionId: 'S1', targetId: 'OOP', url: 'https://other.test/f' }],
    sendCommand: async (_tab, method, params: any, _d, sessionId) => {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      if (method === 'Page.getFrameTree') {
        if (sessionId === 'S1') return { frameTree: { frame: { id: 'OOP', url: 'https://other.test/f' } } }
        return {
          frameTree: {
            frame: { id: 'TOP', url: 'https://a.test/' },
            childFrames: [
              { frame: { id: 'SAME', parentId: 'TOP', url: 'https://b.a.test/s', name: 'same' } },
              { frame: { id: 'OOP', parentId: 'TOP', url: 'https://other.test/f' } },
            ],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'SAME' ? 77 : 0 }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'SAME' ? 11 : 12 }
      if (method === 'DOM.getBoxModel') return { model: { content: params.backendNodeId === 11 ? [10, 100, 0, 0] : [300, 200, 0, 0] } }
      if (method === 'Runtime.evaluate') {
        const doc = sessionId === 'S1' ? 'OOP' : params.contextId === 77 ? 'SAME' : 'TOP'
        const e: string = params.expression
        if (e.includes('Math.max(a, w)')) return { result: { value: docs[doc]!.seq } }
        const ref = /data-stream-el=\\"(\d+)\\"/.exec(e)
        if (e.startsWith('!!document.querySelector') && ref) return { result: { value: docs[doc]!.has.includes(Number(ref[1])) } }
        if (e.includes('__streamInvSeq')) {
          const floor = Number(/Math\.max\([\s\S]*?, (\d+)\);/.exec(e)![1])
          const n = floor + 1
          return { result: { value: { url: doc, title: doc, items: [{ n, tag: 'button', name: doc, rect: { x: 1, y: 2, w: 3, h: 4 } }], truncated: false, seq: n } } }
        }
        return { result: { value: `ran-in-${doc}` } }
      }
      return {}
    },
  }
  return { relay, calls }
}

describe('listFrames', () => {
  it('顶层在第一个；同进程 iframe 跟主会话、OOPIF 归它的子会话且算自己会话的根', async () => {
    const { relay } = fakeRelay()
    const frames = await listFrames(relay, 1)
    expect(frames).toEqual([
      { id: 'TOP', url: 'https://a.test/', root: true },
      { id: 'SAME', url: 'https://b.a.test/s', name: 'same', parentId: 'TOP', root: false },
      { id: 'OOP', url: 'https://other.test/f', parentId: 'TOP', sessionId: 'S1', root: true },
    ])
  })

  it('旧扩展（不认 frames op）→ 只列主会话那棵树，不整张失败', async () => {
    const { relay } = fakeRelay()
    relay.frameSessions = async () => {
      throw new Error('unknown op')
    }
    const frames = await listFrames(relay, 1)
    expect(frames.map((f) => f.id)).toEqual(['TOP', 'SAME', 'OOP'])
    expect(frames.find((f) => f.id === 'OOP')!.sessionId).toBeUndefined()
  })
})

describe('resolveFrame', () => {
  const frames = [
    { id: 'TOP', url: 'https://mp.weixin.qq.com/x', root: true },
    { id: 'G', url: 'https://gamemp.weixin.qq.com/panel', parentId: 'TOP', root: false },
  ]
  it('frame id 全等优先，其次 URL 包含且唯一', () => {
    expect(resolveFrame(frames, 'G').id).toBe('G')
    expect(resolveFrame(frames, 'gamemp').id).toBe('G')
  })
  it('包含匹配命中多个 → 报错列候选，不擅自挑', () => {
    expect(() => resolveFrame(frames, 'weixin.qq.com')).toThrow(/命中 2 个/)
  })
  it('一个都不中 → 报错并列出现有 frame', () => {
    expect(() => resolveFrame(frames, 'nope')).toThrow(/gamemp/)
  })
})

describe('在 frame 里求值与点击', () => {
  it('同进程 iframe 建隔离世界带 contextId 求值；OOPIF 在子会话里直接求值', async () => {
    const { relay, calls } = fakeRelay()
    const frames = await listFrames(relay, 1)
    const same = makeFrameRawPage(relay, 1, frames, frames[1]!)
    expect(await same.evalExpr('x')).toBe('ran-in-SAME')
    expect(calls.some((c) => c.method === 'Page.createIsolatedWorld' && c.params.frameId === 'SAME')).toBe(true)
    const oop = makeFrameRawPage(relay, 1, frames, frames[2]!)
    expect(await oop.evalExpr('x')).toBe('ran-in-OOP')
    expect(calls.at(-1)).toMatchObject({ method: 'Runtime.evaluate', sessionId: 'S1' })
  })

  it('鼠标事件换算成顶层视口坐标、打给主会话；DOM.* / Page.navigate 拒（会落到顶层文档）', async () => {
    const { relay, calls } = fakeRelay()
    const frames = await listFrames(relay, 1)
    const oop = makeFrameRawPage(relay, 1, frames, frames[2]!)
    await oop.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 6 })
    const sent = calls.at(-1)!
    expect(sent).toEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 305, y: 206 } })
    await expect(oop.cdp('DOM.getDocument', {})).rejects.toThrow(/iframe/)
    await expect(oop.cdp('Page.navigate', { url: 'x' })).rejects.toThrow(/iframe/)
  })

  it('frameOffset：父 frame 的会话里量 <iframe> 内容盒；顶层是 (0,0)', async () => {
    const { relay, calls } = fakeRelay()
    const frames = await listFrames(relay, 1)
    expect(await frameOffset(relay, 1, frames, frames[0]!)).toEqual({ x: 0, y: 0 })
    expect(await frameOffset(relay, 1, frames, frames[1]!)).toEqual({ x: 10, y: 100 })
    expect(await frameOffset(relay, 1, frames, frames[2]!)).toEqual({ x: 300, y: 200 })
    // OOPIF 的 <iframe> 元素在父（主）会话里，不在它自己的子会话里
    expect(calls.find((c) => c.method === 'DOM.getFrameOwner' && c.params.frameId === 'OOP')!.sessionId).toBeUndefined()
  })
})

describe('inventoryAcrossFrames', () => {
  it('编号全 tab 唯一：下限取各 frame 已发到的最大号；iframe 条目带 frame、rect 换算到顶层', async () => {
    const { relay } = fakeRelay()
    const inv = (await inventoryAcrossFrames(relay, 1)) as any
    // 各 frame 已发到 3 / 0 / 9 → 从 9 往上发：TOP 10、SAME 11、OOP 12
    expect(inv.items.map((i: any) => [i.n, i.frame])).toEqual([[10, undefined], [11, 'SAME'], [12, 'OOP']])
    expect(inv.items[1].rect).toMatchObject({ x: 11, y: 102 })
    expect(inv.items[2].rect).toMatchObject({ x: 301, y: 202 })
    expect(inv.frames.map((f: any) => [f.id, f.oopif])).toEqual([['TOP', false], ['SAME', false], ['OOP', true]])
    expect(inv.url).toBe('TOP')
  })
})

describe('frameOfRef', () => {
  it('逐 frame 问谁有这个号；都没有 → 顶层（让点击照常回 not-found）', async () => {
    const { relay } = fakeRelay()
    const frames = await listFrames(relay, 1)
    expect((await frameOfRef(relay, 1, frames, 9)).id).toBe('OOP')
    expect((await frameOfRef(relay, 1, frames, 1)).id).toBe('TOP')
    expect((await frameOfRef(relay, 1, frames, 42)).id).toBe('TOP')
  })
})
