import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { activatePackages, makeCookieFor, occupiedByBuiltins, withInstalled, RESERVED_ADAPTER_NAMES, type ActivateFn, type PluginContext } from './activate.ts'
import type { StreamPackage } from './scan.ts'
import { hasNormalizer, registerNormalizer } from '../content/normalize.ts'
import { HOST_ENRICH_SOURCES } from '../content/enrich/index.ts'

const pkg = (id: string, code?: { adapters?: string[]; normalizers?: string[] }): StreamPackage =>
  ({ id, dir: `/tmp/${id}`, ...(code ? { code: { entry: './activate.ts', ...code } } : {}) }) as StreamPackage

/** 造一个真的落在盘上的第三方包：包目录 + （可选）真写出去的 dist/index.js。 */
const userPkg = (
  id: string,
  code: { entry?: string; adapters?: string[]; normalizers?: string[] },
  source?: string,
): StreamPackage => {
  const dir = mkdtempSync(join(tmpdir(), `activate-${id}-`))
  if (source !== undefined) {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'index.js'), source)
  }
  return { id, dir, code: { entry: 'dist/index.js', ...code } } as StreamPackage
}

const ctx = (): PluginContext => ({
  backendUrl: () => undefined,
  withAwake: (_s, fn) => fn(),
  cookieFor: async () => undefined,
  login: async () => { throw new Error('这个测试不该调 login') },
  readSource: async () => { throw new Error('这个测试不该调 readSource') },
  readArticle: async () => { throw new Error('这个测试不该调 readArticle') },
  log: () => {},
  config: {},
})

const fakeAdapter = { fetch: async () => [] } as never

describe('activatePackages', () => {
  it('skips packages with no code slot', async () => {
    const out = await activatePackages([pkg('nocode')], new Map(), ctx)
    expect(out.adapters.size).toBe(0)
  })

  it('returns the adapter instances the package produced', async () => {
    const fn: ActivateFn = () => ({ adapters: { demo: fakeAdapter } })
    const out = await activatePackages([pkg('demo', { adapters: ['demo'] })], new Map([['demo', fn]]), ctx)
    expect(out.adapters.get('demo')).toBe(fakeAdapter)
  })

  it('throws when a package declares code but has no entry in the import table', () => {
    expect(() => activatePackages([pkg('missing', { adapters: ['missing'] })], new Map(), ctx)).toThrow(/missing/)
  })

  it('refuses two packages declaring the same adapter name — before calling either activate', () => {
    let called = 0
    const fn: ActivateFn = () => { called += 1; return { adapters: { dupe: fakeAdapter } } }
    expect(() =>
      activatePackages(
        [pkg('a', { adapters: ['dupe'] }), pkg('b', { adapters: ['dupe'] })],
        new Map([['a', fn], ['b', fn]]),
        ctx,
      ),
    ).toThrow(/dupe/)
    expect(called).toBe(0)
  })

  it('refuses a normalizer name the registry already has — before calling activate', () => {
    // 宿主静态表是空的（具名 normalizer 全归包），所以先由测试自己占一个名字，再让冒名的包来撞。
    registerNormalizer('already-taken', () => ({ archetype: 'text' }) as never)
    let called = 0
    const fn: ActivateFn = () => { called += 1; return { normalizers: { 'already-taken': () => ({ archetype: 'text' }) as never } } }
    expect(() =>
      activatePackages([pkg('impostor', { normalizers: ['already-taken'] })], new Map([['impostor', fn]]), ctx),
    ).toThrow(/already-taken/)
    expect(called).toBe(0)
  })

  it('registers the normalizers a package declared', async () => {
    const norm = (() => ({ archetype: 'text' })) as never
    const fn: ActivateFn = () => ({ normalizers: { 'activate-test-only': norm } })
    await activatePackages([pkg('n', { normalizers: ['activate-test-only'] })], new Map([['n', fn]]), ctx)
    expect(hasNormalizer('activate-test-only')).toBe(true)
  })

  it('throws when activate returns a name it did not declare', async () => {
    const fn: ActivateFn = () => ({ adapters: { surprise: fakeAdapter } })
    await expect(
      activatePackages([pkg('x', { adapters: ['declared'] })], new Map([['x', fn]]), ctx),
    ).rejects.toThrow(/surprise|declared/)
  })

  it('refuses a package that declares the host adapter name "builtin" — before calling activate', () => {
    let called = 0
    const fn: ActivateFn = () => { called += 1; return { adapters: { builtin: fakeAdapter } } }
    expect(() =>
      activatePackages([pkg('impostor', { adapters: ['builtin'] })], new Map([['impostor', fn]]), ctx),
    ).toThrow(/impostor.*builtin|builtin.*impostor/)
    expect(called).toBe(0)
  })

  it('reserves all four host adapter names — rsshub, replay, browser, builtin', () => {
    for (const name of ['rsshub', 'replay', 'browser', 'builtin']) {
      let called = 0
      const fn: ActivateFn = () => { called += 1; return { adapters: { [name]: fakeAdapter } } }
      expect(() =>
        activatePackages([pkg('impostor', { adapters: [name] })], new Map([['impostor', fn]]), ctx),
      ).toThrow(new RegExp(name))
      expect(called).toBe(0)
    }
    expect(RESERVED_ADAPTER_NAMES).toEqual(new Set(['builtin', 'rsshub', 'replay', 'browser']))
  })
})

