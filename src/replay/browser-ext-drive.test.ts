import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeExtPageDriver, makeExtRawPage, openTargetExpr, readStateExpr, type ExtRawPage } from './browser-ext-drive.ts'

/** Fake ExtRawPage recording every cdp/evalExpr call; evalExpr answers by expression. */
function fakeRaw(answer: (expr: string) => unknown = () => null) {
  const cdp: { method: string; params: unknown }[] = []
  const evals: string[] = []
  const raw: ExtRawPage = {
    tabId: 1,
    async evalExpr<T>(expression: string): Promise<T> {
      evals.push(expression)
      return answer(expression) as T
    },
    async cdp(method: string, params?: unknown) {
      cdp.push({ method, params })
      return {}
    },
  }
  /** 这个 driver 一帧都不逼，判据就是它从不发截图命令（`shotOf` 是另一回事，那是显式要图）。 */
  const shots = () => cdp.filter((c) => c.method === 'Page.captureScreenshot')
  return { raw, cdp, evals, shots }
}

/**
 * 页内表达式的可测缝：**把真正要发出去的那个字符串，在一个假 DOM 上跑一遍**。
 *
 * 为什么不是断言字符串里有没有某个子串：那验的是"我写没写这行代码"，不是"它取到了哪个元素"——
 * 而这次的缺陷恰恰是代码写了、取错了。假 rawPage 只能按子串回答固定值，同样验不到取谁。
 * 这里用 `new Function` 把 document/getComputedStyle 喂进去，测的就是发货的那份源码。
 * （jsdom 也能干这件事，但后端 vitest 没有 DOM 环境，为一个 3 元素的假页面拉一个 DOM 实现不划算。）
 */
type StubAnchor = { href: string; rect: [number, number, number, number]; visibility?: 'hidden' }
function evalInStubDom(expression: string, anchors: StubAnchor[]): unknown {
  const els = anchors.map((a) => ({
    getAttribute: (name: string) => (name === 'href' ? a.href : null),
    getBoundingClientRect: () => {
      const [left, top, width, height] = a.rect
      return { left, top, width, height, right: left + width, bottom: top + height }
    },
    __visibility: a.visibility ?? 'visible',
  }))
  const document = { querySelectorAll: () => els }
  const getComputedStyle = (el: { __visibility: string }) => ({ visibility: el.__visibility })
  const window = { innerHeight: 900, innerWidth: 1280, scrollY: 0 }
  // innerWidth/innerHeight 也喂进去：同一个假页面还要答光标居中那条表达式（driver 点击前会问一次）。
  return new Function(
    'document', 'getComputedStyle', 'window', 'innerWidth', 'innerHeight',
    `return (${expression})`,
  )(document, getComputedStyle, window, window.innerWidth, window.innerHeight)
}

/** 一张 xhs 搜索结果卡的真实形状（2026-07-28 活体量的三个 anchor，坐标照抄）。 */
const CARD_ANCHORS: StubAnchor[] = [
  { href: '/explore/aabbccddeeff00112233445566', rect: [0, 0, 0, 0] },              // display:none，中心 (0,0)
  { href: '/search_result/aabbccddeeff00112233445566?xsec_token=A', rect: [196, 217, 262, 350] }, // 封面
  { href: '/search_result/aabbccddeeff00112233445566?xsec_token=A', rect: [208, 579, 238, 39] },  // 标题行
]

