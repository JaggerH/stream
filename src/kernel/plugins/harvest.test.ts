import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import { harvestPlugin } from './harvest.ts'
import { RecipeSessionManager } from '../../replay/session-manager.ts'
import * as DesktopDriver from '../../replay/desktop-driver.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { LlmForTask } from '../../llm/task.ts'
import type { ElementsRead, WindowCapture } from '../../replay/desktop-driver.ts'

async function mount(opts: {
  llmForTask?: LlmForTask
  /** 在挂载之前往内置包目录里写点东西（装载是挂载期一次性做的，写晚了就赶不上）。 */
  seed?: (packagesDir: string) => void
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stream-harvest-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  opts.seed?.(packagesDir)

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir, dataDir, manageContainers: false, log: () => {},
    catalogSummary: (id) => ({ id } as unknown as PluginSummary),
  })
  await kernel.plugin(sourcesPlugin, {
    builtinDir: packagesDir, dataDir, rsshubCatalog: join(root, 'none.json'), log: () => {},
  })
  // 拿在手里的**同一个** config 对象：下面那条"每次现取"的测试要在挂载之后改它的字段。
  const harvestConfig = {
    dataDir,
    log: () => {},
    ...(opts.llmForTask && { llmForTask: opts.llmForTask }),
  }
  await kernel.plugin(harvestPlugin, harvestConfig)
  return { kernel, dataDir, packagesDir, harvestConfig }
}

