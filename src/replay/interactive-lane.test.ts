import { describe, it, expect, vi } from 'vitest'
import { AGENT_FACILITY, agentLaneSpec, InteractiveLane } from './interactive-lane.ts'

describe('agentLaneSpec — AI 交互会话骑保留命名空间', () => {
  it('用保留 facility `_agent` + laneKey=会话 id，不与任何真 facility 冲突', () => {
    const spec = agentLaneSpec('sess-1')
    expect(spec.facility).toBe(AGENT_FACILITY)
    expect(AGENT_FACILITY).toBe('_agent')
    expect(spec.laneKey).toBe('sess-1')
  })

  it('persistent + debug(前台可见) —— 给人看的 lane，不是后台静默', () => {
    const spec = agentLaneSpec('sess-1')
    expect(spec.lifecycle).toBe('persistent') // 跨多步存活，不是一次性
    expect(spec.visibility).toBe('interactive') // 前台可见（用户看得见 AI 在动）
  })

  it('不同会话 = 不同 lane，互不干扰', () => {
    expect(agentLaneSpec('a').laneKey).not.toBe(agentLaneSpec('b').laneKey)
  })
})

function fakeDeps() {
  const acquired: unknown[] = []
  const lease = {
    facility: AGENT_FACILITY,
    page: {},
    rawPage: { tabId: 42 },
    visibility: 'interactive' as const,
    markBlocked: vi.fn(),
    release: vi.fn(async () => {}),
  }
  const sessions = { acquire: vi.fn(async (spec: unknown) => (acquired.push(spec), lease)) }
  // driver 的 evalExpr 会问页面要元素位置/readyState/当前 URL —— fake 给出可用的答案，
  // 好让 act 真的把 CDP 命令发出来（而不是在读页面这步就断掉）。
  // 导航要建模：driver 的 goto 会轮询 location.href 直到它真的变成目标（Page.navigate
  // 只是命令确认、新文档还没到），fake 不跟着变就会一直轮询。
  let href = 'https://a.example/x'
  const relay = {
    list: vi.fn(async () => [{ tabId: 42, url: 'https://a.example/x', title: 'A' }]),
    sendCommand: vi.fn(async (_tabId: number, method: string, params?: unknown) => {
      if (method === 'Page.navigate') {
        href = String((params as { url?: string } | undefined)?.url ?? href)
        return { ok: true }
      }
      if (method !== 'Runtime.evaluate') return { ok: true }
      const expr = String((params as { expression?: string } | undefined)?.expression ?? '')
      // openItem/openTarget 问的是"中心点在哪"({x,y})；click 问的是整个 rect（它要按 position
      // 自己算落点）。两种形状同时给，谁问什么就有什么——中心恰好也是 (100,200)。
      if (expr.includes('getBoundingClientRect'))
        return { result: { value: { x: 100, y: 200, left: 60, top: 180, width: 80, height: 40 } } }
      if (expr.includes('innerWidth')) return { result: { value: { x: 640, y: 400 } } }
      if (expr.includes('readyState')) return { result: { value: { href, state: 'complete' } } }
      if (expr.includes('location.href')) return { result: { value: href } }
      return { result: { value: 'evaluated' } }
    }),
    closeTab: vi.fn(async () => {}),
  }
  /** 取某个 CDP 方法实际发出的 params（断言"线上真发了什么"，而非只断言调用过）。 */
  const sent = (method: string, type?: string) =>
    relay.sendCommand.mock.calls
      .filter((c: unknown[]) => c[1] === method)
      .map((c: unknown[]) => c[2] as Record<string, unknown>)
      .filter((p) => type === undefined || p?.type === type)
  return { sessions, relay, acquired, lease, sent }
}

describe('InteractiveLane — 多步原语骑同一持久 tab', () => {
  it('open 开 lane 并返回 tabId；act/look 复用同一 tabId，不重开', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)

    const opened = await lane.open('https://a.example/x')
    expect(opened.tabId).toBe(42)

    await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    await lane.look(42, 'document.title')

    // 一条 lane 只 acquire 一次——多步骑同一个 tab
    expect(sessions.acquire).toHaveBeenCalledTimes(1)
    expect(relay.sendCommand.mock.calls.every((c: unknown[]) => c[0] === 42)).toBe(true)
  })

  it('list 枚举组内 tab —— AI 靠它认目标', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await expect(lane.list()).resolves.toEqual([{ tabId: 42, url: 'https://a.example/x', title: 'A' }])
  })

  it('mutating act 带上 expectDomain —— 逐动作域名校验在扩展侧兜底', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })

    // 要守的是**真正动手的那条**命令，不是过程中读元素位置的那次求值：
    // 先读到 (100,200)、页面趁机跳走、再照着这个坐标点下去 —— 域名校验正是拦这个。
    const inputs = relay.sendCommand.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('Input.'))
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((c: unknown[]) => c[3] === 'a.example')).toBe(true)
  })

  it('读类 act 不带 expectDomain —— 纯读不需要这道门', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'exists', tabId: 42, domain: 'a.example', selector: '#go' })

    expect(relay.sendCommand.mock.calls.every((c: unknown[]) => c[3] === undefined)).toBe(true)
  })
})

