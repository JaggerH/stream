import { describe, it, expect, vi } from 'vitest'
import { makeCdpRouter } from './cdp-router.ts'
import { SESSION_BUSY_REASON, USER_ABORTED_REASON } from '../replay/desktop-failure.ts'
import { WsHostRelay, HostSessionQueueTimeout, HostAbortedByUser, type HostSocket } from '../http/host-relay.ts'
import { makeDesktopDriver } from '../replay/desktop-driver.ts'
import { runDesktopRecipe } from '../replay/desktop-runner.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'

function deps() {
  return {
    chromeCdp: vi.fn(async (_u: string, _j: string, _o?: { interactive?: boolean }) => ({ value: 'opened', tabId: 7, kept: true })),
    chromeLook: vi.fn(async (_t: number, _j: string, _f?: string) => 'looked'),
    chromeInventory: vi.fn(async (_t: number) => ({ items: [] })),
    chromeShot: vi.fn(async (_t: number): Promise<string | null> => 'CH'),
    chromeAct: vi.fn(async (_a: unknown, _c?: boolean) => ({ status: 'done' as const })),
    chromeOpen: vi.fn(async (url: string) => ({ tabId: 12, title: 'Extensions', url, created: true })),
    chromeTabs: vi.fn(async () => [{ tabId: 1, url: 'u', title: 't' }]),
    chromeCloseTab: vi.fn(async (_t: number) => {}),
    facilityLook: vi.fn(async (_f: string, _j: string) => ({ value: 'facLook' })),
    facilityShot: vi.fn(async (_f: string) => 'FA'),
    facilityAct: vi.fn(async (_a: unknown, _c?: boolean): Promise<{ status: 'done' } | null> => ({ status: 'done' as const })),
  }
}

