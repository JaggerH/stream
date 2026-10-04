import { describe, it, expect } from 'vitest'
import { runDesktopRecipe, stepStatusText, HARD_SEE_ERRORS, type DesktopRunOutcome } from './desktop-runner.ts'
import type { DesktopArea, DesktopRecipe, DesktopStep, See } from './desktop-recipe.ts'
import { makeDesktopDriver, type DesktopDriver, type A11yElement, type A11yQuery, type ReadSpec, type AppMatch, type Rect, type WindowCapture, type ScreenText, type SeeElement, type ImageHit } from './desktop-driver.ts'
import { WsHostRelay, type HostSocket } from '../http/host-relay.ts'
import { makeSeeResolver, type SeeResolver } from './desktop-see.ts'
import { SeeCache } from './see-cache.ts'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** A scriptable fake DesktopDriver that records calls and answers find/readSubtree from queues. */
function fakeDriver(opts: {
  find?: (q: A11yQuery) => A11yElement[]
  reads?: Record<string, string>[][] // successive readSubtree batches
  wall?: boolean
  /** true = 这个应用不认 ValuePattern（自绘控件的常态），setValue 抛错 */
  setValueFails?: boolean
  /** agent 对空结果挂的那面旗：「0 命中，而目标窗口不在前台」（Electron 的 a11y 树懒建） */
  unbuilt?: string
  /** 每次 `windows()` 回什么（逐次消费，最后一项重复）——`window` 步骤要等它出现。
   *  `fg: true` = 这个窗口此刻占着前台（抬不上来时要报出它是谁）。 */
  windows?: Array<Array<{ process: string; title: string; fg?: boolean; platform?: 'win32' | 'darwin'; appVersion?: string }>>
  /** agent 报的平台/应用版本（`WindowInfo.platform` / `appVersion`）——`scopeWindow` 的回执带着它，
   *  runner 按它挑落地方式。**不给 = 老 agent 不报**，只有通用 body 能参与。 */
  platform?: 'win32' | 'darwin'
  appVersion?: string
  /** false = 窗口抬不到前台（屏幕锁着 / 会话没人连着）。**回读结果，不是"我调用过了吗"** */
  focusOk?: boolean
  /** true = 这个 agent 没有零位移叫醒那一口（老 agent / 非 Windows），调用方该落回 moveMouse */
  nudgeUnsupported?: boolean
  /** agent 认出了挡着的是谁时会**抛**这句（`<code>: <人话>`），不是回 false */
  focusThrows?: string
  capture?: WindowCapture
  /** 这一屏认出了什么。`elements` 不给就**从 `texts` 推**（落单即入表：没被任何检测器框
   *  包住的文字段自成一条 `kind:'text'` 元素）——绝大多数用例不关心两张表的差别，只有那几条
   *  专门验二分的才自己给 `elements`。 */
  screen?: () => { texts: ScreenText[]; elements?: SeeElement[]; window: Rect; scale: number } | null
  image?: (tpl: Buffer) => ImageHit | null
} = {}) {
  const calls: Array<{ m: string; a?: unknown; deliver?: string; a11y?: boolean }> = []
  /** 指示条上写过的每一句（`status` op），**不进 `calls`**：它是旁路提示，不该混进那些
   *  对 op 序列做 `toEqual` 的断言里。 */
  const statuses: Array<string | null> = []
  let readIdx = 0
  let winIdx = 0
  const el = (ref: string): A11yElement => ({ ref, role: 'Button', name: '', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } as Rect })
  const driver: DesktopDriver = {
    async focusApp(match: AppMatch) {
      calls.push({ m: 'focusApp', a: match })
      if (opts.focusThrows) throw new Error(opts.focusThrows)
      return opts.focusOk ?? true
    },
    async ensureApp(spec) { calls.push({ m: 'ensureApp', a: spec }); return { running: true, started: false, process: 'chrome' } },
    async find(q) {
      calls.push({ m: 'find', a: q })
      if (opts.wall && JSON.stringify(q).includes('login-wall')) return { elements: [el('wall')] }
      const elements = opts.find ? opts.find(q) : [el('found')]
      return { elements, ...(elements.length === 0 && opts.unbuilt ? { unbuilt: opts.unbuilt } : {}) }
    },
    async windows() {
      calls.push({ m: 'windows' })
      const q = opts.windows ?? []
      const batch = q[Math.min(winIdx, q.length - 1)] ?? []
      winIdx++
      return batch.map((w) => ({
        id: w.title, process: w.process, title: w.title, foreground: w.fg ?? false,
        ...(w.platform ? { platform: w.platform } : {}),
        ...(w.appVersion ? { appVersion: w.appVersion } : {}),
      }))
    },
    async scopeWindow(match: AppMatch) {
      calls.push({ m: 'scopeWindow', a: match })
      return {
        id: 'w0', process: 'x.exe', title: 'x', foreground: true,
        ...(opts.platform ? { platform: opts.platform } : {}),
        ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
      }
    },
    async invoke(ref) { calls.push({ m: 'invoke', a: ref }); return {} },
    async setValue(ref, text) {
      calls.push({ m: 'setValue', a: { ref, text } })
      if (opts.setValueFails) throw new Error('setValue failed on every pattern — Value(unavailable): ...')
      return {}
    },
    async click(rect, button, _expect, deliver) { calls.push({ m: 'click', a: { rect, button }, ...(deliver ? { deliver } : {}) }); return {} },
    async moveMouse(x, y) { calls.push({ m: 'moveMouse', a: { x, y } }); return {} },
    async nudge() { calls.push({ m: 'nudge' }); return !opts.nudgeUnsupported },
    async status(text) { statuses.push(text) },
    async scroll(dir, amount, _expect, deliver) { calls.push({ m: 'scroll', a: { dir, amount }, ...(deliver ? { deliver } : {}) }); return {} },
    async type(text, _expect, deliver) { calls.push({ m: 'type', a: text, ...(deliver ? { deliver } : {}) }); return {} },
    async readSubtree(_spec: ReadSpec) {
      calls.push({ m: 'readSubtree' })
      const batch = opts.reads?.[readIdx] ?? []
      if (readIdx < (opts.reads?.length ?? 0) - 1) readIdx++
      return batch
    },
    async screenshot() { return null },
    async captureWindow() { return opts.capture ?? null },
    async readText(region) {
      calls.push({ m: 'readText', a: region })
      const s = opts.screen?.()
      return s ? { texts: s.texts, window: s.window, scale: s.scale } : null
    },
    async readElements(o) {
      // `a11y` 单独记一格：它是 recipe 的申报，断言要能直接看到 runner 有没有把它带到这里。
      calls.push({ m: 'readElements', a: o?.region, ...(o?.a11y !== undefined ? { a11y: o.a11y } : {}) })
      const s = opts.screen?.()
      if (!s) return null
      const elements = s.elements ?? s.texts.map((t) => ({ name: t.text, rect: t.rect, kind: 'text' as const }))
      return { elements, window: s.window, scale: s.scale }
    },
    async findImage(tpl) { calls.push({ m: 'findImage', a: tpl.length }); return opts.image ? opts.image(tpl) : null },
    async press(key, deliver) { calls.push({ m: 'press', a: key, ...(deliver ? { deliver } : {}) }); return {} },
    async clearInput(deliver) { calls.push({ m: 'clearInput', a: undefined, ...(deliver ? { deliver } : {}) }); return {} },
    async url() { return 'app#win' },
    async sleep(ms) { calls.push({ m: 'sleep', a: ms }) },
  }
  return { driver, calls, statuses }
}

const OBSERVER: ReadSpec = { itemQuery: { role: 'ListItem' }, fields: { title: { read: 'name' } }, dedupeBy: 'id' }

function recipe(over: Partial<DesktopRecipe> = {}): DesktopRecipe {
  return {
    version: 1,
    kind: 'desktop',
    sourceId: 'telegram-search',
    app: { process: 'Telegram.exe' },
    steps: [
      { kind: 'invoke', query: { role: 'Button', name: '搜索消息' } },
      { kind: 'type', text: '{q}' },
    ],
    observer: OBSERVER,
    read: { dedupeBy: 'id', targetCount: 10 },
    ...over,
  }
}