/**
 * 第三方包那条来路：代码在用户数据目录的盘上，运行时 `import(file://…)` 取。
 * 「没有发生任何 import」怎么证：模块顶层给一个全局计数器 +1——`import()` 一旦发生，
 * 哪怕 `activate` 没被调用，这个数也会动。它就是动态那条路上的 `called === 0`。
 */
describe('activatePackages — 用户目录里的第三方包（动态 import）', () => {
  const PROBE = `globalThis.__activateProbe = (globalThis.__activateProbe ?? 0) + 1\n`
  const probeCount = () => (globalThis as Record<string, unknown>).__activateProbe ?? 0
  const resetProbe = () => { (globalThis as Record<string, unknown>).__activateProbe = 0 }

  it('loads and activates a package from the user data dir', async () => {
    const p = userPkg('userdemo', { adapters: ['userdemo'] },
      `${PROBE}export const activate = () => ({ adapters: { userdemo: { fetch: async () => [] } } })\n`)
    resetProbe()
    const out = await activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)
    expect(typeof out.adapters.get('userdemo')?.fetch).toBe('function')
    expect(probeCount()).toBe(1)
  })

  /**
   * 执行期失败（模块取不到 / 顶层炸 / 没导出 activate / 交出来的名单对不上申报）**只对动态那一档**
   * per-package 捕获：第三方包少打包一个依赖不该让整个后端起不来。名字检查（撞名 / 保留名 /
   * 路径越界）仍然致命——见下面那几条。
   */
  it('第三方包的入口文件不存在：记进 failures，不掀翻装载', async () => {
    const p = userPkg('ghost', { adapters: ['ghost'] })  // 没写出任何文件
    const out = await activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)
    expect(out.failures.map((f) => f.id)).toEqual(['ghost'])
    expect(out.failures[0].error.message).toMatch(/ghost/)
    expect(out.adapters.size).toBe(0)
  })

  it('第三方包语法错：记进 failures，别的包照常激活', async () => {
    const broken = userPkg('brokenjs', { adapters: ['brokenjs'] }, 'export const activate = (\n')
    const good = userPkg('okpkg', { adapters: ['okpkg'] },
      'export const activate = () => ({ adapters: { okpkg: { fetch: async () => [] } } })\n')
    const out = await activatePackages(
      [broken, good], { builtin: new Map(), dynamic: new Set([broken, good]) }, ctx,
    )
    expect(out.failures.map((f) => f.id)).toEqual(['brokenjs'])
    expect(typeof out.adapters.get('okpkg')?.fetch).toBe('function') // 后面那个没被前面那个拖下水
  })

  it('第三方包没导出 activate()：记进 failures，不掀翻装载', async () => {
    const p = userPkg('noactivate', { adapters: ['noactivate'] }, 'export const nope = 1\n')
    const out = await activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)
    expect(out.failures.map((f) => f.id)).toEqual(['noactivate'])
    expect(out.failures[0].error.message).toMatch(/activate/)
  })

  it('第三方包交出来的名单与申报不符：同一档（执行之后才知道，不是信任边界）', async () => {
    const p = userPkg('liar', { adapters: ['liar'] },
      'export const activate = () => ({ adapters: { somethingelse: { fetch: async () => [] } } })\n')
    const out = await activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)
    expect(out.failures.map((f) => f.id)).toEqual(['liar'])
    expect(out.adapters.size).toBe(0)
  })

  it('内置那一档（静态表）的执行期失败仍然致命——那是我们自己的代码', async () => {
    const boom: ActivateFn = () => { throw new Error('builtin exploded') }
    await expect(
      activatePackages([pkg('builtinboom', { adapters: ['builtinboom'] })], new Map([['builtinboom', boom]]), ctx),
    ).rejects.toThrow(/builtin exploded/)
  })

  it('refuses an entry that escapes the package dir — before any import happens', () => {
    const root = mkdtempSync(join(tmpdir(), 'activate-escape-'))
    mkdirSync(join(root, 'outside', 'dist'), { recursive: true })
    writeFileSync(join(root, 'outside', 'dist', 'index.js'), `${PROBE}export const activate = () => ({})\n`)
    mkdirSync(join(root, 'pkg'))
    const p = { id: 'escapee', dir: join(root, 'pkg'), code: { entry: '../outside/dist/index.js', adapters: [] } } as unknown as StreamPackage
    resetProbe()
    expect(() => activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)).toThrow(
      /escapee.*outside/s,
    )
    expect(probeCount()).toBe(0)
  })

  it('refuses an absolute entry pointing outside the package dir', () => {
    const p = { id: 'abs', dir: mkdtempSync(join(tmpdir(), 'activate-abs-')), code: { entry: '/etc/passwd', adapters: [] } } as unknown as StreamPackage
    expect(() => activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)).toThrow(/abs/)
  })

  it('refuses a user package clashing with a builtin — neither imports nor calls either activate', () => {
    let called = 0
    const builtinFn: ActivateFn = () => { called += 1; return { adapters: { dupe: fakeAdapter } } }
    const p = userPkg('thirdparty', { adapters: ['dupe'] },
      `${PROBE}export const activate = () => ({ adapters: { dupe: { fetch: async () => [] } } })\n`)
    resetProbe()
    expect(() =>
      activatePackages(
        [pkg('builtinpkg', { adapters: ['dupe'] }), p],
        { builtin: new Map([['builtinpkg', builtinFn]]), dynamic: new Set([p]) },
        ctx,
      ),
    ).toThrow(/dupe/)
    expect(called).toBe(0)
    expect(probeCount()).toBe(0)
  })

  it('refuses a user package declaring a reserved host adapter name — no import', () => {
    const p = userPkg('impostor', { adapters: ['builtin'] },
      `${PROBE}export const activate = () => ({ adapters: { builtin: { fetch: async () => [] } } })\n`)
    resetProbe()
    expect(() =>
      activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx),
    ).toThrow(/builtin/)
    expect(probeCount()).toBe(0)
  })

  /**
   * 路由键是**包对象本身**，不是它的 id。id 是包自己 package.json 里写的字符串——第三方随手
   * 写成 `alist` 就跟内置那个包同名，而内置 alist 的代码入口是 `./activate.ts`（源码，发行
   * bundle 里根本不出货）。按 id 路由时这一撞会把**内置**那个包也送进动态 import 分支 →
   * `Cannot find module …/activate.ts` → 后端起不来，还只能靠用户去翻文件系统删包才能恢复。
   */
  it('routes by package identity, not by id — a third-party package claiming a builtin id changes nothing for the builtin', async () => {
    let builtinCalled = 0
    const builtinFn: ActivateFn = () => { builtinCalled += 1; return { adapters: { alist: fakeAdapter } } }
    // 内置那个包的 dir 指向源码树；一旦被误路由成动态 import 就必然炸（也正是生产的表现）
    const builtinPkg = { id: 'alist', dir: '/nonexistent/alist', code: { entry: './activate.ts', adapters: ['alist'] } } as unknown as StreamPackage
    const impostor = userPkg('alist', { adapters: ['impostor'] },
      `${PROBE}export const activate = () => ({ adapters: { impostor: { fetch: async () => [] } } })\n`)
    resetProbe()

    const out = await activatePackages(
      [builtinPkg, impostor],
      { builtin: new Map([['alist', builtinFn]]), dynamic: new Set([impostor]) },
      ctx,
    )

    expect(builtinCalled).toBe(1)                                  // 内置的走了静态表
    expect(out.adapters.get('alist')).toBe(fakeAdapter)
    expect(typeof out.adapters.get('impostor')?.fetch).toBe('function')
    expect(probeCount()).toBe(1)                                   // 只 import 了第三方那一个
  })
})

