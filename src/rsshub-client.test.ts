import { afterEach, describe, expect, it } from 'vitest'
import { RsshubClient, resolveRsshubPkg, rsshubUnavailableReason, execArgvForEntry } from './rsshub-client.ts'

/**
 * Transport contract for the worker RPC — tested against the echo fixture (no RSSHub, no network).
 * What matters here is the boundary the real harness also relies on: responses match their request
 * by correlation id even when interleaved, an error reply rejects only its own call, a worker crash
 * rejects in-flight calls yet the next call transparently respawns, and accumulated env is replayed
 * into a respawned worker (cookie hot-reload survives a crash).
 */
const ECHO = new URL('./__fixtures__/rsshub-echo-worker.ts', import.meta.url)

let client: RsshubClient | null = null
const make = () => {
  client = new RsshubClient({ entry: ECHO, pkgPath: 'unused' })
  return client
}
afterEach(async () => {
  await client?.dispose()
  client = null
})

describe('RsshubClient worker transport', () => {
  it('round-trips a request and echoes the path back', async () => {
    const data = await make().request('bilibili/user/dynamic/2267573')
    expect(data).toEqual({ echo: 'bilibili/user/dynamic/2267573', env: {} })
  })

  it('matches responses to requests by id when they interleave', async () => {
    const c = make()
    // __slow__ replies after 50ms; the fast one replies immediately. If correlation were by
    // arrival order instead of id, the fast reply would wrongly resolve the slow promise.
    const slow = c.request('__slow__')
    const fast = c.request('juejin/trending')
    expect(await fast).toEqual({ echo: 'juejin/trending', env: {} })
    expect(await slow).toEqual({ echo: '__slow__', env: {} })
  })

  it('rejects only the failing call, not its neighbours', async () => {
    const c = make()
    const bad = c.request('__error__')
    const good = c.request('ok/path')
    await expect(bad).rejects.toThrow('boom')
    expect(await good).toEqual({ echo: 'ok/path', env: {} })
  })

  it('rejects in-flight calls when the worker crashes', async () => {
    await expect(make().request('__crash__')).rejects.toThrow(/exit/i)
  })

  it('respawns transparently after a crash', async () => {
    const c = make()
    await expect(c.request('__crash__')).rejects.toThrow(/exit/i)
    // Next call must spin up a fresh worker rather than staying dead.
    expect(await c.request('after/crash')).toEqual({ echo: 'after/crash', env: {} })
  })

  it('replays accumulated env into a respawned worker (cookie survives a crash)', async () => {
    const c = make()
    await c.init({ BILIBILI_COOKIE: 'sess=abc' })
    expect(await c.request('r1')).toEqual({ echo: 'r1', env: { BILIBILI_COOKIE: 'sess=abc' } })
    await expect(c.request('__crash__')).rejects.toThrow(/exit/i)
    // The respawned worker was cookieless until the client replayed init — assert it isn't.
    expect(await c.request('r2')).toEqual({ echo: 'r2', env: { BILIBILI_COOKIE: 'sess=abc' } })
  })

  it('accumulates env across successive init calls', async () => {
    const c = make()
    await c.init({ A: '1' })
    await c.init({ B: '2' })
    expect(await c.request('r')).toEqual({ echo: 'r', env: { A: '1', B: '2' } })
  })

  /**
   * 发行形态（npm 包，没有 tsx / 没有 RSSHub 检出）里 worker 根本起不来。那条失败路径 reject
   * **每一个** pending promise，其中 `ready` 有一份是没人 await 的孤儿（ensureWorker 从 post()
   * 内部写的那份，随后又被 init() 覆盖）——一条没人接的 rejection 就是 unhandled，会把整个
   * 后端进程带走。这里断言：worker 起不来时调用方照样拿到错误，但**没有任何 unhandled rejection**。
   */
  const spawnFailures: Array<[string, () => RsshubClient]> = [
    [
      'entry module missing',
      () => new RsshubClient({ entry: new URL('./__fixtures__/no-such-worker.ts', import.meta.url), pkgPath: 'unused' }),
    ],
    [
      'the tsx loader in execArgv is unresolvable (the release-package shape)',
      () => new RsshubClient({ entry: ECHO, pkgPath: 'unused', execArgv: ['--import', 'tsx-does-not-exist'] }),
    ],
  ]
  for (const [label, mkBroken] of spawnFailures) {
    it(`never orphans a rejected promise when ${label}`, async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        client = mkBroken()
        // init() is the real first caller (scheduler → adapter.init → client.init).
        await expect(client.init({ A: '1' })).rejects.toThrow()
        await expect(client.request('anything')).rejects.toThrow()
        // Node emits 'unhandledRejection' at a microtask checkpoint — give it turns to fire.
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10))
        expect(unhandled.map(String)).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  }
})