describe('runDesktopRecipe', () => {
  it('scopes to the app, invokes the located control, types the substituted query, reads items', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a', title: 'X' }, { id: 'b', title: 'Y' }]] })
    const out = await runDesktopRecipe(recipe(), { q: '4K' }, driver)
    expect(out.outcome).toBe('ok')
    expect(out.items).toEqual([{ id: 'a', title: 'X' }, { id: 'b', title: 'Y' }])
    const seq = calls.map((c) => c.m)
    // 开头是 scopeWindow 而不是 focusApp：限定搜索范围要，抢屏不要。键盘 type（这份 recipe
    // 的 type 没给 query）才需要前台，focusApp 因此紧挨着它、而不是在最前面。
    expect(seq).toEqual(['scopeWindow', 'find', 'invoke', 'focusApp', 'type', 'readSubtree'])
    expect(calls.find((c) => c.m === 'type')!.a).toBe('4K') // {q} substituted
  })

  // ── `app.process` 多候选：跨平台的名字，按「屏上有哪个」落成一个 ─────────────────────
  it('app.process 是一组候选时，先看一次 windows()，把屏上在的那个名字交给 agent', async () => {
    const { driver, calls } = fakeDriver({
      reads: [[{ id: 'a' }]],
      windows: [[{ process: '微信', title: '微信' }, { process: 'Finder', title: '' }]],
    })
    const out = await runDesktopRecipe(recipe({ app: { process: ['Weixin.exe', '微信', 'WeChat'], title: '微信' } }), { q: 'x' }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.map((c) => c.m).slice(0, 2)).toEqual(['windows', 'scopeWindow'])
    // agent 收到的是具体那一个名字，不是数组——它的协议只认一个
    expect(calls.find((c) => c.m === 'scopeWindow')!.a).toEqual({ process: '微信', title: '微信' })
    expect(calls.find((c) => c.m === 'focusApp')!.a).toEqual({ process: '微信', title: '微信' })
  })

  it('候选一个都不在屏上时退到第一个名字往下走——让 scopeWindow 用它自己的话失败', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]], windows: [[{ process: 'explorer.exe', title: 'x' }]] })
    await runDesktopRecipe(recipe({ app: { process: ['Weixin.exe', '微信'] } }), { q: 'x' }, driver)
    expect(calls.find((c) => c.m === 'scopeWindow')!.a).toEqual({ process: 'Weixin.exe' })
  })

  it('单个字符串的 app.process 不多查一次 windows()', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe(), { q: 'x' }, driver)
    expect(calls[0]!.m).toBe('scopeWindow')
  })

  // ── 抢屏只在真的要发出坐标/键盘输入的那一刻 ────────────────────────────────────────
  //
  // 定时采集每轮把用户的屏幕拽走一次，正是这条链路最该消灭的东西——而 telegram-search 七步里
  // 只有"打搜索词"一步真的需要前台。spec: 2026-08-04-desktop-background-typing-design.md

  it('全 invoke + 带 query 的 type：整轮一次 focusApp 都不发', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const out = await runDesktopRecipe(recipe({
      steps: [
        { kind: 'invoke', query: { role: 'Button', name: '搜索消息' } },
        { kind: 'type', text: '{q}', query: { role: 'Edit', name: '搜索' } },
      ],
    }), { q: '4K' }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.map((c) => c.m)).not.toContain('focusApp')
    expect(calls.find((c) => c.m === 'setValue')!.a).toEqual({ ref: 'found', text: '4K' })
    expect(out.typedVia).toBe('value')
  })

  it('setValue 失败就退回键盘——但必须留痕，不许静默抢屏', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]], setValueFails: true })
    const out = await runDesktopRecipe(recipe({
      steps: [{ kind: 'type', text: '{q}', query: { role: 'Edit', name: '搜索' } }],
    }), { q: '4K' }, driver)
    expect(out.outcome).toBe('ok')
    const seq = calls.map((c) => c.m)
    expect(seq).toEqual(['scopeWindow', 'find', 'setValue', 'focusApp', 'type', 'readSubtree'])
    expect(calls.find((c) => c.m === 'type')!.a).toBe('4K')
    expect(out.typedVia).toBe('keyboard') // 这一轮抢了屏，报告里说得出来
  })

  it('带 query 的 type 找不到输入框 → 退回键盘，不判 drift', async () => {
    // 输入框定位不到不等于流程走歪了：键盘那条路本来就不需要它（焦点由上一步的点击给的）
    const { driver, calls } = fakeDriver({ find: () => [], reads: [[{ id: 'a' }]] })
    const out = await runDesktopRecipe(recipe({
      steps: [{ kind: 'type', text: '{q}', query: { role: 'Edit', name: '搜索' } }],
    }), { q: '4K' }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.map((c) => c.m)).toEqual(['scopeWindow', 'find', 'focusApp', 'type', 'readSubtree'])
    expect(out.typedVia).toBe('keyboard')
  })

  it('click.at：按当前窗口 rect 的比例换成屏幕坐标再点；截不了窗就 drift；比例出界当场拒', async () => {
    const cap = { jpeg: Buffer.alloc(1), window: { x: 100, y: 50, w: 1000, h: 500 }, scale: 1 }
    const { driver, calls } = fakeDriver({ capture: cap })
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'click', at: { x: 0.6, y: 0.87 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      driver,
    )
    const i = calls.findIndex((c) => c.m === 'click')
    expect(calls[i]?.a).toEqual({ rect: { x: 700, y: 485, w: 1, h: 1 }, button: undefined })
    expect(calls.slice(0, i).some((c) => c.m === 'focusApp')).toBe(true)

    const noCap = fakeDriver()
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'click', at: { x: 0.5, y: 0.5 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      noCap.driver,
    )
    expect(out.outcome).toBe('drift')
    expect(noCap.calls.some((c) => c.m === 'click')).toBe(false)

    const bad = fakeDriver({ capture: cap })
    const out2 = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'click', at: { x: 1.2, y: 0.5 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      bad.driver,
    )
    expect(out2.outcome).toBe('drift')
    expect(out2.driftReason).toMatch(/0\.\.1/)
    expect(bad.calls.some((c) => c.m === 'click')).toBe(false)
  })

  it('click 步：坐标先填参、先抢前台再点，坐标不是数字就判 drift 而不是乱点', async () => {
    const { driver, calls } = fakeDriver()
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'click', x: '{sx}', y: 56 }], observer: undefined, read: undefined, allowEmpty: true }),
      { sx: '181' },
      driver,
    )
    const i = calls.findIndex((c) => c.m === 'click')
    expect(calls[i]?.a).toEqual({ rect: { x: 181, y: 56, w: 1, h: 1 }, button: undefined })
    expect(calls.slice(0, i).some((c) => c.m === 'focusApp')).toBe(true)

    const bad = fakeDriver()
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'click', x: '{sx}', y: 56 }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      bad.driver,
    )
    expect(out.outcome).toBe('drift')
    expect(bad.calls.some((c) => c.m === 'click')).toBe(false)
  })

  it('scroll 与 fallbackClick 也是坐标路，各自要前台', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe({
      steps: [
        { kind: 'invoke', query: { role: 'Button', name: '展开' }, fallbackClick: true },
        { kind: 'scroll', dir: 'down', amount: 300 },
      ],
    }), {}, driver)
    const seq = calls.map((c) => c.m)
    expect(seq).toEqual(['scopeWindow', 'find', 'focusApp', 'click', 'focusApp', 'scroll', 'readSubtree'])
  })

  it('没有 type 步骤的 recipe 不报 typedVia——“没打过字”和“打了字走的哪条路”要分得开', async () => {
    const { driver } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const out = await runDesktopRecipe(recipe({
      steps: [{ kind: 'invoke', query: { role: 'Button', name: '搜索消息' } }],
    }), {}, driver)
    expect(out.typedVia).toBeUndefined()
  })

  it('kind:"focus" 步骤仍然显式抢屏——recipe 作者明写要抢就抢', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe({ steps: [{ kind: 'focus' }] }), {}, driver)
    expect(calls.map((c) => c.m)).toEqual(['scopeWindow', 'focusApp', 'readSubtree'])
  })

  it('dedupes by the read key and caps at targetCount', async () => {
    const { driver } = fakeDriver({
      reads: [[{ id: 'a', title: '1' }, { id: 'a', title: '1' }, { id: 'b', title: '2' }, { id: 'c', title: '3' }]],
    })
    const out = await runDesktopRecipe(recipe({ read: { dedupeBy: 'id', targetCount: 2 } }), { q: 'x' }, driver)
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('scrolls + re-reads to page until targetCount, then stops', async () => {
    const { driver, calls } = fakeDriver({
      reads: [
        [{ id: 'a', title: '1' }],
        [{ id: 'a', title: '1' }, { id: 'b', title: '2' }],
        [{ id: 'a', title: '1' }, { id: 'b', title: '2' }, { id: 'c', title: '3' }],
      ],
    })
    const out = await runDesktopRecipe(
      recipe({ read: { dedupeBy: 'id', targetCount: 3, scroll: { dir: 'down', amount: 300, maxTicks: 5 } } }),
      { q: 'x' },
      driver,
    )
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(calls.filter((c) => c.m === 'scroll').length).toBeGreaterThanOrEqual(1)
    expect(calls.filter((c) => c.m === 'readSubtree').length).toBe(3)
  })

  it('stops paging when a scroll yields no fresh items', async () => {
    const { driver, calls } = fakeDriver({
      reads: [[{ id: 'a', title: '1' }], [{ id: 'a', title: '1' }]], // 2nd read = nothing new
    })
    const out = await runDesktopRecipe(
      recipe({ read: { dedupeBy: 'id', targetCount: 99, scroll: { dir: 'down', amount: 300, maxTicks: 5 } } }),
      { q: 'x' },
      driver,
    )
    expect(out.items.map((i) => i.id)).toEqual(['a'])
    expect(calls.filter((c) => c.m === 'readSubtree').length).toBe(2) // one page, then a dry read → stop
  })

  it('returns needsLogin when the wall signal is present', async () => {
    const { driver } = fakeDriver({ wall: true })
    const out = await runDesktopRecipe(
      recipe({ loginCheck: { loggedIn: { name: 'me' }, wall: { name: 'login-wall' } } }),
      { q: 'x' },
      driver,
    )
    expect(out.outcome).toBe('needsLogin')
  })

  /** 「按名打开某个频道」那类 recipe 的整条路都建立在 nameContains 上：会话列表项的 name 是一整句
   *  动态文本（未读数、最后一条消息、时间每秒都变），只有频道名那一截稳定。漏填参数不会报错——
   *  查询会拿字面的 `{channel}` 去匹配，返回空，看起来像"这个频道不存在"。 */
  it('nameContains 也要填参，跟 name 一样', async () => {
    const seen: A11yQuery[] = []
    const { driver } = fakeDriver({ find: (q) => { seen.push(q); return [{ ref: 'r', role: 'ListItem', name: '', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } as Rect }] }, reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', query: { role: 'ListItem', nameContains: '{channel}' } }] }),
      { channel: '夸克云盘影视资源频道' },
      driver,
    )
    expect(seen[0]).toEqual({ role: 'ListItem', nameContains: '夸克云盘影视资源频道' })
  })

  /** `map` 是 kind:'desktop' 的必需层，不是锦上添花：a11y 只能给一坨文本，而**前端各处显示的是
   *  顶层 item.title**（教训见 packages/alist/normalizer.ts）。没有它，任何桌面源进收件箱都是一排 (untitled)。 */
  it('map 从读到的文本里抽出顶层字段', async () => {
    const raw = '名称：野狗骨头（2026）4K 更至EP12\n\n描述：改编自同名小说。\n\n夸克：https://pan.quark.cn/s/aacab8de665b\n\n已收到 904 浏览次数'
    const { driver } = fakeDriver({ reads: [[{ text: raw }]] })
    const out = await runDesktopRecipe(recipe({
      map: {
        title: { from: 'text', match: '名称：(.+)' },
        link: { from: 'text', match: 'https?://[^\\s]+' },
      },
      read: { dedupeBy: 'link', targetCount: 10 },
    }), {}, driver)
    expect(out.items[0].title).toBe('野狗骨头（2026）4K 更至EP12')
    expect(out.items[0].link).toBe('https://pan.quark.cn/s/aacab8de665b')
    expect(out.items[0].text).toBe(raw) // 原文照留，抽取是叠加不是替换
  })

  /** 抽不到就不写这个键。写成空串会让下游把"没抽到"当成"抽到了一个空标题"——(untitled) 至少
   *  还看得出是缺失，一个空字符串则会一路装成正常值。 */
  it('抽不到的字段不写空串，而且它若是 dedupeBy 就整条丢掉', async () => {
    const { driver } = fakeDriver({ reads: [[{ text: '广告: 看到就是你的机会' }, { text: '名称：X\n\nhttps://pan.quark.cn/s/x' }]] })
    const out = await runDesktopRecipe(recipe({
      map: { title: { from: 'text', match: '名称：(.+)' }, link: { from: 'text', match: 'https?://[^\\s]+' } },
      read: { dedupeBy: 'link', targetCount: 10 },
    }), {}, driver)
    // 广告条没有链接 → dedupe 键缺席 → 不进收件箱（既有的 dedupeBy 语义，这里正好当过滤用）
    expect(out.items).toHaveLength(1)
    expect(out.items[0].title).toBe('X')
    expect('link' in out.items[0]).toBe(true)
  })

  it('没有 map 的 recipe 一切照旧', async () => {
    const { driver } = fakeDriver({ reads: [[{ id: 'a', title: 'X' }]] })
    const out = await runDesktopRecipe(recipe(), { q: '4K' }, driver)
    expect(out.items).toEqual([{ id: 'a', title: 'X' }])
  })

  it("wait 步：停一段等界面自己画出来", async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe({ steps: [{ kind: 'wait', ms: 800 }] }), {}, driver)
    expect(calls.find((c) => c.m === 'sleep')!.a).toBe(800)
  })

  /** 步骤级的 `press` 必须真的按下去。装载闸放行它之后，runner 这一侧要是没有分支，它就是
   *  一句什么都不做的话——而"复位没生效"和"复位不需要"在活体上长得一模一样，只有数调用能分开。 */
  it('press 步真的落到 driver 上，不是空转', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe({ steps: [{ kind: 'press', key: 'Escape' }] }), {}, driver)
    expect(calls.filter((c) => c.m === 'press').map((c) => c.a)).toEqual(['Escape'])
  })

  /** 诊断报的是**填过参**的 query。报模板等于让读的人看见 `{"nameContains":"{channel}"}`，
   *  而真正要知道的是"找不到的是哪个频道"——那正是这条 drift 唯一有用的信息。 */
  it('找不到目标时，drift 里报的是填过参的 query', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', query: { role: 'ListItem', nameContains: '{channel}' } }] }),
      { channel: '夸克云盘影视资源频道' },
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('夸克云盘影视资源频道')
    expect(out.driftReason).not.toContain('{channel}')
  })

  /** 「找不到目标」和「根本没读到」是两件事，而它们的 drift 长得一模一样。agent 挂了旗就
   *  必须把它编进 driftReason——否则排查的人会去改 recipe 的选择器（选择器一点毛病都没有，
   *  真因是 Electron 的 a11y 树在后台窗口上还没建）。 */
  it('agent 说树可能没建 → drift 原因里带着这句话', async () => {
    const { driver } = fakeDriver({ find: () => [], unbuilt: 'a11y-unbuilt: 窗口 123 不在前台' })
    const out = await runDesktopRecipe(recipe({ steps: [{ kind: 'invoke', query: { role: 'Button', name: '搜索消息' } }] }), {}, driver)
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('a11y-unbuilt')
  })

  /** 登录墙那一次 find 读空，本身不判失败（没墙住 = 好事），但**那面旗要记住**：后面若真的
   *  一条都没读到，drift 才说得出"可能整棵树都没建"，而不是干巴巴一句 no items read。 */
  it('loginCheck 那次 find 挂的旗，记到后面的 no-items drift 上', async () => {
    const { driver } = fakeDriver({ find: () => [], unbuilt: 'a11y-unbuilt: 窗口 123 不在前台', reads: [[]] })
    const out = await runDesktopRecipe(
      recipe({ steps: [], loginCheck: { loggedIn: { name: 'me' }, wall: { role: 'Text', name: 'login-wall' } } }),
      {},
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('no items read')
    expect(out.driftReason).toContain('a11y-unbuilt')
  })

  /** 一个界面上常常同时挂着好几组同 role 的列表（Telegram 的搜索结果和主消息列表都是 ListItem）。
   *  把当次参数编进 itemQuery 是唯一能说清"我要读哪一组"的手段——漏填的话查询会拿字面的
   *  `{q}` 去匹配，返回空，看起来像"这次什么都没搜到"。 */
  it('observer 的 itemQuery 也要填参', async () => {
    let seen: unknown
    const { driver } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const orig = driver.readSubtree.bind(driver)
    driver.readSubtree = async (spec) => { seen = spec.itemQuery; return orig(spec) }
    await runDesktopRecipe(
      recipe({ observer: { itemQuery: { role: 'ListItem', nameContains: '{q}' }, fields: { text: { read: 'name' } }, dedupeBy: 'id' } }),
      { q: '凡人修仙传' },
      driver,
    )
    expect(seen).toEqual({ role: 'ListItem', nameContains: '凡人修仙传' })
  })

  /** 复位步骤天然是可选的：首次运行时那个「取消搜索」按钮根本不存在，找不到正是正常情况。
   *  没有它就会撞上真发生过的那件事——上一轮把界面留在搜索模式，下一轮第一步匹配到的是
   *  **残留的搜索结果**（名字里同样带频道名），于是整条 recipe 从第二步起全在错的界面上跑，
   *  而每一步都"成功"了。 */
  it('optional 的 invoke 找不到目标 → 跳过，不判 drift', async () => {
    const { driver, calls } = fakeDriver({ find: (q) => (JSON.stringify(q).includes('取消搜索') ? [] : [{ ref: 'r', role: 'Button', name: '', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } as Rect }]), reads: [[{ id: 'a' }]] })
    const out = await runDesktopRecipe(recipe({
      steps: [
        { kind: 'invoke', query: { role: 'Button', name: '取消搜索' }, optional: true },
        { kind: 'invoke', query: { role: 'Button', name: '搜索消息' } },
      ],
    }), {}, driver)
    expect(out.outcome).toBe('ok')
    // 跳过的那一步不该发出 invoke；后面那步照常
    expect(calls.filter((c) => c.m === 'invoke')).toHaveLength(1)
  })

  it('clear 步：先抢屏再清空焦点框（收件人是此刻有焦点的东西，没有前台就是清别人的）', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const out = await runDesktopRecipe(recipe({ steps: [{ kind: 'clear' }] }), {}, driver)
    expect(out.outcome).toBe('ok')
    const seq = calls.map((c) => c.m)
    expect(seq.indexOf('focusApp')).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf('focusApp')).toBeLessThan(seq.indexOf('clearInput'))
  })

  it('没标 optional 的照旧 drift——别把真该失败的步骤变成静默错误', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    const out = await runDesktopRecipe(recipe({ steps: [{ kind: 'invoke', query: { role: 'Button', name: 'X' } }] }), {}, driver)
    expect(out.outcome).toBe('drift')
  })

  it('returns drift when an invoke target is not found', async () => {
    const { driver } = fakeDriver({ find: () => [], reads: [[]] })
    const out = await runDesktopRecipe(recipe(), { q: 'x' }, driver)
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/not found/)
  })

  it('returns drift when nothing is read', async () => {
    const { driver } = fakeDriver({ reads: [[]] })
    const out = await runDesktopRecipe(recipe(), { q: 'x' }, driver)
    expect(out.outcome).toBe('drift')
  })

  /** allowEmpty 只改变"0 条"这一档的判法：动作型 recipe（如"发一条消息"）本来就无物可读，
   *  0 条是它唯一合法的成功形状。跟浏览器那边的 CanonicalBrowserRecipe.allowEmpty 同语义。 */
  it('allowEmpty: true 且读到 0 条 → 正常返回 ok，不判 drift', async () => {
    const { driver } = fakeDriver({ reads: [[]] })
    const out = await runDesktopRecipe(recipe({ allowEmpty: true }), { q: 'x' }, driver)
    expect(out.outcome).toBe('ok')
    expect(out.items).toEqual([])
  })

  /** 这条是防止"把闸门整个拆了"的保险：不开 allowEmpty，0 条依旧是 drift——一条该读到东西
   *  的 recipe 读不到，不能因为加了这个字段就被悄悄放过。 */
  it('不设 allowEmpty（或为 false）且读到 0 条 → 仍然判 drift', async () => {
    const { driver: d1 } = fakeDriver({ reads: [[]] })
    const out1 = await runDesktopRecipe(recipe(), { q: 'x' }, d1)
    expect(out1.outcome).toBe('drift')

    const { driver: d2 } = fakeDriver({ reads: [[]] })
    const out2 = await runDesktopRecipe(recipe({ allowEmpty: false }), { q: 'x' }, d2)
    expect(out2.outcome).toBe('drift')
  })

  // ── 指示条上的"到第几步了"（`status` op）────────────────────────────────────────

  /** 两行：第一行 `title[ · purpose 填参]`、第二行 `label (i/n)`，`\n` 连（overlay 按它拆成第二、三行）。
   *  缺 title 退回 sourceId；缺 purpose 第一行只有 title。**purpose 是唯一一处参数上屏的地方**——它是
   *  作者写的模板，只吃作者点名的那个参数；label 里的 `{q}` 仍原样留着。 */
  it('stepStatusText：两行形状，title/purpose 缺席时退化', () => {
    const steps = { length: 12 }
    const step = { kind: 'click', label: '点候选里的他' }
    expect(stepStatusText({ sourceId: 'wechat-send', steps, meta: { title: '微信发消息', purpose: '发给 {contact}' } }, { contact: '文件传输助手' }, 7, step))
      .toBe('微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)')
    expect(stepStatusText({ sourceId: 'wechat-send', steps, meta: { title: '微信发消息' } }, { contact: 'x' }, 7, step))
      .toBe('微信发消息\n点候选里的他 (8/12)')
    expect(stepStatusText({ sourceId: 'wechat-send', steps }, {}, 7, { kind: 'click' }))
      .toBe('wechat-send\nclick (8/12)')
  })

  it('有 title/purpose 的 recipe 整轮发出的 status 都是两行、purpose 里的参数已填', async () => {
    const { driver, statuses } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const r = recipe({ meta: { title: '找人', purpose: '找 {q}', params_schema: { q: { type: 'string' } } }, steps: [{ kind: 'invoke', query: { role: 'Button', name: '搜索消息' }, label: '打开搜索' }] })
    const out = await runDesktopRecipe(r, { q: 'Bob' }, driver)
    expect(out.outcome).toBe('ok')
    expect(statuses).toEqual(['找人 · 找 Bob\n打开搜索 (1/1)', null])
  })

  it('purpose 填参后带换行 → 压平成空格，第三行不被挤掉', async () => {
    const { driver, statuses } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const r = recipe({ meta: { title: '找人', purpose: '找 {q}', params_schema: { q: { type: 'string' } } }, steps: [{ kind: 'invoke', query: { role: 'Button', name: '搜索消息' }, label: '打开搜索' }] })
    const out = await runDesktopRecipe(r, { q: 'Bob\nEvil' }, driver)
    expect(out.outcome).toBe('ok')
    expect(statuses[0]).toBe('找人 · 找 Bob Evil\n打开搜索 (1/1)')
    expect((statuses[0] as string).split('\n')).toHaveLength(2)
  })

  /** 每步开头一条、结尾一条 null；文字只有 recipe id + label/kind + 序号，**参数值一个都不上屏**
   *  （这条 recipe 没有 purpose；label 里的 `{q}` 模板也原样留着，不替换）。 */
  it('每一步发一条 status、整轮结束发 null，文字里没有参数值', async () => {
    const { driver, statuses } = fakeDriver({ reads: [[{ id: 'a' }]] })
    const r = recipe({
      steps: [
        { kind: 'invoke', query: { role: 'Button', name: '搜索消息' }, label: '打开搜索' },
        { kind: 'type', text: '{q}', label: '输入 {q}' },
      ],
    })
    const out = await runDesktopRecipe(r, { q: 'SECRET-4K' }, driver)
    expect(out.outcome).toBe('ok')
    expect(statuses).toEqual(['telegram-search\n打开搜索 (1/2)', 'telegram-search\n输入 {q} (2/2)', null])
    expect(JSON.stringify(statuses)).not.toContain('SECRET-4K')
  })

  it('没 label 的步骤用 kind 顶上；失败的那一趟结尾同样清掉', async () => {
    const { driver, statuses } = fakeDriver({ reads: [[]] }) // 0 条 → drift
    await runDesktopRecipe(recipe(), { q: 'x' }, driver)
    expect(statuses[0]).toBe('telegram-search\ninvoke (1/2)')
    expect(statuses.at(-1)).toBeNull()
  })

  /** `STREAM_DESKTOP_STATUS=0`：一条都不发，连结尾的清除也不发（关掉就是关掉）。 */
  it('STREAM_DESKTOP_STATUS=0 时一条 status 都不发', async () => {
    const prev = process.env.STREAM_DESKTOP_STATUS
    process.env.STREAM_DESKTOP_STATUS = '0'
    try {
      const { driver, statuses, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
      const out = await runDesktopRecipe(recipe(), { q: 'x' }, driver)
      expect(out.outcome).toBe('ok')
      expect(statuses).toEqual([])
      expect(calls.map((c) => c.m)).toContain('invoke') // 关掉的只是提示，recipe 照跑
    } finally {
      if (prev === undefined) delete process.env.STREAM_DESKTOP_STATUS
      else process.env.STREAM_DESKTOP_STATUS = prev
    }
  })
})

/**
 * C1 集成测试：两条并发 `runDesktopRecipe`（各自的 driver 是 `makeDesktopDriver` 包出来的，
 * 但共用同一个 `WsHostRelay`——正是生产环境的形状，见 `harvest.ts` 的 `desktopDriver` 唯一
 * 构造点头注）不能互相插队。用一个真的 `WsHostRelay` + 假 socket（异步回复，模拟真实的
 * relay round-trip），而不是 desktop-runner.test.ts 上面那种直接给 `DesktopDriver` 的假件——
 * 只有经过真的 relay，"会话租约" 这道闸才在测试路径上（假 DesktopDriver 压根不构造 relay，
 * 测不到这个问题）。
 */
