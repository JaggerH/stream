import { describe, it, expect, vi } from 'vitest'
import { runActionRecipe, type ActionRecipeDeps } from './action-recipe.ts'
import type { CanonicalBrowserRecipe, Recipe } from '../replay/recipe.ts'
import type { RecipeRunOutcome } from '../replay/recipe-runner.ts'
import type { DesktopRecipe } from '../replay/desktop-recipe.ts'
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { SeeResolver } from '../replay/desktop-see.ts'
import { HostRelayDisconnected, HostAbortedByUser } from '../http/host-relay.ts'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一条最小的动作 recipe（kind:'desktop'，meta.action:true），只测 action-recipe.ts 自己的
 *  判据 —— steps/observer 的细节不重要，因为执行本身经 `runDesktop` 注入点绕过了真实 runner。 */
function actionRecipe(overrides: Partial<DesktopRecipe['meta']> = {}): DesktopRecipe {
  return {
    version: 1,
    kind: 'desktop',
    sourceId: 'qq-send',
    app: { process: 'QQ.exe' },
    steps: [],
    observer: { itemQuery: { role: 'Text' }, fields: {}, dedupeBy: 'content' },
    read: { dedupeBy: 'content', targetCount: 1 },
    meta: {
      description: '给指定联系人发一条消息',
      action: true,
      params_schema: {
        contact: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
      ...overrides,
    },
  }
}

function makeDeps(opts: {
  recipe?: Recipe | undefined
  driver?: DesktopDriver | undefined
  runDesktop?: ActionRecipeDeps['runDesktop']
  runBrowser?: ActionRecipeDeps['runBrowser']
  browserConnected?: boolean
  makeSee?: ActionRecipeDeps['makeSee']
  recipeOverrides?: ActionRecipeDeps['recipeOverrides']
  notify?: ActionRecipeDeps['notify']
} = {}): ActionRecipeDeps & { findRecipe: ReturnType<typeof vi.fn> } {
  const findRecipe = vi.fn(() => opts.recipe)
  return {
    findRecipe,
    desktopDriver: () => opts.driver,
    runDesktop: opts.runDesktop,
    runBrowser: opts.runBrowser,
    browserConnected: () => opts.browserConnected ?? true,
    makeSee: opts.makeSee,
    recipeOverrides: opts.recipeOverrides,
    notify: opts.notify,
  }
}

/** 一个不干活的识别层：这几条用例只关心"工厂有没有被递到 runner 手上"，梯子本身有它自己的测试。 */
const NOOP_SEE: SeeResolver = {
  resolve: async () => null,
  matches: async () => [],
  invalidate() {},
  modelCalls: 0,
  localInterrupts: () => [],
}

/** 一条最小的**浏览器**动作 recipe（`isCanonicalBrowserRecipe` 认的形状：steps + observers +
 *  output 三格齐）。执行经 `runBrowser` 注入点绕过真实 executor，这里只测分支判据。 */
function browserAction(): CanonicalBrowserRecipe {
  return {
    version: 1,
    kind: 'browser',
    sourceId: 'dfcf-login',
    entryUrl: 'https://jywg.eastmoneysec.com/Login',
    session: { facility: 'dfcf', lifecycle: 'one-shot', visibility: 'unattended' },
    steps: [],
    observers: [],
    output: { items: [] },
    meta: { description: '登录东方财富网上交易', action: true, params_schema: {} },
  } as unknown as CanonicalBrowserRecipe
}

const OUT = (outcome: RecipeRunOutcome['outcome'], extra: Partial<RecipeRunOutcome> = {}): RecipeRunOutcome =>
  ({ outcome, items: [], trace: [], ...extra })

const FAKE_DRIVER = {} as DesktopDriver

describe('run_action_recipe —— 找不到 / 不是动作 / 参数不合法，三档拒绝分得开', () => {
  it('sourceId 查无此 recipe → not-found，且不执行任何东西', async () => {
    const deps = makeDeps({ recipe: undefined })
    const r = await runActionRecipe(deps, { sourceId: 'ghost', params: {} })
    expect(r.status).toBe('not-found')
    expect(r.reason).toBeTruthy()
  })

  it('recipe 存在但 meta.action 不是 true → not-action，不当成"该跑"处理', async () => {
    // 采集类 recipe 的常见形状：没有 action 字段（或显式 false）。
    const harvestRecipe = actionRecipe({ action: undefined })
    const deps = makeDeps({ recipe: harvestRecipe })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: {}, confirmed: true })
    expect(r.status).toBe('not-action')
    expect(r.reason).toContain('meta.action')
  })

  it('参数不合 recipe 自己的 params_schema → invalid-params，理由点名缺的字段', async () => {
    const deps = makeDeps({ recipe: actionRecipe() })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: '我的手机' } })
    expect(r.status).toBe('invalid-params')
    expect(r.reason).toContain('message')
  })

  // Minor 2: 未在 params_schema 里声明的键必须被拒，不能静默透传——桌面执行路线最终把每个
  // 参数值 String() 打进键盘，一个没声明过的键混进来，值会原样进输入框。
  it('params 里带了 params_schema 没声明过的键 → invalid-params，不静默透传', async () => {
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER })
    const r = await runActionRecipe(deps, {
      sourceId: 'qq-send',
      params: { contact: 'X', message: 'hi', evil: { toString: () => 'x' } },
      confirmed: true,
    })
    expect(r.status).toBe('invalid-params')
    expect(r.reason).toContain('evil')
  })
})