// 这组测的是「线上真发了什么」——动作必须落成页面真会接受的 CDP 命令。
// 曾经 lane 自己手搓过一份映射，结果每条都是坏的：click 的 dispatchMouseEvent 不带 x/y
// （CDP 必需）且没有 mouseReleased，根本不是一次点击；type 永远发 text:''；submit 被
// 映射成鼠标按下。病根是 LaneAction 当时没有 selector/text 字段——手搓那份映射不可能对，
// 它是在给缺口打补丁。现在动作带上目标，落地统一走 makeExtPageDriver（trusted 手势那份）。
describe('InteractiveLane — 动作真的落成可用的 CDP 命令', () => {
  it('click：trusted 三连（move→press→release）且带元素中心 x/y', async () => {
    const { sessions, relay, sent } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })

    // 只有 mousePressed 而没有 mouseReleased 的"点击"，页面根本不认
    expect(sent('Input.dispatchMouseEvent', 'mousePressed')[0]).toMatchObject({ x: 100, y: 200, button: 'left' })
    expect(sent('Input.dispatchMouseEvent', 'mouseReleased')[0]).toMatchObject({ x: 100, y: 200, button: 'left' })
  })

  it('type：把真的文本打下去（不是空串），且先 focus + 全选覆盖旧值', async () => {
    const { sessions, relay, sent } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'type', tabId: 42, domain: 'a.example', selector: '#q', text: '你好' })

    expect(sent('Input.insertText')[0]).toMatchObject({ text: '你好' })
  })

  it('submit：走 Enter 键，不是鼠标按下', async () => {
    const { sessions, relay, sent } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'submit', tabId: 42, domain: 'a.example', selector: '#f' }, { confirmed: true })

    expect(sent('Input.dispatchKeyEvent').map((p) => p.key)).toContain('Enter')
    expect(sent('Input.dispatchMouseEvent', 'mousePressed')).toHaveLength(0)
  })

  it('scroll：trusted 滚轮带 x/y（JS scrollBy 不产生 trusted 事件，会被认出是自动化）', async () => {
    const { sessions, relay, sent } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'scroll', tabId: 42, domain: 'a.example', px: 600 })

    expect(sent('Input.dispatchMouseEvent', 'mouseWheel')[0]).toMatchObject({ x: 640, y: 400, deltaY: 600 })
  })

  it('back：回上一页（不是靠跨站 goto 绕）', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    const r = await lane.act({ kind: 'back', tabId: 42, domain: 'a.example' })

    expect(r.status).toBe('done')
    const evals = relay.sendCommand.mock.calls
      .filter((c: unknown[]) => c[1] === 'Runtime.evaluate')
      .map((c: unknown[]) => String((c[2] as { expression?: string })?.expression ?? ''))
    expect(evals.some((e) => e.includes('history.back()'))).toBe(true)
    // 绝不能退化成 Page.navigate —— 那才是"新去处"，语义不同且会被高危门拦
    expect(relay.sendCommand.mock.calls.filter((c: unknown[]) => c[1] === 'Page.navigate')).toHaveLength(0)
  })

  it('goto：Page.navigate 到目标 URL', async () => {
    const { sessions, relay, sent } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    await lane.act({ kind: 'goto', tabId: 42, domain: 'a.example', targetUrl: 'https://a.example/next' })

    expect(sent('Page.navigate')[0]).toMatchObject({ url: 'https://a.example/next' })
  })
})

describe('InteractiveLane — 高危确认门', () => {
  it('默认档：高危动作不执行，返回待确认', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')

    const r = await lane.act({ kind: 'submit', tabId: 42, domain: 'a.example', selector: '#f' })

    expect(r.status).toBe('needs-confirmation')
    expect(r.reason).toBeTruthy()
    expect(relay.sendCommand).not.toHaveBeenCalled() // 绝不先斩后奏
  })

  it('默认档：非高危动作直行、不打断', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')
    const r = await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    expect(r.status).toBe('done')
    expect(relay.sendCommand).toHaveBeenCalled()
  })

  it('确认后（confirmed:true）高危动作才执行', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')
    const r = await lane.act({ kind: 'submit', tabId: 42, domain: 'a.example', selector: '#f' }, { confirmed: true })
    expect(r.status).toBe('done')
    expect(relay.sendCommand).toHaveBeenCalled()
  })
})