describe('runDesktopRecipe：会话租约防跨 recipe 交错', () => {
  /** 把出站 op 打上"属于 A 还是 B"的标——扫每种 op 类型里能带上身份的那个字段
   *  （scopeWindow/focusApp 的 match.process、type 的 text、readSubtree 的 itemQuery.name）。
   *  两条 recipe 的这几个字段特意取不重叠的值，所以每条发出去的 op 都能唯一归属。 */
  function tagOf(op: string, args: Record<string, unknown> | undefined): 'A' | 'B' | undefined {
    const s = JSON.stringify(args ?? {})
    if (s.includes('QQ.exe') || s.includes('"hello"') || s.includes('"AAA"')) return 'A'
    if (s.includes('Telegram.exe') || s.includes('"world"') || s.includes('"BBB"')) return 'B'
    return undefined
  }

  /** 建一个真 relay + 假 socket：出站 op 记进 `sentOps`，异步（`queueMicrotask`，模拟真实
   *  round-trip 不是同步返回）回一个能让 recipe 往下走的最小合法回执。 */
  function relayWithLog(opts: { errorOnTypeText?: string } = {}) {
    const relay = new WsHostRelay()
    const sentOps: Array<{ op: string; args?: Record<string, unknown> }> = []
    const socket: HostSocket = {
      send(raw) {
        const msg = JSON.parse(raw) as { id: number; op: string; args?: Record<string, unknown> }
        sentOps.push({ op: msg.op, args: msg.args })
        queueMicrotask(() => {
          if (msg.op === 'type' && opts.errorOnTypeText && (msg.args as { text?: string } | undefined)?.text === opts.errorOnTypeText) {
            relay.handleMessage(JSON.stringify({ id: msg.id, error: 'agent crashed mid-recipe' }))
            return
          }
          if (msg.op === 'focusApp') {
            // **`{ok:true}` 是必须的**：agent 的 focusApp 回的是回读结果「它现在真的在前台吗」，
            // runner 据此决定要不要停手。假件回一个空对象等于说"抬失败了"。
            relay.handleMessage(JSON.stringify({ id: msg.id, result: { ok: true, window: { id: 'w', process: 'x', title: 't', foreground: true } } }))
          } else if (msg.op === 'scopeWindow') {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: { window: { id: 'w', process: 'x', title: 't', foreground: true } } }))
          } else if (msg.op === 'readSubtree') {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: [{ id: 'item' }] }))
          } else {
            relay.handleMessage(JSON.stringify({ id: msg.id, result: {} }))
          }
        })
      },
    }
    relay.connect(socket)
    return { relay, socket, sentOps }
  }

  const twoStepRecipe = (process: string, text: string, itemName: string): DesktopRecipe => ({
    version: 1,
    kind: 'desktop',
    sourceId: `concurrent-${process}`,
    app: { process },
    steps: [{ kind: 'focus' }, { kind: 'type', text }],
    observer: { itemQuery: { role: 'ListItem', name: itemName }, fields: { title: { read: 'name' } }, dedupeBy: 'id' },
    read: { dedupeBy: 'id', targetCount: 1 },
  })

  it('两条并发 recipe 发到 socket 的 op 顺序是"A 全部在前、B 全部在后"，不交错', async () => {
    const { sentOps, relay } = relayWithLog()
    const driverA = makeDesktopDriver(relay)
    const driverB = makeDesktopDriver(relay)
    const recipeA = twoStepRecipe('QQ.exe', 'hello', 'AAA')
    const recipeB = twoStepRecipe('Telegram.exe', 'world', 'BBB')

    // 不 await 中间那个：两条 recipe 真的并发在跑，就像 scheduler 的成员抓取那样。
    const pA = runDesktopRecipe(recipeA, {}, driverA)
    const pB = runDesktopRecipe(recipeB, {}, driverB)
    const [outA, outB] = await Promise.all([pA, pB])
    expect(outA.outcome).toBe('ok')
    expect(outB.outcome).toBe('ok')

    // 结尾那条 `status:null`（清指示条）身上没有任何能认出归属的字段，单独放过；带文字的
    // status（`concurrent-QQ.exe\nfocus (1/2)`）照样参与分块断言——它也在租约里，不许交错。
    const tags = sentOps.filter((s) => !(s.op === 'status' && s.args?.text === null)).map((s) => tagOf(s.op, s.args))
    expect(tags).not.toContain(undefined) // 每个 op 都认得出属于谁——不然下面的分块断言测不出交错
    // 真正的钉子：不是"A 在 B 前面"（那可能只是巧合），而是 A 的 op 连成一片、B 的也连成一片，
    // 中间不夹杂对方的——这正是复评实测撞见的反例（focusApp{A} → focusApp{B} → type{A} → type{B}）
    // 应该做不到的事。
    const firstB = tags.indexOf('B')
    expect(tags.slice(0, firstB)).toEqual(Array(firstB).fill('A'))
    expect(tags.slice(firstB)).toEqual(Array(tags.length - firstB).fill('B'))
  })

  // ── skipIf / window / 省掉 observer：让"一套固定的桌面流程"能整个写成 recipe ──────────
  //
  // 这三样都是被**代装 Chrome 扩展**那条流程逼出来的，但没有一样是它特有的：幂等开关、
  // 原生文件对话框、无物可读的动作型 recipe，都是桌面自动化的常见形状。

  it('skipIf 命中 → 整步跳过（幂等开关：已经开着还点一次就是把它关掉）', async () => {
    const { driver, calls } = fakeDriver({
      // 「加载未打包」在场 = 开发者模式已经开着
      find: (q) => (JSON.stringify(q).includes('加载未打包') ? [{ ref: 'load', role: 'Button', name: '加载未打包', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []),
      reads: [[{ id: 'a' }]],
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [
          {
            kind: 'invoke',
            query: { role: 'Button', name: '开发者模式' },
            skipIf: { role: 'Button', name: '加载未打包' },
          },
        ],
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    expect(calls.some((c) => c.m === 'invoke')).toBe(false)
  })

  it('skipIf 落空 → 这一步照常做（守卫不能变成"永远跳过"）', async () => {
    const { driver, calls } = fakeDriver({
      find: (q) => (JSON.stringify(q).includes('加载未打包') ? [] : [{ ref: 'toggle', role: 'Button', name: '开发者模式', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }]),
      reads: [[{ id: 'a' }]],
    })
    await runDesktopRecipe(
      recipe({
        steps: [
          {
            kind: 'invoke',
            query: { role: 'Button', name: '开发者模式' },
            skipIf: { role: 'Button', name: '加载未打包' },
          },
        ],
      }),
      {},
      driver,
    )
    expect(calls.find((c) => c.m === 'invoke')!.a).toBe('toggle')
  })

  it('window 步骤：等到那个窗口出现，之后的范围和抢屏都跟着换过去', async () => {
    const DLG = '选择扩展程序目录。'
    const { driver, calls } = fakeDriver({
      // 第一次枚举还没有对话框（实测第一次弹出要几秒），第二次才有
      windows: [[{ process: 'chrome.exe', title: '扩展程序 - Google Chrome' }], [{ process: 'chrome.exe', title: '扩展程序 - Google Chrome' }, { process: 'explorer.exe', title: DLG }]],
      reads: [[{ id: 'a' }]],
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [
          { kind: 'window', match: { title: '选择扩展程序目录' }, focus: true },
          { kind: 'type', text: 'C:\\x' },
        ],
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    // 钉住的是"换过去了"：scope 和 focus 拿到的都是对话框那个**真实标题**，不是 recipe.app。
    const scoped = calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)
    expect(scoped[scoped.length - 1]).toEqual({ process: 'explorer.exe', title: DLG })
    expect(calls.find((c) => c.m === 'focusApp' && (c.a as AppMatch).title === DLG)).toBeTruthy()
  })

  /**
   * 微信搜索候选那种「随主窗活着的弹层」（2026-09-12）：抬它到前台，主窗一失焦它就自己关。
   * `ownedPopup:true` 要的是范围切过去找候选、前台却钉在主窗——两者分开，缺一不可。
   */
  it('window.ownedPopup：范围换到弹层，抢屏仍抬主窗；换回主窗后两者重新合一', async () => {
    const POP = 'Weixin'
    const MAIN = '微信'
    const { driver, calls } = fakeDriver({
      windows: [[{ process: 'Weixin.exe', title: MAIN }, { process: 'Weixin.exe', title: POP }]],
      reads: [[{ id: 'a' }]],
    })
    const out = await runDesktopRecipe(
      recipe({
        app: { process: 'Weixin.exe', title: MAIN },
        steps: [
          { kind: 'window', match: { title: POP }, ownedPopup: true },
          { kind: 'click', x: 10, y: 10 },
          { kind: 'window', match: { title: MAIN } },
          { kind: 'click', x: 20, y: 20 },
        ],
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    const scoped = calls.filter((c) => c.m === 'scopeWindow').map((c) => (c.a as AppMatch).title)
    // 第一步就是 window，所以开头那次 scope(app) 被跳过（见下一条用例）。
    expect(scoped).toEqual([POP, MAIN])
    // 弹层段里的那次抢屏抬的是主窗，不是弹层；回到主窗后照旧抬主窗。整轮没有一次 focusApp 指向弹层。
    const focused = calls.filter((c) => c.m === 'focusApp').map((c) => (c.a as AppMatch).title)
    expect(focused).toEqual([MAIN, MAIN])
  })

  /**
   * 活体撞到的（2026-08-31，代装扩展）：chrome.exe 开着 4 个窗口，agent 的 `scopeWindow` 对
   * 多窗口匹配直接报 `ambiguous-window`（对的——它不该替调用方猜）。而这条 recipe 的第一步
   * 正是用来消歧的 `window`，却在它之前就死了。
   */
  it('第一步是 window → 跳过开头那次 scope(app)（否则多窗口的应用一步都跑不了）', async () => {
    const { driver, calls } = fakeDriver({
      windows: [[{ process: 'chrome.exe', title: '扩展程序 - Google Chrome' }]],
      reads: [[{ id: 'a' }]],
    })
    await runDesktopRecipe(
      recipe({
        app: { process: 'chrome.exe' }, // 没有 title：哪个窗口由下面那一步来认
        steps: [{ kind: 'window', match: { process: 'chrome.exe', title: '扩展程序' } }],
      }),
      {},
      driver,
    )
    const scoped = calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)
    expect(scoped).toEqual([{ process: 'chrome.exe', title: '扩展程序 - Google Chrome' }])
  })

  it('第一步不是 window → 开头那次 scope(app) 照旧（采集型 recipe 全靠它限定范围）', async () => {
    const { driver, calls } = fakeDriver({ reads: [[{ id: 'a' }]] })
    await runDesktopRecipe(recipe({ app: { process: 'Telegram.exe' }, steps: [] }), {}, driver)
    expect(calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)).toEqual([{ process: 'Telegram.exe' }])
  })

  it('stepGate：每一步（含 branch）之前问一次、停在动作之前；答 abort 整轮 drift 且此后一个输入都不发', async () => {
    // branch 的判据落空（find 对它回空），三步都要真走到闸前
    const { driver, calls } = fakeDriver({ find: (q) => (JSON.stringify(q).includes('nope') ? [] : [{ ref: 'r', role: 'Button', name: '搜索消息', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }]), reads: [[{ id: 'a' }]] })
    const asked: number[] = []
    const probes: string[] = []
    const out = await runDesktopRecipe(
      recipe({
        steps: [
          { kind: 'branch', when: { query: { name: 'nope' } }, skip: 1 },
          { kind: 'invoke', query: { role: 'Button', name: '搜索消息' } },
          { kind: 'type', text: 'x', label: '打字' },
        ],
      }),
      {},
      driver,
      {
        onProbe: (m) => probes.push(m),
        stepGate: async ({ index, total }) => {
          asked.push(index)
          expect(total).toBe(3)
          // 停在第 2 步之前时，前两步的动作已经发生、第 2 步的还没有
          if (index === 2) expect(calls.map((c) => c.m)).not.toContain('type')
          return index === 2 ? 'abort' : 'run'
        },
      },
    )
    expect(asked).toEqual([0, 1, 2])
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/aborted-by-debugger@打字/)
    expect(calls.map((c) => c.m)).not.toContain('type')
    expect(calls.map((c) => c.m)).toContain('invoke')
    // 探针原样交出去
    expect(probes.some((p) => /#1 invoke/.test(p))).toBe(true)
  })

  it('window 等不到 → drift，且 reason 用步骤自己的 label 说人话', async () => {
    const { driver } = fakeDriver({ windows: [[]] })
    const out = await runDesktopRecipe(
      recipe({
        steps: [
          { kind: 'window', match: { title: '选择扩展程序目录' }, timeoutMs: 1, label: '点了「加载未打包的扩展程序」之后没等到文件夹对话框' },
        ],
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('没等到文件夹对话框')
  })

  it('nameAnyOf：逐个候选名试，第一个命中就用（界面语言换了不该变成空结果）', async () => {
    const { driver, calls } = fakeDriver({
      // 这台机器是英文界面：只有 Load unpacked 在
      find: (q) => (JSON.stringify(q).includes('Load unpacked') ? [{ ref: 'load', role: 'Button', name: 'Load unpacked', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []),
      reads: [[{ id: 'a' }]],
    })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', query: { role: 'Button', nameAnyOf: ['加载未打包的扩展程序', 'Load unpacked'] } }] }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    expect(calls.find((c) => c.m === 'invoke')!.a).toBe('load')
    // 候选是**逐个发**的，而且 nameAnyOf 不上 wire：agent 只看见普通的 name 查询。
    const sent = calls.filter((c) => c.m === 'find').map((c) => c.a as Record<string, unknown>)
    expect(sent.map((q) => q.name)).toEqual(['加载未打包的扩展程序', 'Load unpacked'])
    expect(sent.every((q) => q.nameAnyOf === undefined)).toBe(true)
  })

  it('动作型 recipe：省掉 observer/read，一次 readSubtree 都不发', async () => {
    const { driver, calls } = fakeDriver({})
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', query: { role: 'Button', name: '确定' } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    expect(out.items).toEqual([])
    expect(calls.some((c) => c.m === 'readSubtree')).toBe(false)
  })

  it('省了 observer 却没开 allowEmpty → drift，不许安静地 ok', async () => {
    const { driver } = fakeDriver({})
    const out = await runDesktopRecipe(
      recipe({ observer: undefined, read: undefined }),
      { q: 'x' },
      driver,
    )
    expect(out.outcome).toBe('drift')
  })

  it('租约在异常路径下会释放：第一趟中途抛错，第二趟仍能拿到租约跑完', async () => {
    const { relay } = relayWithLog({ errorOnTypeText: 'boom' })
    const driverA = makeDesktopDriver(relay)
    const driverB = makeDesktopDriver(relay)
    const recipeA = twoStepRecipe('QQ.exe', 'boom', 'AAA') // agent 在这一步"崩了"
    const recipeB = twoStepRecipe('Telegram.exe', 'ok', 'BBB')

    const pA = runDesktopRecipe(recipeA, {}, driverA)
    const pB = runDesktopRecipe(recipeB, {}, driverB) // 排在 A 后面，此刻 A 还没释放租约

    await expect(pA).rejects.toThrow('agent crashed mid-recipe')
    const outB = await pB // 若租约没在 finally 里释放，这一行会一直挂到测试超时
    expect(outB.outcome).toBe('ok')
  })
})

/**
 * `focusApp` 回的是**回读结果**「它现在真的在前台吗」。丢掉这个 false，下一个坐标 op 会被
 * agent 的闸门以 `no-foreground-target: 还没确立目标窗口` 拒掉——那句话读起来像我们漏了一步
 * focusApp，而真相是窗口抬不上来（屏幕锁着 / 会话没人连着）。活体撞到：2026-08-31，win-test。
 */
describe('抬不到前台', () => {
  it('当场停手，并且报的是**这一步**的人话，不是一句像内部不变量的机器话', async () => {
    const { driver, calls } = fakeDriver({
      focusOk: false,
      windows: [[{ process: 'node.exe', title: 'Windows 安全中心警报', fg: true }]],
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'type', text: 'hi', label: '地址栏回车没发出去' }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('抬到前台')
    // **报事实，不列可能**：占着前台的那个窗口是谁，一说就明白；一串猜测只会把人支开
    // （活体真因是 Node.js 的防火墙授权框，猜不出来）。
    expect(out.driftReason).toContain('Windows 安全中心警报')
    // **不许套上这一步的 label**：那句讲的是"没等到窗口"，而这里窗口找到了、只是抬不上来。
    // 套上去就是一句把人引向"Chrome 是不是没装"的假话。
    expect(out.driftReason).not.toContain('地址栏回车没发出去')
    // 关键：**没有真的把字打出去**——抬不上来时键盘会投给别人的窗口
    expect(calls.some((c) => c.m === 'type')).toBe(false)
  })

  it('agent 自己认出是锁屏（抛 desktop-locked）→ 那句话原样成为这一步的 drift，不是未知异常', async () => {
    // 活体 2026-09-07：锁屏时 focusApp 以 `desktop-locked: …` 报错而不是回 false；不接住就一路炸到
    // 调用方，预览里成了 `category:"unknown"`——而那句话正是最准的诊断（下一步 = 解锁）。
    const locked = 'desktop-locked: 桌面已锁屏——抬不起前台，坐标输入没有可确认的收件人，因此拒绝（读不受影响）'
    const { driver, calls } = fakeDriver({ focusThrows: locked })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'focus' }, { kind: 'type', text: 'hi' }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toBe(locked)
    expect(calls.some((c) => c.m === 'type')).toBe(false)
  })

  it('input:"message"：整轮一次 focusApp 都不发，坐标 op 全带 deliver:"message"——锁着屏也照跑', async () => {
    // 活体 2026-09-07：锁屏下 PostMessage 给微信主窗口，点搜索框 / 打字 / 回车全部生效。
    // 这条路的收件人是窗口 hwnd，不需要前台，所以 focusApp 这个会被锁屏拒掉的动作一次都不该发。
    const { driver, calls } = fakeDriver({ focusThrows: 'desktop-locked: 桌面已锁屏' })
    const out = await runDesktopRecipe(
      recipe({
        input: 'message',
        steps: [
          { kind: 'focus' },
          { kind: 'click', x: 10, y: 20 },
          { kind: 'type', text: 'hi\n' },
          { kind: 'scroll', dir: 'down', amount: 300 },
        ],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('ok')
    expect(calls.some((c) => c.m === 'focusApp')).toBe(false)
    expect(calls.filter((c) => c.m === 'click' || c.m === 'type' || c.m === 'scroll').map((c) => c.deliver)).toEqual(['message', 'message', 'message'])
  })

  it('focus.wake：投消息那条路上先发一下真实鼠标移动把渲染端叫醒；没写 wake 就一次都不动鼠标', async () => {
    // 本机 2026-09-08 实测：机器一闲下来 QQ 的渲染端就挂起，投进去的点击/按键整份被静默丢弃
    // （`focus-spike plain` 0/6、控件树 0 个），而先发一下真实输入再点是 3/4。PostMessage
    // 不是"用户输入"，叫不醒任何东西——所以这一下必须是真实的 moveMouse。
    const capture = { jpeg: Buffer.from(''), window: { x: 100, y: 200, w: 400, h: 300 }, scale: 1 }
    const r = (wake: boolean) =>
      recipe({ input: 'message', steps: [{ kind: 'focus', ...(wake ? { wake: true } : {}) }], observer: undefined, read: undefined, allowEmpty: true })

    // 首选零位移那一口：叫醒了就**不许**再去挪用户的指针。
    const woke = fakeDriver({ capture })
    expect((await runDesktopRecipe(r(true), {}, woke.driver)).outcome).toBe('ok')
    expect(woke.calls.some((c) => c.m === 'nudge')).toBe(true)
    expect(woke.calls.some((c) => c.m === 'moveMouse')).toBe(false)

    // 老 agent 没有 nudge → 落回 moveMouse，落到**窗口中心**（不是左上角）。
    const old = fakeDriver({ capture, nudgeUnsupported: true })
    expect((await runDesktopRecipe(r(true), {}, old.driver)).outcome).toBe('ok')
    expect(old.calls.filter((c) => c.m === 'moveMouse').map((c) => c.a)).toEqual([{ x: 300, y: 350 }])

    // 没写 wake：一次都不许动用户的鼠标，也不发那一下真实输入。
    const quiet = fakeDriver({ capture })
    expect((await runDesktopRecipe(r(false), {}, quiet.driver)).outcome).toBe('ok')
    expect(quiet.calls.some((c) => c.m === 'moveMouse' || c.m === 'nudge')).toBe(false)

    // 叫醒之后**等到控件树回来为止**，不是睡一个魔法数：树一直空就等到上界。这一格钉住"不会永远卡住"，
    // 以及**叫不醒就停**：活体 2026-09-12 证明睡着时投进去的输入不是丢了而是排队了（两轮的联系人名
    // 在渲染端被人碰醒后一起落进搜索框），所以不许再"照常往下走"——一个输入都不发，判 drift 收场。
    const asleep = fakeDriver({ capture, find: () => [] })
    const out = await runDesktopRecipe(r(true), {}, asleep.driver, { now: fakeClock(asleep.driver) })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/排队/)
    expect(asleep.calls.filter((c) => c.m === 'find').length).toBeGreaterThan(1) // 真轮询过
    // 零位移那一下叫不醒（活体 2026-09-12：nudge 成功、树 6 秒始终空、随后的输入整份被丢）→
    // 升第二级：把指针真挪到窗口中心。上面 `woke` 那一格钉住反向：叫醒了就不许挪。
    expect(asleep.calls.filter((c) => c.m === 'moveMouse').map((c) => c.a)).toEqual([{ x: 300, y: 350 }])
    const order = asleep.calls.map((c) => c.m)
    expect(order.indexOf('nudge')).toBeLessThan(order.indexOf('moveMouse'))
  })

  it('input:"message" 判了 drift 时，driftReason 要带上"这一轮屏幕锁着"——投给窗口的键鼠可能整轮被静默丢弃', async () => {
    // 活体 2026-09-07：锁屏时往 QQ 投点击 + 打字 0/12 一次反应都没有，而每一步都以"expect 未兑现"
    // 收场、失败在哪一步纯看运气。没有这一句，读的人只会去改 recipe。
    const steps = [{ kind: 'type' as const, text: 'hello\n', require: { query: { name: 'title-is-him' }, timeoutMs: 500 }, else: 'abort' as const }]
    const r = recipe({ input: 'message', steps, observer: undefined, read: undefined, allowEmpty: true })

    const locked = fakeDriver({ find: () => [], windows: [[{ process: 'LockApp.exe', title: 'Windows 默认锁屏界面', fg: true }]] })
    const out = await runDesktopRecipe(r, {}, locked.driver, { now: fakeClock(locked.driver) })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('前置条件未成立') // 原来那句还在，不许被顶掉
    expect(out.driftReason).toContain('屏幕锁着')
    expect(out.driftReason).toContain('LockApp.exe')

    // 没锁屏就一个字都不加——一句永远都在的"提示"等于没有提示。
    const awake = fakeDriver({ find: () => [], windows: [[{ process: 'QQ.exe', title: 'QQ', fg: true }]] })
    const ok = await runDesktopRecipe(r, {}, awake.driver, { now: fakeClock(awake.driver) })
    expect(ok.driftReason).not.toContain('屏幕锁着')
  })

  it('require：前置条件成立才动；不成立 + else:abort → 一个输入都不发', async () => {
    // 判据是 a11y query（find 命中与否由 fake 控制）
    const ok = fakeDriver({ find: (q) => (JSON.stringify(q).includes('title-is-him') ? [{ ref: 'r', role: 'Text', name: 'x', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []) })
    const steps = [{ kind: 'type' as const, text: 'hello\n', require: { query: { name: 'title-is-him' }, timeoutMs: 500 }, else: 'abort' as const }]
    const good = await runDesktopRecipe(recipe({ steps, observer: undefined, read: undefined, allowEmpty: true }), {}, ok.driver)
    expect(good.outcome).toBe('ok')
    expect(ok.calls.some((c) => c.m === 'type')).toBe(true)

    const bad = fakeDriver({ find: () => [] })
    const out = await runDesktopRecipe(recipe({ steps, observer: undefined, read: undefined, allowEmpty: true }), {}, bad.driver, { now: fakeClock(bad.driver) })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('aborted-by-recipe')
    expect(out.driftReason).toContain('前置条件未成立')
    expect(bad.calls.some((c) => c.m === 'type')).toBe(false)
  })

  it('branch：when 成立就跳过接下来 N 步；不成立就照走', async () => {
    const steps = [
      { kind: 'branch' as const, when: { query: { name: 'already-there' } }, skip: 2 },
      { kind: 'type' as const, text: 'search' },
      { kind: 'type' as const, text: 'enter\n' },
      { kind: 'type' as const, text: 'body\n' },
    ]
    const taken = fakeDriver({ find: (q) => (JSON.stringify(q).includes('already-there') ? [{ ref: 'r', role: 'Text', name: 'x', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []) })
    const out1 = await runDesktopRecipe(recipe({ steps, observer: undefined, read: undefined, allowEmpty: true }), {}, taken.driver)
    expect(out1.outcome).toBe('ok')
    expect(taken.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['body\n'])

    const notTaken = fakeDriver({ find: () => [] })
    const out2 = await runDesktopRecipe(recipe({ steps, observer: undefined, read: undefined, allowEmpty: true }), {}, notTaken.driver)
    expect(out2.outcome).toBe('ok')
    expect(notTaken.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['search', 'enter\n', 'body\n'])
    // 跳过了什么要进回执；一步都没跳就没有这个字段
    expect(out1.skipped).toEqual(['#1 ← #0', '#2 ← #0'])
    expect(out2.skipped).toBeUndefined()
  })

  /**
   * `wechat-send` 的 `send:false`：正文打进输入框、回车那一步跳过、run 以 ok 收场。参数分支不读屏——
   * 一次 find / readText 都不发；它允许跳到 recipe 末尾（读屏的分支不许，装载期拦）。
   */
  it('branch：按参数分支——param 等于 equals 就跳、不读屏；缺席不成立；回执 skipped 说出没做什么', async () => {
    const steps = [
      { kind: 'type' as const, label: '打正文', text: '{message}' },
      { kind: 'branch' as const, label: '不发就停在这', when: { param: 'send', equals: false }, skip: 1 },
      { kind: 'type' as const, label: '回车发出去', text: '\n' },
    ]
    const mk = () => recipe({ steps, observer: undefined, read: undefined, allowEmpty: true })

    const off = fakeDriver()
    const o1 = await runDesktopRecipe(mk(), { message: 'hi', send: 'false' }, off.driver)
    expect(o1.outcome).toBe('ok')
    expect(off.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['hi'])
    expect(off.calls.some((c) => c.m === 'find' || c.m === 'readText')).toBe(false)
    expect(o1.skipped).toEqual(['回车发出去 ← 不发就停在这'])

    const on = fakeDriver()
    const o2 = await runDesktopRecipe(mk(), { message: 'hi', send: 'true' }, on.driver)
    expect(on.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['hi', '\n'])
    expect(o2.skipped).toBeUndefined()

    // 参数缺席 = 不成立（默认值只在 params_schema.default 一处补，runner 不猜）
    const absent = fakeDriver()
    await runDesktopRecipe(mk(), { message: 'hi' }, absent.driver)
    expect(absent.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['hi', '\n'])
  })

  it('没写 input 的 recipe：坐标 op 不带 deliver（照旧走屏幕 + 抢前台）', async () => {
    const { driver, calls } = fakeDriver()
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'type', text: 'hi' }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      driver,
    )
    expect(calls.some((c) => c.m === 'focusApp')).toBe(true)
    expect(calls.find((c) => c.m === 'type')?.deliver).toBeUndefined()
  })

  it('focusApp 抛的是认不出前缀的异常 → 照抛，别吞成 drift', async () => {
    const { driver } = fakeDriver({ focusThrows: 'socket hang up' })
    await expect(
      runDesktopRecipe(
        recipe({ steps: [{ kind: 'focus' }], observer: undefined, read: undefined, allowEmpty: true }),
        {},
        driver,
      ),
    ).rejects.toThrow('socket hang up')
  })
})

// ── `see` 目标：靶子用"看得见的样子"指，而不是控件树里的名字 ──────────────────────────
//
// 走没走模型必须能读出来（`seeVia`）：第一次成功（模型指的）和第 N 次成功（缓存里的模板）
// 在结果上一模一样，没有这个字段就分不出这条 recipe 到底是稳了、还是每轮都在烧 token。

const seeOpts = () => ({
  see: (d: DesktopDriver) => makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }),
})

/**
 * 假时钟：`expect` 的超时按**墙钟**算，而假 driver 的一觉是零耗时的——不驱动这只表的话，
 * 一个本该 4 拍就收工的轮询会在真实时间里空转上千次（还慢）。让"一觉 = 时间前进那么多"，
 * 轮数就回到确定的 `timeoutMs / 300`，而"等了多久"也能在单测里钉住。
 */
function fakeClock(d: DesktopDriver): () => number {
  let t = 1_000_000
  const sleep = d.sleep.bind(d)
  d.sleep = async (ms: number) => { t += ms; await sleep(ms) }
  return () => t
}

describe('runDesktopRecipe: see 目标', () => {
  it('invoke see：a11y 段命中走 invoke 快车道，不抢屏', async () => {
    const { driver, calls } = fakeDriver({
      find: () => [{ ref: 'r1', role: 'Button', name: '搜索', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' }, label: '点搜索' }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('ok')
    expect(calls.map((c) => c.m)).toEqual(['scopeWindow', 'find', 'invoke'])
    expect(out.seeVia).toEqual({ 点搜索: 'a11y' })
  })

  it('invoke see：screen 段命中 → 先抢屏再按屏幕物理坐标点', async () => {
    const { driver, calls } = fakeDriver({
      find: () => [],
      screen: () => ({
        texts: [{ text: '搜索', rect: { x: 10, y: 10, w: 40, h: 16 } }],
        window: { x: 100, y: 100, w: 800, h: 600 },
        scale: 2,
      }),
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' } }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('ok')
    // 识别层给的就是屏幕物理坐标（截图上的框 + 窗口原点），runner 原样递给 click——**不除 scale**。
    const click = calls.find((c) => c.m === 'click')!.a as { rect: Rect }
    expect(click.rect).toEqual({ x: 110, y: 110, w: 40, h: 16 })
    const seq = calls.map((c) => c.m)
    expect(seq.indexOf('focusApp')).toBeLessThan(seq.indexOf('click'))
    expect(out.seeVia).toEqual({ '#0': 'screen' })
  })

  it('see 一段都没命中 → drift，reason 带 label 与 see', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' }, label: '点搜索' }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/点搜索.*see.*搜索/)
  })

  it('没传 see resolver 而 recipe 用了 see → drift 说清是宿主没配', async () => {
    const { driver } = fakeDriver()
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' } }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/识别层/)
  })

  it('type see：定位到输入框就先点它再键盘打字（see 没有 setValue 快车道，除非 a11y 段给了 ref）', async () => {
    const { driver, calls } = fakeDriver({
      find: () => [],
      screen: () => ({
        texts: [{ text: '搜索', rect: { x: 10, y: 10, w: 40, h: 16 } }],
        window: { x: 0, y: 0, w: 800, h: 600 },
        scale: 1,
      }),
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'type', text: 'hi', see: { text: '搜索' } }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('ok')
    // `type` 的 see 是动作路 → 查元素表
    expect(calls.map((c) => c.m)).toEqual(['scopeWindow', 'find', 'readElements', 'focusApp', 'click', 'type'])
    expect(out.typedVia).toBe('keyboard')
  })

  /**
   * `app.a11y:false` 是作者的事实申报（"这个应用没有控件树"），要一路落到 `readElements` 的
   * 参数上——agent 靠它跳过控件树枚举（微信每步白付 80–90ms）。缺省必须是 `true`：不写就是
   * 今天的行为，而"缺席被当成 false"会让所有有控件树的应用静默失去 a11y 那一档。
   */
  it('app.a11y:false 透传到 readElements；不写就是 true', async () => {
    const screen = () => ({
      texts: [{ text: '搜索', rect: { x: 10, y: 10, w: 40, h: 16 } }],
      window: { x: 0, y: 0, w: 800, h: 600 },
      scale: 1,
    })
    const steps: DesktopRecipe['steps'] = [{ kind: 'invoke', see: { text: '搜索' } }]
    const off = fakeDriver({ find: () => [], screen })
    await runDesktopRecipe(
      recipe({ app: { process: 'Weixin.exe', a11y: false }, steps, observer: undefined, read: undefined, allowEmpty: true }),
      {}, off.driver, seeOpts(),
    )
    expect(off.calls.filter((c) => c.m === 'readElements').map((c) => c.a11y)).toEqual([false])

    const on = fakeDriver({ find: () => [], screen })
    await runDesktopRecipe(
      recipe({ steps, observer: undefined, read: undefined, allowEmpty: true }),
      {}, on.driver, seeOpts(),
    )
    expect(on.calls.filter((c) => c.m === 'readElements').map((c) => c.a11y)).toEqual([true])
  })

  /**
   * `resolveSee` 里 a11y 段（`see.text` 当 name 查一次 `driver.find`）与 `pinned` 段同样要认
   * `app.a11y:false`——不认的话，申报了"没有控件树"的应用每一步照样白挨一次必然落空的 `find`
   * 往返。用一个 `find` 会命中、`screen` 也会命中的夹具区分两条路：a11y:false 时命中来自
   * `screen`（`find` 完全不出现在 calls 里）；缺省（true）时命中来自 `find` 本身。
   */
  it('app.a11y:false 时 see.text 段跳过 find，退到屏幕文字段；缺省仍走 find', async () => {
    const find = () => [{ ref: 'r1', role: 'Button', name: '搜索', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }]
    const screen = () => ({
      texts: [{ text: '搜索', rect: { x: 10, y: 10, w: 40, h: 16 } }],
      window: { x: 0, y: 0, w: 800, h: 600 },
      scale: 1,
    })
    const off = fakeDriver({ find, screen })
    const outOff = await runDesktopRecipe(
      recipe({
        app: { process: 'Weixin.exe', a11y: false },
        steps: [{ kind: 'invoke', see: { text: '搜索' }, label: '点搜索' }],
        observer: undefined, read: undefined, allowEmpty: true,
      }),
      {}, off.driver, seeOpts(),
    )
    expect(outOff.outcome).toBe('ok')
    expect(off.calls.map((c) => c.m)).not.toContain('find')
    expect(outOff.seeVia).toEqual({ 点搜索: 'screen' })

    const on = fakeDriver({ find, screen })
    const outOn = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' }, label: '点搜索' }],
        observer: undefined, read: undefined, allowEmpty: true,
      }),
      {}, on.driver, seeOpts(),
    )
    expect(outOn.outcome).toBe('ok')
    expect(on.calls.map((c) => c.m)).toContain('find')
    expect(outOn.seeVia).toEqual({ 点搜索: 'a11y' })
  })

  // 诊断里报**填过参**的那个 see，和 query 那条路同一个理由：报模板等于让读的人看见
  // `{"text":"{contact}"}`，而真正要知道的是"找不到的是哪个人"。
  it('找不到时报的是填过参的 see，不是模板', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '{contact}' } }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      { contact: 'Alice' },
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('Alice')
    expect(out.driftReason).not.toContain('{contact}')
  })

  // 预算用完**只关掉模型那一段**，不关整个梯子：a11y / 屏幕文字 / 模板都是免费的，把它们
  // 一起停掉等于让"省钱"变成"这一步必然失败"。而失败那句话也必须说清是预算用满了——
  // 照着"四段都落空"去查界面，查的是一个根本没发生过的事。
  it('model 预算用满：免费的三段照跑，且 reason 说的是预算不是四段落空', async () => {
    const seen: boolean[] = []
    const spent: SeeResolver = {
      modelCalls: 1, // 已经等于步骤数（这份 recipe 只有一步）
      matches: async () => [],
      invalidate() {},
      localInterrupts: () => [],
      async resolve(_see, { allowModel }) {
        seen.push(allowModel)
        return null
      },
    }
    const { driver } = fakeDriver()
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { text: '搜索' } }],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      { see: () => spent },
    )
    expect(seen).toEqual([false]) // 梯子照样走了一趟，只是模型那一段被关掉
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('预算')
    expect(out.driftReason).not.toContain('模型都落空')
  })

  it('两步用同一个 label → 第二步的 seeVia 键加上序号，不互相盖掉', async () => {
    const { driver } = fakeDriver({
      find: () => [{ ref: 'r1', role: 'Button', name: '搜索', className: '', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    })
    const out = await runDesktopRecipe(
      recipe({
        steps: [
          { kind: 'invoke', see: { text: '搜索' }, label: '点它' },
          { kind: 'invoke', see: { text: '搜索' }, label: '点它' },
        ],
        observer: undefined,
        read: undefined,
        allowEmpty: true,
      }),
      {},
      driver,
      seeOpts(),
    )
    expect(out.outcome).toBe('ok')
    expect(out.seeVia).toEqual({ 点它: 'a11y', '点它#1': 'a11y' })
  })
})

// ── 每步 `expect`：动作前必须为假、动作后轮询到真 ──────────────────────────────────────
//
// 恒真的判据是装饰不是监督——它永远"通过"，于是这一步做没做成再也没人看。所以动作**之前**
// 先查一次：此刻就成立的，当场判 drift 并指名"恒真"，而不是等到活体上某天真出问题时才发现
// 这道闸从来没有牙。

// ── `expect.fresh`：冒出一个动作前没有的位置才算 ─────────────────────────────────────────
//
// 区域画不准（输入框被用户拖高拖矮）时，"这段字在不在这块区域里"一边读不到、一边罩错。改问
// "有没有冒出新的一处"——下面四条对着真实的四种情形：打字、回车发出、回车没发出、连发同一句。
describe('runDesktopRecipe: expect.fresh', () => {
  const win = { x: 0, y: 0, w: 900, h: 600 }
  const at = (y: number) => ({ text: '收到', rect: { x: 300, y, w: 60, h: 20 } })
  const run = async (before: Array<ReturnType<typeof at>>, after: Array<ReturnType<typeof at>>) => {
    let acted = false
    const f = fakeDriver({ find: () => [], screen: () => ({ texts: acted ? after : before, window: win, scale: 1 }) })
    f.driver.type = async (t) => { f.calls.push({ m: 'type', a: t }); acted = true; return {} }
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'type', text: '\n', label: '回车', expect: { see: { text: '收到', region: { x: 0.3, y: 0, w: 0.7, h: 1 } }, fresh: true, timeoutMs: 600 }, else: 'abort' }],
        observer: undefined, read: undefined, allowEmpty: true,
      }),
      {}, f.driver, { ...seeOpts(), now: fakeClock(f.driver) },
    )
    return { out, typed: f.calls.filter((c) => c.m === 'type').length }
  }

  it('动作前已在屏上不判恒真：连发同一句，上一条在原位、新一条冒出来 → 兑现', async () => {
    const { out, typed } = await run([at(300)], [at(260), at(300)])
    expect(typed).toBe(1)
    expect(out.outcome).toBe('ok')
  })

  it('回车发出：输入框那处消失、气泡里冒出一处 → 兑现', async () => {
    expect((await run([at(500)], [at(300)])).out.outcome).toBe('ok')
  })

  it('回车没发出：还是原位那一处（OCR 框抖几个像素也算原位）→ 不兑现，abort', async () => {
    const { out } = await run([at(500)], [{ ...at(500), rect: { x: 303, y: 502, w: 58, h: 20 } }])
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/aborted-by-recipe/)
  })

  it('动作前屏上没有、动作后出现 → 兑现（和普通 expect 一样）', async () => {
    expect((await run([], [at(500)])).out.outcome).toBe('ok')
  })
})

describe('runDesktopRecipe: expect / else', () => {
  const steps = (else_?: 'drift' | 'retry' | 'abort') => [
    { kind: 'type' as const, text: '\n', expect: { see: { text: 'Alice', region: 'top' as const }, timeoutMs: 1000 }, else: else_, label: '回车打开会话' },
    { kind: 'type' as const, text: 'hello\n', label: '发正文' },
  ]

  it('expect 动作前已成立 → 当场判 drift，指名恒真', async () => {
    const { driver, calls } = fakeDriver({ find: () => [], screen: () => ({ texts: [{ text: 'Alice', rect: { x: 5, y: 5, w: 30, h: 10 } }], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }), {}, driver, seeOpts())
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/恒真/)
    expect(calls.map((c) => c.m)).not.toContain('type')
  })

  it('expect 动作后成立 → 通过；动作后一直不成立 → 默认 drift，后面的步骤不跑', async () => {
    let shown = false
    const screen = () => ({ texts: shown ? [{ text: 'Alice', rect: { x: 5, y: 5, w: 30, h: 10 } }] : [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 })
    const good = fakeDriver({ find: () => [], screen })
    good.driver.type = async (t) => { good.calls.push({ m: 'type', a: t }); shown = true; return {} }
    const ok = await runDesktopRecipe(recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }), {}, good.driver, seeOpts())
    expect(ok.outcome).toBe('ok')
    expect(good.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['\n', 'hello\n'])

    const bad = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(
      recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }),
      {}, bad.driver, { ...seeOpts(), now: fakeClock(bad.driver) },
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/回车打开会话.*expect/)
    expect(bad.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['\n'])
    // **走过哪几段要如实说**：判据这条路一开始就不许调模型，报"四段都落空"会让人去查一段
    // 从来没跑过的东西。等了多久也要说——3 秒没出现和 300ms 没出现，下一步不一样。
    expect(out.driftReason).toContain('判据不调模型')
    // 报的是**真花掉的**那个数（6 觉 × 150ms），不是名义上的 1000ms
    expect(out.driftReason).toContain('等了 900ms（7 轮）')
    // 最后一轮查完就该收工：那一觉之后没有人再看一眼，纯粹是白等 150ms（1000ms → 7 轮 6 觉）
    expect(bad.calls.filter((c) => c.m === 'sleep' && c.a === 150)).toHaveLength(6)
  })

  /**
   * 一轮 = 一次完整的读屏（PrintWindow + OCR，几百毫秒）。按轮数计时的实现在这里
   * 照样跑满 4 轮、报「等了 1000ms」；按墙钟计时的实现查一次就发现时间到了，并且**如实报出
   * 那 1200ms**。这条钉的正是两者的差别——不然"界面 1 秒没反应"这个假结论会一直立着，
   * 而真相是我们自己读得慢。
   */
  it('expect 的超时是墙钟不是轮数：一轮就吃掉整个预算 → 只查一次，报真花掉的时间', async () => {
    let t = 1_000_000
    const slow = fakeDriver({
      find: () => [],
      screen: () => { t += 1200; return { texts: [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 } },
    })
    const out = await runDesktopRecipe(
      recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }),
      {}, slow.driver, { ...seeOpts(), now: () => t },
    )
    expect(out.outcome).toBe('drift')
    // 动作前那次恒真检查也读一次屏，所以这里数的是动作之后的：一轮就超了，不再睡也不再查
    expect(slow.calls.filter((c) => c.m === 'sleep' && c.a === 150)).toHaveLength(0)
    expect(out.driftReason).toContain('等了 1200ms（1 轮）')
  })

  /**
   * 读屏的硬失败（exe 旁缺了运行时库或模型、截不出图、没确立目标窗口、region 和画面没交集）过去是
   * 裸抛：整趟以未捕获异常收场，`driftReason` 是 null，而那句唯一说得清怎么办的话一次都
   * 没被人看见。
   */
  it('识别层读屏硬失败 → 翻成这一步的 drift，缺库那句话进 driftReason，之后一个输入都不发', async () => {
    const { driver, calls } = fakeDriver({ find: () => [] })
    driver.readText = async () => {
      throw new Error('ort-missing: C:\\x\\bin\\onnxruntime.dll 不在场——ONNX Runtime 1.20.1 的动态库要和 ocr-det.onnx 放在同一目录（或 STREAM_ORT_LIB 指到它）')
    }
    const out = await runDesktopRecipe(
      recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }),
      {}, driver, seeOpts(),
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('STREAM_ORT_LIB')
    expect(out.driftReason).toContain('回车打开会话') // 套上这一步的 label
    expect(calls.map((c) => c.m)).not.toContain('type')
    expect(calls.map((c) => c.m)).not.toContain('click')
  })

  it('region 和窗口画面没交集也是硬失败：agent 那句话原样进 driftReason', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    driver.readText = async () => { throw new Error('bad-region: region … 和窗口画面（1946×1041）没有交集') }
    const out = await runDesktopRecipe(
      recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }),
      {}, driver, seeOpts(),
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toContain('没有交集')
  })

  /**
   * **这一条盯的是"名单和 agent 分家"这件事本身**，不是某一次具体的失败。
   *
   * `HARD_SEE_ERRORS` 是按前缀字面匹配的：op 改名（`readScreen` → `readText`/`readElements`）
   * 或错误措辞改了，名单里那条就永远匹配不上，而**它失效的样子是安静的**——硬失败退化成
   * "当作没找到、轮询到超时"，每步白等三秒，唯一有用的那句话仍然没人看见。`no-window:` 就
   * 这么躺了很久：agent 从来只发 `no-window-match:`。
   *
   * 判据是拿 host agent 的**源码**对账：名单里的每个前缀都得在那儿真的出现过。**必须先砍掉
   * 每个文件的测试模块**（`mod tests { ... }`，从它前面那个 `#[cfg(test)]` 起）再拼——不然一条
   * 前缀只活在测试段的字面量里（agent 早就不发它了）也能把这条守卫骗绿。注意不能拿"文件里第
   * 一个 `#[cfg(test)]`"当分界：这个属性也会单独挂在测试专用的小函数/thread_local 上（如
   * `see.rs` 的 `note_full_positions`），出现在 `mod tests` 之前的正常代码区里，见 `see.rs:96`。
   */
  it('HARD_SEE_ERRORS 的每个前缀都在 host agent 源码里真的存在', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../app/host-agent/src')
    const src = readdirSync(dir)
      .filter((f) => f.endsWith('.rs'))
      .map((f) => {
        const text = readFileSync(join(dir, f), 'utf8')
        const modMatch = /#\[cfg\(test\)\]\s*\n(?:pub\(crate\)\s+)?mod tests \{/.exec(text)
        return modMatch ? text.slice(0, modMatch.index) : text
      })
      .join('\n')
    for (const prefix of HARD_SEE_ERRORS) expect(src, `agent 不再发 ${prefix}`).toContain(prefix)
  })

  /** 不认识的异常照抛：把它吞成 drift，等于把一个我们还不认识的 bug 记成"界面变了"。 */
  it('识别层的其它异常不被吞掉', async () => {
    const { driver } = fakeDriver({ find: () => [] })
    driver.readText = async () => { throw new Error('boom') }
    await expect(runDesktopRecipe(
      recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }),
      {}, driver, seeOpts(),
    )).rejects.toThrow('boom')
  })

  /**
   * `seeVia` 回答的是**「这一步的靶子是怎么找到的」**——它存在的唯一理由是让人分得出
   * "这条 recipe 稳了（模板命中）"和"它每轮都在烧 token（模型指的）"。判据是另一件事：
   * 它每步都要查、而且专挑便宜的段走，把它的路径写进这一栏，等于让一次 `screen` 命中的
   * 判据把动作那次 `model` 覆盖掉——**这一栏从此永远报便宜的那条路，字段的用途正好被反过来**。
   */
  it('expect 的定位不写 seeVia（也不给没用 see 的步骤凭空长一行）', async () => {
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    // 动作那次落到 model 段（icon 只有模型指得出来），判据那次走 screen
    let acted = false
    const f = fakeDriver({
      find: () => [],
      screen: () => ({
        texts: acted ? [{ text: 'Zebra', rect: { x: 0, y: 0, w: 20, h: 10 } }, { text: 'Alice', rect: { x: 0, y: 40, w: 30, h: 10 } }] : [{ text: 'Zebra', rect: { x: 0, y: 0, w: 20, h: 10 } }],
        window: WIN, scale: 1,
      }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    const click = f.driver.click.bind(f.driver)
    f.driver.click = async (r, b) => { acted = true; return click(r, b) }
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { icon: '那个图标' }, expect: { see: { text: 'Alice' }, timeoutMs: 1000 } }],
        observer: undefined, read: undefined, allowEmpty: true,
      }),
      {},
      f.driver,
      { see: (d) => makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: async () => ({ content: '1', raw: {} } as never) }) },
    )
    expect(out.outcome).toBe('ok')
    expect(out.seeVia).toEqual({ '#0': 'model' }) // 不是判据那次的 'screen'

    // 一个压根没用 see 的步骤，不该因为它的 expect 用了 see 就在这一栏里冒出一行
    let shown = false
    const g = fakeDriver({ find: () => [], screen: () => ({ texts: shown ? [{ text: 'Alice', rect: { x: 5, y: 5, w: 30, h: 10 } }] : [], window: WIN, scale: 1 }) })
    g.driver.type = async (t) => { g.calls.push({ m: 'type', a: t }); shown = true; return {} }
    const out2 = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'type', text: '\n', expect: { see: { text: 'Alice' }, timeoutMs: 1000 }, label: '回车' }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      g.driver,
      seeOpts(),
    )
    expect(out2.outcome).toBe('ok')
    expect(out2.seeVia).toBeUndefined()
  })

  /** 动作前那一次查在**重试循环外面**：重试是"再做一次动作"，不是"再判一次恒真"。
   *  放进循环里的话，重试那一轮的动作前检查会撞上"界面此刻已经到位"——于是一条只是慢了
   *  一拍、靠 retry 救回来的 recipe 会被判成"判据是装饰"。所以这条特意让它真重试一次：
   *  第一个轮询窗口全落空 → retry → 第二次动作**之前**界面就已经满足了。 */
  it('expect 晚一拍才成立：retry 一次之后兑现，动作前那次检查不在重试循环里', async () => {
    let reads = 0
    const f = fakeDriver({
      find: () => [],
      screen: () => {
        reads++
        // 1 = 动作前那次；2–8 = 第一个轮询窗口（1000ms → 7 拍）全落空 → retry；9 = 重试后第一拍
        return { texts: reads >= 9 ? [{ text: 'Alice', rect: { x: 5, y: 5, w: 30, h: 10 } }] : [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }
      },
    })
    const out = await runDesktopRecipe(
      recipe({ steps: [steps('retry')[0]], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      { ...seeOpts(), now: fakeClock(f.driver) }, // 1000ms 的预算 = 7 拍，落空之后才 retry
    )
    expect(out.outcome).toBe('ok')
    expect(f.calls.filter((c) => c.m === 'type')).toHaveLength(2)
  })

  it('else:retry 只重做一次', async () => {
    const bad = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(recipe({ steps: steps('retry'), observer: undefined, read: undefined, allowEmpty: true }), {}, bad.driver, { ...seeOpts(), now: fakeClock(bad.driver) })
    expect(out.outcome).toBe('drift')
    expect(bad.calls.filter((c) => c.m === 'type')).toHaveLength(2)
  })

  it('else:abort → 此后一个输入都不发，driftReason 标 aborted-by-recipe', async () => {
    const bad = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(recipe({ steps: steps('abort'), observer: undefined, read: undefined, allowEmpty: true }), {}, bad.driver, { ...seeOpts(), now: fakeClock(bad.driver) })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/aborted-by-recipe@回车打开会话/)
    expect(bad.calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['\n'])
  })

  it('expect 不调模型，也不碰元素表：验证阶段只读文字表', async () => {
    const bad = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: { x: 0, y: 0, w: 9, h: 9 }, scale: 1 }) })
    await runDesktopRecipe(recipe({ steps: steps(), observer: undefined, read: undefined, allowEmpty: true }), {}, bad.driver, {
      see: (d) => makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: async () => ({ content: '1', raw: {} } as never) }),
      now: fakeClock(bad.driver),
    })
    // 检测器（2 秒）和元素合成都只为动作路存在——判据这条路一次元素表都不该问。
    expect(bad.calls.map((c) => c.m)).not.toContain('readElements')
  })

  /**
   * 本地四档落空之后上不上模型，看这一步是不是 `optional`：作者已经备好了第二条路的步骤，
   * 认不到就是答案（活体 2026-09-12：wechat-send「左栏看得见他就直接点」为此白等了 31s 的模型）。
   * 必须找到的步骤才让模型兜底——两条对照写在一起，免得哪天有人把闸拧成"永不上模型"。
   */
  it('optional 的 see 步认不到 → 不调模型、不补读检测器；没标 optional 的照旧让模型兜底', async () => {
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const capture = { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 }
    const mk = (optional: boolean) => {
      // 屏上有字、但不是要找的那几个，且截得到图：模型段才有候选可编号、有图可叠
      // （没有候选或没有图它连模型都不会问，对照就不成立）。
      const f = fakeDriver({ find: () => [], capture, screen: () => ({ texts: [{ text: '别的东西', rect: { x: 10, y: 10, w: 80, h: 20 } }], window: WIN, scale: 1 }) })
      let llmCalls = 0
      return {
        ...f,
        llmCalls: () => llmCalls,
        opts: {
          see: (d: DesktopDriver) => makeSeeResolver(d, 'x', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')), llm: async () => { llmCalls++; return { content: '看不出来', raw: {} } as never } }),
          now: fakeClock(f.driver),
        },
        steps: [{ kind: 'invoke' as const, see: { text: '不在这一屏的' }, ...(optional ? { optional: true } : {}) }],
      }
    }
    const opt = mk(true)
    const out = await runDesktopRecipe(recipe({ steps: opt.steps, observer: undefined, read: undefined, allowEmpty: true }), {}, opt.driver, opt.opts)
    expect(out.outcome).toBe('ok')
    expect(opt.llmCalls()).toBe(0)
    // 模型段之前那次"补读一张带检测器的元素表"也不该发生：只读了动作路本来那一次。
    expect(opt.calls.filter((c) => c.m === 'readElements')).toHaveLength(1)

    const must = mk(false)
    const out2 = await runDesktopRecipe(recipe({ steps: must.steps, observer: undefined, read: undefined, allowEmpty: true }), {}, must.driver, must.opts)
    expect(out2.outcome).toBe('drift')
    expect(must.llmCalls()).toBe(1)
  })

  /**
   * 自愈（spec §5.5）：模板是"上次模型指的那一刀"冻下来的，界面一改版它照样能匹配到一个
   * 分数够高的地方——**每一趟都命中、每一趟都点空**，而 `seeVia` 上写着 `template`，看起来
   * 比模型那条路还稳。唯一能戳破它的信号就是 expect：命中了却什么都没发生 → 那条模板作废。
   * **不在同一步里重走模型**：这一趟已经点过一次（副作用可能已经发生），重来一次是第二次点。
   */
  it('template 命中但 expect 未兑现 → 作废那条模板（缓存文件消失）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    // 先种模板：走一趟 model 段，把裁下来的那一刀存进缓存
    const seed = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [{ text: 'A', rect: { x: 0, y: 0, w: 20, h: 10 } }], window: WIN, scale: 1 }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    const seeded = makeSeeResolver(seed.driver, 'x', { cacheDir: dir, llm: async () => ({ content: '1', raw: {} } as never) })
    await seeded.resolve({ icon: '那个图标' }, { allowModel: true, mode: 'action' })
    expect(readdirSync(join(dir, 'x')).some((f) => f.endsWith('.png'))).toBe(true)

    // 回放：模板命中（findImage 分数够），但 expect 的 Alice 永不出现
    const f = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: WIN, scale: 1 }), image: () => ({ rect: { x: 0, y: 0, w: 20, h: 10 }, score: 0.99 }) })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: { icon: '那个图标' }, expect: { see: { text: 'Alice' }, timeoutMs: 300 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      { see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir }) },
    )
    expect(out.outcome).toBe('drift')
    expect(out.seeVia).toEqual({ '#0': 'template' })
    expect(readdirSync(join(dir, 'x')).some((n) => n.endsWith('.png'))).toBe(false)
  })

  /**
   * 介入闸（spec §5）：**`expect` 没兑现是唯一的触发口**，而处置和 template 那条完全一样——
   * 作废靶子、**不在同一趟里重走**、把「它当时是怎么找到的」交出去当提议。
   *
   * 新的两档要一起吃这一下，理由和 template 一模一样：`point` 缓存的是**坐标**，坐标会漂；
   * `pinned` 是**上一趟固化的控件名**，界面改版后那个名字可能挂到了别的控件上。两者陈旧时
   * 的表现都是「每趟都命中、每趟都点空」，而回执上写着一个看起来很稳的 via。
   */
  it('point 命中但 expect 未兑现 → 作废那条坐标缓存，并交出一条 locator 提议', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const proposals: unknown[] = []
    const f = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [], elements: [], window: WIN, scale: 1 }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: { point: '消息输入框' }, expect: { see: { text: 'Alice' }, timeoutMs: 300 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      {
        see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir, llm: async () => ({ content: "click(start_box='[100,100,140,140]')", raw: {} } as never) }),
        repairRunner: {
          async requestRepair() {},
          async proposeLocator(p) { proposals.push(p) },
          async proposeState() {},
          async proposeDiscriminator() {},
          async proposeTransition() {},
        },
        facility: 'telegram',
      },
    )
    expect(out.outcome).toBe('drift')
    expect(out.seeVia).toEqual({ '#0': 'point' })
    // 坐标缓存作废了：那个 key 的 json 没了
    expect(readdirSync(join(dir, 'x')).filter((n) => n.endsWith('.json'))).toHaveLength(0)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ sourceId: recipe().sourceId, wasVia: 'point', see: { point: '消息输入框' } })
    // 现场和提议一起交（spec §4.1）：人审和 AI 看的是同一张画面，而不是一句"靶子作废了"。
    expect((proposals[0] as { scene?: { side?: string } }).scene?.side).toBe('desktop')
    // facility 由调用方（`opts.facility`）透传给提议——DesktopRecipe 本身不携带它，
    // 缺席会让 Broker 退回按 sourceId 分文件，把同站的状态学散（见 `RepairProposal.facility` 头注）。
    expect((proposals[0] as { facility?: string }).facility).toBe('telegram')
  })

  it('pinned 命中但 expect 未兑现 → 丢掉那个陈旧句柄（丢的是 handles.json，不是模板文件）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const SEE = { point: '消息输入框' } as const
    const cache = new SeeCache(join(dir, 'x'))
    cache.putHandle(SEE, '旧输入框')
    const f = fakeDriver({
      // **只应答那个句柄**：全应答的话判据（`{text:'Alice'}`）也会在 a11y 段命中，
      // 这一步会被判成「expect 恒真」，整个用例验的就不是它想验的东西了。
      find: (q) => (q.name === '旧输入框' ? [{ ref: 'r1', rect: { x: 10, y: 10, w: 20, h: 20 }, role: 'Edit', name: '旧输入框', className: '' }] : []),
      screen: () => ({ texts: [], elements: [], window: WIN, scale: 1 }),
    })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: SEE, expect: { see: { text: 'Alice' }, timeoutMs: 300 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      { see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir }) },
    )
    expect(out.outcome).toBe('drift')
    expect(out.seeVia).toEqual({ '#0': 'pinned' })
    expect(cache.peekHandle(SEE)).toBeNull()
  })

  it('提议里装的是动作那一步的 see，不是判据里那个——AI 只许改「点哪儿」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const proposals: Array<{ see: unknown }> = []
    const f = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [], elements: [], window: WIN, scale: 1 }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: { point: '消息输入框' }, expect: { see: { text: '判据文字' }, timeoutMs: 300 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      {
        see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir, llm: async () => ({ content: "click(start_box='[100,100,140,140]')", raw: {} } as never) }),
        repairRunner: { async requestRepair() {}, async proposeLocator(p) { proposals.push(p) }, async proposeState() {}, async proposeDiscriminator() {}, async proposeTransition() {} },
      },
    )
    for (const p of proposals) expect(p.see).not.toEqual({ text: '判据文字' })
    expect(proposals[0]?.see).toEqual({ point: '消息输入框' })
  })

  it('see.point 也吃 {param} 替换——漏掉这一格不报错，只是把花括号原样发给模型', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const asked: string[] = []
    const f = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [], elements: [], window: WIN, scale: 1 }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: { point: '{contact} 的消息输入框' }, expect: { see: { text: 'Alice' }, timeoutMs: 200 } }], observer: undefined, read: undefined, allowEmpty: true }),
      { contact: '我的手机' },
      f.driver,
      {
        see: (d) => makeSeeResolver(d, 'x', {
          cacheDir: dir,
          llm: async (_id, input) => {
            const parts = (input as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0].content
            asked.push(parts.map((p) => p.text ?? '').join(''))
            return { content: '没找到', raw: {} } as never
          },
        }),
      },
    )
    expect(asked.join('')).toContain('我的手机 的消息输入框')
    expect(asked.join('')).not.toContain('{contact}')
  })

  it('靶子不是缓存给的（screen 段现读）→ 不作废、也不提议：那不是靶子陈旧，是界面上真没有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const proposals: unknown[] = []
    const f = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [{ text: '发送', rect: { x: 0, y: 0, w: 20, h: 10 } }], elements: [{ name: '发送', rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'text' }], window: WIN, scale: 1 }),
    })
    const out = await runDesktopRecipe(
      recipe({ steps: [{ kind: 'invoke', see: { text: '发送' }, expect: { see: { text: 'Alice' }, timeoutMs: 300 } }], observer: undefined, read: undefined, allowEmpty: true }),
      {},
      f.driver,
      { see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir }), repairRunner: { async requestRepair() {}, async proposeLocator(p) { proposals.push(p) }, async proposeState() {}, async proposeDiscriminator() {}, async proposeTransition() {} } },
    )
    expect(out.outcome).toBe('drift')
    expect(proposals).toHaveLength(0)
  })

  /**
   * 作废发生在**这一步真的放弃之后**，不是 expect 第一次没兑现就作废。
   *
   * `retry` 的语义是"同一个动作原样再做一遍"——原样就包括**用同一个靶子**。第一次没兑现常常
   * 只是界面还没跟上（动画、网络），这时候删掉模板，重试那一趟就得重走模型段：**一次白花的
   * 模型调用**，而且换来的靶子跟刚才那个多半是同一个。真正说明模板不对的信号是"重试也没兑现"。
   */
  it('else:retry：重试沿用同一条模板（中间不重走模型），两次都没兑现才作废', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const WIN = { x: 0, y: 0, w: 900, h: 600 }
    const seed = fakeDriver({
      find: () => [],
      screen: () => ({ texts: [{ text: 'A', rect: { x: 0, y: 0, w: 20, h: 10 } }], window: WIN, scale: 1 }),
      capture: { jpeg: await sharp({ create: { width: 900, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer(), window: WIN, scale: 1 },
    })
    await makeSeeResolver(seed.driver, 'x', { cacheDir: dir, llm: async () => ({ content: '1', raw: {} } as never) })
      .resolve({ icon: '那个图标' }, { allowModel: true, mode: 'action' })
    expect(readdirSync(join(dir, 'x')).some((f) => f.endsWith('.png'))).toBe(true)

    const f = fakeDriver({ find: () => [], screen: () => ({ texts: [], window: WIN, scale: 1 }), image: () => ({ rect: { x: 0, y: 0, w: 20, h: 10 }, score: 0.99 }) })
    const out = await runDesktopRecipe(
      recipe({
        steps: [{ kind: 'invoke', see: { icon: '那个图标' }, expect: { see: { text: 'Alice' }, timeoutMs: 300 }, else: 'retry' }],
        observer: undefined, read: undefined, allowEmpty: true,
      }),
      {},
      f.driver,
      // 模型这一趟一次都不该被叫到：叫了就是模板被提前删了
      { see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir, llm: async () => { throw new Error('这一趟不该调模型') } }) },
    )
    expect(out.outcome).toBe('drift')
    expect(f.calls.filter((c) => c.m === 'findImage')).toHaveLength(2) // 两趟都走的模板段
    expect(readdirSync(join(dir, 'x')).some((n) => n.endsWith('.png'))).toBe(false) // 重试也黄了，这才作废
  })
})