/**
 * RSSHub 的两个来源：开发检出（TS 源码，要 tsx）与 npm 包 `rsshub`（预构建 .mjs，不要 tsx）。
 * 顺序不能反——检出在场时它必须赢，否则本仓库改的 RSSHub 路由永远跑不到（改了没反应，
 * 而 npm 包那份看起来一切正常）。
 */
describe('RSSHub 解析顺序：开发检出 > npm 包', () => {
  const pkg = () => '/n/rsshub/dist-lib/pkg.mjs'

  it('未配置开发检出时不虚构作者机器路径，仍可落到已安装的 npm 包', () => {
    expect(
      resolveRsshubPkg({ checkoutPath: undefined, exists: () => false, hasTsx: () => false, resolvePackage: pkg }),
    ).toEqual({ path: pkg(), source: 'package' })
    expect(
      rsshubUnavailableReason({ checkoutPath: undefined, exists: () => false, hasTsx: () => false, resolvePackage: () => null }),
    ).not.toContain(['/home', 'jagger'].join('/'))
  })

  it('检出在场（且有 tsx）时用检出，不用 npm 包', () => {
    expect(
      resolveRsshubPkg({ checkoutPath: '/co/lib/pkg.ts', exists: () => true, hasTsx: () => true, resolvePackage: pkg }),
    ).toEqual({ path: '/co/lib/pkg.ts', source: 'checkout' })
  })

  it('检出不在时落到 npm 包（发行安装的常态）', () => {
    expect(
      resolveRsshubPkg({ checkoutPath: '/co/lib/pkg.ts', exists: () => false, hasTsx: () => true, resolvePackage: pkg }),
    ).toEqual({ path: pkg(), source: 'package' })
  })

  it('检出在但没有 tsx → 落到 npm 包，而不是拿一条注定 spawn 失败的路', () => {
    expect(
      resolveRsshubPkg({ checkoutPath: '/co/lib/pkg.ts', exists: () => true, hasTsx: () => false, resolvePackage: pkg }),
    ).toEqual({ path: pkg(), source: 'package' })
  })

  it('两个都不在 → null，且 unavailable 理由把两个来源都点名', () => {
    const deps = { checkoutPath: '/co/lib/pkg.ts', exists: () => false, hasTsx: () => false, resolvePackage: () => null }
    expect(resolveRsshubPkg(deps)).toBeNull()
    expect(rsshubUnavailableReason(deps)).toMatch(/\/co\/lib\/pkg\.ts/)
    expect(rsshubUnavailableReason(deps)).toMatch(/rsshub/)
  })

  it('任一来源在场 → 不报不可用', () => {
    const base = { checkoutPath: '/co/lib/pkg.ts', exists: () => false, hasTsx: () => false }
    expect(rsshubUnavailableReason({ ...base, resolvePackage: pkg })).toBeNull()
    expect(
      rsshubUnavailableReason({ ...base, exists: () => true, hasTsx: () => true, resolvePackage: () => null }),
    ).toBeNull()
  })
})

/**
 * `--import tsx` **只为 worker 入口自己是 TypeScript 那一档**。发行包里入口是预构建的
 * `rsshub-worker.mjs` 且没有 tsx——多加这两个参数就是 100% 的 ERR_MODULE_NOT_FOUND，
 * 而且失败得极晚（要到用户机器上第一次采集才现）。
 */