// 拟人契约:PageDriver 是一个接口、两份实现(cloak 的 makePageDriver / 这里的 ext 版)。cloak 那份
// 点击前走 `page.mouse.move(x,y,{steps:8})` 有轨迹,ext 这份曾经是**一次瞬移**——同一份 recipe 换条
// transport 就少了轨迹。平时看不出来,撞上行为检测(Cloudflare Turnstile 这类)就炸:活体实测
// console.groq.com 建 key,人手点能过、瞬移点击过不了(转圈后复位、token 恒空)。
describe('makeExtPageDriver — 点击前的鼠标轨迹(拟人契约)', () => {
  const movesOf = (cdp: { method: string; params: unknown }[]) =>
    cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' && (c.params as any).type === 'mouseMoved')
      .map((c) => ({ x: (c.params as any).x, y: (c.params as any).y }))

  it('click 前插值出多步 mouseMoved,不是一步瞬移', async () => {
    const { raw, cdp } = fakeRaw((e) => (e.includes('innerWidth') ? { x: 0, y: 0 } : e.includes('getBoundingClientRect') ? { x: 400, y: 300 } : null))
    await makeExtPageDriver(raw).openItem('#go', 0)
    const moves = movesOf(cdp)
    expect(moves.length).toBeGreaterThan(3) // 瞬移只有 1 步
    // 终点必须精确落在目标上
    expect(moves[moves.length - 1]).toEqual({ x: 400, y: 300 })
  })

  it('轨迹从上一次的光标位置出发,而不是每次从头', async () => {
    const { raw, cdp } = fakeRaw((e) => (e.includes('innerWidth') ? { x: 0, y: 0 } : e.includes('getBoundingClientRect') ? { x: 400, y: 300 } : null))
    const d = makeExtPageDriver(raw)
    await d.moveMouse(100, 100) // 先把光标放到 (100,100)
    cdp.length = 0
    await d.openItem('#go', 0)
    const moves = movesOf(cdp)
    // 第一步应当离起点 (100,100) 比离终点 (400,300) 近——即确实从上次位置出发
    const first = moves[0]
    const dStart = Math.hypot(first.x - 100, first.y - 100)
    const dEnd = Math.hypot(first.x - 400, first.y - 300)
    expect(dStart).toBeLessThan(dEnd)
  })

  it('press/release 仍然只发一次,且落在终点', async () => {
    const { raw, cdp } = fakeRaw((e) => (e.includes('innerWidth') ? { x: 0, y: 0 } : e.includes('getBoundingClientRect') ? { x: 400, y: 300 } : null))
    await makeExtPageDriver(raw).openItem('#go', 0)
    const press = cdp.filter((c) => (c.params as any)?.type === 'mousePressed')
    const rel = cdp.filter((c) => (c.params as any)?.type === 'mouseReleased')
    expect(press).toHaveLength(1)
    expect(rel).toHaveLength(1)
    expect(press[0].params).toMatchObject({ x: 400, y: 300 })
  })
})

// click 的 `position`:为什么中心点不够——Cloudflare Turnstile 的 widget 实测 300x72,复选框在最左侧
// 方块区、中间是文字,点中心 12 秒无反应、点左侧一秒通过。语义与字段名照抄 Playwright 的
// locator.click({position}),偏移在 driver 里换算,两条 transport 因此对同一组数字给出同一个落点。
describe('makeExtPageDriver — click 的落点', () => {
  const rect = { left: 100, top: 200, width: 300, height: 72 }
  const rawFor = () =>
    fakeRaw((e) => (e.includes('innerWidth') ? { x: 0, y: 0 } : e.includes('getBoundingClientRect') ? rect : null))
  const pressOf = (cdp: { method: string; params: unknown }[]) =>
    cdp.find((c) => (c.params as any)?.type === 'mousePressed')!.params as any

  it('省略 position → 点 rect 中心', async () => {
    const { raw, cdp } = rawFor()
    expect(await makeExtPageDriver(raw).click('#w')).toBe(true)
    expect(pressOf(cdp)).toMatchObject({ x: 250, y: 236 }) // 100+150, 200+36
  })

  it('带 position → 相对 rect 左上角偏移(Turnstile 的复选框在左侧方块区)', async () => {
    const { raw, cdp } = rawFor()
    await makeExtPageDriver(raw).click('#w', { x: 36, y: 36 })
    expect(pressOf(cdp)).toMatchObject({ x: 136, y: 236 }) // 100+36, 200+36 —— 不是中心
  })

  // 表单的下一个控件常常等上一个 resolve 了才渲染（Groq 的提交按钮要等 Turnstile 拿到 token）。
  // 读一次就判"没有"，会把"还没出来"当成"不存在"。cloak 那侧靠 Playwright 自带的 auto-wait，
  // ext 这侧必须自己轮询，否则同一份 recipe 换条 transport 行为就不一样。
  it('元素迟到几轮才出现 → 等到它再点，不是当场判没中', async () => {
    let calls = 0
    const { raw, cdp } = fakeRaw((e) => {
      if (e.includes('innerWidth')) return { x: 0, y: 0 }
      if (e.includes('getBoundingClientRect')) return ++calls >= 3 ? rect : null
      return null
    })
    expect(await makeExtPageDriver(raw).click('#late')).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(pressOf(cdp)).toMatchObject({ x: 250, y: 236 })
  })

  it('选择器没命中 → 返回 false 且一个鼠标事件都不发', async () => {
    const { raw, cdp } = fakeRaw(() => null)
    expect(await makeExtPageDriver(raw).click('#gone')).toBe(false)
    expect(cdp.filter((c) => c.method === 'Input.dispatchMouseEvent')).toHaveLength(0)
  })
})