describe('harvestPlugin', () => {
  it('挂成 ctx.harvest：运输面一整套都在，dispose 后消失', async () => {
    const { kernel } = await mount()
    const h = kernel.harvest
    for (const key of [
      'extRelay', 'hostRelay', 'browserCapability', 'harvestBrowser', 'extLauncher', 'desktopDriver', 'makeSee',
      'transport', 'recipeSessions', 'feedLedger', 'sessionRecipes', 'ensureHarvestBrowser',
      'pageLook', 'pageShot', 'pageAct', 'closeFacilityTabs', 'reapIdleLanes', 'claimedTabs',
      'focusLoginTab',
    ] as const) {
      expect(h[key], key).toBeDefined()
    }
    // 本域注册的配置 row（spec config-rows-slice1）：harvest-browser 的 exe + validate 钩子。
    expect(kernel.settings.rows.has('harvest-browser')).toBe(true)
    await quiesceKernel(kernel)
    expect(kernel.harvest).toBeUndefined()
  })

  /**
   * locate 步的坐标系：`sessionRecipes` 拿到的 `orderedFor` 必须绑在**这个域自己那份** `feedLedger` 上
   * （记账在 adapters 域的 `sessionFetch`，同一本账的另一端）。绑到别的实例、或干脆没接，症状都是
   * locate 每趟 MISS 落 fallback-nav，没有任何一处会喊。执行器把它存成私有字段，这里直接读它。
   */
  it('sessionRecipes 的 orderedFor 读的就是 ctx.harvest.feedLedger', async () => {
    const { kernel } = await mount()
    const h = kernel.harvest
    h.feedLedger.record('xhs', ['n1', 'n2'])
    const orderedFor = (h.sessionRecipes as unknown as { orderedFor?: (f: string) => string[] }).orderedFor
    expect(typeof orderedFor).toBe('function')
    expect(orderedFor!('xhs')).toEqual(['n1', 'n2'])
    expect(orderedFor!('nobody')).toEqual([])
    await quiesceKernel(kernel)
  })

  // 句柄清欠：关停时把采集开出来的标签还给用户。这是**用户看得见的行为**，过去是 bootstrap
  // shutdown() 里的一行手写代码；搬成 effect 之后必须还在，否则用户的 Chrome 里会留下一堆
  // 没人认领的标签，而且没有任何一处会喊。
  it('dispose 时归还采集标签（recipeSessions.closeAll 被调用）', async () => {
    const closeAll = vi.spyOn(RecipeSessionManager.prototype, 'closeAll').mockResolvedValue(undefined)
    const { kernel } = await mount()
    expect(closeAll).not.toHaveBeenCalled()
    await quiesceKernel(kernel)
    expect(closeAll).toHaveBeenCalledTimes(1)
    closeAll.mockRestore()
  })

  /**
   * 接缝 3'：`makeSee` 的 model 段打给谁，**每次调用现取**。
   *
   * LLM 网关（`ctx.llm`）比本域晚建，写成
   * `inject: ['llm']` 是个环（链条见 `HarvestConfig.llmForTask` 的头注），所以走 config 里的
   * thunk。但 thunk 只解决了"装配期不能解"，**没解决"建实例时也不能把它捞走存着"**——
   * `makeSee` 里若把 `config.llmForTask` 捞出来存进 deps，"打给谁"就冻在建实例那一刻，
   * 而 model 段可能几分钟后才第一次跑到。
   *
   * 这条钉的正是那一步：域挂完之后再换掉 thunk 的目标，模型段必须打给**换上去的那个**。
   */
  it('makeSee 的 model 段每次现取 llmForTask：域挂完之后换掉目标，打给换上去的那个', async () => {
    const calls: string[] = []
    const { kernel, dataDir, harvestConfig } = await mount({
      llmForTask: async () => { calls.push('装配期那份'); return { content: '1', raw: {} } as never },
    })
    const white = await sharp({ create: { width: 300, height: 150, channels: 3, background: '#fff' } }).jpeg().toBuffer()
    const win = { x: 100, y: 50, w: 300, h: 150 }
    // 一个走得到 model 段的最小驱动：a11y 无命中、screen 有框但 icon 对不上、模板缓存是空的。
    const driver = {
      async find() { return { elements: [] } },
      async readElements(): Promise<ElementsRead> {
        return { elements: [{ name: 'T1', rect: { x: 0, y: 0, w: 20, h: 10 }, kind: 'text' }], window: win, scale: 2 }
      },
      async findImage() { return null },
      async captureWindow(): Promise<WindowCapture> { return { jpeg: white, window: win, scale: 2 } },
    } as unknown as DesktopDriver.DesktopDriver

    const see = kernel.harvest.makeSee(driver, 'x')
    // **换在 `makeSee` 之后、`resolve` 之前**——这是这条测试有没有牙的全部。换在 `makeSee`
    // 之前的话，一个在建实例那一刻就把 `config.llmForTask` 捞走存起来的实现照样能通过
    // （它捞走的正是换上去的那份），而那正是这条测试要拦的写法。
    // 换掉 config 上那一格本身，不是换某个闭包变量：那样装配期把函数捞走的写法也能跟上。
    // 答 1 号框（而不是 0 = "没有一个是它"）：这一趟要走完整条 model 段，模板才会落进缓存目录。
    harvestConfig.llmForTask = async () => { calls.push('后换上的那份'); return { content: '1', raw: {} } as never }
    await see.resolve({ icon: '右下角那个' }, { allowModel: true, mode: 'action' })
    expect(calls).toEqual(['后换上的那份'])
    // 顺带钉住缓存目录：模板按 sourceId 分目录，落在 `<dataDir>/desktop-see/`。
    expect(existsSync(join(dataDir, 'desktop-see'))).toBe(true)
    await quiesceKernel(kernel)
  })

  // 接缝 4：desktopDriver 按 `hostRelay.connected` **现判**，不是启动那一刻的快照。
  // 快照化的症状是：agent 后来连上了，桌面这一档却一直报「不可用」。
  it('desktopDriver 每次现判 hostRelay.connected', async () => {
    const { kernel } = await mount()
    const h = kernel.harvest
    expect(h.desktopDriver()).toBeUndefined()
    Object.defineProperty(h.hostRelay, 'connected', { get: () => true, configurable: true })
    expect(h.desktopDriver()).toBeDefined()
    await quiesceKernel(kernel)
  })

  // 接缝 2：限速表经 `ctx.sources` 的 holder，**调用时**才解 `.current`。装配期解开 = 冻结在
  // 启动那一刻，新装的 recipe 包限速永远读不到，而且不报错。这里钉的是装配期零解引用。
  it('装配期不去解 sources 的归并快照', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-harvest-rl-'))
    const packagesDir = join(root, 'packages')
    const dataDir = join(root, 'data')
    mkdirSync(packagesDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
    await kernel.plugin(packagesPlugin, {
      packagesDir, dataDir, manageContainers: false, log: () => {},
      catalogSummary: (id) => ({ id } as unknown as PluginSummary),
    })
    await kernel.plugin(sourcesPlugin, {
      builtinDir: packagesDir, dataDir, rsshubCatalog: join(root, 'none.json'), log: () => {},
    })
    const inner = kernel.sources.recipePackages
    let calls = 0
    kernel.sources.recipePackages = () => { calls++; return inner() }
    await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
    expect(calls).toBe(0)
    await quiesceKernel(kernel)
  })

  // 确保 ensureHarvestBrowser 的 ensureApp 调用使用短的排队等待上界（不是默认的 180s）——
  // best-effort 的浏览器唤起不该被无关 recipe 的会话租约卡住。采集轮次有 deadline，
  // 上游不该因为排队超时而整轮挂掉。
  it('ensureApp 用短等待上界（20s），不是默认的 180s', async () => {
    const { kernel } = await mount()
    const h = kernel.harvest
    const capturedWaitMs: number[] = []
    // 替换 withSession 以拦截 waitMs 参数
    h.hostRelay.withSession = vi.fn(async (fn, opts) => {
      capturedWaitMs.push(opts?.waitMs ?? 180_000)
      // 执行实际逻辑
      return fn()
    })
    // Mock makeDesktopDriver 返回一个 mock driver，ensureApp 返回进程未启动
    const mockDriver = {
      ensureApp: vi.fn(async () => ({ running: false, started: false })),
    }
    vi.spyOn(DesktopDriver, 'makeDesktopDriver').mockReturnValue(mockDriver as any)
    // 模拟 extRelay 未连接但 hostRelay 已连接的情况
    Object.defineProperty(h.extRelay, 'connected', { value: false, writable: true, configurable: true })
    Object.defineProperty(h.hostRelay, 'connected', { value: true, writable: true, configurable: true })
    // ensureApp 返回 running: false 会导致快速抛错
    await expect(h.ensureHarvestBrowser()).rejects.toThrow()
    // 验证至少一次 withSession 调用用的是短上界（20_000ms）
    expect(capturedWaitMs.length).toBeGreaterThan(0)
    expect(capturedWaitMs.some((ms) => ms === 20_000)).toBe(true)
    expect(capturedWaitMs.every((ms) => ms !== 180_000)).toBe(true)
    await quiesceKernel(kernel)
  })
})