/**
 * 安装期的占用表必须同时含**内置**和**已装的第三方**：两个第三方包申报同一个 adapter 名时各自装
 * 都成功，启动时 activatePackages 按设计「两边都不激活」→ 抛 → 后端起不来，UI 里恢复不了。
 * 唯一的例外是**这个包自己**（升级 / 重装），否则第二次装自己就被自己挡住。
 */
describe('withInstalled — 已装第三方包也进占用表', () => {
  const BUILTINS = [{ id: 'alist', code: { entry: './activate.ts', adapters: ['alist'], normalizers: ['alist'] } }] as unknown as StreamPackage[]
  const INSTALLED = [
    { id: 'demo', pkgName: '@someone/demo', dir: '/x', code: { entry: 'dist/index.js', adapters: ['demo-a'], normalizers: ['demo-n'] } },
  ] as unknown as StreamPackage[]

  it('把已装第三方包申报的 adapter / normalizer 名并进来', () => {
    const occupied = withInstalled(occupiedByBuiltins(BUILTINS), INSTALLED)
    expect(occupied.adapters.has('demo-a')).toBe(true)
    expect(occupied.normalizers.has('demo-n')).toBe(true)
    expect(occupied.adapters.has('alist')).toBe(true)   // 内置那半没被覆盖掉
    expect(occupied.adapters.has('rsshub')).toBe(true)  // 宿主保留名也还在
  })

  it('排除正在装的那个包自己——升级 / 重装不算撞名', () => {
    const occupied = withInstalled(occupiedByBuiltins(BUILTINS), INSTALLED, '@someone/demo')
    expect(occupied.adapters.has('demo-a')).toBe(false)
    expect(occupied.normalizers.has('demo-n')).toBe(false)
    expect(occupied.adapters.has('alist')).toBe(true)
  })

  it('不并 id：两个第三方包 id 相同不是开不了机的原因（路由按包对象走）', () => {
    const occupied = withInstalled(occupiedByBuiltins(BUILTINS), INSTALLED)
    expect(occupied.ids.has('demo')).toBe(false)
    expect(occupied.ids.has('alist')).toBe(true)
  })

  it('已装第三方包的容器 service 名（= 它的包 id）也占位', () => {
    const withBackend = [
      { id: 'demo', pkgName: '@someone/demo', dir: '/x', backend: { image: 'i', port: 80, mem: '1G' } },
    ] as unknown as StreamPackage[]
    expect(withInstalled(occupiedByBuiltins([]), withBackend).services.has('demo')).toBe(true)
    // 不带容器的包不占 service 名（它没有容器要跑）
    expect(withInstalled(occupiedByBuiltins([]), INSTALLED).services.has('demo')).toBe(false)
  })

  // enricher 名 / connect 域名在 activatePackages 第一段撞上也是「两边都不激活」→ 抛，两层都要占位；
  // connect 域名按小写记（activatePackages 判归属就是按小写）。
  it('enricher 名 / connect 域名两层都进占用表，connect 域名小写化，宿主 enrich 源自带', () => {
    const builtins = [
      { id: 'xhs', pkgName: '@streamapp/xhs', credentials: ['xiaohongshu.com'], code: { entry: './activate.ts', enrichers: ['xhs-detail'], connect: ['XiaoHongShu.com'] } },
    ] as unknown as StreamPackage[]
    const installed = [
      { id: 'demo', pkgName: '@someone/demo', dir: '/x', credentials: ['demo.example'], code: { entry: 'dist/index.js', enrichers: ['demo-e'], connect: ['Demo.example'] } },
    ] as unknown as StreamPackage[]
    const occupied = withInstalled(occupiedByBuiltins(builtins), installed)
    expect(occupied.enrichers.has('xhs-detail')).toBe(true)
    expect(occupied.enrichers.has('demo-e')).toBe(true)
    expect(occupied.connect.has('xiaohongshu.com')).toBe(true)
    expect(occupied.connect.has('demo.example')).toBe(true)
    for (const n of HOST_ENRICH_SOURCES) expect(occupied.enrichers.has(n)).toBe(true)
    // 剔自己：两层各自的剔除都生效
    expect(occupiedByBuiltins(builtins, '@streamapp/xhs').enrichers.has('xhs-detail')).toBe(false)
    expect(withInstalled(occupiedByBuiltins([]), installed, '@someone/demo').connect.has('demo.example')).toBe(false)
  })
})