describe('makeCdpRouter', () => {
  it('look: chrome+url opens a tab', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    expect(await r.look({ target: 'chrome', url: 'https://x', js: '1', interactive: true })).toEqual({ value: 'opened', tabId: 7, kept: true })
    expect(d.chromeCdp).toHaveBeenCalledWith('https://x', '1', { interactive: true })
  })
  it('look: chrome:<tabId> reads an existing tab', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    expect(await r.look({ target: 'chrome:42', js: 'x' })).toEqual({ value: 'looked' })
    expect(d.chromeLook).toHaveBeenCalledWith(42, 'x')
  })
  it('look: facility:<name> dispatch', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    expect(await r.look({ target: 'facility:xhs', js: 'x' })).toEqual({ value: 'facLook' })
  })
  it('look: chrome without a tabId or url is an error', async () => {
    const r = makeCdpRouter(deps())
    await expect(r.look({ target: 'chrome', js: 'x' })).rejects.toThrow(/needs a url .* or a tabId/i)
  })
  it('shot dispatches per target and wraps chrome/facility into {shot}', async () => {
    const r = makeCdpRouter(deps())
    expect(await r.shot({ target: 'chrome:1' })).toEqual({ shot: 'CH' })
    expect(await r.shot({ target: 'facility:xhs' })).toEqual({ shot: 'FA' })
  })
  it('act: chrome builds a LaneAction with tabId; facility builds ActionSpec&{facility}', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await r.act({ target: 'chrome:9', kind: 'click', domain: 'x.com', selector: '#a', confirmed: true })
    expect(d.chromeAct).toHaveBeenCalledWith(expect.objectContaining({ tabId: 9, kind: 'click', domain: 'x.com', selector: '#a' }), true)
    await r.act({ target: 'facility:xhs', kind: 'click', domain: 'x.com' })
    expect(d.facilityAct).toHaveBeenCalledWith(expect.objectContaining({ facility: 'xhs', kind: 'click' }), undefined)
  })
  it('act: facility with no live tab returns {live:false}, not a fake status:done', async () => {
    const d = deps()
    d.facilityAct.mockResolvedValueOnce(null)
    const r = makeCdpRouter(d)
    const result = await r.act({ target: 'facility:xhs', kind: 'click', domain: 'x' })
    expect(result).toEqual({ live: false })
    expect(result).not.toEqual(expect.objectContaining({ status: 'done' }))
  })
  it('act: chrome without a tabId is an error', async () => {
    const r = makeCdpRouter(deps())
    await expect(r.act({ target: 'chrome', kind: 'click', domain: 'x' })).rejects.toThrow(/tabId/)
  })
  it("act: kind:'open' needs no tabId — it RETURNS one, and the receipt passes through verbatim", async () => {
    // 缺的正是这一步：chrome 档只认已存在的 tab，"开一个页面"没有原语，调用方只好从 bash
    // 起 chrome.exe——没有回执，失败不可知。
    const d = deps(); const r = makeCdpRouter(d)
    const res = await r.act({ target: 'chrome', kind: 'open', domain: 'extensions', targetUrl: 'chrome://extensions' })
    expect(d.chromeOpen).toHaveBeenCalledWith('chrome://extensions')
    expect(d.chromeAct).not.toHaveBeenCalled()
    expect(res).toEqual({ status: 'done', result: { tabId: 12, title: 'Extensions', url: 'chrome://extensions', created: true } })
  })
  it("act: kind:'open' without targetUrl is an error", async () => {
    const r = makeCdpRouter(deps())
    await expect(r.act({ target: 'chrome', kind: 'open', domain: 'x' })).rejects.toThrow(/targetUrl/)
  })
  it("act: kind:'open' does not swallow the tabId requirement of the other kinds", async () => {
    const r = makeCdpRouter(deps())
    await expect(r.act({ target: 'chrome', kind: 'goto', domain: 'x', targetUrl: 'https://x' })).rejects.toThrow(/tabId/)
  })
  it("act: app:<process> + kind:'open' 唤起应用（走 ensureApp，不 scopeWindow/focusApp）", async () => {
    // 桌面档的 open 必须先于 desktopAct 分流：那条路一上来就 scopeWindow，而要开的进程按定义
    // 还没有窗口——走过去只会报 no-window-match，把"能开"变成"开不了"。
    const calls: string[] = []
    const desktopDriver = {
      ensureApp: vi.fn(async (spec: { process?: string }) => {
        calls.push('ensureApp')
        return { running: true, started: true, pid: 99, process: spec.process ?? '' }
      }),
      scopeWindow: vi.fn(async () => { calls.push('scopeWindow'); return { id: 'w', process: '', title: '', foreground: false } }),
      focusApp: vi.fn(async () => { calls.push('focusApp'); return true }),
    }
    const d = { ...deps(), desktop: () => desktopDriver as never }
    const res = await makeCdpRouter(d).act({
      target: 'app:Telegram.exe', kind: 'open', domain: 'desktop', exe: 'C:\\T\\Telegram.exe', args: [],
    })
    expect(calls).toEqual(['ensureApp'])
    expect(desktopDriver.ensureApp).toHaveBeenCalledWith({ process: 'Telegram.exe', exe: 'C:\\T\\Telegram.exe', args: [] })
    expect(res).toEqual({ status: 'done', result: { running: true, started: true, pid: 99, process: 'Telegram.exe' } })
  })
  it("act: 没连 Stream Desktop 时桌面 open 报 agent-disconnected（能力不可用，不是这次失败）", async () => {
    const r = makeCdpRouter({ ...deps(), desktop: () => undefined })
    await expect(r.act({ target: 'app:Telegram.exe', kind: 'open', domain: 'desktop' })).rejects.toThrow(/agent-disconnected/)
  })
  it('look: inventory:true 走跨 iframe 的清单（不是只在顶层文档跑一段 js）', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    expect(await r.look({ target: 'chrome:42', inventory: true })).toEqual({ value: { items: [] } })
    expect(d.chromeInventory).toHaveBeenCalledWith(42)
    expect(d.chromeLook).not.toHaveBeenCalled()
  })
  it('look: inventory + url 交给开标签那一格，带上 inventory 旗', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await r.look({ target: 'chrome', url: 'https://x', inventory: true, interactive: true })
    expect(d.chromeCdp).toHaveBeenCalledWith('https://x', expect.stringContaining('data-stream-el'), { interactive: true, inventory: true })
  })
  it('look: frame 透传到 chrome 读口；别的档与 inventory 同给都拒', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await r.look({ target: 'chrome:42', js: 'document.title', frame: 'gamemp' })
    expect(d.chromeLook).toHaveBeenCalledWith(42, 'document.title', 'gamemp')
    await expect(r.look({ target: 'facility:xhs', js: '1', frame: 'x' })).rejects.toThrow(/frame 只在 chrome 档/)
    await expect(r.look({ target: 'chrome:42', inventory: true, frame: 'x' })).rejects.toThrow(/跨全部 iframe/)
    await expect(r.look({ target: 'chrome', url: 'https://x', js: '1', frame: 'x' })).rejects.toThrow(/已开着的标签/)
  })
  it('act: frame 随动作下去（chrome）；别的档拒', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await r.act({ target: 'chrome:9', kind: 'click', domain: 'x', selector: '#b', frame: 'F1' })
    expect(d.chromeAct).toHaveBeenCalledWith(expect.objectContaining({ tabId: 9, frame: 'F1', selector: '#b' }), undefined)
    await expect(r.act({ target: 'facility:xhs', kind: 'click', domain: 'x', frame: 'F1' })).rejects.toThrow(/frame 只在 chrome 档/)
  })
  it('look: inventory 与 js 同给是错——只会有一个生效，别猜是哪个', async () => {
    const r = makeCdpRouter(deps())
    await expect(r.look({ target: 'chrome:42', inventory: true, js: '1' })).rejects.toThrow(/二选一/)
  })
  it('look: 既没 js 也没 inventory 是错', async () => {
    const r = makeCdpRouter(deps())
    await expect(r.look({ target: 'chrome:42' })).rejects.toThrow(/needs js/)
  })
  it('look: desktop 档 inventory 被拒（那一档的 a11y query 本来就是清单）', async () => {
    const r = makeCdpRouter({ ...deps(), desktop: () => ({} as never) })
    await expect(r.look({ target: 'desktop', inventory: true })).rejects.toThrow(/a11y query/)
  })
  it('act: ref 展开成 data-stream-el 选择器后走原路', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await r.act({ target: 'chrome:9', kind: 'click', domain: 'x.com', ref: 12 })
    expect(d.chromeAct).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 9, kind: 'click', selector: '[data-stream-el="12"]' }), undefined,
    )
    // ref 是寻址糖，不该作为动作语义漏进下游
    expect(d.chromeAct.mock.calls[0]![0]).not.toHaveProperty('ref')
  })
  it('act: ref 与 selector 同给是错', async () => {
    const r = makeCdpRouter(deps())
    await expect(r.act({ target: 'chrome:9', kind: 'click', domain: 'x', ref: 3, selector: '#a' })).rejects.toThrow(/二选一/)
  })
  it('act: facility 给 ref 被拒（采集页不开放按编号动作）', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    await expect(r.act({ target: 'facility:xhs', kind: 'click', domain: 'x', ref: 3 })).rejects.toThrow(/只在 chrome 档有效/)
    expect(d.facilityAct).not.toHaveBeenCalled()
  })
  it('pages: chrome lists, chrome close closes, facility single', async () => {
    const d = deps(); const r = makeCdpRouter(d)
    expect(await r.pages({ target: 'chrome' })).toEqual({ pages: [{ tabId: 1, url: 'u', title: 't' }] })
    expect(await r.pages({ target: 'chrome', close: 5 })).toEqual({ closed: 5 })
    expect(d.chromeCloseTab).toHaveBeenCalledWith(5)
    expect(await r.pages({ target: 'facility:xhs' })).toEqual({ pages: [{ target: 'facility:xhs' }] })
  })
})