describe('worker 的 execArgv 按入口决定', () => {
  it('.ts 入口（源码形态）才加 --import tsx', () => {
    expect(execArgvForEntry(new URL('file:///s/src/rsshub-worker.ts'))).toEqual(['--import', 'tsx'])
  })

  it('.mjs 入口（发行形态）一个参数都不加', () => {
    expect(execArgvForEntry(new URL('file:///s/resources/rsshub-worker.mjs'))).toEqual([])
  })

  it('客户端默认就吃这条规则（.mjs 入口不会被塞进 tsx）', () => {
    const c = new RsshubClient({ entry: new URL('file:///s/resources/rsshub-worker.mjs'), pkgPath: 'unused' })
    expect((c as unknown as { execArgv: string[] }).execArgv).toEqual([])
  })
})

/** 第 2 档（`<dataDir>/rsshub/`）：发行安装用到 RSSHub 源时现装的落点。 */
describe('RSSHub 解析顺序：检出 > dataDir > npm 包', () => {
  const pkg = () => '/n/rsshub/dist-lib/pkg.mjs'
  const installed = '/data/rsshub/node_modules/rsshub/dist-lib/pkg.mjs'
  const base = { checkoutPath: '/co/lib/pkg.ts', exists: () => false, hasTsx: () => false }

  it('检出不在、dataDir 里装了 → 用 dataDir 那份', () => {
    expect(
      resolveRsshubPkg({ ...base, dataDir: '/data', resolveDataDir: () => installed, resolvePackage: pkg }),
    ).toEqual({ path: installed, source: 'datadir' })
  })

  it('检出赢过 dataDir（本仓库改的 RSSHub 路由必须跑得到）', () => {
    expect(
      resolveRsshubPkg({
        ...base,
        exists: () => true,
        hasTsx: () => true,
        dataDir: '/data',
        resolveDataDir: () => installed,
      }),
    ).toEqual({ path: '/co/lib/pkg.ts', source: 'checkout' })
  })

  it('dataDir 里还没装 → 继续往下落到 npm 包', () => {
    expect(
      resolveRsshubPkg({ ...base, dataDir: '/data', resolveDataDir: () => null, resolvePackage: pkg }),
    ).toEqual({ path: pkg(), source: 'package' })
  })

  it('三个都不在 → 理由里点名 dataDir，用户才知道它本该装在哪', () => {
    const deps = { ...base, dataDir: '/data', resolveDataDir: () => null, resolvePackage: () => null }
    expect(resolveRsshubPkg(deps)).toBeNull()
    expect(rsshubUnavailableReason(deps)).toMatch(/\/data\/rsshub/)
  })
})

/**
 * **解析必须每次 spawn 现问，不能在建对象时定死。**
 *
 * 发行形态下 RSSHub 是用到那条源才装的，而这个 client 是模块级单例、在任何源跑起来之前就建好了：
 * 构造那一刻问到的答案必然是「没有」。把它存下来 = 宣称「这台机器永远没有 RSSHub」——装完了也
 * 还是没有，且**不报错**，只是每条源都跑不了。（AGENTS.md「装配期取的值 = 冻住的答案」。）
 *
 * 这条的牙：把 `resolveNow()` 改回构造期解析一次，它必须变红。
 */
describe('client 每次 spawn 现解析（装完就跟得上）', () => {
  it('建对象时没装、之后装上了 → worker 拿到的是装完那一份', async () => {
    let installed: string | null = null
    const c = new RsshubClient({
      entry: ECHO,
      resolveDeps: {
        checkoutPath: '/co/lib/pkg.ts',
        exists: () => false,
        hasTsx: () => false,
        dataDir: '/data',
        resolveDataDir: () => installed,
        resolvePackage: () => null,
      },
    })
    installed = '/data/rsshub/node_modules/rsshub/dist-lib/pkg.mjs'
    try {
      expect(await c.request('__workerdata__')).toEqual({ pkgPath: installed, pkgSource: 'datadir' })
    } finally {
      await c.dispose()
    }
  })
})