/**
 * service 名是全局单一命名空间（`/_p/<service>` 路由 + standby 名册 + compose service key）。
 * 内置包的 service 名**不一定等于它的 id**——`Douyin_TikTok_Download_API` 那个包的 service 就是
 * `douyin-tiktok-download-api`。id 闸门查不到它，所以占用表必须单列这一格。
 */
describe('occupiedByBuiltins — 容器 service 名', () => {
  it('显式写了 service 的内置包，占的是那个 service 名（不是它的 id）', () => {
    const occupied = occupiedByBuiltins([
      { id: 'Douyin_TikTok_Download_API', code: undefined, backend: { image: 'i', port: 80, service: 'douyin-tiktok-download-api' } },
    ] as unknown as StreamPackage[])
    expect(occupied.services.has('douyin-tiktok-download-api')).toBe(true)
    expect(occupied.ids.has('douyin-tiktok-download-api')).toBe(false) // id 闸门看不见它
  })

  it('没写 service 的内置包，占的是它的 id（那是 service 的默认值）', () => {
    const occupied = occupiedByBuiltins([
      { id: 'pansou', code: undefined, backend: { image: 'i', port: 80 } },
    ] as unknown as StreamPackage[])
    expect(occupied.services.has('pansou')).toBe(true)
  })

  it('不带容器的内置包不占 service 名', () => {
    expect(occupiedByBuiltins([{ id: 'xhs', code: undefined }] as unknown as StreamPackage[]).services.size).toBe(0)
  })
})