describe('cdp_shot chrome 档截不到帧 → 原生窗口截图', () => {
  const NO_FRAME = 'Page.captureScreenshot 在 1500ms 内没有回执：这个标签没有产出帧（Chrome 窗口没有真的显示在屏幕上——被盖住/最小化/锁屏都算）'
  function setup(tab: { active?: boolean; title?: string } = {}, windows = [
    { id: 'w1', process: 'chrome.exe', title: '游戏设置 - Google Chrome', foreground: false },
    { id: 'w2', process: 'Code.exe', title: '游戏设置 - notes', foreground: true },
  ]) {
    const d = deps()
    d.chromeShot.mockRejectedValue(new Error(NO_FRAME))
    d.chromeTabs.mockResolvedValue([{ tabId: 5, url: 'https://mp.test/', title: tab.title ?? '游戏设置', active: tab.active ?? true }] as never)
    const scoped: unknown[] = []
    const driver = {
      windows: vi.fn(async () => windows),
      scopeWindow: vi.fn(async (m: unknown) => { scoped.push(m); return windows[0] }),
      screenshot: vi.fn(async () => Buffer.from('WIN')),
    }
    return { d, driver, scoped }
  }

  it('标签是那扇窗的当前标签 → 自动截那扇 Chrome 窗，回执说清是整窗、用的哪个 app: 地址', async () => {
    const { d, driver, scoped } = setup()
    const r = makeCdpRouter({ ...d, desktop: () => driver as never })
    const out = await r.shot({ target: 'chrome:5' })
    expect(out).toMatchObject({ shot: Buffer.from('WIN').toString('base64'), via: 'window', target: 'app:chrome.exe/游戏设置 - Google Chrome' })
    expect(scoped).toEqual([{ process: 'chrome.exe', title: '游戏设置 - Google Chrome' }]) // 按整个窗口标题认，不是子串
  })

  it('标签不是当前标签 → 不回落（会截到别的标签），报错说先切过去', async () => {
    const { d, driver } = setup({ active: false })
    const r = makeCdpRouter({ ...d, desktop: () => driver as never })
    await expect(r.shot({ target: 'chrome:5' })).rejects.toThrow(/不是它那扇窗的当前标签/)
    expect(driver.screenshot).not.toHaveBeenCalled()
  })

  it('Stream Desktop 没连 → 报错里写出该调的 app: 地址', async () => {
    const { d } = setup()
    const r = makeCdpRouter({ ...d, desktop: () => undefined })
    await expect(r.shot({ target: 'chrome:5' })).rejects.toThrow("cdp_shot({target:'app:chrome.exe/游戏设置'})")
  })

  it('两扇 Chrome 窗标题都像 → 不擅自挑', async () => {
    const { d, driver } = setup({}, [
      { id: 'w1', process: 'chrome.exe', title: '游戏设置 - Google Chrome', foreground: false },
      { id: 'w3', process: 'chrome.exe', title: '游戏设置 - Google Chrome', foreground: false },
    ])
    const r = makeCdpRouter({ ...d, desktop: () => driver as never })
    await expect(r.shot({ target: 'chrome:5' })).rejects.toThrow(/不擅自挑/)
  })

  it('别的截图失败原样冒出去，不去碰原生档', async () => {
    const { d, driver } = setup()
    d.chromeShot.mockRejectedValue(new Error('refuse to attach tab 5'))
    const r = makeCdpRouter({ ...d, desktop: () => driver as never })
    await expect(r.shot({ target: 'chrome:5' })).rejects.toThrow('refuse to attach tab 5')
    expect(driver.windows).not.toHaveBeenCalled()
  })
})

