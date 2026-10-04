import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import type { PluginSummary } from '../../mcp/tools.ts'

/** 一个内置 recipe 包：package.json（facility 槽位）+ 一份 recipe。 */
/** `pkgName` 单独给，是为了造出「全名撞车」那个场景：sourceId 的全名是
 *  `<npm 包名>/<局部名>`，所以两个包只有在 **npm 名也相同** 时才可能产出同一个 id。 */
function writeRecipePackage(
  dir: string,
  facility: string,
  sourceId: string,
  pkgName: string | null = `@t/${facility}`,
  version = '1.0.0',
) {
  const pkgDir = join(dir, facility)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ ...(pkgName ? { name: pkgName } : {}), version, stream: { id: facility, facility, name: facility } }),
  )
  writeFileSync(
    join(pkgDir, `${sourceId}.recipe.json`),
    JSON.stringify({
      version: 1,
      kind: 'http',
      sourceId,
      request: { url: `https://${facility}.example/feed` },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'items', maxPages: 1 },
      mapping: { guid: 'id', title: 'title' },
    }),
  )
  return pkgDir
}

/** 一个**插件**包：只有 manifests.yaml（内置层填了 sources 槽位 → 进 curated，不进 recipes 组；
 *  放进用户层则经 recipes 组进）。`pkgName` 传 null = 没有 npm 名的本地包（`local/<目录名>` 前缀）。 */
function writePluginPackage(dir: string, id: string, sourceId: string, pkgName: string | null = `@t/${id}`, version = '1.0.0') {
  const pkgDir = join(dir, id)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ ...(pkgName ? { name: pkgName } : {}), version, stream: { id, name: id } }))
  writeFileSync(join(pkgDir, 'manifests.yaml'), [
    `- id: ${sourceId}`,
    '  adapter: replay',
    '  description: curated source that a third-party package will collide with',
    '  topics: []',
    '  capabilities: [timeline]',
    '  cadence_hint_seconds: 1800',
    '  auth:',
    '    type: none',
  ].join('\n'))
}

async function mount(opts: {
  onDebug?: (e: { key: string; ok?: boolean; summary?: string }) => void
  /** 装载**之前**往两层目录里放东西——启动期那条路只有这一个观察窗口。 */
  seed?: (dirs: { builtinDir: string; userDir: string }) => void
} = {}) {
  const logs: string[] = []
  const root = mkdtempSync(join(tmpdir(), 'stream-sources-'))
  const builtinDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(builtinDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeRecipePackage(builtinDir, 'alpha', 'alpha-feed')
  opts.seed?.({ builtinDir, userDir: join(dataDir, 'recipes') })

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir: builtinDir,
    dataDir,
    manageContainers: false,
    log: () => {},
    catalogSummary: (id) => ({ id } as unknown as PluginSummary),
  })
  await kernel.plugin(sourcesPlugin, {
    builtinDir,
    dataDir,
    // 读不到目录只该降级成「只有 curated」，不该掀翻装载 —— 下面有一条专门钉它。
    rsshubCatalog: join(root, 'no-such-catalog.json'),
    log: (...args: unknown[]) => void logs.push(args.join(' ')),
    onDebug: opts.onDebug,
  })
  return { kernel, root, builtinDir, dataDir, logs }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** 轮到条件成立；超时就让断言在调用点变红（而不是在这里吞掉）。 */
async function waitFor(cond: () => boolean, timeoutMs: number) {
  const until = Date.now() + timeoutMs
  while (!cond() && Date.now() < until) await sleep(25)
  expect(cond()).toBe(true)
}