/**
 * 内置带 code 的包也发 npm（今天 4 个）：`stream add @streamapp/xhs` 装到的是**同一个包**的另一个版本，它申报的
 * id / adapter / normalizer / service 名与内置那份一字不差。占用表必须按 npm 名把那一个内置包剔掉，否则
 * 这条自我升级路在安装门就被拒，`pick-layer.ts`「同名两层只激活一层」永远轮不到。剔的只有**同 npm 名**
 * 那一个：第三方把 id 写成 `xhs` 但 npm 名不同，照样被挡。
 */
describe('occupiedByBuiltins — 同 npm 名的内置包按正在装的包剔除', () => {
  const BUILTINS = [
    { id: 'xhs', pkgName: '@streamapp/xhs', code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs'] } },
    { id: 'pansou', pkgName: '@streamapp/pansou', code: { entry: 'dist/index.js', adapters: ['pansou'] }, backend: { image: 'i', port: 80 } },
  ] as unknown as StreamPackage[]

  it('不传 excludePkgName：两个内置包的名字全占着', () => {
    const o = occupiedByBuiltins(BUILTINS)
    expect(o.ids.has('xhs')).toBe(true)
    expect(o.adapters.has('xhs')).toBe(true)
    expect(o.normalizers.has('xhs')).toBe(true)
    expect(o.services.has('pansou')).toBe(true)
  })

  it('传自己的 npm 名：只有那一个内置包的名字让出来，别的内置包与宿主保留名照旧', () => {
    const o = occupiedByBuiltins(BUILTINS, '@streamapp/xhs')
    expect(o.ids.has('xhs')).toBe(false)
    expect(o.adapters.has('xhs')).toBe(false)
    expect(o.normalizers.has('xhs')).toBe(false)
    expect(o.ids.has('pansou')).toBe(true)
    expect(o.services.has('pansou')).toBe(true)
    expect(o.adapters.has('rsshub')).toBe(true)
  })

  it('npm 名不同的第三方把 id 写成 xhs → 内置 xhs 照样占着', () => {
    const o = occupiedByBuiltins(BUILTINS, '@someone/xhs-clone')
    expect(o.ids.has('xhs')).toBe(true)
    expect(o.adapters.has('xhs')).toBe(true)
  })
})

/**
 * id 那一格只收**填了插件槽位**的内置包。目录并轨（`plugins/` + `recipes/` → 一个 `packages/`）
 * 之后 bootstrap 传进来的是全部 29 个包，若照单全收，19 个内置纯 recipe 包的 id 会一起进占用表
 * ——官方随应用发布的每个 recipe 包当场变成装不了也升不了（活体实测：preview @streamapp/toubiec
 * → 400）。而"用户层覆盖内置 recipe 包"是这条线一直支持的能力。
 */
describe('occupiedByBuiltins — id 只收填了插件槽位的包', () => {
  it('纯 recipe 包（一格插件槽位都没填）的 id 不进占用表', () => {
    const occupied = occupiedByBuiltins([
      { id: 'toubiec', facility: 'toubiec', cookieDomain: 'toubiec.cn' },
    ] as unknown as StreamPackage[])
    expect(occupied.ids.has('toubiec')).toBe(false)
  })

  it.each([
    ['backend', { backend: { image: 'i', port: 80 } }],
    ['code', { code: { entry: './activate.ts', adapters: ['x'] } }],
    ['normalizer', { normalizer: 'alist' }],
    ['sources', { sources: [{ id: 's' }] }],
    ['sourceGrouping', { sourceGrouping: { enabled: true, resolver: 'r' } }],
    ['credentials', { credentials: ['alist.example'] }],
  ])('填了 %s 槽位的内置包，id 仍然独占', (_slot, extra) => {
    const occupied = occupiedByBuiltins([{ id: 'p', ...extra }] as unknown as StreamPackage[])
    expect(occupied.ids.has('p')).toBe(true)
  })
})

describe('makeCookieFor', () => {
  it('serves a domain the package declared', async () => {
    const fn = makeCookieFor({ id: 'p', credentials: ['douyin.com'] }, async () => 'a=1')
    await expect(fn('douyin.com')).resolves.toBe('a=1')
  })

  it('maps "no cookies stored" to undefined rather than null', async () => {
    const fn = makeCookieFor({ id: 'p', credentials: ['douyin.com'] }, async () => null)
    await expect(fn('douyin.com')).resolves.toBeUndefined()
  })

  it('throws for a domain the package did not declare', async () => {
    const fn = makeCookieFor({ id: 'p', credentials: ['douyin.com'] }, async () => 'a=1')
    await expect(fn('quark.cn')).rejects.toThrow(/quark\.cn.*credentials/)
  })

  // 域名本来就大小写不敏感：申报 `douyin.com`、请求 `DOUYIN.COM` 拒掉就是一次查不出原因的失败。
  it('compares domains case-insensitively, and looks the cookie up by the normalized domain', async () => {
    // cookie 侧的 stub 只认小写——归一必须发生在闸门之前，否则闸门放行了、查询却落空
    const fn = makeCookieFor({ id: 'p', credentials: ['douyin.com'] }, async (d) =>
      d === 'douyin.com' ? 'a=1' : null,
    )
    await expect(fn('DOUYIN.COM')).resolves.toBe('a=1')
  })

  it('compares case-insensitively on the declared side too', async () => {
    const fn = makeCookieFor({ id: 'p', credentials: ['DouYin.com'] }, async () => 'a=1')
    await expect(fn('douyin.com')).resolves.toBe('a=1')
  })

  it('throws for every domain when the package declared no credentials at all (e.g. pansou)', async () => {
    const fn = makeCookieFor({ id: 'pansou' }, async () => 'a=1')
    await expect(fn('anything.test')).rejects.toThrow(/pansou/)
  })
})

// ── 动作槽位（spec 2026-09-02-package-action-slot-design）──────────────────
describe('activatePackages —— 包提供的动作', () => {
  const noop = async () => ({ summary: 'ok' })

  it('交出来的动作带着交它的包 id 一起回来', async () => {
    const fn: ActivateFn = () => ({ actions: { calendar: noop } })
    const out = await activatePackages([pkg('eastmoney', {})], new Map([['eastmoney', fn]]), ctx)
    expect(out.actions.map((a) => [a.pkgId, a.local])).toEqual([['eastmoney', 'calendar']])
  })

  // 不申报也能交：动作名前缀是包 id，而带 code 槽位的包 id 全局独占，包与包之间撞不了名。
  // 再加一份 `stream.code.actions` 申报名单，只是多一份会漂的东西。
  it('不需要在 stream.code 里申报', async () => {
    const fn: ActivateFn = () => ({ actions: { a: noop, b: noop } })
    const out = await activatePackages([pkg('p', {})], new Map([['p', fn]]), ctx)
    expect(out.actions).toHaveLength(2)
  })

  // 半批比没有更坏：缺席的那个动作会让引用它的任务行每轮红一次，而其余照跑，看起来只是"某条坏了"。
  it('一个不合格 ⇒ 内置包整个不生效（照抛），一个动作都不收', async () => {
    const fn: ActivateFn = () => ({ actions: { good: noop, 'a:b': noop } })
    await expect(activatePackages([pkg('p', {})], new Map([['p', fn]]), ctx))
      .rejects.toThrow(/separates the package id/)
  })

  it('一个不合格 ⇒ 第三方包记进 failures 且不掀翻后端，一个动作都不收', async () => {
    const p = userPkg('third', {}, `export const activate = () => ({ actions: {
      ok: async () => ({ summary: 's' }),
      bad: 'not a function',
    } })`)
    const out = await activatePackages([p], { builtin: new Map(), dynamic: new Set([p]) }, ctx)
    expect(out.actions).toEqual([])
    expect(out.failures.map((f) => f.id)).toEqual(['third'])
    expect(out.failures[0]!.error.message).toMatch(/is not a function/)
  })

  it('没交动作的包不产生动作（关掉一个包 = 它的动作一起消失）', async () => {
    const fn: ActivateFn = () => ({ adapters: { demo: fakeAdapter } })
    const out = await activatePackages([pkg('demo', { adapters: ['demo'] })], new Map([['demo', fn]]), ctx)
    expect(out.actions).toEqual([])
  })
})

describe('activate() 交出来的 enrichers / connect', () => {
  const mkPkg = (over: Record<string, unknown>) => ({
    id: 'p1', dir: '/tmp/p1', pkgName: '@t/p1',
    credentials: ['example.com'],
    code: { entry: 'activate.ts' },
    ...over,
  }) as never

  it('申报了就收进表，键就是注册名', async () => {
    const pkg = mkPkg({ code: { entry: 'a.ts', enrichers: ['x-comments'], connect: ['example.com'] } })
    const r = await activatePackages([pkg], new Map([['p1', () => ({
      enrichers: { 'x-comments': async () => ({ comments: [] }) },
      connect: { 'example.com': async () => ({ stream: { id: 's', description: 'd', sources: [], cadence_seconds: 1, vault_subdir: 'v' } }) },
    })]]), () => ctx())
    expect([...r.enrichers.keys()]).toEqual(['x-comments'])
    expect([...r.connect.keys()]).toEqual(['example.com'])
  })

  // 包跑自己的源只有 `ctx.readSource` 这一扇门；enricher 的第二参是取消信号（WS 现取协议里
  // 新点击顶掉旧的靠它），一参调用（`/api/enrich`）也合法。
  it('包拿到的 ctx 带 readSource，enricher 把 signal 原样递给它', async () => {
    const pkg = mkPkg({ code: { entry: 'a.ts', enrichers: ['x-detail'] } })
    const seen: unknown[] = []
    const r = await activatePackages([pkg], new Map([['p1', (c: PluginContext) => ({
      enrichers: { 'x-detail': (q, signal) => c.readSource('x-detail', q, { signal }) },
    })]]), () => ({ ...ctx(), readSource: async (id, params, opts) => { seen.push([id, params, opts?.signal]); return [] } }))
    const ac = new AbortController()
    await r.enrichers.get('x-detail')!({ noteId: 'n1' }, ac.signal)
    await r.enrichers.get('x-detail')!({ noteId: 'n2' })
    expect(seen).toEqual([['x-detail', { noteId: 'n1' }, ac.signal], ['x-detail', { noteId: 'n2' }, undefined]])
  })

  // 前端把 article.html / comments[].html 原样 innerHTML——它信的是宿主，所以包交的 html 在收口处消毒。
  it('enricher 交出的 html 由宿主消毒（HTTP 与 WS 两个出口吃同一份）', async () => {
    const pkg = mkPkg({ code: { entry: 'a.ts', enrichers: ['x-comments'] } })
    const r = await activatePackages([pkg], new Map([['p1', () => ({
      enrichers: {
        'x-comments': async () => ({
          article: { sourceUrl: 'https://x', html: '<p>a</p><script>evil()</script>' },
          comments: [{
            id: '1', text: 't', html: '<p>c</p><script>evil()</script>',
            replies: [{ id: '2', text: 't', html: '<b onclick="evil()">r</b><script>evil()</script>' }],
          }],
          total: 2,
        }),
      },
    })]]), () => ctx())
    const out = await r.enrichers.get('x-comments')!({}) as {
      article: { html: string }; comments: Array<{ html: string; replies: Array<{ html: string }> }>; total: number
    }
    expect(out.article.html).toBe('<p>a</p>')
    expect(out.comments[0].html).toBe('<p>c</p>')
    expect(out.comments[0].replies[0].html).toBe('<b>r</b>')
    expect(out.total).toBe(2)
  })

  it('申报名单与实际返回对不上 → 抛（内置那一档是致命的）', async () => {
    const pkg = mkPkg({ code: { entry: 'a.ts', enrichers: ['x-comments'] } })
    await expect(activatePackages([pkg], new Map([['p1', () => ({ enrichers: {} })]]), () => ctx()))
      .rejects.toThrow(/enrichers/)
  })

  it('两个包申报同一个 enricher 名 → 同步抛，两个都不激活', () => {
    const a = mkPkg({ id: 'a', code: { entry: 'a.ts', enrichers: ['dup'] } })
    const b = mkPkg({ id: 'b', code: { entry: 'b.ts', enrichers: ['dup'] } })
    expect(() => activatePackages([a, b], new Map([['a', () => ({})], ['b', () => ({})]]), () => ctx()))
      .toThrow(/dup/)
  })

  it('撞上宿主自己的 enrich source 名 → 同步抛', () => {
    const pkg = mkPkg({ code: { entry: 'a.ts', enrichers: ['link'] } })
    expect(() => activatePackages([pkg], new Map([['p1', () => ({})]]), () => ctx())).toThrow(/link/)
  })

  it('connect 的键必须在 credentials 里申报过 → 否则同步抛', () => {
    const pkg = mkPkg({ credentials: ['example.com'], code: { entry: 'a.ts', connect: ['other.com'] } })
    expect(() => activatePackages([pkg], new Map([['p1', () => ({})]]), () => ctx())).toThrow(/other\.com/)
  })

  it('两个包 connect 同一个域 → 同步抛', () => {
    const a = mkPkg({ id: 'a', credentials: ['example.com'], code: { entry: 'a.ts', connect: ['example.com'] } })
    const b = mkPkg({ id: 'b', credentials: ['example.com'], code: { entry: 'b.ts', connect: ['example.com'] } })
    expect(() => activatePackages([a, b], new Map([['a', () => ({})], ['b', () => ({})]]), () => ctx())).toThrow(/example\.com/)
  })
})