/**
 * C1 集成测试：`cdp_act`（人在交互时用的那条路）的一次调用是好几个 host op（`focusApp` →
 * `type`），跟一趟并发的 desktop recipe（`run_action_recipe` 那条路，`runDesktopRecipe` 包过
 * `withSession`）共用同一个 `WsHostRelay` 时不能互相插队——插了队就是复评实测撞见的那条事故：
 * `focusApp{Notepad} → focusApp{QQ} → type{recipe的字} → type{agent的字}`，agent 的字打进了
 * recipe 抢到的窗口。
 *
 * 跟 `desktop-runner.test.ts` 里同名的 C1 集成测试同一个手法：真 `WsHostRelay` + 假 socket
 * （异步回复，模拟真实 round-trip），而不是直接喂 `DesktopDriver` 假件——只有经过真的 relay，
 * 会话租约这道闸才在测试路径上。
 */
describe('cdp_act 与并发 desktop recipe：会话租约防交错', () => {
  function tagOf(op: string, args: Record<string, unknown> | undefined): 'recipe' | 'act' | undefined {
    const s = JSON.stringify(args ?? {})
    // `status` 的文字是 `<sourceId> · <步骤> (i/n)`——sourceId 就是它的身份。
    if (s.includes('QQ.exe') || s.includes('"recipe-text"') || s.includes('"AAA"') || s.includes('concurrent-recipe')) return 'recipe'
    if (s.includes('Notepad.exe') || s.includes('"agent-text"')) return 'act'
    return undefined
  }

  function relayWithLog() {
    const relay = new WsHostRelay()
    const sentOps: Array<{ op: string; args?: Record<string, unknown> }> = []
    const socket: HostSocket = {
      send(raw) {
        const msg = JSON.parse(raw) as { id: number; op: string; args?: Record<string, unknown> }
        sentOps.push({ op: msg.op, args: msg.args })
        queueMicrotask(() => {
          if (msg.op === 'scopeWindow') {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: { window: { id: 'w', process: 'x', title: 't', foreground: true } } }))
          } else if (msg.op === 'readSubtree') {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: [{ id: 'item' }] }))
          } else if (msg.op === 'focusApp') {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: { ok: true } }))
          } else {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: {} }))
          }
        })
      },
    }
    relay.connect(socket)
    return { relay, sentOps }
  }

  const recipe: DesktopRecipe = {
    version: 1,
    kind: 'desktop',
    sourceId: 'concurrent-recipe',
    app: { process: 'QQ.exe' },
    steps: [{ kind: 'focus' }, { kind: 'type', text: 'recipe-text' }],
    observer: { itemQuery: { role: 'ListItem', name: 'AAA' }, fields: { title: { read: 'name' } }, dedupeBy: 'id' },
    read: { dedupeBy: 'id', targetCount: 1 },
  }

  it('cdp_act 的 focusApp+type 不会插进并发 recipe 的 op 序列中间', async () => {
    const { sentOps, relay } = relayWithLog()
    const recipeDriver = makeDesktopDriver(relay)
    const actDriver = makeDesktopDriver(relay)
    const router = makeCdpRouter({ ...deps(), desktop: () => actDriver })

    // `cdp_act` 先起跑；等它把自己的第一个 op（focusApp）真的发到 socket 之后（一个微任务
    // tick，让它跑到自己第一次 `await relay.send()` 那一步），recipe 才紧随其后并发发出——
    // 正是复评实测的时序：act 的第一个 op 在途中，recipe 到点起跑排进队。
    const pAct = router.act({ target: 'app:Notepad.exe', kind: 'type', domain: 'desktop', text: 'agent-text' })
    await Promise.resolve()
    const pRecipe = runDesktopRecipe(recipe, {}, recipeDriver)
    const [outRecipe] = await Promise.all([pRecipe, pAct])
    expect(outRecipe.outcome).toBe('ok')

    // 结尾那条 `status:null`（清指示条）身上没有能认出归属的字段，单独放过；带文字的照样参与。
    const tags = sentOps.filter((s) => !(s.op === 'status' && s.args?.text === null)).map((s) => tagOf(s.op, s.args))
    expect(tags).not.toContain(undefined) // 每个 op 都认得出属于谁——不然分块断言测不出交错
    // 真正的钉子：不断言谁先谁后（那可能只是巧合），只断言各自连成一片、不被对方夹在中间——
    // 数"连续同标签段"应当恰好两段。没有这道租约时，act 会先发出第一个 op、被 recipe 整趟
    // 插进来、recipe 跑完才轮到 act 的第二个 op，段数变成三段（act, recipe, act）。
    const groups = tags.reduce<string[]>((acc, t) => {
      if (acc[acc.length - 1] !== t) acc.push(t as string)
      return acc
    }, [])
    expect(groups).toEqual([groups[0], groups[0] === 'act' ? 'recipe' : 'act'])
  })
})