describe('sourcesPlugin', () => {
  it('注册 source row family（配置 row 引擎；重复注册硬拒证明它在场）', async () => {
    const { kernel } = await mount()
    expect(() => kernel.settings.rows.registerFamily({ prefix: 'source', resolve: () => undefined })).toThrow(/duplicate/)
    await quiesceKernel(kernel)
  })

  it('挂成 ctx.sources，registry 里能查到 recipe 包的源；dispose 后消失', async () => {
    const { kernel } = await mount()
    // registry 收裸名（第 3 级按局部名解析），**recipe 表只按全名索引**——两者各是各的契约。
    expect(kernel.sources.registry.get('alpha-feed')?.id).toBe('@t/alpha/alpha-feed')
    expect(kernel.sources.liveRecipes.current.has('@t/alpha/alpha-feed')).toBe(true)
    await quiesceKernel(kernel)
    expect(kernel.sources).toBeUndefined()
  })

  // RSSHub 目录读不到 = 长尾没有，不是启动失败。
  it('RSSHub 目录读不到只降级，不掀翻装载', async () => {
    const { kernel } = await mount()
    expect(kernel.sources.registry.all().length).toBeGreaterThan(0)
    await quiesceKernel(kernel)
  })

  // install/uninstall 走的是**同步立即重挂**那条路，不等 watcher：首跑时 userDir 还不存在，
  // watcher 根本没挂上，这条同步路径是「装完立刻可见」的唯一保证。
  it('reloadRecipePackages 同步生效：新包不等 watcher 就进 registry', async () => {
    const { kernel, dataDir } = await mount()
    expect(kernel.sources.registry.get('beta-feed')).toBeUndefined()
    writeRecipePackage(join(dataDir, 'recipes'), 'beta', 'beta-feed')
    kernel.sources.reloadRecipePackages()
    expect(kernel.sources.registry.get('beta-feed')?.id).toBe('@t/beta/beta-feed')
    expect(kernel.sources.liveRecipes.current.has('@t/beta/beta-feed')).toBe(true)
    await quiesceKernel(kernel)
  })

  // holder 语义：消费者持的是 `liveRecipes` 这个对象本身，重载换的是它里面那张 Map。
  // 把 `.current` 在装配期解开 = 冻结在启动那一刻，改 recipe 永远不生效。
  it('liveRecipes 是 holder：重载换里面那张表，对象本身不换', async () => {
    const { kernel, dataDir } = await mount()
    const holder = kernel.sources.liveRecipes
    const before = holder.current
    writeRecipePackage(join(dataDir, 'recipes'), 'beta', 'beta-feed')
    kernel.sources.reloadRecipePackages()
    expect(kernel.sources.liveRecipes).toBe(holder)
    expect(holder.current).not.toBe(before)
    await quiesceKernel(kernel)
  })

  // 同理，归并快照是「每次现取」：install 后新包的 rateLimit 活体就该读得到。
  it('recipePackages() 每次现取，不是启动快照', async () => {
    const { kernel, dataDir } = await mount()
    expect([...kernel.sources.recipePackages().byFacility.keys()]).toEqual(['alpha'])
    writeRecipePackage(join(dataDir, 'recipes'), 'beta', 'beta-feed')
    kernel.sources.reloadRecipePackages()
    expect([...kernel.sources.recipePackages().byFacility.keys()].sort()).toEqual(['alpha', 'beta'])
    await quiesceKernel(kernel)
  })

  // 坏包只该 log 并保留上一份装载 —— 热重载失败不能把已经跑着的目录清空。
  it('重载失败保留上一份装载，不抛', async () => {
    const { kernel, dataDir } = await mount()
    const userDir = join(dataDir, 'recipes', 'broken')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'package.json'), '{ this is not json')
    expect(() => kernel.sources.reloadRecipePackages()).not.toThrow()
    expect(kernel.sources.registry.get('alpha-feed')).toBeDefined()
    await quiesceKernel(kernel)
  })

  // 启动这条路以前是裸的 swapGroup：一个坏包 = 后端起不来，而用户唯一的恢复手段是自己去
  // 文件系统删包（spec 2026-08-29 §8）。热重载那条早就接得住，两条路不对称正是缺陷本身。
  describe('启动期坏包只掉自己那一格', () => {
    it('recipe JSON 坏了：照常起来，其余源全在，坏包被点名（日志 + debug bus + mountFailures）', async () => {
      const seen: { key: string; ok?: boolean; summary?: string }[] = []
      const { kernel, dataDir } = await mount({
        onDebug: (e) => void seen.push(e),
        seed: ({ userDir }) => {
          const p = join(userDir, 'rotten')
          mkdirSync(p, { recursive: true })
          writeFileSync(join(p, 'package.json'), JSON.stringify({ name: '@t/rotten', version: '1.0.0', stream: { id: 'rotten', facility: 'rotten' } }))
          writeFileSync(join(p, 'rotten-feed.recipe.json'), '{ "version": 1, "kind": "http"')   // 少一个括号
        },
      })
      expect(kernel.sources.registry.get('alpha-feed')).toBeDefined()
      expect(kernel.sources.mountFailures.map((f) => f.dir)).toEqual([join(dataDir, 'recipes', 'rotten')])
      // 三处一起说：只写日志的话，用户看到的现象只是「我装的那个源不见了」。
      expect(seen.filter((e) => e.key === 'skipped' && e.ok === false)).toHaveLength(1)
      expect(seen.find((e) => e.key === 'skipped')?.summary).toContain('rotten')
      await quiesceKernel(kernel)
    })

    it('sourceId 撞上 curated：整组被拒 → 逐包重试，只摘掉撞的那个包', async () => {
      const { kernel, dataDir } = await mount({
        seed: ({ builtinDir, userDir }) => {
          // sourceId 带包命名空间之后，撞 curated 的**唯一**途径是两层合成出同一个前缀。同 npm 名
          // 的两层由 pickLayers 整包只留一层（下面 `同 npm 名两层` 那组钉着），所以剩下的只有
          // **两边都没有 npm 名**的本地包撞同一个目录名（`local/<目录名>`）。安装口挡得住有名字的
          // 那一手（`occupied.ids`），手放进目录的挡不住，所以这条降级路仍然承重。
          writePluginPackage(builtinDir, 'curated-pkg', 'clash-feed', null)
          writeRecipePackage(userDir, 'curated-pkg', 'clash-feed', null)
          writeRecipePackage(userDir, 'innocent', 'innocent-feed')
        },
      })
      expect(kernel.sources.registry.get('clash-feed')?.adapter).toBe('replay')
      expect(kernel.sources.registry.get('alpha-feed')).toBeDefined()
      // 被摘掉的那个包只掉自己：同一层的另一个第三方包照常进来。
      expect(kernel.sources.registry.get('innocent-feed')).toBeDefined()
      expect(kernel.sources.mountFailures.map((f) => f.dir)).toEqual([join(dataDir, 'recipes', 'curated-pkg')])
      // manifest 进不了 registry，recipe 正文也不该留成一份没人取得到的僵尸。
      expect(kernel.sources.liveRecipes.current.has('clash-feed')).toBe(false)
      await quiesceKernel(kernel)
    })

    // 来查「我装的包怎么没了」的人最先看的就是这行汇总。它要是照装载时的快照数报，数字就
    // 对得上——于是他去别处找原因，而真相恰恰是这两个数不该对得上。**通知发对了、日志却在
    // 骗人，比没有日志更糟**：它给的是一条把人带偏的线索。
    it('降级之后那行汇总报的是进了 registry 的数，并说出跳过了几个包', async () => {
      const { kernel, logs } = await mount({
        seed: ({ builtinDir, userDir }) => {
          writePluginPackage(builtinDir, 'curated-pkg', 'clash-feed', null)
          writeRecipePackage(userDir, 'curated-pkg', 'clash-feed', null)   // 本地包撞同前缀 → 被摘掉
          writeRecipePackage(userDir, 'innocent', 'innocent-feed')
        },
      })
      const summary = logs.find((l) => l.includes('[stream] registry:'))!
      expect(summary).toContain('2 recipe')          // alpha-feed + innocent-feed，不是盘上读到的 3
      expect(summary).toContain('1 package(s) skipped')
      await quiesceKernel(kernel)
    })

    // 没降级的那次一个字都不该多说 —— 尾巴只在真摘掉包时出现。
    it('没跳过任何包时汇总不带那条尾巴', async () => {
      const { kernel, logs } = await mount()
      const summary = logs.find((l) => l.includes('[stream] registry:'))!
      expect(summary).toContain('1 recipe')
      expect(summary).not.toContain('skipped')
      await quiesceKernel(kernel)
    })
  })

  // 活体 2026-09-20：内置 `packages/xhs`（1.0.0，带 manifests.yaml）+ 用户 `stream add @streamapp/xhs`
  // （9.9.9，同一份 manifests.yaml）。内置那份经 curated 进 registry、用户那份经 recipes 组进 →
  // `Duplicate manifest id: @streamapp/xhs/xhs-resolve` → 用户装的整包被跳过、`video-xhs` 行消失。
  // 修法：同 npm 名两层只装版本高的一层的一切（`pickLayers`），curated 投影也吃这个结论。
  describe('同 npm 名两层都在：只装版本高的一层（curated 投影与 recipes 组同一把尺）', () => {
    /** 两层各放一个 `@t/xhsish`：manifests.yaml 里一条纯 manifest 源（x-resolve，内置层走 curated）+ 一条 recipe。 */
    const seedBoth = (builtinVersion: string, userVersion: string) => ({ builtinDir, userDir }: { builtinDir: string; userDir: string }) => {
      writePluginPackage(builtinDir, 'xhsish', 'x-resolve', '@t/xhsish', builtinVersion)
      writeRecipePackage(builtinDir, 'xhsish', 'x-home', '@t/xhsish', builtinVersion)   // 同一个目录：补一份 recipe
      writePluginPackage(userDir, 'xhsish', 'x-resolve', '@t/xhsish', userVersion)
      writeRecipePackage(userDir, 'xhsish', 'x-home', '@t/xhsish', userVersion)
    }

    it('用户层更高 → registry 里恰一条 x-resolve（来自用户层）、没有 Duplicate、没有包被跳过；内置的 curated 被摘掉', async () => {
      const { kernel, logs } = await mount({ seed: seedBoth('1.0.0', '9.9.9') })
      expect(kernel.sources.registry.all().filter((m) => m.id === '@t/xhsish/x-resolve')).toHaveLength(1)
      expect(kernel.sources.registry.get('@t/xhsish/x-home')).toBeDefined()
      expect(kernel.sources.mountFailures).toEqual([])
      expect(logs.some((l) => l.includes('Duplicate manifest id'))).toBe(false)
      expect(kernel.packages.layerPick.skipBuiltinNames.has('@t/xhsish')).toBe(true)
      // curated 那一格只剩别的包：alpha 是 recipe 包不进 curated，xhsish 被摘 → 0 curated
      expect(logs.find((l) => l.includes('[stream] registry:'))).toContain('0 curated')
      // 归并快照与 recipe 表拿到的也是用户层那份
      expect(kernel.sources.recipePackages().byFacility.get('xhsish')?.version).toBe('9.9.9')
      expect(kernel.sources.liveRecipes.current.has('@t/xhsish/x-home')).toBe(true)
      await quiesceKernel(kernel)
    })

    it('用户层更低 → 内置那份照常经 curated 进 registry，用户层整包跳过（不是 Duplicate、不进 mountFailures）', async () => {
      const { kernel, logs } = await mount({ seed: seedBoth('2.0.0', '1.9.9') })
      expect(kernel.sources.registry.all().filter((m) => m.id === '@t/xhsish/x-resolve')).toHaveLength(1)
      expect(kernel.sources.mountFailures).toEqual([])
      expect(logs.some((l) => l.includes('Duplicate manifest id'))).toBe(false)
      expect(kernel.packages.layerPick.skipUserNames.has('@t/xhsish')).toBe(true)
      expect(logs.find((l) => l.includes('[stream] registry:'))).toContain('1 curated')
      expect(kernel.sources.recipePackages().byFacility.get('xhsish')?.version).toBe('2.0.0')
      await quiesceKernel(kernel)
    })

    // 启动后才装进来的同名新版：curated 不热换，所以取舍**冻住**在启动那份（`layerPick`）。这一轮
    // 先不装它、说一句"重启后切换"，registry 保持可用——而且**之后每一轮**热重载（改 recipe、装别的包）
    // 都照常，不能被这一对同名包拖成永远失败。
    it('运行中装进同名新版（内置有 curated 清单）→ 这一轮不装它、点名说重启后切换；之后的无关重载照常成功', async () => {
      const { kernel, logs, dataDir } = await mount({
        seed: ({ builtinDir }) => {
          writePluginPackage(builtinDir, 'xhsish', 'x-resolve', '@t/xhsish', '1.0.0')
        },
      })
      const userDir = join(dataDir, 'recipes')
      writePluginPackage(userDir, 'xhsish', 'x-resolve', '@t/xhsish', '9.9.9')
      writeRecipePackage(userDir, 'xhsish', 'x-home', '@t/xhsish', '9.9.9')
      kernel.sources.reloadRecipePackages()
      expect(logs.filter((l) => l.includes('@t/xhsish: user layer installed, takes over on restart'))).toHaveLength(1)
      expect(logs.some((l) => l.includes('@t/xhsish: user layer 9.9.9 supersedes builtin 1.0.0'))).toBe(true)
      expect(logs.some((l) => l.includes('recipe reload failed'))).toBe(false)
      expect(logs.some((l) => l.includes('recipe packages reloaded'))).toBe(true)
      // 内置那份仍是唯一的一份；用户层的 recipe 这一轮没装
      expect(kernel.sources.registry.all().filter((m) => m.id === '@t/xhsish/x-resolve')).toHaveLength(1)
      expect(kernel.sources.liveRecipes.current.has('@t/xhsish/x-home')).toBe(false)

      // 随后一次无关的重载（装别的包）照常生效，且"重启后切换"那句不再重复
      writeRecipePackage(userDir, 'beta', 'beta-feed')
      kernel.sources.reloadRecipePackages()
      expect(kernel.sources.registry.get('beta-feed')?.id).toBe('@t/beta/beta-feed')
      expect(logs.filter((l) => l.includes('recipe reload failed'))).toEqual([])
      expect(logs.filter((l) => l.includes('takes over on restart'))).toHaveLength(1)
      await quiesceKernel(kernel)
    })

    // 顶掉的内置**没有** curated 清单（纯 recipe 包）→ swap 不会撞，照常装、不说要重启。
    it('运行中装进同名新版（内置只有 recipe、没有 curated）→ 直接生效，不提重启', async () => {
      const { kernel, logs, dataDir } = await mount()   // 内置 alpha 是纯 recipe 包（@t/alpha 1.0.0）
      writeRecipePackage(join(dataDir, 'recipes'), 'alpha', 'alpha-feed', '@t/alpha', '9.9.9')
      kernel.sources.reloadRecipePackages()
      expect(logs.some((l) => l.includes('takes over on restart'))).toBe(false)
      expect(logs.some((l) => l.includes('recipe reload failed'))).toBe(false)
      expect(kernel.sources.recipePackages().byFacility.get('alpha')?.version).toBe('9.9.9')
      await quiesceKernel(kernel)
    })

    // 启用开关必须继续管住被顶掉的插件：内置禁用了不出 curated，用户层那份也不能从 recipes 组把源装回来。
    it('用户层更高、但内置那个插件被禁用 → 用户层那份也不装（开关照样生效）', async () => {
      const { kernel } = await mount({
        seed: ({ builtinDir, userDir }) => {
          seedBoth('1.0.0', '9.9.9')({ builtinDir, userDir })
          writeFileSync(join(builtinDir, '..', 'data', 'settings.json'), JSON.stringify({ plugins: { xhsish: false } }))
        },
      })
      expect(kernel.packages.layerPick.skipBuiltinNames.has('@t/xhsish')).toBe(true)   // 仍按版本比：禁用不影响谁高
      expect(kernel.sources.registry.all().filter((m) => m.id.startsWith('@t/xhsish/'))).toEqual([])
      expect(kernel.sources.liveRecipes.current.has('@t/xhsish/x-home')).toBe(false)
      // 翻开开关 → 下一次重载装回用户层那份
      kernel.packages.setPluginEnabled('xhsish', true)
      kernel.sources.reloadRecipePackages()
      expect(kernel.sources.registry.all().filter((m) => m.id === '@t/xhsish/x-resolve')).toHaveLength(1)
      expect(kernel.sources.liveRecipes.current.has('@t/xhsish/x-home')).toBe(true)
      await quiesceKernel(kernel)
    })
  })

  // 本域的两个句柄：watcher 和它那个还没到点的 debounce，都登记成 effect。没登记的话，关停
  // 之后文件事件照样进来、debounce 照样到点，重载会去碰一个已经撤掉的 registry。
  it('dispose 之后文件事件不再触发重载', async () => {
    const keys: string[] = []
    const { kernel, builtinDir } = await mount({ onDebug: (e) => void keys.push(e.key) })
    // 写进**内置那层**：用户层首跑时目录还不存在，watcher 根本没挂上（正是 install 走同步
    // 重挂而不是等 watcher 的原因）。这条测的是 watcher 本身的生命周期，所以挑一个有 watcher 的目录。
    writeRecipePackage(builtinDir, 'beta', 'beta-feed')
    await waitFor(() => keys.includes('watch'), 4000)
    await quiesceKernel(kernel)
    keys.length = 0
    writeRecipePackage(builtinDir, 'gamma', 'gamma-feed')
    await sleep(800) // > debounce(300)，到点了也该没人再跑
    expect(keys).toEqual([])
  })
})
