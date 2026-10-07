import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { isPluginTargetBound } from '../../plugins/plugin-target.ts'
import type { ActivateFn } from '../../packages/activate.ts'
import type { PluginSummary } from '../../mcp/tools.ts'

/** 一个盘上的假包：只写 package.json，槽位由调用方指定。 */
function writePackage(dir: string, id: string, stream: Record<string, unknown>) {
  const pkgDir = join(dir, id)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: `@t/${id}`, version: '1.0.0', stream: { id, ...stream } }),
  )
}

const summaryOf = (id: string): PluginSummary => ({
  id, name: id, status: 'ready', enabled: true, required: false,
  launch: { mode: 'in-process' }, capabilities: [], sourceCount: 0,
} as unknown as PluginSummary)

async function mount(opts: {
  alistUrl?: string
  alistToken?: string
  /** 装载**之前**往两层目录里放东西——启动期那条路只有这一个观察窗口。 */
  seed?: (dirs: { packagesDir: string; userDir: string }) => void
  /** 收本域的日志行（同名两层挑一层激活那条是靠它钉的）。 */
  log?: (...args: unknown[]) => void
  /** 假的内置代码入口表（真表里没有测试包的入口，`activatePackages` 对此抛错不跳过）。 */
  builtinActivations?: Map<string, ActivateFn>
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stream-packages-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // alpha 填了插件槽位（normalizer）；beta 一格都不填 = 纯 recipe 包，不进 plugins 投影。
  writePackage(packagesDir, 'alpha', { name: 'Alpha', normalizer: 'alpha-norm' })
  writePackage(packagesDir, 'beta', { facility: 'beta' })
  opts.seed?.({ packagesDir, userDir: join(dataDir, 'recipes') })

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir,
    dataDir,
    // 关着：这条线一个 docker 调用都不发（测试里没有 docker，也不该有）。
    manageContainers: false,
    log: opts.log ?? (() => {}),
    alistUrl: opts.alistUrl,
    alistToken: opts.alistToken,
    catalogSummary: (id) => summaryOf(id),
    builtinActivations: opts.builtinActivations,
  })
  return { kernel, root, packagesDir, dataDir }
}

afterEach(() => vi.useRealTimers())

