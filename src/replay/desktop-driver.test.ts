import { describe, it, expect } from 'vitest'
import { makeDesktopDriver, type HostOp, type HostRelay, type ReadSpec } from './desktop-driver.ts'

/** A fake Stream Desktop: records every op it receives and answers with `handler`. */
function fakeRelay(handler: (op: HostOp) => unknown = () => null) {
  const sent: HostOp[] = []
  const relay: HostRelay = {
    async send(op) {
      sent.push(op)
      return handler(op)
    },
  }
  return { relay, sent }
}

describe('DesktopDriver over the host relay', () => {
  it('find sends an a11y query and returns located elements', async () => {
    const el = {
      ref: 'r1',
      className: 'HistoryInner',
      role: 'List',
      name: '消息',
      rect: { x: 0, y: 0, w: 100, h: 100 },
    }
    const { relay, sent } = fakeRelay((op) => (op.op === 'find' ? { elements: [el] } : null))
    const res = await makeDesktopDriver(relay).find({ className: 'HistoryInner', role: 'List' })
    expect(res).toEqual({ elements: [el] })
    expect(sent).toEqual([{ op: 'find', args: { query: { className: 'HistoryInner', role: 'List' } } }])
  })

  it('find returns no elements when the agent reports nothing', async () => {
    const { relay } = fakeRelay()
    expect(await makeDesktopDriver(relay).find({ name: 'nope' })).toEqual({ elements: [] })
  })

  /** agent 说「0 命中，但目标窗口不在前台」时，那句人话必须原样带上来——**这就是本条链路上
   *  「没读到」和「没有」唯一的分界**（Electron 的 a11y 树懒建，后台读恒空且不报错）。 */
  it('find 把 agent 的 unbuilt 旗原样带上来（"没读到" ≠ "没有"）', async () => {
    const { relay } = fakeRelay((op) =>
      op.op === 'find' ? { elements: [], unbuilt: 'a11y-unbuilt: 窗口 123 不在前台' } : null,
    )
    const res = await makeDesktopDriver(relay).find({ role: 'Button' })
    expect(res.elements).toEqual([])
    expect(res.unbuilt).toContain('a11y-unbuilt')
  })

  /** 老 agent 回的是裸数组。降级成"没验到"（没有 `unbuilt` 字段），**不是**谎报"验过了"。 */
  it('老 agent 的裸数组照收，但不凭空造出 unbuilt', async () => {
    const { relay } = fakeRelay((op) => (op.op === 'find' ? [] : null))
    const res = await makeDesktopDriver(relay).find({ role: 'Button' })
    expect(res.elements).toEqual([])
    expect(res.unbuilt).toBeUndefined()
  })

  it('invoke sends the element ref (the handle fast-path)', async () => {
    const { relay, sent } = fakeRelay()
    await makeDesktopDriver(relay).invoke('r1')
    expect(sent).toEqual([{ op: 'invoke', args: { ref: 'r1' } }])
  })

  it('readSubtree returns items shaped by the read spec, and pins the wire message', async () => {
    const items = [{ noteId: 'a', title: 'X' }, { noteId: 'b', title: 'Y' }]
    const { relay, sent } = fakeRelay((op) => (op.op === 'readSubtree' ? items : null))
    const spec: ReadSpec = {
      itemQuery: { role: 'ListItem' },
      fields: { title: { read: 'name' } },
      dedupeBy: 'title',
    }
    const res = await makeDesktopDriver(relay).readSubtree(spec)
    expect(res).toEqual(items)
    expect(sent[0]).toEqual({ op: 'readSubtree', args: { spec } })
  })

  it('screenshot decodes base64 to a Buffer, null when unsupported', async () => {
    const b64 = Buffer.from('hello').toString('base64')
    const { relay } = fakeRelay((op) => (op.op === 'screenshot' ? { base64: b64 } : null))
    expect((await makeDesktopDriver(relay).screenshot())?.toString()).toBe('hello')

    const { relay: r2 } = fakeRelay(() => ({}))
    expect(await makeDesktopDriver(r2).screenshot()).toBeNull()
  })

  it('actuation ops send coordinates / text verbatim, in order', async () => {
    const { relay, sent } = fakeRelay()
    const d = makeDesktopDriver(relay)
    await d.focusApp({ process: 'Telegram.exe' })
    await d.click({ x: 10, y: 20, w: 4, h: 4 })
    await d.moveMouse(5, 6)
    await d.scroll('down', 300)
    await d.type('hello\n')
    await d.sleep(400)
    expect(sent).toEqual([
      { op: 'focusApp', args: { match: { process: 'Telegram.exe' } } },
      { op: 'click', args: { rect: { x: 10, y: 20, w: 4, h: 4 }, button: 'left' } },
      { op: 'moveMouse', args: { x: 5, y: 6 } },
      { op: 'scroll', args: { dir: 'down', amount: 300 } },
      { op: 'type', args: { text: 'hello\n' } },
      { op: 'sleep', args: { ms: 400 } },
    ])
  })

  /**
   * `via` = 这一下走的哪条路。同一个 `cdp_act` click，底下"有 ref 走 invoke / 没 ref 走坐标"
   * 是个调用方看不见的分支，而锁屏时行不行恰恰取决于它——不报出来，调用方解释不了结果。
   */
  it('via 原样透传：invoke 一条路，坐标输入另一条', async () => {
    const { relay } = fakeRelay((op) => ({ via: op.op === 'invoke' ? 'invoke' : 'coords' }))
    const d = makeDesktopDriver(relay)
    expect(await d.invoke('r1')).toEqual({ via: 'invoke' })
    expect(await d.click({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ via: 'coords' })
    expect(await d.type('4K')).toEqual({ via: 'coords' })
    expect(await d.scroll('down', 300)).toEqual({ via: 'coords' })
  })

  /** setValue 是第三条路：文字写进元素，不经键盘也就不需要前台。它和 `type` 的区别是整条
   *  桌面采集能不能不抢用户的屏，所以 `via` 必须把它和 coords 分开报。 */
  it('setValue 走 ref + text，via 是它自己的一档', async () => {
    const { relay, sent } = fakeRelay(() => ({ via: 'value' }))
    const d = makeDesktopDriver(relay)
    expect(await d.setValue('r1', '4K')).toEqual({ via: 'value' })
    expect(await d.setValue('r1', '4K', { role: 'Text', name: 'ok' })).toEqual({ via: 'value' })
    expect(sent).toEqual([
      { op: 'setValue', args: { ref: 'r1', text: '4K' } },
      { op: 'setValue', args: { ref: 'r1', text: '4K', expect: { role: 'Text', name: 'ok' } } },
    ])
  })

  it('via 和 confirmed 各自独立：走了哪条路 ≠ 效果验没验', async () => {
    const { relay } = fakeRelay(() => ({ via: 'invoke', confirmed: false }))
    expect(await makeDesktopDriver(relay).invoke('r1', { name: 'x' })).toEqual({ via: 'invoke', confirmed: false })
  })

  it('agent 没说 via 就不编一个 —— 猜一个"大概走了 invoke"等于抹掉这个字段的全部价值', async () => {
    const { relay } = fakeRelay(() => ({ confirmed: true }))
    expect(await makeDesktopDriver(relay).invoke('r1')).toEqual({ confirmed: true })

    const { relay: r2 } = fakeRelay(() => ({ via: 'somehow' }))
    expect(await makeDesktopDriver(r2).click({ x: 0, y: 0, w: 1, h: 1 })).toEqual({})
  })

  it('focusApp returns the agent boolean; url reads the foreground window id', async () => {
    const { relay } = fakeRelay((op) => (op.op === 'focusApp' ? true : op.op === 'url' ? 'Telegram.exe#MainWindow' : null))
    const d = makeDesktopDriver(relay)
    expect(await d.focusApp({ windowClass: 'MainWindow' })).toBe(true)
    expect(await d.url()).toBe('Telegram.exe#MainWindow')
  })
})

/**
 * ensureApp 的 wire 形状。它和 focusApp 是**两件事**：focusApp 会 SetForegroundWindow +
 * BringWindowToTop（职责就是抢屏），ensureApp 只让进程活着。采集迁到用户 Chrome 之后唤醒浏览器
 * 是常规动作，混用会让每次定时采集都把用户的屏幕抢过去。
 */
describe('makeDesktopDriver — ensureApp', () => {
  it('整个 spec 原样当 args 下发,不改形状', async () => {
    const sent: unknown[] = []
    const relay = { send: async (m: unknown) => { sent.push(m); return { running: true, started: true, pid: 42, process: 'chrome' } } }
    const got = await makeDesktopDriver(relay as never).ensureApp({ profileDirectory: 'Profile 1' })
    expect(sent).toEqual([{ op: 'ensureApp', args: { profileDirectory: 'Profile 1' } }])
    expect(got).toMatchObject({ running: true, started: true, pid: 42 })
  })

  it('空 spec 也发得出去 —— 全省略 = 按默认路径拉默认 profile', async () => {
    const sent: unknown[] = []
    const relay = { send: async (m: unknown) => { sent.push(m); return { running: true, started: false, process: 'chrome' } } }
    await makeDesktopDriver(relay as never).ensureApp({})
    expect(sent).toEqual([{ op: 'ensureApp', args: {} }])
  })

  it('回读的 running 原样带上来 —— "我发了启动命令"不等于"它在跑"', async () => {
    const relay = { send: async () => ({ running: false, started: false, process: 'chrome' }) }
    expect((await makeDesktopDriver(relay as never).ensureApp({})).running).toBe(false)
  })

  /** 「打开 → 拿到窗口 → find/invoke」要是一条不断的链：只报 pid 的话下一步只能猜标题，
   *  而窗口标题带动态前后缀，猜出来的 `app:<process>/<title>` 地址十有八九指不中。 */
  it('开出来的那个窗口带回来，够拼出 app:<process>/<title> 地址', async () => {
    const window = { id: 'w7', process: 'chrome.exe', title: '新标签页 - Google Chrome', foreground: true }
    const relay = { send: async () => ({ running: true, started: true, pid: 42, process: 'chrome', window }) }
    expect((await makeDesktopDriver(relay as never).ensureApp({})).window).toEqual(window)
  })

  it('agent 拿不准就没有 window 字段 —— 指错一个窗口比不给更坏', async () => {
    const relay = { send: async () => ({ running: true, started: true, pid: 42, process: 'chrome' }) }
    expect((await makeDesktopDriver(relay as never).ensureApp({})).window).toBeUndefined()
  })
})

describe('EnsureAppSpec.force 的 wire 形状', () => {
  it('force 原样下发 —— 后端只在"已确认它不答话"时才带它', async () => {
    const sent: unknown[] = []
    const relay = { send: async (m: unknown) => { sent.push(m); return { running: true, started: true, process: 'chrome' } } }
    await makeDesktopDriver(relay as never).ensureApp({ profileDirectory: 'Default', force: true })
    expect(sent).toEqual([{ op: 'ensureApp', args: { profileDirectory: 'Default', force: true } }])
  })
})

function relay(answers: Record<string, unknown>) {
  const sent: Array<{ op: string; args?: unknown }> = []
  const r: HostRelay = { async send(op) { sent.push(op); return answers[op.op] } }
  return { r, sent }
}

describe('makeDesktopDriver: readText / readElements / findImage / captureWindow / press', () => {
  it('readText 回 texts/window/scale；region 下推给 agent，不给就整窗', async () => {
    const { r, sent } = relay({ readText: { texts: [{ text: '搜索', rect: { x: 1, y: 2, w: 3, h: 4 } }], window: { x: 0, y: 0, w: 100, h: 50 }, scale: 2 } })
    const d = makeDesktopDriver(r)
    const out = await d.readText()
    expect(sent[0]).toEqual({ op: 'readText', args: {} })
    expect(out?.texts[0].text).toBe('搜索')
    expect(out?.scale).toBe(2)
    await d.readText({ x: 0, y: 0, w: 1946, h: 124 })
    expect(sent[1]).toEqual({ op: 'readText', args: { region: { x: 0, y: 0, w: 1946, h: 124 } } })
  })
  it('readElements：icons 显式传（缺省 false）；空名当作没名字', async () => {
    const { r, sent } = relay({
      readElements: {
        elements: [
          { rect: { x: 1, y: 2, w: 3, h: 4 }, name: '发送', kind: 'detector' },
          { rect: { x: 9, y: 9, w: 3, h: 4 }, kind: 'detector' },
          { rect: { x: 5, y: 5, w: 3, h: 4 }, name: '', kind: 'text' },
        ],
        window: { x: 0, y: 0, w: 100, h: 50 }, scale: 2,
      },
    })
    const out = await makeDesktopDriver(r).readElements({ icons: true })
    expect(sent[0]).toEqual({ op: 'readElements', args: { icons: true } })
    expect(out?.elements).toEqual([
      { rect: { x: 1, y: 2, w: 3, h: 4 }, kind: 'detector', name: '发送' },
      { rect: { x: 9, y: 9, w: 3, h: 4 }, kind: 'detector' },
      // 空串**不能**留成 name：包含匹配在空串上恒真，会静默命中每一个无名图标。
      { rect: { x: 5, y: 5, w: 3, h: 4 }, kind: 'text' },
    ])
  })
  it('老 agent 回 unsupported 错 → 两个读屏 op 都回 null，不抛', async () => {
    const r: HostRelay = { async send() { throw new Error('unknown op: readText') } }
    expect(await makeDesktopDriver(r).readText()).toBeNull()
    expect(await makeDesktopDriver(r).readElements()).toBeNull()
  })
  it('硬失败照抛，不当成"没找到"（runner 的 HARD_SEE_ERRORS 靠它够得着那句人话）', async () => {
    const r: HostRelay = { async send() { throw new Error('bad-region: region … 和窗口画面没有交集') } }
    await expect(makeDesktopDriver(r).readText({ x: 9999, y: 0, w: 10, h: 10 })).rejects.toThrow(/bad-region/)
  })
  it('findImage 送 base64 模板，回 rect+score；agent 回 {} = 没找到 → null', async () => {
    const { r, sent } = relay({ findImage: { rect: { x: 5, y: 6, w: 7, h: 8 }, score: 0.97 } })
    const hit = await makeDesktopDriver(r).findImage(Buffer.from('png'))
    expect((sent[0].args as { template: string }).template).toBe(Buffer.from('png').toString('base64'))
    expect(hit).toEqual({ rect: { x: 5, y: 6, w: 7, h: 8 }, score: 0.97 })
    const none = relay({ findImage: {} })
    expect(await makeDesktopDriver(none.r).findImage(Buffer.from('png'))).toBeNull()
    // 给了 region 就原样下推（agent 只在这一块里扫）；没给就不带这个键（老 agent 也不会被多余的键绊住）
    expect(sent[0].args).not.toHaveProperty('region')
    const scoped = relay({ findImage: {} })
    await makeDesktopDriver(scoped.r).findImage(Buffer.from('png'), { x: 1, y: 2, w: 30, h: 40 })
    expect((scoped.sent[0].args as { region?: unknown }).region).toEqual({ x: 1, y: 2, w: 30, h: 40 })
  })
  it('clearInput：发 clearInput op；deliver 原样带上（agent 那头对 message 档直接拒）', async () => {
    const { r, sent } = relay({ clearInput: {} })
    await makeDesktopDriver(r).clearInput()
    expect(sent[0].op).toBe('clearInput')
    expect(sent[0].args).not.toHaveProperty('deliver')
    const m = relay({ clearInput: {} })
    await makeDesktopDriver(m.r).clearInput('message')
    expect((m.sent[0].args as { deliver?: string }).deliver).toBe('message')
  })
  it('captureWindow 读 screenshot 的新字段；老 agent 没给 window → null', async () => {
    const withWin = relay({ screenshot: { base64: Buffer.from('j').toString('base64'), window: { x: 0, y: 0, w: 10, h: 10 }, scale: 1 } })
    expect((await makeDesktopDriver(withWin.r).captureWindow())?.window.w).toBe(10)
    const old = relay({ screenshot: { base64: 'ag==' } })
    expect(await makeDesktopDriver(old.r).captureWindow()).toBeNull()
  })
  it('press 走 press op', async () => {
    const { r, sent } = relay({ press: { via: 'coords' } })
    expect(await makeDesktopDriver(r).press('Escape')).toEqual({ via: 'coords' })
    expect(sent[0]).toEqual({ op: 'press', args: { key: 'Escape' } })
  })
  it('status 走 status op：文字原样、null 原样', async () => {
    const { r, sent } = relay({})
    const d = makeDesktopDriver(r)
    await d.status('wechat-send · 点候选里的他 (8/12)')
    await d.status(null)
    expect(sent).toEqual([
      { op: 'status', args: { text: 'wechat-send · 点候选里的他 (8/12)' } },
      { op: 'status', args: { text: null } },
    ])
  })
  /** 和 `nudge` 同一条纪律：老 agent 不认 → 吞（条子上少一句话不该让那一步失败）；
   *  别的错误照抛（WS 断了是整趟都要停的病）。 */
  it('status：老 agent 回 unknown op → 静默；其它错误照抛', async () => {
    const old: HostRelay = { async send() { throw new Error('unknown op: status') } }
    await expect(makeDesktopDriver(old).status('x')).resolves.toBeUndefined()
    const dead: HostRelay = { async send() { throw new Error('host relay: socket closed') } }
    await expect(makeDesktopDriver(dead).status('x')).rejects.toThrow(/socket closed/)
  })

  /** 落地方式按 `platform` / `appVersion` 挑，而这两格**只有 agent 知道**——后端可能在 WSL 里、
   *  agent 在 Windows 上，后端自己的 `process.platform` 是错的答案。所以它们必须一路原样浮上来：
   *  中间任何一层把字段吃掉，表现都是"这台机器没报版本"，和"这个应用真没版本资源"长得一模一样。 */
  it('windows 把 agent 报的 platform / appVersion 原样带上来', async () => {
    const { r } = relay({
      windows: [
        { id: 'w1', process: 'WeChat', title: '微信', foreground: true, platform: 'darwin', appVersion: '4.0.6' },
      ],
    })
    const [w] = await makeDesktopDriver(r).windows()
    expect(w.platform).toBe('darwin')
    expect(w.appVersion).toBe('4.0.6')
  })

  /** 老 agent 两格都不报。缺席就是 `undefined`——不该被补成空串或某个默认平台，
   *  「没报」和「报了个值」要分得开。 */
  it('老 agent 不报这两格 → undefined，不补默认值', async () => {
    const { r } = relay({ windows: [{ id: 'w1', process: 'WeChat', title: '微信', foreground: true }] })
    const [w] = await makeDesktopDriver(r).windows()
    expect(w.platform).toBeUndefined()
    expect(w.appVersion).toBeUndefined()
  })
})
