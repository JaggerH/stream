import { describe, it, expect } from 'vitest'
import { resolveRoute, RssHubAdapter } from './rsshub-adapter.ts'
import type { SourceManifest } from './manifest/types.ts'

function mk(partial: Partial<SourceManifest>): SourceManifest {
  return {
    schema_version: 1,
    id: 'm',
    adapter: 'rsshub',
    type: 'post',
    description: 'd',
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

describe('rsshub adapter route resolution', () => {
  it('uses a static manifest route', () => {
    expect(resolveRoute(mk({ route: '/hackernews/best' }), {})).toBe('/hackernews/best')
  })

  it('substitutes {key} placeholders from params', () => {
    const r = resolveRoute(mk({ route: '/bilibili/user/dynamic/{uid}' }), { uid: '12345' })
    expect(r).toBe('/bilibili/user/dynamic/12345')
  })

  it('errors on a missing route param', () => {
    expect(() => resolveRoute(mk({ route: '/x/{uid}' }), {})).toThrow(/uid/)
  })

  it('substitutes a :key path param and strips its {regex} constraint', () => {
    // Hono constraint syntax (:tags{.+}) is routing metadata, never part of the value.
    expect(resolveRoute(mk({ route: '/bangumi.moe/:tags{.+}?' }), { tags: '葬送的芙莉莲' })).toBe('/bangumi.moe/葬送的芙莉莲')
    expect(resolveRoute(mk({ route: '/comicat/search/:keyword' }), { keyword: '芙莉莲' })).toBe('/comicat/search/芙莉莲')
  })

  it('drops an optional path param when absent — with or without a constraint', () => {
    expect(resolveRoute(mk({ route: '/nyaa/search/:query?' }), {})).toBe('/nyaa/search')
    expect(resolveRoute(mk({ route: '/bangumi.moe/:tags{.+}?' }), {})).toBe('/bangumi.moe')
  })

  it('falls back to a literal params.route (rsshub-raw passthrough)', () => {
    const r = resolveRoute(mk({ id: 'rsshub-raw', route: undefined }), { route: '/some/new/route' })
    expect(r).toBe('/some/new/route')
  })

  it('errors when no route is available at all', () => {
    expect(() => resolveRoute(mk({ route: undefined }), {})).toThrow(/route/)
  })

  it('appends allowlisted limit as a query param', () => {
    const r = resolveRoute(mk({ route: '/lizhi/user/:id' }), { id: '251381', limit: 1000 })
    expect(r).toBe('/lizhi/user/251381?limit=1000')
  })

  it('does not duplicate a template-declared query', () => {
    const r = resolveRoute(mk({ route: '/feed/best?limit=20' }), { limit: 50 })
    expect(r).toBe('/feed/best?limit=20')
  })

  it('never leaks non-allowlisted params (engine-injected url)', () => {
    const r = resolveRoute(mk({ route: '/lizhi/user/:id' }), { id: '251381', url: 'https://lizhi.fm/user/251381', limit: 50 })
    expect(r).toBe('/lizhi/user/251381?limit=50')
    expect(r).not.toContain('url=')
  })

  it('adapter id is rsshub', () => {
    expect(new RssHubAdapter().id).toBe('rsshub')
  })

  /**
   * RSSHub 有两个来源（开发检出 / npm 包 `rsshub`）。**两个都不在**时 adapter 必须在 spawn
   * **之前**拒绝——以前它照样往下走，直到 worker 撞 ERR_MODULE_NOT_FOUND 才炸，还是以
   * unhandled rejection 的形式把整个后端带走。硬依赖之后这条路正常走不到，但它守的是
   * 「包被删了 / node_modules 没装」，那时用户要的是一句能读的错。
   */
  describe('declines when neither RSSHub source is present', () => {
    const absent = () =>
      new RssHubAdapter({ resolveDeps: { exists: () => false, hasTsx: () => false, resolvePackage: () => null } })

    it('init() refuses instead of spawning a worker', async () => {
      await expect(absent().init({})).rejects.toThrow(/找不到可用的 RSSHub/)
    })

    it('fetch() refuses instead of spawning a worker', async () => {
      await expect(absent().fetch({}, mk({ route: '/lizhi/user/:id', id: 'x' }))).rejects.toThrow(/找不到可用的 RSSHub/)
    })

    it('names both sources so the user knows which one to restore', async () => {
      await expect(absent().init({})).rejects.toThrow(/npm 包 `rsshub`/)
    })
  })

  /** 反面：只要解析得到，就**不许**拒绝——哪怕检出不在。 */
  it('accepts an already-resolvable RSSHub — no checkout needed', async () => {
    const adapter = new RssHubAdapter({
      resolveDeps: { exists: () => false, hasTsx: () => false, resolvePackage: () => '/n/rsshub/dist-lib/pkg.mjs' },
    })
    // ensureAvailable 是 init/fetch 的第一步；不抛就说明它放行了（真 spawn 由集成测试覆盖）。
    await expect(
      (adapter as unknown as { ensureAvailable(): Promise<void> }).ensureAvailable(),
    ).resolves.toBeUndefined()
  })

  /**
   * 发行安装的常态：本机还没有 RSSHub，第一次跑到这类源时**现装**（`rsshub-install.ts`）。
   * 这不是异常分支，是主路——所以它必须真的去装，而不是拒绝。
   *
   * 用例**绝不能真敲 npm**：那会起一个比测试活得久的子进程，qrun 的锁护不住它
   * （AGENTS.md 记着一次把 48GB 打穿的事故）。所以 install 是注入的。
   */
  describe('本机没有 RSSHub 时现装', () => {
    /** 装之前解析不到、装之后解析得到——就是真机上那条时间线。 */
    const withInstall = (installed: { at: string | null }, calls: string[]) =>
      new RssHubAdapter({
        resolveDeps: {
          exists: () => false,
          hasTsx: () => false,
          resolvePackage: () => null,
          dataDir: '/data',
          resolveDataDir: () => installed.at,
        },
        install: async (dataDir) => {
          calls.push(dataDir)
          installed.at = '/data/rsshub/node_modules/rsshub/dist-lib/pkg.mjs'
        },
      })

    it('装一次，然后放行（不是拒绝这条源）', async () => {
      const installed = { at: null as string | null }
      const calls: string[] = []
      const adapter = withInstall(installed, calls)
      await expect(
        (adapter as unknown as { ensureAvailable(): Promise<void> }).ensureAvailable(),
      ).resolves.toBeUndefined()
      expect(calls).toEqual(['/data'])
    })

    it('已经装好了就不再装（第二条源不该再等 40 秒）', async () => {
      const installed = { at: '/data/rsshub/node_modules/rsshub/dist-lib/pkg.mjs' }
      const calls: string[] = []
      const adapter = withInstall(installed, calls)
      await (adapter as unknown as { ensureAvailable(): Promise<void> }).ensureAvailable()
      expect(calls).toEqual([])
    })

    it('装失败 → 把 npm 的错原样抛出去（不是静默 decline）', async () => {
      const adapter = new RssHubAdapter({
        resolveDeps: {
          exists: () => false, hasTsx: () => false, resolvePackage: () => null, dataDir: '/data',
          resolveDataDir: () => null,
        },
        install: async () => {
          throw new Error('[rsshub] npm install 失败（退出码 1）：npm error code ENOTFOUND')
        },
      })
      await expect(adapter.init({})).rejects.toThrow(/ENOTFOUND/)
    })

    it('装完仍然解析不到 → 也要抛，别假装装好了', async () => {
      const adapter = new RssHubAdapter({
        resolveDeps: {
          exists: () => false, hasTsx: () => false, resolvePackage: () => null, dataDir: '/data',
          resolveDataDir: () => null,
        },
        install: async () => {},
      })
      await expect(adapter.init({})).rejects.toThrow(/装完之后仍然找不到/)
    })
  })
})

/**
 * 长尾目录（~3900 条路由）在发行安装上**整段缺席**过：`assets/build/routes.json` 是开发检出的
 * 构建产物，不在 npm tarball 里（活体 2026-09-04，win-test：`0 RSSHub catalog sources`）。
 * 现在它由 adapter 在一次真的取数之后顺手重取——那时 worker 已经热着。
 */
describe('取数之后顺手刷长尾目录', () => {
  const ok = { resolvePackage: () => '/fixture/rsshub.mjs' }
  const manifest = mk({ route: '/lizhi/user/:id', id: 'x' })

  const mkAdapter = (opts: {
    needsRefresh: boolean
    request: (path: string) => Promise<unknown>
    applied: Record<string, unknown>[]
    log?: (m: string) => void
  }) =>
    new RssHubAdapter({
      resolveDeps: ok,
      request: opts.request,
      log: opts.log,
      catalog: {
        needsRefresh: () => opts.needsRefresh,
        apply: (raw) => opts.applied.push(raw),
      },
    })

  it('缓存过期 → 取一次 /api/namespace 并交给 registry', async () => {
    const applied: Record<string, unknown>[] = []
    const paths: string[] = []
    const adapter = mkAdapter({
      needsRefresh: true,
      applied,
      request: async (path) => {
        paths.push(path)
        return path === '/api/namespace' ? { bilibili: { routes: {} } } : { item: [] }
      },
    })
    await adapter.fetch({ id: '1' }, manifest)
    expect(paths).toEqual(['/lizhi/user/1', '/api/namespace'])
    expect(applied).toEqual([{ bilibili: { routes: {} } }])
  })

  it('缓存还新 → 一次都不取（别为一份没过期的目录多跑一趟）', async () => {
    const applied: Record<string, unknown>[] = []
    const paths: string[] = []
    const adapter = mkAdapter({
      needsRefresh: false,
      applied,
      request: async (path) => {
        paths.push(path)
        return { item: [] }
      },
    })
    await adapter.fetch({ id: '1' }, manifest)
    expect(paths).toEqual(['/lizhi/user/1'])
    expect(applied).toEqual([])
  })

  /** 目录旧几天没人会死；一条源因为刷目录失败而取不到数才是真的坏。 */
  it('刷目录失败 → 这次取数照样成功，只记一行日志', async () => {
    const logs: string[] = []
    const adapter = mkAdapter({
      needsRefresh: true,
      applied: [],
      log: (m) => logs.push(m),
      request: async (path) => {
        if (path === '/api/namespace') throw new Error('worker 挂了')
        return { item: [{ id: 'a' }] }
      },
    })
    const out = await adapter.fetch({ id: '1' }, manifest)
    expect(out.items).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/长尾目录这次没刷成/)
  })

  it('取回来是空的 → 不往 registry 灌空目录（那等于把长尾清掉）', async () => {
    const applied: Record<string, unknown>[] = []
    const adapter = mkAdapter({
      needsRefresh: true,
      applied,
      request: async (path) => (path === '/api/namespace' ? {} : { item: [] }),
    })
    await adapter.fetch({ id: '1' }, manifest)
    expect(applied).toEqual([])
  })
})