describe('run_action_recipe —— 二次确认闸', () => {
  it('不带 confirmed → needs-confirmation，回执里说清会做什么，且没有执行（runDesktop 未被调）', async () => {
    const runDesktop = vi.fn()
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' } })

    expect(r.status).toBe('needs-confirmation')
    expect(r.sourceId).toBe('qq-send')
    expect(r.description).toBe('给指定联系人发一条消息')
    expect(r.params).toEqual({ contact: 'X', message: 'hi' })
    expect(runDesktop).not.toHaveBeenCalled()
    // I3: 回执要点名会抢哪个应用、以及会抢屏+模拟键盘输入这件事——业务描述之外的物理副作用，
    // 用户批准前需要知道（正在共享屏幕开会时答案是"现在不行"）。
    expect(r.targetApp).toBe('QQ.exe')
    expect(r.screenTakeover).toMatch(/前台|键盘/)
  })

  it('confirmed:false（显式）与"不带 confirmed"同样被闸住——不是只有"缺席"才拦', async () => {
    // 这条不是变异验证（它不改产品代码，也不证明"删掉这道闸测试会变红"——那需要真的去改
    // 源码再改回来，见任务交付里的变异验证记录）。它测的是一个和上一条不同的具体输入：
    // 上一条测试完全不传 `confirmed`；这条显式传 `confirmed:false`，钉住这道闸对两种输入
    // 一视同仁，不会有人以为"只要传了 confirmed 字段（哪怕是 false）就算表态"。
    const runDesktop = vi.fn()
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: false })
    expect(r.status).not.toBe('done')
    expect(runDesktop).toHaveBeenCalledTimes(0)
  })

  it('带 confirmed:true → 真的执行（runDesktop 被调用一次）', async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'ok' as const, items: [{ content: 'hi' }], driftReason: null }))
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })

    expect(r.status).toBe('done')
    expect(r.items).toEqual([{ content: 'hi' }])
    expect(runDesktop).toHaveBeenCalledTimes(1)
  })

  it('params_schema 里带 default 的可选参数：调用方没给就补默认值，给了就用调用方的', async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'ok' as const, items: [], driftReason: null }))
    const recipe = actionRecipe({
      params_schema: {
        contact: { type: 'string', required: true },
        message: { type: 'string', required: true },
        search_x: { type: 'string', required: false, default: '181' },
        search_y: { type: 'string', required: false, default: '56' },
      },
    })
    const deps = makeDeps({ recipe, driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi', search_y: '70' }, confirmed: true })
    const passed = (runDesktop.mock.calls[0] as unknown[])[1] as Record<string, string>
    expect(passed).toEqual({ contact: 'X', message: 'hi', search_x: '181', search_y: '70' })
  })

  it('done 回执带上被 branch 跳过的步骤——wechat-send 的 send:false 靠它说出"打进去了、没发"', async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'ok' as const, items: [], driftReason: null, skipped: ['回车发出去 ← 不发就停在这（send:false）'] }))
    const recipe = actionRecipe({ params_schema: { contact: { type: 'string', required: true }, message: { type: 'string', required: true }, send: { type: 'boolean', default: true } } })
    const deps = makeDeps({ recipe, driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi', send: false }, confirmed: true })
    expect(r.status).toBe('done')
    expect(r.skipped).toEqual(['回车发出去 ← 不发就停在这（send:false）'])
    // 布尔进 runner 时是字符串——参数分支按 String(equals) 比的前提
    expect((runDesktop.mock.calls[0] as unknown[])[1]).toEqual({ contact: 'X', message: 'hi', send: 'false' })
  })

  it("format:'path' 的参数：翻成 Windows 侧的路径、派生 <k>_name；文件不存在 → invalid-params，一步都不跑", async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'ok' as const, items: [], driftReason: null }))
    const recipe = actionRecipe({ params_schema: { contact: { type: 'string', required: true }, message: { type: 'string', required: true }, path: { type: 'string', required: true, format: 'path' } } })
    const paramEnv = { wsl: true, exists: (p: string) => p === '/home/j/a.txt', translateToWindowsPath: (p: string) => `\\\\wsl.localhost\\U${p.replace(/\//g, '\\')}` }
    const deps = makeDeps({ recipe, driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const ok = await runActionRecipe({ ...deps, paramEnv }, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi', path: '/home/j/a.txt' }, confirmed: true })
    expect(ok.status).toBe('done')
    expect((runDesktop.mock.calls[0] as unknown[])[1]).toEqual({
      contact: 'X', message: 'hi', path: '\\\\wsl.localhost\\U\\home\\j\\a.txt',
      path_name: 'a.txt', path_stem: 'a', path_stem6: 'a', path_ext: 'txt', path_kind: 'file',
    })
    const bad = await runActionRecipe({ ...deps, paramEnv }, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi', path: '/home/j/none.txt' }, confirmed: true })
    expect(bad.status).toBe('invalid-params')
    expect(bad.reason).toContain('不存在')
    expect(runDesktop).toHaveBeenCalledTimes(1)
  })
})