// ── `interrupts` 打断表：expect 不成立时问一句「是不是被弹窗挡住了」 ─────────────────────
//
// 只在 expect 失败之后才查表——正常路径一次多余的读屏都不发。表里没有的界面**绝不乱点**：
// 一个"看见没见过的弹窗就随便按一下"的兜底，在桌面这一侧就是替用户点了「确认删除」。

describe('runDesktopRecipe: interrupts', () => {
  const rec = (interrupts?: DesktopRecipe['interrupts']) => recipe({
    steps: [{ kind: 'type', text: '\n', expect: { see: { text: 'Alice' }, timeoutMs: 600 }, label: '开会话' }],
    interrupts, observer: undefined, read: undefined, allowEmpty: true,
  })
  /** 这一组每条用例都要走一次"expect 落空"，所以都得驱动那只表——见 `fakeClock` 的头注：
   *  假 driver 的一觉是零耗时的，不驱动它，每条用例会在**真实时间**里空转满 `timeoutMs`。 */
  const clocked = (f: { driver: DesktopDriver }) => ({ ...seeOpts(), now: fakeClock(f.driver) })
  /** 弹窗挡着 → 消化掉（click 或 press 都算）→ 目标文字才露出来。 */
  const popupThenOk = () => {
    let dismissed = false
    const screen = () => ({
      texts: dismissed ? [{ text: 'Alice', rect: { x: 1, y: 1, w: 9, h: 9 } }] : [{ text: '稍后再说', rect: { x: 50, y: 50, w: 40, h: 10 } }],
      window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1,
    })
    const f = fakeDriver({ find: () => [], screen })
    f.driver.click = async (rect) => { f.calls.push({ m: 'click', a: { rect } }); dismissed = true; return {} }
    f.driver.press = async (key) => { f.calls.push({ m: 'press', a: key }); dismissed = true; return {} }
    return f
  }

  it('expect 失败 → 查表命中 → dismiss（invoke see）→ 重验通过', async () => {
    const f = popupThenOk()
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'invoke', see: { text: '稍后再说' } } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    expect(f.calls.find((c) => c.m === 'click')).toBeTruthy()
    expect(out.dismissed).toEqual([JSON.stringify({ text: '稍后再说' })])
  })

  it('dismiss 是 press → 走 press op', async () => {
    const f = popupThenOk()
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    expect(f.calls.find((c) => c.m === 'press')!.a).toBe('Escape')
  })

  /** 查表是**失败之后**才问的一句话，不是每步都问。放进正常路径就等于每一步多一次读屏，
   *  而绝大多数步骤根本没有弹窗——那是白花的时间，且它长得像"识别层很慢"。 */
  it('expect 第一次就成立 → 根本不查表（正常路径零开销）', async () => {
    let typed = false
    const f = fakeDriver({
      find: () => [],
      screen: () => ({ texts: typed ? [{ text: 'Alice', rect: { x: 1, y: 1, w: 9, h: 9 } }] : [], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }),
    })
    f.driver.type = async (t) => { f.calls.push({ m: 'type', a: t }); typed = true; return {} }
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    expect(out.dismissed).toBeUndefined()
    // 动作前那次 + 轮询第一拍 = 2 次读屏。查了表就会多出第 3 次。
    expect(f.calls.filter((c) => c.m.startsWith('read'))).toHaveLength(2)
  })

  it('每步最多消化一次：第二次 expect 仍失败就按 else 走，不再 dismiss', async () => {
    const f = fakeDriver({ find: () => [], screen: () => ({ texts: [{ text: '稍后再说', rect: { x: 50, y: 50, w: 40, h: 10 } }], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('drift')
    expect(f.calls.filter((c) => c.m === 'press')).toHaveLength(1)
  })

  it('表里没有的弹窗 = drift，不乱点', async () => {
    const f = fakeDriver({ find: () => [], screen: () => ({ texts: [{ text: '立即升级', rect: { x: 50, y: 50, w: 40, h: 10 } }], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 }) })
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('drift')
    expect(f.calls.map((c) => c.m)).not.toContain('press')
    expect(f.calls.filter((c) => c.m === 'click')).toHaveLength(0)
  })

  /** 启动即弹广告：`focus` 没有 expect（"窗口在前台"是它的隐含判据），所以标了 `atFocus:true`
   *  的条目在这里查一次——否则那张广告会一直挡到下一步，而下一步的失败读起来像"界面变了"。 */
  it('focus 步骤后查表——但只查 atFocus:true 的条目（启动即弹广告）', async () => {
    let popup = true
    let typed = false
    const f = fakeDriver({
      find: () => [],
      screen: () => ({
        texts: [
          ...(popup ? [{ text: '稍后再说', rect: { x: 50, y: 50, w: 40, h: 10 } }] : []),
          ...(typed ? [{ text: 'Alice', rect: { x: 1, y: 1, w: 9, h: 9 } }] : []),
        ],
        window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1,
      }),
    })
    f.driver.press = async (key) => { f.calls.push({ m: 'press', a: key }); popup = false; return {} }
    f.driver.type = async (t) => { f.calls.push({ m: 'type', a: t }); typed = true; return {} }
    const out = await runDesktopRecipe(recipe({
      steps: [{ kind: 'focus' }, { kind: 'type', text: 'x', expect: { see: { text: 'Alice' }, timeoutMs: 300 } }],
      interrupts: [{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' }, atFocus: true }], observer: undefined, read: undefined, allowEmpty: true,
    }), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    // press 发生在 type 之前。**先钉住它真的发生过**：`indexOf` 落空是 -1，天然小于任何下标，
    // 只写下面那条的话，一个"压根没查表"的实现照样能全绿。
    const seq = f.calls.map((c) => c.m)
    expect(seq).toContain('press')
    expect(seq.indexOf('press')).toBeLessThan(seq.indexOf('type'))
  })

  /** 没有条目 opt-in `atFocus` 时，focus 步骤一次读屏都不发——上面那条 5.9s 的教训（微信每趟
   *  白付一次整窗 OCR）就是这里没做区分。用假 driver 数屏幕读次数，不能只看"没触发 dismiss"，
   *  否则一个"查了表但没命中"的实现也能全绿。 */
  it('focus 后没有 atFocus 的打断表 → 不读屏（微信这份不该白付一次整窗 OCR）', async () => {
    let screenReads = 0
    const f = fakeDriver({
      find: () => [],
      screen: () => { screenReads++; return { texts: [{ text: 'Alice', rect: { x: 1, y: 1, w: 9, h: 9 } }], window: { x: 0, y: 0, w: 900, h: 600 }, scale: 1 } },
    })
    const out = await runDesktopRecipe(recipe({
      steps: [{ kind: 'focus' }],
      interrupts: [{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }], observer: undefined, read: undefined, allowEmpty: true,
    }), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    expect(screenReads).toBe(0)
  })

  /** expect 失败时，非 atFocus 的打断照样被消化——`atFocus` 只收窄"focus 步骤后无条件查一次"
   *  这一条路径，不改变"expect 失败后查表"那条既有路径。 */
  it('expect 失败时，非 atFocus 的打断照样被消化', async () => {
    const f = popupThenOk()
    const out = await runDesktopRecipe(rec([{ see: { text: '稍后再说' }, dismiss: { kind: 'invoke', see: { text: '稍后再说' } } }]), {}, f.driver, clocked(f))
    expect(out.outcome).toBe('ok')
    expect(f.calls.find((c) => c.m === 'click')).toBeTruthy()
    expect(out.dismissed).toEqual([JSON.stringify({ text: '稍后再说' })])
  })

  it('本地缓存里的 interrupts.json 与 recipe 的表并集', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    mkdirSync(join(dir, 'x'), { recursive: true })
    writeFileSync(join(dir, 'x', 'interrupts.json'), JSON.stringify([{ see: { text: '稍后再说' }, dismiss: { kind: 'press', key: 'Escape' } }]))
    const f = popupThenOk()
    const out = await runDesktopRecipe(rec(), {}, f.driver, { see: (d) => makeSeeResolver(d, 'x', { cacheDir: dir }), now: fakeClock(f.driver) })
    expect(out.outcome).toBe('ok')
  })
})

describe('DesktopRunOutcome 的出口词汇', () => {
  /**
   * 类型层面的钉子：union 里缺 `challenged` 时这一行通不过 tsc。
   *
   * 为什么现在就钉：下一期把状态图接到桌面这一侧时，撞上风控挑战**只能判 drift**——
   * 而 drift 会去修一份根本没坏的 recipe，还会连着几次把源隔离，此后返回
   * `items:0 + errors:[]`，和「跑成功了、但确实没读到」一模一样。等到那时候才发现，
   * 已经分不出哪些源是被这样悄悄关掉的了。
   */
  it('认得 challenged——桌面撞挑战不该只能判 drift', () => {
    const o: DesktopRunOutcome = { outcome: 'challenged', items: [], driftReason: '站方风控挑战' }
    expect(o.outcome).toBe('challenged')
  })
})

describe('groundings：按 agent 报的平台/版本挑落地方式', () => {
  const base = (): DesktopRecipe => ({
    version: 1, kind: 'desktop', sourceId: 'g', app: { process: 'x.exe' }, allowEmpty: true,
    steps: [{
      label: '点输入框', kind: 'click', at: { x: 0.5, y: 0.5 }, blind: '焦点无画面',
      groundings: [
        { on: { platform: 'darwin' }, kind: 'click', at: { x: 0.6, y: 0.87 } },
        { on: { platform: 'win32', app: '>=4.0 <4.1' }, kind: 'click', at: { x: 0.1, y: 0.1 } },
      ],
    }],
  })
  const cap: WindowCapture = { jpeg: Buffer.alloc(0), window: { x: 0, y: 0, w: 1000, h: 1000 }, scale: 1 }
  /** 走 `see` 的那两条要一张真图：识别层命中后会从截图上裁模板，空 Buffer 会在 sharp 里炸。 */
  const seeCap = async (): Promise<WindowCapture> => ({
    jpeg: await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#fff' } }).jpeg().toBuffer(),
    window: cap.window, scale: 1,
  })

  it('darwin agent → 用 darwin 那条；回执记下用了哪条', async () => {
    const { driver, calls } = fakeDriver({ capture: cap, platform: 'darwin' })
    const out = await runDesktopRecipe(base(), {}, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.find((c) => c.m === 'click')!.a).toEqual({ rect: { x: 600, y: 870, w: 1, h: 1 }, button: undefined })
    expect(out.groundings).toEqual({ 点输入框: 'package:darwin' })
  })
  it('win32 4.0.6 → 用带 app 区间那条；4.2 → 区间不匹配，落回通用', async () => {
    const a = fakeDriver({ capture: cap, platform: 'win32', appVersion: '4.0.6' })
    await runDesktopRecipe(base(), {}, a.driver)
    expect(a.calls.find((c) => c.m === 'click')!.a).toEqual({ rect: { x: 100, y: 100, w: 1, h: 1 }, button: undefined })
    const b = fakeDriver({ capture: cap, platform: 'win32', appVersion: '4.2.0' })
    const out = await runDesktopRecipe(base(), {}, b.driver)
    expect(b.calls.find((c) => c.m === 'click')!.a).toEqual({ rect: { x: 500, y: 500, w: 1, h: 1 }, button: undefined })
    expect(out.groundings).toEqual({ 点输入框: 'universal' })
  })
  it('老 agent 不报平台 → 只有通用 body 参与，探针说出来', async () => {
    const probes: string[] = []
    const { driver, calls } = fakeDriver({ capture: cap })
    await runDesktopRecipe(base(), {}, driver, { onProbe: (m) => probes.push(m) })
    expect(calls.find((c) => c.m === 'click')!.a).toEqual({ rect: { x: 500, y: 500, w: 1, h: 1 }, button: undefined })
    expect(probes.some((p) => /agent 没报平台/.test(p))).toBe(true)
  })
  it('第一条的 expect 没兑现 → 试下一条；都没兑现 → no-grounding@label，带上试过的清单', async () => {
    let seen = 0
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '点候选', kind: 'invoke', see: { text: 'U' }, expect: { see: { text: '会话' }, timeoutMs: 0 },
        groundings: [{ on: { platform: 'win32' }, kind: 'invoke', see: { text: 'A' } }, { on: { platform: 'win32' }, kind: 'invoke', see: { text: 'B' } }],
      }],
    }
    const { driver } = fakeDriver({
      capture: await seeCap(), platform: 'win32',
      // a11y 段一律空：靶子只能从屏幕文字来（默认的假 find 会让每个 see 都命中，判据就成了恒真）
      find: () => [],
      // 屏上有 A / B / U 三个靶子，但「会话」永远不出现
      screen: () => ({ texts: [{ text: 'A', rect: { x: 0, y: 0, w: 10, h: 10 } }, { text: 'B', rect: { x: 0, y: 20, w: 10, h: 10 } }, { text: 'U', rect: { x: 0, y: 40, w: 10, h: 10 } }], window: cap.window, scale: 1 }),
    })
    const out = await runDesktopRecipe(rec, {}, driver, { see: (d) => makeSeeResolver(d, 'g', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }), now: () => (seen += 1000) })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/^no-grounding@点候选/)
    expect(out.driftReason).toMatch(/package:win32.*package:win32.*universal/)
  })
  it('else:abort 的步骤第一条没兑现就停，不试第二条（abort = 此后不再发任何输入）', async () => {
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '打正文', kind: 'type', text: 'hi', else: 'abort', expect: { see: { text: 'never' }, timeoutMs: 0 },
        groundings: [{ on: { platform: 'win32' }, kind: 'type', text: 'hi' }],
      }],
    }
    const { driver, calls } = fakeDriver({ capture: await seeCap(), platform: 'win32', find: () => [], screen: () => ({ texts: [], window: cap.window, scale: 1 }) })
    const out = await runDesktopRecipe(rec, {}, driver, { see: (d) => makeSeeResolver(d, 'g', { cacheDir: mkdtempSync(join(tmpdir(), 'see-')) }) })
    expect(out.driftReason).toMatch(/aborted-by-recipe/)
    expect(calls.filter((c) => c.m === 'type')).toHaveLength(1)
  })
  // 本机 override 那份文件**不过装载闸**（只 JSON.parse），而 spec §5.4 明写允许手工编辑它。
  // 一条 kind 拼错的落地方式会被选中、然后什么都不做——此前它报成功、给 verified.runs 加一次，
  // 三次之后成为可贡献的落地方式。安静地成功比报错贵得多。
  it('落地方式的 kind 不认识 → 这一条判失败并留痕，不许报成功', async () => {
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{ label: '点发送', kind: 'invoke', query: { role: 'Button', name: '发送' }, blind: '无画面' }],
    }
    const overrides = {
      groundingsFor: (_s: string, label: string) => (label === '点发送'
        ? [{ on: { platform: 'win32' as const }, kind: 'frob', verified: { runs: 4, first: 'a', last: 'b', by: 'human' as const } } as never]
        : []),
      recordRun: (...a: unknown[]) => { recorded.push(a) },
    }
    const recorded: unknown[] = []
    const { driver, calls } = fakeDriver({ capture: cap, platform: 'win32', find: () => [] })
    const out = await runDesktopRecipe(rec, {}, driver, { overrides })
    expect(out.outcome).toBe('drift')
    // 认不出的那一条必须在「试过」清单里说出原因，而不是悄悄算成功
    expect(out.driftReason).toMatch(/不认识的步骤 kind：frob/)
    // 它一个输入都没发出去
    expect(calls.some((c) => c.m === 'click' || c.m === 'invoke')).toBe(false)
    // 整趟 drift → 一条账都不记（别让一条什么都没做的落地方式攒出 verified.runs）
    expect(recorded).toEqual([])
  })
  // 条件边本期只校验形状、不执行。"装载通过 + 安静地不生效"是这条链路最贵的那种失败：
  // 作者以为那几步插进去了，实际一步没插，而每一步都照常报成功。
  it('recipe 带 edges[] → 跑之前就报 edges-unsupported，一个输入都不发', async () => {
    const rec: DesktopRecipe = {
      ...base(),
      edges: [{ from: '点输入框', on: { platform: 'win32' }, insert: [{ label: '插一步', kind: 'click', at: { x: 0.1, y: 0.1 }, blind: 'x' }] }],
    }
    const { driver, calls } = fakeDriver({ capture: cap, platform: 'win32' })
    const out = await runDesktopRecipe(rec, {}, driver)
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/^edges-unsupported/)
    expect(calls.some((c) => c.m === 'click')).toBe(false)
  })
  it('本机 override 参与选择；整趟 done 后按用到的那几条记账', async () => {
    const recorded: unknown[] = []
    const overrides = {
      groundingsFor: (_s: string, label: string) => (label === '点输入框'
        ? [{ on: { platform: 'win32' as const }, kind: 'click', at: { x: 0.2, y: 0.2 }, verified: { runs: 4, first: 'a', last: 'b', by: 'human' as const } }]
        : []),
      recordRun: (...a: unknown[]) => { recorded.push(a) },
    }
    const { driver, calls } = fakeDriver({ capture: cap, platform: 'win32' })
    const out = await runDesktopRecipe(base(), {}, driver, { overrides, packageInfo: { name: '@streamapp/x', version: '1.0.0' } })
    expect(out.groundings).toEqual({ 点输入框: 'local:win32' })
    expect(calls.find((c) => c.m === 'click')!.a).toEqual({ rect: { x: 200, y: 200, w: 1, h: 1 }, button: undefined })
    expect(recorded).toHaveLength(1)
    const [sourceId, used, facts, pkg] = recorded[0] as [string, Array<{ label: string; by: string }>, { platform: string }, { name: string }]
    expect(sourceId).toBe('g'); expect(used[0]).toMatchObject({ label: '点输入框', by: 'human' }); expect(facts.platform).toBe('win32'); expect(pkg.name).toBe('@streamapp/x')
  })
  it('else:abort 也挡住「动作本身失败」那个出口——不试第二条，报 aborted-by-recipe', async () => {
    const probes: string[] = []
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '点发送', kind: 'invoke', query: { role: 'Button', name: '发送' }, else: 'abort',
        groundings: [
          { on: { platform: 'win32' }, kind: 'invoke', query: { role: 'Button', name: '发送 A' } },
          { on: { platform: 'win32' }, kind: 'invoke', query: { role: 'Button', name: '发送 B' } },
        ],
      }],
    }
    const { driver, calls } = fakeDriver({ capture: cap, platform: 'win32', find: () => [] })
    const out = await runDesktopRecipe(rec, {}, driver, { onProbe: (m) => probes.push(m) })
    expect(out.driftReason).toMatch(/aborted-by-recipe@点发送/)
    // 第二条一次都没跑：换落地方式的探针不该出现，`发送 B` 也不该被查过
    expect(probes.some((p) => /换落地方式/.test(p))).toBe(false)
    expect(calls.some((c) => JSON.stringify(c.a).includes('发送 B'))).toBe(false)
  })
  it('第一步就是 window 的 recipe 也学得到事实——按 darwin 挑那条 match', async () => {
    const probes: string[] = []
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '等窗口', kind: 'window', match: { process: 'x.exe', title: '这个标题不存在' }, timeoutMs: 0,
        groundings: [{ on: { platform: 'darwin' }, kind: 'window', match: { process: 'x.exe', title: 'Mac 窗' }, timeoutMs: 0 }],
      }],
    }
    const { driver } = fakeDriver({ capture: cap, windows: [[{ process: 'x.exe', title: 'Mac 窗', platform: 'darwin' }]] })
    const out = await runDesktopRecipe(rec, {}, driver, { onProbe: (m) => probes.push(m) })
    expect(out.outcome).toBe('ok')
    expect(out.groundings).toEqual({ 等窗口: 'package:darwin' })
    // 事实学到了，那句「老 agent 没报平台」就不许说——它会把人支去升级一个本来就在报平台的 agent
    expect(probes.some((p) => /agent 没报平台/.test(p))).toBe(false)
  })
  // 平台是**整台机器**的事实，不是这个应用的：桌面上任何一行窗口都在回答同一个问题。按「是不是
  // 自己的窗口」一起过滤掉它，代价全落在第一步就是 `window` 的 recipe 上——开头那次 `windows()`
  // 本来就常常还看不到自己的窗口（它就是来等它出现的），于是平台跟着丢，每一步只剩通用落地方式，
  // 还附赠一句假的「agent 没报平台」。（`appVersion` 相反，必须是自己的窗口，由上一条钉着。）
  it('平台从任意一行窗口学得到——开头只有别的进程在，darwin 那条照样被挑中', async () => {
    const probes: string[] = []
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '等窗口', kind: 'window', match: { process: 'x.exe', title: '这个标题不存在' }, timeoutMs: 0,
        groundings: [{ on: { platform: 'darwin' }, kind: 'window', match: { process: 'x.exe', title: 'Mac 窗' }, timeoutMs: 0 }],
      }],
    }
    const { driver } = fakeDriver({
      capture: cap,
      // 第一次问：屏上只有个不相干的进程（自己的窗口还没开）。第二次才轮到自己那个。
      windows: [
        [{ process: 'finder', title: '访达', platform: 'darwin' }],
        [{ process: 'x.exe', title: 'Mac 窗' }],
      ],
    })
    const out = await runDesktopRecipe(rec, {}, driver, { onProbe: (m) => probes.push(m) })
    expect(out.outcome).toBe('ok')
    expect(out.groundings).toEqual({ 等窗口: 'package:darwin' })
    expect(probes.some((p) => /agent 没报平台/.test(p))).toBe(false)
  })
  it('optional 的步骤所有候选都 skip → 不记账（没做成不算一次成功）', async () => {
    const recorded: unknown[] = []
    const overrides = { groundingsFor: () => [], recordRun: (...a: unknown[]) => { recorded.push(a) } }
    const rec: DesktopRecipe = {
      ...base(),
      steps: [{
        label: '顺手复位', kind: 'invoke', query: { role: 'Button', name: '关闭' }, optional: true,
        groundings: [
          { on: { platform: 'win32' }, kind: 'invoke', query: { role: 'Button', name: '关闭 A' } },
          { on: { platform: 'win32' }, kind: 'invoke', query: { role: 'Button', name: '关闭 B' } },
        ],
      }],
    }
    const { driver } = fakeDriver({ capture: cap, platform: 'win32', find: () => [] })
    const out = await runDesktopRecipe(rec, {}, driver, { overrides })
    expect(out.outcome).toBe('ok')
    expect(out.groundings).toBeUndefined()
    const [, used] = recorded[0] as [string, Array<{ label: string }>]
    expect(used.some((u) => u.label === '顺手复位')).toBe(false)
  })
  // 对账住每趟运行的开头，不住装配期：包的装/卸是进程内热重载，后端不重启——装配期对一次账
  // 就漏掉了「包升级」这条主路径，而漏掉的表现是本机那份一直压着包里的新版本，两边都不报错。
  it('每趟运行开头对一次账，且拿到的是这条 recipe 本身', async () => {
    const seen: unknown[] = []
    const probes: string[] = []
    const overrides = {
      groundingsFor: () => [],
      recordRun: () => {},
      reconcile: (...a: unknown[]) => { seen.push(a); return { removed: 2, shadowed: 1 } },
    }
    const { driver } = fakeDriver({ capture: cap, platform: 'win32' })
    const rec = base()
    const out = await runDesktopRecipe(rec, {}, driver, { overrides, onProbe: (m) => probes.push(m) })
    expect(out.outcome).toBe('ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(['g', rec])
    expect(probes.some((p) => p.includes('[recipe-overrides] g: 已上游 2 条、被包覆盖 1 条'))).toBe(true)
  })
  it('没变化不出声；存储没有 reconcile 这一格也照跑（不伪造一个"对过了"）', async () => {
    const probes: string[] = []
    const { driver } = fakeDriver({ capture: cap, platform: 'win32' })
    const quiet = { groundingsFor: () => [], recordRun: () => {}, reconcile: () => ({ removed: 0, shadowed: 0 }) }
    const a = await runDesktopRecipe(base(), {}, driver, { overrides: quiet, onProbe: (m) => probes.push(m) })
    expect(a.outcome).toBe('ok')
    expect(probes.some((p) => p.includes('[recipe-overrides]'))).toBe(false)

    const { driver: d2 } = fakeDriver({ capture: cap, platform: 'win32' })
    const b = await runDesktopRecipe(base(), {}, d2, { overrides: { groundingsFor: () => [], recordRun: () => {} } })
    expect(b.outcome).toBe('ok')
  })
  it('drift 的一趟不记账', async () => {
    const recorded: unknown[] = []
    const overrides = { groundingsFor: () => [], recordRun: (...a: unknown[]) => { recorded.push(a) } }
    const { driver } = fakeDriver({ capture: null as unknown as WindowCapture, platform: 'win32' }) // click.at 截不了窗 → drift
    const out = await runDesktopRecipe(base(), {}, driver, { overrides })
    expect(out.outcome).toBe('drift')
    expect(recorded).toHaveLength(0)
  })
})