describe('makeExtPageDriver', () => {
  it('scrollOnce sends a TRUSTED CDP mouseWheel (not window.scrollBy) with deltaY', async () => {
    const { raw, cdp } = fakeRaw((e) => (e.includes('innerWidth') ? { x: 100, y: 200 } : null))
    await makeExtPageDriver(raw).scrollOnce(640)
    const wheel = cdp.find((c) => c.method === 'Input.dispatchMouseEvent' && (c.params as any).type === 'mouseWheel')
    expect(wheel).toBeTruthy()
    expect(wheel!.params).toMatchObject({ type: 'mouseWheel', deltaY: 640, x: 100, y: 200 })
  })

  it('exists probes via a querySelector evaluate and coerces to boolean', async () => {
    const { raw, evals } = fakeRaw(() => true)
    const got = await makeExtPageDriver(raw).exists('.main-container .user')
    expect(got).toBe(true)
    expect(evals.some((e) => e.includes('document.querySelector') && e.includes('.main-container .user'))).toBe(true)
  })

  it('readItems inlines extractCards over querySelectorAll(itemSelector) and returns records', async () => {
    const rows = [{ noteId: 'abc', title: 't' }]
    const { raw, evals } = fakeRaw((e) => (e.includes('extractCards') ? rows : null))
    const out = await makeExtPageDriver(raw).readItems!('section.note-item', {
      noteId: { selector: 'a.cover', attr: 'href' },
    })
    expect(out).toEqual(rows)
    const expr = evals.find((e) => e.includes('extractCards'))!
    expect(expr).toContain('section.note-item')
    expect(expr).toContain('const __name') // esbuild shim present
  })

  it('readState evaluates one expression that walks the dot-path off window', async () => {
    const feeds = [{ id: 'a', noteCard: { type: 'video' } }]
    const { raw, evals } = fakeRaw((e) => (e.includes('__INITIAL_STATE__') ? feeds : null))
    const out = await makeExtPageDriver(raw).readState!('__INITIAL_STATE__.feed.feeds')
    expect(out).toEqual(feeds)
    const expr = evals.find((e) => e.includes('__INITIAL_STATE__'))!
    expect(expr).toContain('.split(') // walks the path segments
    expect(expr).toContain('cur=window') // rooted at window, no Input/focus
    expect(expr).toContain(JSON.stringify('__INITIAL_STATE__.feed.feeds'))
  })

  it('readStateExpr materializes a reactive Proxy store — CDP returnByValue cannot serialize one', () => {
    // xhs hydrates __INITIAL_STATE__ into a Vue reactive Proxy. V8's value serializer
    // (returnByValue) walks own properties and hands back {} for a Proxy, so the read
    // must flatten to plain JSON IN THE PAGE, where the get/ownKeys traps still run.
    const backing = { note: { noteDetailMap: { n1: { note: { title: 'hello' } } } } }
    const reactive = <T extends object>(o: T): T =>
      new Proxy(o, {
        get: (t, k) => {
          const v = Reflect.get(t, k)
          return v && typeof v === 'object' ? reactive(v as object) : v
        },
      })
    const window = { __INITIAL_STATE__: reactive(backing) }
    const read = new Function('window', `return ${readStateExpr('__INITIAL_STATE__.note.noteDetailMap')}`) as (w: unknown) => unknown
    const got = read(window)
    expect(Object.keys(got as object)).toEqual(['n1'])
    expect(got).toEqual({ n1: { note: { title: 'hello' } } })
    expect(Object.getPrototypeOf(got as object)).toBe(Object.prototype) // plain, not a Proxy
  })

  it('readStateExpr returns undefined for an absent path instead of throwing', () => {
    const read = new Function('window', `return ${readStateExpr('__NOPE__.deep.path')}`) as (w: unknown) => unknown
    expect(read({})).toBeUndefined()
  })

  it('moveMouse dispatches a trusted mouseMoved at the point', async () => {
    const { raw, cdp } = fakeRaw()
    await makeExtPageDriver(raw).moveMouse(33, 44)
    // 逐字段匹配而不是整体深等:每个 mouseMoved 现在还带一个 timestamp(见后台档那组测试——
    // 事件被压着一起兑现时,靠它保住轨迹的时间间隔)。这里要断言的是落点,不是参数表的全貌。
    expect(cdp.some((c) =>
      c.method === 'Input.dispatchMouseEvent' &&
      (c.params as any).type === 'mouseMoved' && (c.params as any).x === 33 && (c.params as any).y === 44,
    )).toBe(true)
  })

  it('openItem clicks the Nth match at its center via CDP press+release', async () => {
    const { raw, cdp } = fakeRaw((e) => (e.includes('getBoundingClientRect') ? { x: 12, y: 34 } : null))
    await makeExtPageDriver(raw).openItem('a.cover', 2)
    const types = cdp.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => (c.params as any).type)
    // 光标先「走」过去(多步 mouseMoved,见 moveTo 的注释)再按下——曾经是一步瞬移。
    expect(types.filter((t) => t === 'mouseMoved').length).toBeGreaterThan(1)
    expect(types.slice(-2)).toEqual(['mousePressed', 'mouseReleased'])
    expect(cdp.find((c) => (c.params as any).type === 'mousePressed')!.params).toMatchObject({ x: 12, y: 34, button: 'left' })
  })

  it('openTarget 点的是**看得见**的那个 anchor，不是文档序第一个', async () => {
    // 活体钉死（2026-07-28）：xhs 搜索结果页上一张卡有 3 个同 id 的 anchor，文档序第一个是
    // display:none 的 /explore/<id>（rect 全 0 → 中心 (0,0)）。取第一个 = 点在页面左上角，
    // 笔记根本没打开，observeOpened 白等 3 秒再退 fallback-nav。
    const { raw, cdp } = fakeRaw((e) => evalInStubDom(e, CARD_ANCHORS))
    const ok = await makeExtPageDriver(raw).openTarget!('a', 'aabbccddeeff00112233445566')
    expect(ok).toBe(true)
    const pressed = cdp.find((c) => (c.params as any).type === 'mousePressed')!.params as { x: number; y: number }
    expect(pressed).toMatchObject({ x: 327, y: 392 }) // 封面 262×350 的中心
    expect(pressed).not.toMatchObject({ x: 0, y: 0 })
  })

  it('openTarget：候选全都看不见 → 不点，返回 false（交给 fallbackUrl）', async () => {
    // 点一个看不见的元素不是"尽力而为"：(0,0) 常常正是站点 logo，点下去等于随机导航。
    const { raw, cdp } = fakeRaw((e) => evalInStubDom(e, [CARD_ANCHORS[0]]))
    const ok = await makeExtPageDriver(raw).openTarget!('a', 'aabbccddeeff00112233445566')
    expect(ok).toBe(false)
    expect(cdp.filter((c) => (c.method as string) === 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('openTarget：visibility:hidden 也算看不见（它有非空盒子，光看 rect 拦不住）', async () => {
    const hidden: StubAnchor = {
      href: '/search_result/aabbccddeeff00112233445566', rect: [196, 217, 262, 350], visibility: 'hidden',
    }
    const { raw } = fakeRaw((e) => evalInStubDom(e, [CARD_ANCHORS[0], hidden]))
    expect(await makeExtPageDriver(raw).openTarget!('a', 'aabbccddeeff00112233445566')).toBe(false)
  })

  it('readViewport：隐藏的同 id anchor 不能把真卡挤掉（先判可见、再记 seen）', async () => {
    const { raw } = fakeRaw((e) => evalInStubDom(e, CARD_ANCHORS))
    const cards = await makeExtPageDriver(raw).readViewport!('a')
    // 一张卡一条，坐标是**封面**那个 anchor 的；隐藏的那个既不占位也不顶替
    expect(cards).toEqual([{ id: 'aabbccddeeff00112233445566', top: 217, height: 350 }])
  })

  it('submit focuses then presses Enter via CDP key events', async () => {
    const { raw, cdp } = fakeRaw(() => true) // 目标存在——量的是找到之后的按键序列
    await makeExtPageDriver(raw).submit('input#search-input')
    const keys = cdp.filter((c) => c.method === 'Input.dispatchKeyEvent')
    expect(keys.map((k) => (k.params as any).type)).toEqual(['keyDown', 'keyUp'])
    expect((keys[0].params as any).key).toBe('Enter')
  })

  it('submit 没找到目标 → 返回 false，且不发任何按键（不把 Enter 打到别处）', async () => {
    const { raw, cdp } = fakeRaw(() => false)
    expect(await makeExtPageDriver(raw).submit('input#gone')).toBe(false)
    expect(cdp.filter((c) => c.method === 'Input.dispatchKeyEvent')).toEqual([])
  })

  it('type focuses the field then inserts text as a trusted CDP input', async () => {
    const { raw, cdp } = fakeRaw(() => true)
    await makeExtPageDriver(raw).type('input#search-input', 'hello')
    expect(cdp).toContainEqual({ method: 'Input.insertText', params: { text: 'hello' } })
  })

  it('type 没找到目标 → 返回 false，且不发 insertText（不把文本打到别处）', async () => {
    const { raw, cdp } = fakeRaw(() => false)
    expect(await makeExtPageDriver(raw).type('input#gone', 'hello')).toBe(false)
    expect(cdp.filter((c) => c.method === 'Input.insertText')).toEqual([])
  })

  it('type selects any existing field text so insertText replaces instead of appends', async () => {
    const { raw, cdp } = fakeRaw(() => true)
    await makeExtPageDriver(raw).type('input#search-input', 'hello')
    const sequence = cdp.map((c) => c.method === 'Input.dispatchKeyEvent' ? `${(c.params as any).type}:${(c.params as any).key}` : c.method)
    expect(sequence).toEqual(['keyDown:Control', 'keyDown:a', 'keyUp:a', 'keyUp:Control', 'Input.insertText'])
  })

  it('currentUrl returns the tab location.href', async () => {
    const { raw } = fakeRaw((e) => (e.includes('location.href') ? 'https://x.test/somewhere' : null))
    expect(await makeExtPageDriver(raw).currentUrl!()).toBe('https://x.test/somewhere')
  })

  it('goto waits until the destination document is ready before returning', async () => {
    let navigated = false
    const { raw, cdp } = fakeRaw((e) => {
      if (e.includes('readyState')) {
        return navigated
          ? { href: 'https://x.test/next', state: 'complete' }
          : { href: 'https://x.test/old', state: 'complete' }
      }
      if (e.includes('location.href')) return 'https://x.test/old'
      return null
    })
    const origCdp = raw.cdp.bind(raw)
    raw.cdp = async (method, params) => {
      const out = await origCdp(method, params)
      if (method === 'Page.navigate') setTimeout(() => { navigated = true }, 30)
      return out
    }
    await makeExtPageDriver(raw).goto('https://x.test/next', 'load')
    expect(cdp).toContainEqual({ method: 'Page.navigate', params: { url: 'https://x.test/next' } })
    expect(navigated).toBe(true)
  })

  /**
   * 撞上界的那个出口以前和"等到了"长得一模一样（都是静默 return），所以一个偶发挂满 15 秒的
   * goto 只能靠蹲守——34 次冷跑、81 次 goto 一次都没蹲到。这两条钉的就是"它会自己招供"。
   * 行为不变仍然是契约的一部分：超时照旧不抛。
   */
  it('goto 撞 15s 上界时记一笔，带上最后读到的 href/readyState', async () => {
    vi.useFakeTimers()
    try {
      const entries: any[] = []
      // 页面永远停在 loading：这正是活体里那个"等满 15 秒"的形状
      const { raw } = fakeRaw((e) =>
        e.includes('readyState')
          ? { href: 'https://x.test/next', state: 'loading' }
          : e.includes('location.href')
            ? 'https://x.test/old'
            : null,
      )
      const p = makeExtPageDriver(raw, { onDebug: (entry) => entries.push(entry) }).goto('https://x.test/next', 'load')
      await vi.advanceTimersByTimeAsync(16_000)
      await expect(p).resolves.toBeUndefined() // 行为不变：超时照旧安静返回
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.channel).toBe('drive')
      expect(e.key).toBe('tab:1')
      expect(e.ok).toBe(false)
      const field = (label: string) => e.fields.find((f: any) => f.label === label)?.value
      expect(field('最后 readyState')).toBe('loading')
      expect(field('最后 href')).toBe('https://x.test/next')
      expect(field('目标 url')).toBe('https://x.test/next')
      expect(field('导航前 href')).toBe('https://x.test/old')
      expect(Number(String(field('等了')).replace('ms', ''))).toBeGreaterThanOrEqual(15_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('goto 等到了就不记 —— 这笔痕只标记 deadline 那个出口', async () => {
    const entries: unknown[] = []
    const { raw } = fakeRaw((e) =>
      e.includes('readyState')
        ? { href: 'https://x.test/next', state: 'complete' }
        : e.includes('location.href')
          ? 'https://x.test/old'
          : null,
    )
    await makeExtPageDriver(raw, { onDebug: (entry) => entries.push(entry) }).goto('https://x.test/next', 'load')
    expect(entries).toEqual([])
  })

  it('goto with commit does not poll for readiness', async () => {
    const { raw, evals } = fakeRaw()
    await makeExtPageDriver(raw).goto('https://x.test/api-ish', 'commit')
    expect(evals.filter((e) => e.includes('readyState'))).toEqual([])
  })
})

/**
 * **这个 driver 一帧都不逼**——采集路径上一发 `Page.captureScreenshot` 都不该出现。
 *
 * 两半各有各的实测理由（2026-08-15）：可信输入由 `Emulation.setFocusEmulationEnabled` 接住
 * （`browser-ext.ts` 的 launch 一处无条件开启）；等待期间的懒加载在后台标签里照常跑
 * （定时器 40/40 拍、`rAF` 在跑、`scrollHeight` 2983 → 6978），带计数的 A/B 里 `xhs-home`
 * 关掉心跳照样 110–113 条。唯一真的要帧的 douyin 已改成站内直调，不再走这条路。
 *
 * 这一组存在的意义是**钉住"别加回来"**：加回来不会有任何症状，只是每个动作/每一拍白烧几百
 * 毫秒到 2 秒（那一档实测 267ms / 1.2s / 39.8s，忽快忽慢），而窗口不显示时它还拿不到帧。
 */
describe('makeExtPageDriver — 采集路径一帧都不逼', () => {
  const rectRaw = () =>
    fakeRaw((e) => (e.includes('innerWidth') ? { x: 5, y: 5 } : e.includes('getBoundingClientRect') ? { left: 0, top: 0, width: 10, height: 10, x: 5, y: 5 } : null))

  it('点击不逼帧 —— 可信输入靠 focus 仿真,不靠帧', async () => {
    const { raw, cdp, shots } = rectRaw()
    await makeExtPageDriver(raw).click('.card')
    // 手势本身照常发全：8 步轨迹 + press + release
    expect(cdp.filter((c) => (c.params as any)?.type === 'mouseReleased')).toHaveLength(1)
    expect(shots()).toHaveLength(0)
  })

  it('goto / back / type / submit 都不逼帧', async () => {
    const { raw, shots } = fakeRaw((e) =>
      e.includes('readyState') ? { href: 'https://x.test/a', state: 'complete' } : e.includes('querySelector') ? true : 'https://x.test/b',
    )
    const d = makeExtPageDriver(raw)
    await d.goto('https://x.test/a')
    await d.back()
    await d.type('#q', 'hi')
    await d.submit('#q')
    expect(shots()).toHaveLength(0)
  })

  it('轨迹的每一步都自带 timestamp —— 压着一起兑现时轨迹不会塌成瞬移', async () => {
    const { raw, cdp } = rectRaw()
    await makeExtPageDriver(raw).click('.card')
    const moves = cdp.filter((c) => (c.params as any)?.type === 'mouseMoved')
    expect(moves.length).toBeGreaterThan(1)
    expect(moves.every((m) => typeof (m.params as any).timestamp === 'number')).toBe(true)
    // 时间戳必须是递增的真实时刻,否则 8 步和 1 步没区别
    const ts = moves.map((m) => (m.params as any).timestamp as number)
    expect(ts[ts.length - 1]).toBeGreaterThan(ts[0])
  })

  it('scrollOnce 不等 wheel 的回执 —— 回执永不返回也不能挂住它', async () => {
    // 背景档实测：mouseWheel 的 ack 永不回来(relay 30s 超时),但滚动其实生效了。
    // 等它 = 每滚一屏白等 30 秒再收一个假故障。
    const { raw } = fakeRaw((e) => (e.includes('innerWidth') ? { x: 1, y: 1 } : null))
    const never = new Promise<never>(() => {}) // 永不 settle,模拟丢掉的回执
    const sent: string[] = []
    const stuck: typeof raw = {
      ...raw,
      cdp: (m) => { sent.push(m); return m === 'Input.dispatchMouseEvent' ? never : Promise.resolve({}) },
    }
    // 超时那一侧赢了就是 scrollOnce 在等回执 —— 那正是要防的死等
    await Promise.race([
      makeExtPageDriver(stuck).scrollOnce(600),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scrollOnce 等了 wheel 的回执')), 300)),
    ])
    // 滚动这一步不逼帧:滚没滚要靠 scrollProbe 的位移去判,不靠帧、也不靠回执
    expect(sent.filter((m) => m === 'Page.captureScreenshot')).toEqual([])
  })

  it('makeExtRawPage 自己从不发截图 —— 没有任何"顺带产帧"的暗门', async () => {
    // 钉住接缝本身：raw page 只该转发调用方点名的命令。以前它带一个 flushFrame 成员，
    // 会在后台档偷偷打 1×1 截图；摘掉之后这里必须是空的。
    const sent: string[] = []
    const relay = { sendCommand: async (_t: number, m: string) => { sent.push(m); return {} } }
    const raw = makeExtRawPage(relay, 1)
    await raw.evalExpr('1')
    await raw.cdp('Input.dispatchMouseEvent', {})
    expect(sent.filter((m) => m === 'Page.captureScreenshot')).toEqual([])
  })
})

describe('makeExtPageDriver — 等待就是等待，不在中间做任何事', () => {
  // 用假时钟：真实墙钟断言在这台机器上会飘（单调时钟偏快约 7.6%，setTimeout 提前触发），
  // 而且并行跑测试时更不稳。
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const sleepWith = async (ms: number) => {
    const { raw, cdp, evals, shots } = fakeRaw()
    const done = makeExtPageDriver(raw).sleep(ms)
    await vi.advanceTimersByTimeAsync(ms + 10)
    await done
    return { cdp, evals, shots }
  }

  it('dwell 期间一条命令都不发 —— 心跳已经摘掉,页面自己在跑', async () => {
    // 曾经这里按 250ms 一拍打 1×1 截图。摘掉的理由是实测：后台标签的定时器/rAF/懒加载照常跑
    // (scrollHeight 2983 → 6978)，xhs-home 关掉心跳照样 110–113 条；而唯一要帧的 douyin 已
    // 改成站内直调、不再走 dwell 这条路。
    const { cdp, evals, shots } = await sleepWith(3000)
    expect(shots()).toHaveLength(0)
    expect(cdp).toEqual([]) // 一次 relay 往返都不该有
    expect(evals).toEqual([])
  })

  it('该等多久就等多久 —— 少等等于把 dwell 偷走', async () => {
    vi.useFakeTimers()
    let done = false
    const { raw } = fakeRaw()
    void makeExtPageDriver(raw).sleep(3000).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(2999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toBe(true)
  })
})