describe('run_action_recipe —— 执行路线上的分支', () => {
  it('没有 Stream Desktop 连着 → no-desktop，和「找不到」「不是动作」是不同的 reason', async () => {
    const deps = makeDeps({ recipe: actionRecipe(), driver: undefined })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(r.status).toBe('no-desktop')
    expect(r.reason).toContain('Stream Desktop')
  })

  // Minor 1: unsupported-kind / no-desktop 这两档纯读判断前置到确认闸之前——不带 confirmed
  // 也要能拿到同样的结论，不该让用户先批准一次、第二次调用（带 confirmed:true）才被告知
  // 这个动作注定跑不起来。
  it('没有 Stream Desktop 连着，即使不带 confirmed 也直接报 no-desktop（不会先回 needs-confirmation）', async () => {
    const deps = makeDeps({ recipe: actionRecipe(), driver: undefined })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' } })
    expect(r.status).toBe('no-desktop')
  })

  it('非 desktop kind，即使不带 confirmed 也直接报 unsupported-kind（不会先回 needs-confirmation）', async () => {
    const httpAction: Recipe = {
      version: 1,
      kind: 'http',
      sourceId: 'some-http-action',
      request: { url: 'https://x/', method: 'GET' },
      pagination: { mode: 'increment', itemsAt: 'items', maxPages: 1 },
      assert: [],
      mapping: {},
      meta: { action: true, params_schema: {} },
    } as unknown as Recipe
    const deps = makeDeps({ recipe: httpAction, driver: FAKE_DRIVER })
    const r = await runActionRecipe(deps, { sourceId: 'some-http-action', params: {} })
    expect(r.status).toBe('unsupported-kind')
  })

  it('agent 执行中途掉线（HostRelayDisconnected）→ 同样报 no-desktop，不是原始异常直接炸出去', async () => {
    const runDesktop = vi.fn(async () => { throw new HostRelayDisconnected() })
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(r.status).toBe('no-desktop')
  })

  it('用户按热键中止 → blocked 且理由说清"别重试"，不报成 no-desktop（agent 是健康的）', async () => {
    const runDesktop = vi.fn(async () => { throw new HostAbortedByUser('user-hotkey') })
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(r.status).toBe('blocked')
    expect(r.reason).toContain('中止')
    expect(runDesktop).toHaveBeenCalledTimes(1)
  })

  it('needsLogin → needs-login', async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'needsLogin' as const, items: [], driftReason: null }))
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(r.status).toBe('needs-login')
  })

  it('drift（没读到送达确认）→ blocked，带上 driftReason', async () => {
    const runDesktop = vi.fn(async () => ({ outcome: 'drift' as const, items: [], driftReason: '没读到发出去的那条消息' }))
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    const r = await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(r.status).toBe('blocked')
    expect(r.reason).toBe('没读到发出去的那条消息')
  })

  it('desktop / browser 之外的 kind → unsupported-kind', async () => {
    const httpAction: Recipe = {
      version: 1,
      kind: 'http',
      sourceId: 'some-http-action',
      request: { url: 'https://x/', method: 'GET' },
      pagination: { mode: 'increment', itemsAt: 'items', maxPages: 1 },
      assert: [],
      mapping: {},
      meta: { action: true, params_schema: {} },
    } as unknown as Recipe
    const deps = makeDeps({ recipe: httpAction, driver: FAKE_DRIVER })
    const r = await runActionRecipe(deps, { sourceId: 'some-http-action', params: {}, confirmed: true })
    expect(r.status).toBe('unsupported-kind')
  })

  // 接线的唯一判据：**runner 手上有没有那个工厂**。宿主装配了识别层却没递到这一跳，症状是
  // 一条用了 `see` 的动作 recipe 报 drift 说"没配识别层"——而后端明明配了，查起来会一路查错方向。
  it('装配了 makeSee → runner 拿到的 opts.see 是一个函数（一趟一个实例，所以是工厂不是实例）', async () => {
    const seen: unknown[] = []
    const runDesktop = vi.fn(async (_r: unknown, _p: unknown, _d: unknown, opts?: { see?: unknown }) => {
      seen.push(opts?.see)
      return { outcome: 'ok' as const, items: [], driftReason: null }
    })
    const deps = makeDeps({
      recipe: actionRecipe(),
      driver: FAKE_DRIVER,
      runDesktop: runDesktop as never,
      makeSee: () => NOOP_SEE,
    })
    await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(typeof seen[0]).toBe('function')
  })

  // 反例：没装配就必须**是 undefined 而不是一个返回空的函数**——runner 据此报"宿主没接识别层"，
  // 那句话和"界面变了"是两个完全不同的下一步。
  it('没装配 makeSee → opts.see 缺席，不伪造一个空实现', async () => {
    const seen: unknown[] = []
    const runDesktop = vi.fn(async (_r: unknown, _p: unknown, _d: unknown, opts?: { see?: unknown }) => {
      seen.push(opts?.see)
      return { outcome: 'ok' as const, items: [], driftReason: null }
    })
    const deps = makeDeps({ recipe: actionRecipe(), driver: FAKE_DRIVER, runDesktop: runDesktop as never })
    await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(seen[0]).toBeUndefined()
  })

  // 本机学到的落地方式必须**原样**递到 runner：不是复制一份、不是包一层。runner 在每一步开头
  // 读它（`groundingsFor`）、整趟 done 后写它（`recordRun`），两侧对的都得是同一个存储实例——
  // 否则 run_action_recipe 这条路学到的东西写进了一个没人读的对象，而每一步照样"成功"。
  it('桌面档把 recipeOverrides 递给 runner', async () => {
    const seen: unknown[] = []
    const runDesktop = vi.fn(async (_r: unknown, _p: unknown, _d: unknown, opts?: { overrides?: unknown }) => {
      seen.push(opts?.overrides)
      return { outcome: 'ok' as const, items: [], driftReason: null }
    })
    const recipeOverrides = { groundingsFor: () => [], recordRun: () => {} }
    const deps = makeDeps({
      recipe: actionRecipe(),
      driver: FAKE_DRIVER,
      runDesktop: runDesktop as never,
      recipeOverrides,
    })
    await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(seen[0]).toBe(recipeOverrides)
  })

  // 工厂必须绑在**这条 recipe 自己的 sourceId** 上：识别层的模板缓存按 sourceId 分目录，绑错了
  // 就是两条 recipe 共用一份模板缓存——每一步都"命中"，只是点在别的应用的坐标上。
  it('工厂绑的是这条 recipe 的 sourceId', async () => {
    const bound: string[] = []
    const runDesktop = vi.fn(async (_r: unknown, _p: unknown, d: unknown, opts?: { see?: (d: unknown) => SeeResolver }) => {
      opts?.see?.(d)
      return { outcome: 'ok' as const, items: [], driftReason: null }
    })
    const deps = makeDeps({
      recipe: actionRecipe(),
      driver: FAKE_DRIVER,
      runDesktop: runDesktop as never,
      makeSee: (_driver, sourceId) => { bound.push(sourceId); return NOOP_SEE },
    })
    await runActionRecipe(deps, { sourceId: 'qq-send', params: { contact: 'X', message: 'hi' }, confirmed: true })
    expect(bound).toEqual(['qq-send'])
  })
})