// ── 具名区域（spec §3.4）：判据看的那一块屏，按平台落地 ──────────────────────────────
//
// 两件事这里钉死：**换在开跑之前**（一块选不中就一个输入都不发，而不是跑到那一步才发现前面
// 的动作已经做了），以及**识别层永远看不见 `area`**（它只认 `region`；漏换的表现是判据把
// 整窗当范围，慢一个量级却照样"成立"）。
describe('areas：具名区域', () => {
  /** 假识别层：记下每次收到的 `see`，第 n 次起命中。真的那份会去读屏，这里要的是"它收到了什么"。 */
  const fakeSeeResolver = (hitAtCall = Number.POSITIVE_INFINITY) => {
    const seen: See[] = []
    let n = 0
    const resolver: SeeResolver = {
      matches: async () => [],
      async resolve(see) {
        seen.push(see)
        return ++n >= hitAtCall ? { rect: { x: 0, y: 0, w: 10, h: 10 }, via: 'a11y', cacheKey: null } : null
      },
      invalidate() {},
      modelCalls: 0,
      localInterrupts: () => [],
    }
    return { resolver, seen }
  }
  /** 恒真那一次（动作前）落空、动作后那一次命中——`expect` 走通的最短路径。 */
  const hitOnSecondCall = () => fakeSeeResolver(2)

  const rec = (areas: Record<string, DesktopArea>, expectSee: See): DesktopRecipe => ({
    version: 1, kind: 'desktop', sourceId: 'areas', app: { process: 'x.exe' }, allowEmpty: true,
    ...(Object.keys(areas).length ? { areas } : {}),
    steps: [
      { label: '抢到前台', kind: 'focus' },
      { label: '打字', kind: 'type', text: 'hi', query: { role: 'Edit' }, expect: { see: expectSee, timeoutMs: 100 } },
    ],
  })

  it('开跑前把 see.area 换成按事实选中的 region；resolver 看不到 area', async () => {
    const { resolver, seen } = hitOnSecondCall()
    const { driver } = fakeDriver({ platform: 'win32' })
    const out = await runDesktopRecipe(
      rec({ 气泡区: { region: 'bottom', groundings: [{ on: { platform: 'win32' }, region: 'center' }] } }, { text: 'hi', area: '气泡区' }),
      {}, driver, { see: () => resolver },
    )
    expect(out.outcome).toBe('ok')
    expect(seen.every((s) => s.area === undefined)).toBe(true)
    expect(seen[0]).toMatchObject({ text: 'hi', region: 'center' })
    expect(out.areas).toEqual({ 气泡区: 'package:win32' })
  })

  it('区域一条都选不中 → 在发出任何输入之前以 no-grounding@area 判 drift', async () => {
    const { driver, calls } = fakeDriver({ platform: 'darwin' })
    const out = await runDesktopRecipe(
      rec({ 气泡区: { groundings: [{ on: { platform: 'win32' }, region: 'center' }] } }, { text: 'hi', area: '气泡区' }),
      {}, driver, { see: () => fakeSeeResolver().resolver },
    )
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/^no-grounding@area:气泡区/)
    expect(out.driftReason).toContain('darwin')
    expect(calls.filter((c) => ['focusApp', 'type', 'setValue', 'click', 'press'].includes(c.m))).toEqual([])
  })

  it('判据借区域得出肯定结论 → 记账到 area；恒真那次不记', async () => {
    const recorded: unknown[] = []
    const overrides = { groundingsFor: () => [], areaGroundingsFor: () => [], recordRun: (...a: unknown[]) => { recorded.push(a) } }
    const { resolver } = hitOnSecondCall()
    const { driver } = fakeDriver({ platform: 'win32' })
    await runDesktopRecipe(
      rec({ 气泡区: { groundings: [{ on: { platform: 'win32' }, region: 'center' }] } }, { text: 'hi', area: '气泡区' }),
      {}, driver, { see: () => resolver, overrides },
    )
    expect(recorded).toHaveLength(1)
    expect((recorded[0] as unknown[])[1]).toEqual([{ area: '气泡区', body: { region: 'center' }, on: { platform: 'win32' }, by: 'author' }])
  })

  // 第一步是 `window` 的 recipe：开头那次 `windows()` 里常常还没有自己的窗口（那一步正是来等它
  // 出现的），事实要到这一步认出窗口才学得到。区域若在那之前查表，拿的是 `事实 {}`——分平台那条
  // 一律不匹配，于是要么落回通用、要么以一句**诚实但错**的 `no-grounding@area:… 事实 {}` 把整趟
  // 拦下来，而同一份 recipe 的步骤那一侧（`rankGroundings`）选得好好的。
  const windowFirst = (winPlatform: 'win32' | 'darwin') => {
    const rec: DesktopRecipe = {
      version: 1, kind: 'desktop', sourceId: 'areas', app: { process: 'x.exe' }, allowEmpty: true,
      areas: { 气泡区: { groundings: [{ on: { platform: 'darwin' }, region: 'center' }] } },
      steps: [
        { label: '等窗口', kind: 'window', match: { process: 'x.exe', title: '会话' }, timeoutMs: 0 },
        { label: '打字', kind: 'type', text: 'hi', query: { role: 'Edit' }, expect: { see: { text: 'hi', area: '气泡区' }, timeoutMs: 100 } },
      ],
    }
    // 开头那次 `windows()` 看不到自己的窗口（只有别人的、且不报平台）；`window` 步骤那次才认出它。
    const { driver, calls } = fakeDriver({
      windows: [[{ process: 'other.exe', title: '别人' }], [{ process: 'x.exe', title: '会话', platform: winPlatform }]],
    })
    return { rec, driver, calls }
  }

  it('第一步是 window：区域等它学到平台之后再查表，不拿空事实选', async () => {
    const { resolver } = hitOnSecondCall()
    const { rec, driver } = windowFirst('darwin')
    const out = await runDesktopRecipe(rec, {}, driver, { see: () => resolver })
    expect(out.outcome).toBe('ok')
    expect(out.areas).toEqual({ 气泡区: 'package:darwin' })
  })

  it('第一步是 window 且那个窗口报的平台没有对应区域 → 仍然以 no-grounding@area 判 drift，事实是学全之后那份', async () => {
    const { rec, driver } = windowFirst('win32')
    const out = await runDesktopRecipe(rec, {}, driver, { see: () => fakeSeeResolver().resolver })
    expect(out.outcome).toBe('drift')
    expect(out.driftReason).toMatch(/^no-grounding@area:气泡区/)
    expect(out.driftReason).toContain('win32')   // 不是空事实 {}
  })

  it('老 recipe（没有 areas、see 只写 region）一字不改照跑', async () => {
    const { resolver } = hitOnSecondCall()
    const { driver } = fakeDriver({ platform: 'win32' })
    const out = await runDesktopRecipe(rec({}, { text: 'hi', region: 'bottom' }), {}, driver, { see: () => resolver })
    expect(out.outcome).toBe('ok')
    expect(out.areas).toBeUndefined()
  })
})