describe('InteractiveLane — close 是命令，不是强制 finally', () => {
  it('open→act 之后不自动关：tab 留着让用户看见 AI 干了什么', async () => {
    const { sessions, relay, lease } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')
    await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    expect(relay.closeTab).not.toHaveBeenCalled()
    expect(lease.release).not.toHaveBeenCalled()
  })

  it('显式 close 才关（AI 一轮走完主动发 / 用户手动关）', async () => {
    const { sessions, relay } = fakeDeps()
    const lane = new InteractiveLane('sess-1', sessions as never, relay as never)
    await lane.open('https://a.example/x')
    await lane.close(42)
    expect(relay.closeTab).toHaveBeenCalledWith(42)
  })
})

describe('InteractiveLane — 点击开出新标签要说出来', () => {
  it('click 之后扩展报来的新标签进回执 opened（带可用的 chrome:<tabId>）', async () => {
    const { relay } = fakeDeps()
    const openedSince = vi.fn(async (_opener: number, _since: number, _wait?: number) => [
      { tabId: 77, openerTabId: 42, url: 'https://a.example/next', at: Date.now() },
    ])
    const lane = new InteractiveLane('s', null, { ...relay, openedSince } as never)
    const r = await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    expect(r.status).toBe('done')
    expect(r.opened).toEqual([{ tabId: 77, url: 'https://a.example/next', target: 'chrome:77' }])
    expect(openedSince.mock.calls[0]![0]).toBe(42)
    expect(openedSince.mock.calls[0]![2]).toBeGreaterThan(0) // 没 expect → 值得等一会儿
  })

  it('没开新标签 → 回执不带 opened；不会开标签的动作（type）根本不问', async () => {
    const { relay } = fakeDeps()
    const openedSince = vi.fn(async () => [])
    const lane = new InteractiveLane('s', null, { ...relay, openedSince } as never)
    const r = await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    expect(r).not.toHaveProperty('opened')
    await lane.act({ kind: 'type', tabId: 42, domain: 'a.example', selector: '#q', text: 'x' })
    expect(openedSince).toHaveBeenCalledTimes(1)
  })
})

describe('InteractiveLane — iframe', () => {
  it('ref 选择器 → 逐 frame 找号；在 OOPIF 的子会话里读矩形，点击坐标加上 frame 偏移打给主会话', async () => {
    const calls: Array<{ method: string; params: any; sessionId?: string }> = []
    const relay = {
      list: vi.fn(async () => []),
      closeTab: vi.fn(async () => {}),
      frameSessions: vi.fn(async () => [{ sessionId: 'S1', targetId: 'OOP', url: 'https://o.test/' }]),
      sendCommand: vi.fn(async (_t: number, method: string, params: any, _d?: string, sessionId?: string) => {
        calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
        if (method === 'Page.getFrameTree')
          return sessionId
            ? { frameTree: { frame: { id: 'OOP', url: 'https://o.test/' } } }
            : {
                frameTree: {
                  frame: { id: 'TOP', url: 'https://a.example/' },
                  childFrames: [{ frame: { id: 'OOP', parentId: 'TOP', url: 'https://o.test/' } }],
                },
              }
        if (method === 'DOM.getFrameOwner') return { backendNodeId: 5 }
        if (method === 'DOM.getBoxModel') return { model: { content: [200, 300, 0, 0] } }
        if (method !== 'Runtime.evaluate') return {}
        const e: string = params.expression
        if (e.startsWith('!!document.querySelector')) return { result: { value: sessionId === 'S1' } }
        if (e.includes('getBoundingClientRect')) return { result: { value: { left: 10, top: 20, width: 40, height: 20 } } }
        return { result: { value: null } }
      }),
    }
    const lane = new InteractiveLane('s', null, relay as never)
    const r = await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '[data-stream-el="12"]' })
    expect(r.status).toBe('done')
    const rectRead = calls.find((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('getBoundingClientRect'))!
    expect(rectRead.sessionId).toBe('S1')
    const press = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')!
    expect(press.sessionId).toBeUndefined()
    expect([press.params.x, press.params.y]).toEqual([230, 330]) // 矩形中心 (30,30) + frame 偏移 (200,300)
  })

  it('普通选择器、没给 frame → 原路（不列 frame，一次多余往返都不加）', async () => {
    const { relay } = fakeDeps()
    const frameSessions = vi.fn(async () => [])
    const lane = new InteractiveLane('s', null, { ...relay, frameSessions } as never)
    await lane.act({ kind: 'click', tabId: 42, domain: 'a.example', selector: '#go' })
    expect(frameSessions).not.toHaveBeenCalled()
  })

  it('goto 给 frame → 拒（导航作用在整张标签上）', async () => {
    const { relay } = fakeDeps()
    const lane = new InteractiveLane('s', null, { ...relay, frameSessions: async () => [] } as never)
    await expect(
      lane.act({ kind: 'goto', tabId: 42, domain: 'a.example', targetUrl: 'https://a.example/y', frame: 'x' }),
    ).rejects.toThrow(/不支持 frame/)
  })
})