describe('run_action_recipe —— 浏览器档', () => {
  it('确认回执给的是 targetSite（不是桌面那两格）——浏览器动作不抢屏幕，但用的是用户真实登录态', async () => {
    const runBrowser = vi.fn()
    const deps = makeDeps({ recipe: browserAction(), runBrowser })
    const r = await runActionRecipe(deps, { sourceId: 'dfcf-login', params: {} })
    expect(r.status).toBe('needs-confirmation')
    expect(r.targetSite).toContain('dfcf')
    expect(r.targetSite).toContain('jywg.eastmoneysec.com')
    expect(r.screenTakeover).toBeUndefined()
    expect(r.targetApp).toBeUndefined()
    // 确认闸之前一步都不执行——这是整条闸门的意义。
    expect(runBrowser).not.toHaveBeenCalled()
  })

  // 内置包的 recipe 在装载期被加了命名空间前缀，recipe 体里写的却是局部名。回执必须回**调用方
  // 给的那个 id**——否则用户照回执抄一遍带上 confirmed:true，会得到 not-found，而第一次明明成功。
  it('回执里的 sourceId 是调用方给的那个（带命名空间），不是 recipe 体里的局部名', async () => {
    const deps = makeDeps({ recipe: browserAction(), runBrowser: vi.fn() })
    const r = await runActionRecipe(deps, { sourceId: '@streamapp/dfcf/dfcf-login', params: {} })
    expect(r.status).toBe('needs-confirmation')
    expect(r.sourceId).toBe('@streamapp/dfcf/dfcf-login')
  })

  it('confirmed:true → 走 runBrowser（= 采集那同一个 executor），成功回 done', async () => {
    const runBrowser = vi.fn(async () => OUT('ok', { items: [{ 委托号: 1481285 }] }))
    const deps = makeDeps({ recipe: browserAction(), runBrowser: runBrowser as never })
    const r = await runActionRecipe(deps, { sourceId: 'dfcf-login', params: {}, confirmed: true })
    expect(r.status).toBe('done')
    // MappedItem 的值是 unknown，回执逐值 String()——否则数字会以 unknown 漏进对外形状。
    expect(r.items).toEqual([{ 委托号: '1481285' }])
    expect(runBrowser).toHaveBeenCalledOnce()
  })

  it('output.files：base64 落盘、回执里换成路径；没装配 artifactsDir 则整条报错，不退回把 base64 留在结果里', async () => {
    const recipe = browserAction()
    recipe.output = { ...recipe.output, mapping: { guid: 'guid', format: 'format', file: 'data' }, files: { file: { extFrom: 'format' } } }
    const png = Buffer.from('\x89PNG fake')
    const runBrowser = vi.fn(async () => OUT('ok', { items: [{ guid: 'r1', format: 'png', file: png.toString('base64') }] }))
    const artifactsDir = mkdtempSync(join(tmpdir(), 'action-recipe-artifacts-'))
    const r = await runActionRecipe(
      { ...makeDeps({ recipe, runBrowser: runBrowser as never }), artifactsDir },
      { sourceId: 'dfcf-login', params: {}, confirmed: true },
    )
    expect(r.status).toBe('done')
    const file = r.items![0].file
    expect(file.startsWith(artifactsDir)).toBe(true)
    expect(file.endsWith('.png')).toBe(true)
    expect(readFileSync(file)).toEqual(png)
    expect(JSON.stringify(r)).not.toContain(png.toString('base64'))

    await expect(
      runActionRecipe(makeDeps({ recipe, runBrowser: runBrowser as never }), { sourceId: 'dfcf-login', params: {}, confirmed: true }),
    ).rejects.toThrow(/artifactsDir/)
  })

  it('没装配 runBrowser / 扩展没连 → no-browser，且一步都没跑', async () => {
    const noSurface = await runActionRecipe(makeDeps({ recipe: browserAction() }), {
      sourceId: 'dfcf-login', params: {}, confirmed: true,
    })
    expect(noSurface.status).toBe('no-browser')

    const runBrowser = vi.fn()
    const offline = await runActionRecipe(
      makeDeps({ recipe: browserAction(), runBrowser, browserConnected: false }),
      { sourceId: 'dfcf-login', params: {}, confirmed: true },
    )
    expect(offline.status).toBe('no-browser')
    expect(runBrowser).not.toHaveBeenCalled()
  })

  // 这一条是要害：`unavailable` 是"浏览器没就绪、recipe 一步都没跑"，`blocked` 是"站点拦了
  // 我们"。合并成一档，用户关一晚电脑就会被报成"被站点拦了"，下一步完全相反。
  it('unavailable 报 no-browser，challenged/drift 才报 blocked', async () => {
    const run = async (o: RecipeRunOutcome['outcome']) =>
      (await runActionRecipe(
        makeDeps({ recipe: browserAction(), runBrowser: (async () => OUT(o)) as never }),
        { sourceId: 'dfcf-login', params: {}, confirmed: true },
      )).status

    expect(await run('unavailable')).toBe('no-browser')
    expect(await run('challenged')).toBe('blocked')
    expect(await run('drift')).toBe('blocked')
    expect(await run('blocked')).toBe('blocked')
    expect(await run('cancelled')).toBe('blocked')
    expect(await run('needsLogin')).toBe('needs-login')
  })

  it('challenged / needsLogin 各发一条通知（要人来拖滑块 / 登录），其它结局不出声', async () => {
    const run = async (o: RecipeRunOutcome['outcome']) => {
      const sent: Array<{ type: string; dedupeKey?: string }> = []
      await runActionRecipe(
        makeDeps({ recipe: browserAction(), runBrowser: (async () => OUT(o)) as never, notify: (e) => sent.push(e) }),
        { sourceId: 'dfcf-login', params: {}, confirmed: true },
      )
      return sent
    }
    expect((await run('challenged')).map((e) => e.type)).toEqual(['action.challenged'])
    expect((await run('needsLogin')).map((e) => e.type)).toEqual(['auth.needed'])
    // 同一站点连着撞，dedupeKey 按 facility，不按动作
    expect((await run('challenged'))[0].dedupeKey).toBe('action.challenged:dfcf')
    expect(await run('ok')).toEqual([])
    expect(await run('drift')).toEqual([])
    expect(await run('unavailable')).toEqual([])
  })
})