/**
 * `pickFile`：喂一个已经弹出来的系统文件对话框（微信「发送文件」→「选择文件」IFileOpenDialog，
 * 活体 2026-09-18）。这些用例钉的是形状：等对话框 → 换范围 → setValue 文件名框 → 让它拿焦点 → 回车
 * →（没关才点「打开(O)」）→ 等消失 → 范围换回。**确认键不依赖树里有没有「打开(O)」**——同一台机器
 * 两次抓树一有一无，只有回车那条路活体验过。
 */
describe('pickFile：喂系统文件对话框', () => {
  const MAIN = { process: 'Weixin.exe', title: '微信' }
  const DLG = { process: 'Weixin.exe', title: '选择文件' }
  const EDIT: A11yElement = { ref: 'edit-1', role: 'Edit', name: '文件名(N):', className: 'Edit', rect: { x: 0, y: 0, w: 1, h: 1 } }
  const OPEN_BTN: A11yElement = { ref: 'btn-open', role: 'Button', name: '打开(O)', className: 'Button', rect: { x: 0, y: 0, w: 1, h: 1 } }

  /**
   * 一台"会弹对话框"的假机器：`windows()` 读的是一份**活的**清单（不是逐次消费的队列）——
   * 对话框的出现/消失由测试按动作推进：`appearAfter` 次枚举之后它才在；收到 `\n`（或 invoke 确认键）
   * 就把它拿掉（`closesOn`）。这样钉得住的是"runner 在等那件事"，不是"runner 数了几次"。
   */
  function dialogMachine(opts: {
    appearAfter?: number
    /** 对话框对哪些动作关掉。默认只认回车；`'button'` = 只认点「打开(O)」（回车没用的那种机器）。 */
    closesOn?: 'enter' | 'button' | 'never'
    /** 树里有没有「打开(O)」。默认没有（活体两次抓取之一就是这样）。 */
    hasOpenButton?: boolean
    setValueFails?: boolean
    /** 对话框消失后谁在前台。默认主窗。 */
    fgAfter?: { process: string; title: string }
    /** 文件名框不在（界面语言不对那种） */
    noEdit?: boolean
  } = {}) {
    let enumerations = 0
    let dialogUp = false
    let dialogClosed = false
    const closesOn = opts.closesOn ?? 'enter'
    const base = fakeDriver({
      setValueFails: opts.setValueFails,
      platform: 'win32',
      find: (q) => {
        if (q.role === 'Edit' && q.name === '文件名(N):') return opts.noEdit ? [] : [EDIT]
        if (q.role === 'Button' && q.name === '打开(O)') return opts.hasOpenButton ? [OPEN_BTN] : []
        return []
      },
    })
    const close = () => { dialogUp = false; dialogClosed = true }
    const driver: DesktopDriver = {
      ...base.driver,
      async windows() {
        base.calls.push({ m: 'windows' })
        enumerations++
        if (!dialogClosed && enumerations > (opts.appearAfter ?? 0)) dialogUp = true
        const fg = dialogClosed ? (opts.fgAfter ?? MAIN) : dialogUp ? DLG : MAIN
        const list = [MAIN, ...(dialogUp ? [DLG] : [])]
        return list.map((w) => ({ id: w.title, ...w, foreground: w.title === fg.title && w.process === fg.process, platform: 'win32' as const }))
      },
      async type(text, e, deliver) {
        await base.driver.type(text, e, deliver)
        if (text === '\n' && closesOn === 'enter') close()
        return {}
      },
      async invoke(ref, e) {
        await base.driver.invoke(ref, e)
        if (ref === OPEN_BTN.ref && closesOn === 'button') close()
        return {}
      },
    }
    return { driver, calls: base.calls }
  }
  const rec = (over: Partial<Extract<DesktopStep, { kind: 'pickFile' }>> = {}, steps: DesktopStep[] = []): DesktopRecipe =>
    recipe({
      sourceId: 'wechat-send-file',
      app: MAIN,
      steps: [
        { kind: 'pickFile', label: '喂对话框', path: '{path}', blind: '测试', ...over } as DesktopStep,
        ...steps,
      ],
      observer: undefined, read: undefined, allowEmpty: true,
    })
  const PATH = '\\\\wsl.localhost\\U\\home\\j\\a.txt'

  it('主路：等对话框出现 → 换范围 → setValue 文件名框 → invoke 让它拿焦点 → 回车 → 等它消失 → 范围换回主窗', async () => {
    const { driver, calls } = dialogMachine({ appearAfter: 2 })
    const out = await runDesktopRecipe(rec(), { path: PATH }, driver)
    expect(out.outcome).toBe('ok')
    // 路径填过参、写进的是那个 Edit；确认走的是「让它拿焦点 + 回车」，一次都没去找也没去点「打开(O)」
    expect(calls.find((c) => c.m === 'setValue')?.a).toEqual({ ref: EDIT.ref, text: PATH })
    expect(calls.filter((c) => c.m === 'invoke').map((c) => c.a)).toEqual([EDIT.ref])
    expect(calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual(['\n'])
    expect(calls.some((c) => c.m === 'find' && (c.a as A11yQuery).name === '打开(O)')).toBe(false)
    // 范围：主窗 → 对话框（真实标题）→ 回主窗
    expect(calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)).toEqual([MAIN, DLG, MAIN])
    // 回车之前抬的是对话框（模态、自己拿焦点），不是主窗
    expect(calls.filter((c) => c.m === 'focusApp').map((c) => c.a)).toEqual([DLG])
    // 回执：走的哪条路、各段耗时、主窗回前台
    expect(out.pickFile?.['喂对话框']).toMatchObject({ via: 'value+enter', dialog: DLG, foregroundBack: true })
    expect(out.pickFile?.['喂对话框'].ms).toMatchObject({ total: expect.any(Number) })
    expect(Object.keys(out.pickFile!['喂对话框'].ms).sort()).toEqual(['appear', 'close', 'fill', 'total'])
  })

  it('回车没关掉、树里有「打开(O)」→ 才点它当备选，回执 via=button', async () => {
    const { driver, calls } = dialogMachine({ closesOn: 'button', hasOpenButton: true })
    const out = await runDesktopRecipe(rec({ closeTimeoutMs: 600 }), { path: PATH }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.filter((c) => c.m === 'invoke').map((c) => c.a)).toEqual([EDIT.ref, OPEN_BTN.ref])
    expect(out.pickFile?.['喂对话框'].via).toBe('button')
  })

  it('setValue 不认 → 退回键盘打进文件名框（先 invoke 拿焦点），回执 via=keyboard+enter', async () => {
    const { driver, calls } = dialogMachine({ setValueFails: true })
    const out = await runDesktopRecipe(rec(), { path: PATH }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.filter((c) => c.m === 'type').map((c) => c.a)).toEqual([PATH, '\n'])
    expect(out.pickFile?.['喂对话框'].via).toBe('keyboard+enter')
  })

  it('四种失败各有前缀，读的人一眼分得出停在哪一段；范围在失败时也换回主窗', async () => {
    // 1. 对话框没出现（前一步没点中）
    {
      const { driver, calls } = dialogMachine({ closesOn: 'never', appearAfter: 10_000 })
      // 虚拟时钟：等窗口按墙钟超时，假 driver 的 sleep 不花真时间——不给时钟，800ms 的真时间里
      // 它会枚举上万次，把"永远不出现"的对话框枚举出来。
      const out = await runDesktopRecipe(rec({ timeoutMs: 800 }), { path: PATH }, driver, { now: fakeClock(driver) })
      expect(out.outcome).toBe('drift')
      expect(out.driftReason).toMatch(/^喂对话框：pickFile\/dialog-missing/)
      expect(out.driftReason).toContain('微信(Weixin.exe)')   // 此刻在的窗口
      expect(calls.some((c) => c.m === 'setValue')).toBe(false)
      expect(out.pickFile?.['喂对话框'].ms.appear).toBeDefined()
    }
    // 2. 对话框在、文件名框不在（界面语言 / 版本）
    {
      const { driver, calls } = dialogMachine({ noEdit: true })
      const out = await runDesktopRecipe(rec({ closeTimeoutMs: 600 }), { path: PATH }, driver)
      expect(out.outcome).toBe('drift')
      expect(out.driftReason).toMatch(/^喂对话框：pickFile\/edit-missing/)
      expect(calls.some((c) => c.m === 'type')).toBe(false)   // 一个键都没按
      expect(calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)).toEqual([MAIN, DLG, MAIN])   // 换回了
    }
    // 3. 确认了它不关（路径打不开 / 弹了错误框）——回车、备选按钮都试过
    {
      const { driver, calls } = dialogMachine({ closesOn: 'never', hasOpenButton: true })
      const out = await runDesktopRecipe(rec({ closeTimeoutMs: 600 }), { path: PATH }, driver)
      expect(out.outcome).toBe('drift')
      expect(out.driftReason).toMatch(/^喂对话框：pickFile\/dialog-still-open/)
      expect(calls.filter((c) => c.m === 'invoke').map((c) => c.a)).toEqual([EDIT.ref, OPEN_BTN.ref])
      expect(out.pickFile?.['喂对话框'].via).toBeUndefined()   // 没走通就不报 via
      expect(calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)).toEqual([MAIN, DLG, MAIN])
    }
  })

  it('对话框消失后前台不是主窗 → 照样 ok，只在回执上记 foregroundBack:false（弱信号只记不判）', async () => {
    const { driver } = dialogMachine({ fgAfter: { process: 'other.exe', title: '别人' } })
    const out = await runDesktopRecipe(rec(), { path: PATH }, driver)
    expect(out.outcome).toBe('ok')
    expect(out.pickFile?.['喂对话框'].foregroundBack).toBe(false)
  })

  it('dialog 给了就按它认（标题填参），不用平台默认', async () => {
    const { driver, calls } = dialogMachine()
    const out = await runDesktopRecipe(rec({ dialog: { process: 'Weixin.exe', title: '{dlg}' } }), { path: PATH, dlg: '选择文件' }, driver)
    expect(out.outcome).toBe('ok')
    expect(calls.filter((c) => c.m === 'scopeWindow').map((c) => c.a)[1]).toEqual(DLG)
  })

  it('expect 在范围换回主窗之后验：恒真预检也在主窗里做（上一轮留下的同名卡片会被当场指出）', async () => {
    const { driver, calls } = dialogMachine()
    const out = await runDesktopRecipe(
      rec({ blind: undefined, expect: { query: { role: 'Text', name: 'a.txt' }, timeoutMs: 100 } } as never),
      { path: PATH },
      driver,
    )
    // 假机器的 find 对这个 query 恒空 → 动作前预检为假（好）、动作后等不到 → drift；关键是 find 发生在换回主窗之后
    expect(out.outcome).toBe('drift')
    const idxRestore = calls.findIndex((c, i) => c.m === 'scopeWindow' && i > 0 && JSON.stringify(c.a) === JSON.stringify(MAIN))
    const lastFind = calls.map((c, i) => [c, i] as const).filter(([c]) => c.m === 'find' && (c.a as A11yQuery).name === 'a.txt').map(([, i]) => i)
    expect(lastFind.length).toBeGreaterThan(1)
    expect(lastFind[lastFind.length - 1]).toBeGreaterThan(idxRestore)
    expect(out.driftReason).toContain('expect 未兑现')
  })
})