describe('packagesPlugin', () => {
  it('挂成 ctx.packages（顺带 ctx.backendDirectory），dispose 后都消失', async () => {
    const { kernel } = await mount()
    expect(kernel.packages.plugins).toBeDefined()
    expect(kernel.backendDirectory.all().map((p) => p.id)).toEqual(['alpha'])
    await quiesceKernel(kernel)
    expect(kernel.packages).toBeUndefined()
    expect(kernel.backendDirectory).toBeUndefined()
  })

  // 「是不是插件」按槽位判、不按目录判（`fillsPluginSlot`）：两个包住同一层，只有一个进投影。
  it('plugins 只投影填了插件槽位的包，packages 是整层扫描', async () => {
    const { kernel } = await mount()
    expect(kernel.packages.packages.map((p) => p.id).sort()).toEqual(['alpha', 'beta'])
    expect(kernel.packages.plugins.map((p) => p.id)).toEqual(['alpha'])
    await quiesceKernel(kernel)
  })

  it('setPluginEnabled 落盘 + 判据当场翻转（下一次读到的就是新值）', async () => {
    const { kernel } = await mount()
    const alpha = kernel.packages.plugins[0]!
    expect(kernel.packages.isPluginEnabled(alpha)).toBe(true)
    kernel.packages.setPluginEnabled('alpha', false)
    expect(kernel.settings.get().plugins?.alpha).toBe(false)
    expect(kernel.packages.isPluginEnabled(alpha)).toBe(false)
    await quiesceKernel(kernel)
  })

  it('不认识的 id 拒绝，不静默当成一次成功', async () => {
    const { kernel } = await mount()
    expect(() => kernel.packages.setPluginEnabled('nope', false)).toThrow(/unknown plugin/)
    await quiesceKernel(kernel)
  })

  // 用户层必须**每次现扫**：刚 install 完的包不在任何启动快照里，用快照会让用户装完看不到自己装的东西。
  it('packageInventory 的用户层现扫，装完立刻可见', async () => {
    const { kernel, dataDir } = await mount()
    expect(kernel.packages.packageInventory().map((p) => p.id).sort()).toEqual(['alpha', 'beta'])
    writePackage(join(dataDir, 'recipes'), 'gamma', { facility: 'gamma' })
    expect(kernel.packages.packageInventory().map((p) => p.id).sort()).toEqual(['alpha', 'beta', 'gamma'])
    await quiesceKernel(kernel)
  })

  // 待生效清单 = 启动快照（故意冻住）vs 盘上现扫。快照冻住是这条能力的定义，不是装配期的疏忽：
  // 它记的就是「启动那一刻装载了什么」；变的那一侧（盘）每次调用现扫，结果绝不存。
  it('pending()：启动时空；装一个代码包 → installed + needsRestart；再删掉 → 清单归零', async () => {
    const { kernel, dataDir } = await mount({
      seed: ({ userDir }) => writePackage(userDir, 'delta', { facility: 'delta' }),
    })
    // 启动时装载的和盘上的一致 → 没有待生效项（seed 进去的 delta 不算）。
    expect(kernel.packages.pending()).toEqual([])
    writePackage(join(dataDir, 'recipes'), 'gamma', { code: { entry: 'dist/index.js' } })
    const after = kernel.packages.pending()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: '@t/gamma', kind: 'installed', to: '1.0.0', needsRestart: true })
    // 快照没被上一次调用改写：删掉盘上的包，清单回到空，而不是报一条 removed。
    rmSync(join(dataDir, 'recipes', 'gamma'), { recursive: true, force: true })
    expect(kernel.packages.pending()).toEqual([])
    await quiesceKernel(kernel)
  })

  // 现扫那一侧碰到读不动的包：跳过它、不抛（这是请求路径，抛 = 三处露面一起 500）。
  it('pending()：盘上多出一个坏包 → 不抛，其余照常对账', async () => {
    const { kernel, dataDir } = await mount()
    mkdirSync(join(dataDir, 'recipes', 'rotten'), { recursive: true })
    writeFileSync(join(dataDir, 'recipes', 'rotten', 'package.json'), '{ not json')
    expect(kernel.packages.pending()).toEqual([])
    await quiesceKernel(kernel)
  })

  // plugin-target 是模块级全局：挂载时接上、dispose 时复位。不复位的话，同一进程里跑第二次
  // 装配会读到上一次的残留，而残留和「正确接线」运行时完全无法区分。
  it('plugin-target 接线随内核挂卸', async () => {
    const { kernel } = await mount()
    expect(isPluginTargetBound()).toBe(true)
    await quiesceKernel(kernel)
    expect(isPluginTargetBound()).toBe(false)
  })

  // 状态预热的 setTimeout 是本域唯一的句柄。没登记成 effect 的话，关停后它还会醒过来打一轮
  // 容器健康探测——已 unref 所以不卡进程，只是一次悬空的活动，测试里表现为泄漏的定时器。
  it('状态预热定时器随 dispose 清掉', async () => {
    vi.useFakeTimers()
    const { kernel } = await mount()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await quiesceKernel(kernel)
    expect(vi.getTimerCount()).toBe(0)
  })

  // 给 DSH 网盘插件递的必须是永久 token（netdisk spec §5.3）：插件没有 401 重登通道。
  describe('alist.permanentToken', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abcDEF123'
    afterEach(() => vi.unstubAllGlobals())

    it('手里已经是永久 token（ALIST_TOKEN / 配置给的那种）→ 原样交出，一个请求都不发', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { kernel } = await mount({ alistUrl: 'http://alist.example', alistToken: 'alist-perm-xyz' })
      await expect(kernel.packages.alist.permanentToken()).resolves.toBe('alist-perm-xyz')
      expect(fetchMock).not.toHaveBeenCalled()
      await quiesceKernel(kernel)
    })

    it('手里是 48h JWT（接管序列 login 换来的）→ 拿它去 OpenList 读永久 token 设置项', async () => {
      const urls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ code: 200, data: { key: 'token', value: 'alist-perm-from-setting' } }), { status: 200 })
      }))
      const { kernel } = await mount({ alistUrl: 'http://alist.example', alistToken: JWT })
      await expect(kernel.packages.alist.permanentToken()).resolves.toBe('alist-perm-from-setting')
      expect(urls).toEqual(['http://alist.example/api/admin/setting/get?key=token'])
      await quiesceKernel(kernel)
    })

    it('没有 token → undefined（不是空串、不抛）', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
      const { kernel } = await mount({ alistUrl: 'http://alist.example' })
      await expect(kernel.packages.alist.permanentToken()).resolves.toBeUndefined()
      await quiesceKernel(kernel)
    })
  })

  it('alist.status 读的是覆盖层的活值（token 不回显）', async () => {
    const { kernel } = await mount({ alistUrl: 'http://alist.example' })
    // 本域注册的配置 row（spec config-rows-slice2）
    expect(kernel.settings.rows.has('alist')).toBe(true)
    expect(kernel.packages.alist.status()).toEqual({ url: 'http://alist.example', hasToken: false, configured: false })
    const after = await kernel.packages.alist.set({ url: 'http://other.example', token: 'tok' })
    expect(after).toEqual({ url: 'http://other.example', hasToken: true, configured: true })
    await quiesceKernel(kernel)
  })

  // 托管模式的 token 是登录换来的，登录要容器醒着。启动那一刻容器在睡（standby 管着的容器闲置
  // 会停，而启动时只等它 2 秒）就拿不到——那之后必须还能在用到时取，不能等到下次重启：
  // 活体（2026-10-04 起三天）六条网盘来源每轮都报「缺少 token」，网盘域整块没装配。
  describe('alist 托管接管：启动时没拿到 token 也得留着取它的通道', () => {
    const seedAlist = ({ packagesDir }: { packagesDir: string }) =>
      writePackage(packagesDir, 'alist', { name: 'AList', normalizer: 'alist-norm' })

    it('网盘底座包开着、没有任何 token → 算托管，接管通道递给包', async () => {
      const { kernel } = await mount({ seed: seedAlist })
      expect(kernel.packages.alist.token).toBeUndefined()
      expect(kernel.packages.alist.managed()).toBe(true)
      expect(kernel.packages.configForPackage('alist').refresh).toBeTypeOf('function')
      await quiesceKernel(kernel)
    })

    it('外接模式（用户自己填了 token，没有托管密码）→ 不算托管，不递通道，refresh 说清', async () => {
      const { kernel } = await mount({ seed: seedAlist, alistUrl: 'http://alist.example', alistToken: 'perm' })
      expect(kernel.packages.alist.managed()).toBe(false)
      expect(kernel.packages.configForPackage('alist').refresh).toBeUndefined()
      await expect(kernel.packages.alist.refresh()).rejects.toThrow(/非托管/)
      await quiesceKernel(kernel)
    })

    it('没装网盘底座包 → 不算托管', async () => {
      const { kernel } = await mount()
      expect(kernel.packages.alist.managed()).toBe(false)
      await quiesceKernel(kernel)
    })

    it('token 读的是活值：接管把 token 存盘之后，这一格跟着变', async () => {
      const { kernel } = await mount({ seed: seedAlist })
      expect(kernel.packages.alist.token).toBeUndefined()
      kernel.settings.setAlistCredentials({ password: 'pw', token: 'fresh-jwt' })
      expect(kernel.packages.alist.token).toBe('fresh-jwt')
      await quiesceKernel(kernel)
    })
  })

  // 一个第三方包的 package.json 坏了，以前从这里抛出去 = 后端起不来，恢复手段只有让用户自己
  // 去文件系统删包（spec 2026-08-29 §8 的同一个缺陷，早了一层）。**内置那层不接**：那是随
  // 应用发布的，坏了就该掀桌。
  it('用户层第三方包读不动：跳过它、进 failures 台账，其余包照常', async () => {
    const { kernel, dataDir } = await mount({
      seed: ({ userDir }) => {
        const p = join(userDir, 'rotten')
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'package.json'), '{ this is not json')
        writePackage(userDir, 'sane', { facility: 'sane' })
      },
    })
    expect(kernel.packages.activated.failures.map((f) => f.id)).toEqual(['rotten'])
    expect(kernel.packages.activated.failures[0].dir).toBe(join(dataDir, 'recipes', 'rotten'))
    // 只掉自己那一格：同一层的另一个包照常被扫进来（它进不了 plugins 投影，但装载没塌）。
    expect(kernel.packages.plugins.map((p) => p.id)).toEqual(['alpha'])
    await quiesceKernel(kernel)
  })

  // 上面那条只修了启动。`packageInventory()` 是**每次请求现扫**的读路径：不接住的话，故障
  // 只是从「后端起不来」挪成「包页面每次请求 500」——一个包都看不见，而且那条 500 跟启动时
  // 那条「跳过了一个包」的通知对不上号，比原样更隐蔽。
  it('包目录（现扫的读路径）：读不动的包不抛，且在结果里看得见', async () => {
    const { kernel } = await mount({
      seed: ({ userDir }) => {
        const p = join(userDir, 'rotten')
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'package.json'), '{ this is not json')
        writePackage(userDir, 'sane', { facility: 'sane' })
      },
    })
    const list = kernel.packages.packageInventory()
    expect(list.map((p) => p.id).sort()).toEqual(['alpha', 'beta', 'rotten', 'sane'])
    const row = list.find((p) => p.id === 'rotten')!
    expect(row.layer).toBe('user')
    expect(row.unreadable).toMatch(/rotten\/package\.json/)
    await quiesceKernel(kernel)
  })

  it('内置层的坏包照旧掀桌（我们自己发的东西不降级成一条通知）', async () => {
    await expect(mount({
      seed: ({ packagesDir }) => {
        mkdirSync(join(packagesDir, 'busted'), { recursive: true })
        writeFileSync(join(packagesDir, 'busted', 'package.json'), '{ this is not json')
      },
    })).rejects.toThrow(/busted/)
  })

  // `ctx.readSource` 的接线走 thunk + 回填（与 `ctx.login` 同形）：scheduling 域在装配序上晚于
  // 本域，Scheduler 建好后才回填进来。观察窗口是包自己交出的 enricher——它拿的是 activate 时
  // 那个 ctx，所以能证明 ctx 读的是回填变量而不是装配期的快照。
  describe('ctx.readSource', () => {
    const seedProbePackage = ({ userDir }: { userDir: string }) => {
      const p = join(userDir, 'probe')
      mkdirSync(join(p, 'dist'), { recursive: true })
      writeFileSync(join(p, 'package.json'), JSON.stringify({
        name: '@t/probe', version: '1.0.0',
        stream: { id: 'probe', code: { entry: 'dist/index.js', enrichers: ['probe'] } },
      }))
      writeFileSync(join(p, 'dist', 'index.js'),
        'export function activate(ctx) { return { enrichers: { probe: (q) => ctx.readSource(q.id, { k: q.k }) } } } ')
    }

    it('回填前调用抛"还没接线"，不静默回空', async () => {
      const { kernel } = await mount({ seed: seedProbePackage })
      const probe = kernel.packages.activated.enrichers.get('probe')!
      await expect(probe({ id: 'probe-detail', k: 'v' })).rejects.toThrow(/还没接线/)
      await quiesceKernel(kernel)
    })

    it('回填后按本包全名转发；别家的全名被拒且实现一次都不被叫', async () => {
      const { kernel } = await mount({ seed: seedProbePackage })
      const impl = vi.fn(async () => [{ hit: true }])
      kernel.packages.setPackageReadSource(impl)
      const probe = kernel.packages.activated.enrichers.get('probe')!
      await expect(probe({ id: 'probe-detail', k: 'v' })).resolves.toEqual([{ hit: true }])
      expect(impl).toHaveBeenCalledWith('@t/probe/probe-detail', { k: 'v' }, { signal: undefined })
      await expect(probe({ id: '@t/other/x', k: 'v' })).rejects.toThrow(/只能运行自己声明的源/)
      expect(impl).toHaveBeenCalledTimes(1)
      await quiesceKernel(kernel)
    })
  })

  // 同 npm 名的带 code 包两层都在（内置 + `stream update` 装来的）→ 按版本高者只激活一层。两层
  // 都进 activatePackages 的话，同名 enricher 撞名 → 整批拒绝激活，用户升一个包等于全部带 code 的
  // 包一起不生效。判据与 recipe 归并同一把尺（shared/package-sdk/semver.ts）。
  describe('同 npm 名两层带 code：按版本高者挑一层激活', () => {
    /** 内置那份的 activate：走它就交出一个能认出来源的 enricher。 */
    const builtinActivate: ActivateFn = () => ({ enrichers: { probe: async () => ({ layer: 'builtin' }) } })
    const seedBoth = (builtinVersion: string, userVersion: string | null) =>
      ({ packagesDir, userDir }: { packagesDir: string; userDir: string }) => {
        // 内置：`packages/probe/`，npm 名 @t/probe，带 code（入口由注入的表提供，entry 字面量不被读）
        const b = join(packagesDir, 'probe')
        mkdirSync(b, { recursive: true })
        writeFileSync(join(b, 'package.json'), JSON.stringify({
          name: '@t/probe', version: builtinVersion,
          stream: { id: 'probe', code: { entry: 'dist/index.js', enrichers: ['probe'] } },
        }))
        // 用户层：`<dataDir>/recipes/@t__probe/`，同 npm 名，dist 里真有代码
        const u = join(userDir, '@t__probe')
        mkdirSync(join(u, 'dist'), { recursive: true })
        writeFileSync(join(u, 'package.json'), JSON.stringify({
          name: '@t/probe', ...(userVersion === null ? {} : { version: userVersion }),
          stream: { id: 'probe', code: { entry: 'dist/index.js', enrichers: ['probe'] } },
        }))
        writeFileSync(join(u, 'dist', 'index.js'),
          'export function activate() { return { enrichers: { probe: async () => ({ layer: "user" }) } } }')
      }
    const table = () => new Map<string, ActivateFn>([['probe', builtinActivate]])

    it('用户层严格更高 → 跑用户层的代码，内置那份跳过，日志说 supersedes', async () => {
      const logs: string[] = []
      const { kernel } = await mount({ seed: seedBoth('1.0.0', '1.2.0'), builtinActivations: table(), log: (...a) => logs.push(a.join(' ')) })
      await expect(kernel.packages.activated.enrichers.get('probe')!({})).resolves.toEqual({ layer: 'user' })
      expect(kernel.packages.activated.failures).toEqual([])
      expect(logs).toContain('[stream] package @t/probe: user layer 1.2.0 supersedes builtin 1.0.0')
      await quiesceKernel(kernel)
    })

    it('用户层更低 → 跑内置的代码，用户层跳过，日志说 kept / skipped', async () => {
      const logs: string[] = []
      const { kernel } = await mount({ seed: seedBoth('1.2.0', '1.1.9'), builtinActivations: table(), log: (...a) => logs.push(a.join(' ')) })
      await expect(kernel.packages.activated.enrichers.get('probe')!({})).resolves.toEqual({ layer: 'builtin' })
      expect(logs).toContain('[stream] package @t/probe: builtin 1.2.0 kept, user layer 1.1.9 skipped')
      await quiesceKernel(kernel)
    })

    it('版本相等 / 用户层缺版本 → 内置', async () => {
      for (const userVersion of ['1.0.0', null]) {
        const { kernel } = await mount({ seed: seedBoth('1.0.0', userVersion), builtinActivations: table() })
        await expect(kernel.packages.activated.enrichers.get('probe')!({})).resolves.toEqual({ layer: 'builtin' })
        expect(kernel.packages.activated.failures).toEqual([])
        await quiesceKernel(kernel)
      }
    })

    // 这条钉的是「不挑就会怎样」：把两层都塞进去，撞名闸门整批拒绝——正是 pickCodeLayer 存在的理由。
    it('对照：没有挑一层的话两份同名 enricher 撞名、整批拒绝激活', async () => {
      const { activatePackages } = await import('../../packages/activate.ts')
      const { scanPackages } = await import('../../packages/scan.ts')
      const root = mkdtempSync(join(tmpdir(), 'stream-packages-ctl-'))
      const packagesDir = join(root, 'packages'); const userDir = join(root, 'data', 'recipes')
      mkdirSync(packagesDir, { recursive: true }); mkdirSync(userDir, { recursive: true })
      seedBoth('1.0.0', '1.2.0')({ packagesDir, userDir })
      const builtin = scanPackages(packagesDir); const user = scanPackages(userDir, { leftovers: 'ignore' })
      expect(() => activatePackages([...builtin, ...user], { builtin: table(), dynamic: new Set(user) }, () => ({}) as never))
        .toThrow(/both declare enricher "probe"/)
    })
  })

  // 容器接管关着时这条线一个 docker 调用都不发，通知恒空——「默认不改变任何现状」的全部实现。
  it('manage_containers 关着 → 没有容器通知', async () => {
    const { kernel } = await mount()
    expect(kernel.packages.provisionNotices).toEqual([])
    await quiesceKernel(kernel)
  })
})