/**
 * 排队超时的归类。`run_action_recipe` 那条路早就把 `HostSessionQueueTimeout` 映成了带下一步
 * 的状态（`action-recipe.ts`：「大概率还没开始执行，稍后重试即可」），而 `cdp_*` 这条交互路径
 * 抛的是裸的异常——同一件事两条路一条有归类一条没有，将来加第五个动词容易照着没归类的那条抄。
 *
 * 钉的是**下一步说得出来**，不是某句措辞：调用方（模型）要能分出「这次 op 根本没发出去，重试
 * 即可」和「agent 挂了，去查 agent」——后者是 `HostRelayTimeout` 那一档。
 */
describe('cdp_*：排队等会话租约超时要归类', () => {
  const busyDriver = () =>
    ({
      withSession: <T,>(_fn: () => Promise<T>) => Promise.reject(new HostSessionQueueTimeout()),
    }) as never

  it('四个动词都把排队超时映成带下一步的说明，而不是裸异常', async () => {
    const r = makeCdpRouter({ ...deps(), desktop: busyDriver })
    const calls = [
      () => r.look({ target: 'app:QQ.exe', js: '{"role":"Button"}' }),
      () => r.shot({ target: 'app:QQ.exe' }),
      () => r.act({ target: 'app:QQ.exe', kind: 'type', domain: 'desktop', text: 'x' }),
      () => r.pages({ target: 'desktop' }),
    ]
    for (const call of calls) {
      const e = await call().then(() => undefined, (err: unknown) => err as Error)
      expect(e).toBeInstanceOf(Error)
      // 裸的那句原样冒出来就算没归类
      expect(e!.name).not.toBe('HostSessionQueueTimeout')
      expect(e!.message).toContain(SESSION_BUSY_REASON)
    }
  })

  // 用户按热键叫停 `cdp_act` 的一次动作，和 `run_action_recipe` 那条路是同一件事，措辞也
  // 必须是同一句（`USER_ABORTED_REASON`）——两条路各写各的，就会漂成"一条说别重试、一条
  // 只说超时"，而这一档的下一步恰恰是四档里唯一"别自动重试"的。
  it('四个动词都把用户中止映成"别自动重试"的那句，而不是裸异常', async () => {
    const abortedDriver = () =>
      ({
        withSession: <T,>(_fn: () => Promise<T>) => Promise.reject(new HostAbortedByUser('user-hotkey')),
      }) as never
    const r = makeCdpRouter({ ...deps(), desktop: abortedDriver })
    const calls = [
      () => r.look({ target: 'app:QQ.exe', js: '{"role":"Button"}' }),
      () => r.shot({ target: 'app:QQ.exe' }),
      () => r.act({ target: 'app:QQ.exe', kind: 'type', domain: 'desktop', text: 'x' }),
      () => r.pages({ target: 'desktop' }),
    ]
    for (const call of calls) {
      const e = await call().then(() => undefined, (err: unknown) => err as Error)
      expect(e).toBeInstanceOf(Error)
      expect(e!.message).toContain(USER_ABORTED_REASON)
    }
  })

  it('归类只吃排队超时这一种——别的错误原样冒出去，不许被吞成"通道忙"', async () => {
    const boom = new Error('scopeWindow blew up')
    const r = makeCdpRouter({
      ...deps(),
      desktop: () => ({ withSession: <T,>(_fn: () => Promise<T>) => Promise.reject(boom) }) as never,
    })
    await expect(r.shot({ target: 'app:QQ.exe' })).rejects.toBe(boom)
  })
})