/**
 * `branch.unverified`：参数分支成立 = 跳过了这一趟唯一的判据（`wechat-send-file` 发图片：微信不画文件名）。
 * 回执要把"没验"和"验过了"分开——一趟 ok + unverified 和一趟干净的 ok 在 `outcome` 上一模一样。
 */
describe('branch.unverified', () => {
  const steps: DesktopStep[] = [
    { kind: 'branch', label: '图片没有文字判据', when: { param: 'path_kind', equals: 'image' }, skip: 1, unverified: 'image-no-caption' },
    { kind: 'type', label: '带判据的那一路', text: 'x', expect: { query: { role: 'Text', name: 'never' }, timeoutMs: 100 } },
  ]
  const mk = () => recipe({ steps, observer: undefined, read: undefined, allowEmpty: true })

  it('成立 → 回执 unverified 带上理由；不成立 → 没有这个字段', async () => {
    const img = fakeDriver({ find: () => [] })
    const o1 = await runDesktopRecipe(mk(), { path_kind: 'image' }, img.driver)
    expect(o1.outcome).toBe('ok')
    expect(o1.unverified).toEqual(['image-no-caption'])
    expect(o1.skipped).toEqual(['带判据的那一路 ← 图片没有文字判据'])

    const file = fakeDriver({ find: () => [] })
    const o2 = await runDesktopRecipe(mk(), { path_kind: 'file' }, file.driver)
    expect(o2.outcome).toBe('drift')   // 走了带判据的那一路，判据没兑现
    expect(o2.unverified).toBeUndefined()
  })
})