/**
 * **本批的主险：`secret_params` 的两格装配（readSecret / isBuiltinRecipe）以前一格都没接。**
 *
 * 不接的表现不是报错，是一句指向错误方向的话：闸 3 抛「只有内置包的 recipe 能拿到凭据」，
 * 而真因是宿主没接线。executor 自己的单测证不了这件事（它把两格都注入了），所以守卫必须
 * 长在**真的把域挂起来**的这一层。
 */
describe('harvestPlugin —— secret_params 的宿主接线', () => {
  /** 往内置层写一个最小 recipe 包：一条声明了 secret_params 的 browser recipe。 */
  function writeBuiltinSecretRecipe(packagesDir: string): void {
    const dir = join(packagesDir, 'fakebank')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@t/fakebank', version: '1.0.0', private: true, type: 'module',
      stream: { id: 'fakebank', name: 'FakeBank' },
    }))
    writeFileSync(join(dir, 'fb-login.recipe.json'), JSON.stringify({
      version: 1,
      kind: 'browser',
      sourceId: 'fb-login',
      entryUrl: 'https://fakebank.test/login',
      loginCheck: { loggedIn: '#ok', wall: '#pw', runAtWall: true },
      session: { facility: 'fakebank', lifecycle: 'one-shot', visibility: 'unattended' },
      steps: [{ kind: 'type', selector: '#pw', text: '{pw}' }],
      // 不产内容的动作 recipe 仍必须有一个 item 来源（装载期要求），照 dfcf-login 的做法挂一个
      // 什么都取不到的 dom observer + allowEmpty。
      observers: [{
        kind: 'dom', trigger: 'final', itemSelector: 'body',
        fields: { at: { attr: 'data-nonexistent' } },
        input: { itemsAt: 'items', dedupeBy: 'at', targetCount: 1, mapping: { guid: 'at' } },
      }],
      output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'at' } },
      allowEmpty: true,
      meta: {
        description: '登录', action: true, params_schema: {},
        runtime_config: { ref: 'fakebank', fields: { pw: { type: 'secret', label: '密码' } } },
        secret_params: ['pw'],
      },
    }))
  }

  it('内置包的 recipe 认得出来——判据按对象身份，不按 sourceId（map 键带命名空间，recipe 体里是局部名）', async () => {
    const { kernel, packagesDir } = await mount({ seed: writeBuiltinSecretRecipe })
    const recipe = kernel.sources.liveRecipes.current.get('@t/fakebank/fb-login')
    expect(recipe, '内置 recipe 应该以全名进表').toBeDefined()
    // 这一行就是当初对不上的那一处：recipe 体里的 sourceId 是 'fb-login'，表里的键是全名。
    expect(recipe!.sourceId).toBe('fb-login')
    expect(kernel.sources.isBuiltinRecipe(recipe!)).toBe(true)
    // 换一个同名但不是那份对象的 recipe → 不是内置（防「用同名顶掉内置就拿到凭据」）。
    expect(kernel.sources.isBuiltinRecipe({ ...recipe! } as typeof recipe & object)).toBe(false)
    expect(packagesDir).toBeTruthy()
    await quiesceKernel(kernel)
  })

  it('宿主把两格都接上了：跑一条内置的 secret recipe，不会再被闸 3 挡下来', async () => {
    const { kernel } = await mount({ seed: writeBuiltinSecretRecipe })
    kernel.settings.setRuntimeConfig('fakebank', { pw: 's3cret' }, ['pw'])
    const recipe = kernel.sources.liveRecipes.current.get('@t/fakebank/fb-login')!

    // 这次运行注定跑不起来（测试环境没有浏览器），我们只关心**它是怎么失败的**：
    // 闸 3 在开标签之前就抛，所以「没被闸 3 挡」是一个可判、且不依赖浏览器的信号。
    let blockedByGate3 = false
    try {
      await (kernel.harvest.sessionRecipes as {
        execute: (r: unknown, p: Record<string, string>) => Promise<unknown>
      }).execute(recipe, {})
    } catch (e) {
      if (/只有内置包|宿主没有接凭据读口/.test((e as Error).message)) blockedByGate3 = true
    }
    expect(blockedByGate3, 'readSecret / isBuiltinRecipe 有一格没接上').toBe(false)
    await quiesceKernel(kernel)
  })
})
