import { describe, it, expect, vi } from 'vitest'

// `cookiePull` = 后端主动来取登录态的那一口，取代了扩展定时往后端推。
//
// **这里唯一要钉死的是范围闸**：请求方（后端）说要哪些域不算数，只有扩展自己申报过的同步域
// 才给。理由不是不信任那个后端——身份校验挡的是常态，不是全部；而是一个"请求方自己定范围"
// 的接口等于没有范围，将来任何一次身份校验被绕过就是整个浏览器的 cookie 一把梭。
function makeChrome(
  config: Record<string, unknown>,
  cookies: Array<{ name: string; value: string; domain: string }>,
  opts: { noAccess?: string[] } = {},
) {
  const local: Record<string, unknown> = { config }
  return {
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: {
        get: vi.fn(async (k: string) => (k in local ? { [k]: local[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(local, o) }),
      },
      onChanged: { addListener: vi.fn() },
    },
    cookies: {
      getAll: vi.fn(async ({ domain }: { domain: string }) =>
        cookies.filter((c) => c.domain === domain || c.domain === '.' + domain),
      ),
    },
    tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    tabGroups: { onRemoved: { addListener: vi.fn() } },
    debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => !(opts.noAccess ?? []).some((d) => origins[0] === `*://*.${d}/*`)),
    },
    _local: local,
  }
}

const COOKIES = [
  { name: 'sid', value: 'quark-secret', domain: '.quark.cn' },
  { name: 'a1', value: 'xhs-secret', domain: '.xiaohongshu.com' },
  { name: 'tok', value: 'bank-secret', domain: '.mybank.example' },
]

async function load(config: Record<string, unknown>, opts: { noAccess?: string[] } = {}) {
  const chrome = makeChrome(config, COOKIES, opts)
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return { ...(await import('./driver.ts')), local: chrome._local }
}

/** 用户填了 xiaohongshu，Stream 申报了 quark —— 范围是两者的并集，mybank 不在里面。 */
const CONFIG = { domains: ['xiaohongshu.com'], requiredDomains: ['quark.cn'], autoSync: true }

type PullResult = { cookies: Record<string, Array<Record<string, unknown>>>; refused: string[]; noAccess: string[] }

describe('dispatch op:cookiePull', () => {
  it('申报过的域连值一起给（后端要的就是值）', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 1, op: 'cookiePull', domains: ['quark.cn'] })
    const out = res.result as PullResult
    expect(Object.keys(out.cookies)).toEqual(['quark.cn'])
    expect(out.cookies['quark.cn'][0]).toMatchObject({ name: 'sid', value: 'quark-secret' })
  })

  it('用户填的和 Stream 申报的都算数（并集，不是二选一）', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 2, op: 'cookiePull', domains: ['quark.cn', 'xiaohongshu.com'] })
    expect(Object.keys((res.result as PullResult).cookies).sort()).toEqual(['quark.cn', 'xiaohongshu.com'])
  })

  // 整件事的红线：范围外的域，一个字节都不能出去。
  it('【核心】范围外的域一个字都不给，哪怕后端点名要', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 3, op: 'cookiePull', domains: ['mybank.example'] })
    expect((res.result as PullResult).cookies).toEqual({})
    expect(JSON.stringify(res)).not.toContain('bank-secret')
  })

  // 静默丢弃会让后端把"没权限"读成"用户没登录"——两者的修法完全不同。
  it('被拒的域要明说，不能静默丢掉', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 4, op: 'cookiePull', domains: ['quark.cn', 'mybank.example'] })
    expect((res.result as PullResult).refused).toEqual(['mybank.example'])
  })

  it('范围为空（还没同步过）→ 什么都不给，fail-closed', async () => {
    const { dispatch } = await load({ domains: [], requiredDomains: [], autoSync: true })
    const res = await dispatch({ id: 5, op: 'cookiePull', domains: ['quark.cn'] })
    expect((res.result as PullResult).cookies).toEqual({})
    expect((res.result as PullResult).refused).toEqual(['quark.cn'])
  })

  it('子域也算在范围内（cookie 域带点/不带点都要能对上）', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 6, op: 'cookiePull', domains: ['drive.quark.cn'] })
    expect((res.result as PullResult).refused).toEqual([])
  })

  it('hostOnly 必须随值一起回去——丢了它注入回去就是全程游客态', async () => {
    const { dispatch } = await load(CONFIG)
    const res = await dispatch({ id: 7, op: 'cookiePull', domains: ['quark.cn'] })
    expect((res.result as PullResult).cookies['quark.cn'][0]).toHaveProperty('hostOnly')
  })

  // 站点权限按 profile 记（用户可以在 chrome://extensions 里把站点访问收成「点击时」）。没权限时 getAll 静默回空，
  // 后端会读成「没登录」——所以单独说出来。
  it('范围里但这个 profile 没给站点权限的域：不读，报 noAccess', async () => {
    const { dispatch } = await load(CONFIG, { noAccess: ['quark.cn'] })
    const res = await dispatch({ id: 8, op: 'cookiePull', domains: ['quark.cn', 'xiaohongshu.com', 'mybank.example'] })
    const out = res.result as PullResult
    expect(Object.keys(out.cookies)).toEqual(['xiaohongshu.com'])
    expect(out.refused).toEqual(['mybank.example'])
    expect(out.noAccess).toEqual(['quark.cn'])
  })

  it('没给的域记进 cookieGaps，弹窗据此给一键修；给齐了就清掉', async () => {
    const { dispatch, local } = await load(CONFIG, { noAccess: ['quark.cn'] })
    await dispatch({ id: 9, op: 'cookiePull', domains: ['quark.cn', 'mybank.example'] })
    expect(local.cookieGaps).toMatchObject({ local: { refused: ['mybank.example'], noAccess: ['quark.cn'] } })
    await dispatch({ id: 10, op: 'cookiePull', domains: ['xiaohongshu.com'] })
    expect(local.cookieGaps).toEqual({})
  })

  // 新 profile 第一次连上：后端那一轮取数可能先于 runSync 把 requiredDomains 缓存下来，于是全被拒、快照是空的，
  // 身份探测读成「没登录」。缺的先向本机 Stream 重读一次同步范围再判。
  it('本机绑定：范围缓存里缺的域先重读一次 sync-config 再判', async () => {
    const fetchMock = vi.fn(async (_u: string) => ({ ok: true, json: async () => ({ configured: true, requiredDomains: ['quark.cn', 'bilibili.com'] }) }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { dispatch, local } = await load({ baseUrl: 'http://127.0.0.1:8900', domains: [], autoSync: true })
      const res = await dispatch({ id: 11, op: 'cookiePull', domains: ['quark.cn', 'mybank.example'] })
      expect(fetchMock.mock.calls.map(([u]) => u)).toContain('http://127.0.0.1:8900/api/ext/sync-config')
      expect((res.result as PullResult).refused).toEqual(['mybank.example'])
      expect(Object.keys((res.result as PullResult).cookies)).toEqual(['quark.cn'])
      expect((local.config as { requiredDomains: string[] }).requiredDomains).toEqual(['quark.cn', 'bilibili.com'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
