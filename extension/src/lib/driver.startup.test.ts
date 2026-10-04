import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { VERIFY_PREFIX } from './backend-identity.ts'

// ── 「Chrome 一起来就连中继」的去重 ──
// 采集搬到用户自己的 Chrome 之后，定时采集的前提是「浏览器活着 **且 relay 已连**」，于是
// background 除了 SW 顶层那次启动，还加了 chrome.runtime.onStartup 这个入口。浏览器启动时
// 这两件事**同时**发生（顶层脚本先跑，紧接着 onStartup 派发），不去重就会开出两条中继连接，
// 两条都收后端下发的 CDP 命令 —— 同一个动作被执行两遍。
//
// 所以 startExtCdp 必须「每个 SW 实例只启动一次」。作用域正好是模块生命周期：SW 被回收，
// 模块状态跟着没，下次唤醒理应重连。

function makeChrome(config: Record<string, unknown> | undefined) {
  return {
    storage: {
      local: { get: vi.fn(async () => (config ? { config } : {})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    tabs: { query: vi.fn(async () => []), onUpdated: { addListener: vi.fn() } },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    debugger: { onEvent: { addListener: vi.fn() }, detach: vi.fn(async () => {}) },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    // token 现在从 native host 取（不再向后端索取），连线前必经这一步。
    runtime: {
      lastError: undefined,
      sendNativeMessage: vi.fn((_host: string, _msg: unknown, cb: (r: unknown) => void) =>
        cb({ ok: true, token: EXT_TOKEN }),
      ),
    },
  }
}

const EXT_TOKEN = 't0k'

/** 一个「诚实的后端」：能用同一把 token 算出 proof，所以 verifyBackend 放行。 */
function honestBackendFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        proof: createHmac('sha256', EXT_TOKEN).update(`${VERIFY_PREFIX}${nonce}`).digest('hex'),
      }),
    }
  })
}

/** 记录被 new 出来的 WebSocket 条数 —— 「开了几条连接」的直接证据。 */
function stubSockets() {
  const built: string[] = []
  class FakeSocket {
    constructor(url: string) {
      built.push(url)
    }
    addEventListener() {}
    send() {}
  }
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
  return built
}

/** connect 在 startExtCdp 返回之后才取 token、验后端身份、才 new WebSocket —— 等它落地再断言。
 *  中间隔着 native messaging 回调 + 一次 fetch + 两次 WebCrypto，所以要多让几拍。 */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadModule(config: Record<string, unknown> | undefined) {
  vi.stubGlobal('chrome', makeChrome(config))
  vi.stubGlobal('fetch', honestBackendFetch())
  vi.resetModules()
  return import('./driver.ts')
}

describe('startExtCdp：每个 SW 实例只连一条中继', () => {
  it('【核心】顶层启动 + onStartup 同时调 → 只开出一条 WS', async () => {
    const built = stubSockets()
    const mod = await loadModule({ baseUrl: 'http://127.0.0.1:8900' })

    await Promise.all([mod.startExtCdp(), mod.startExtCdp()])
    await mod.startExtCdp() // 迟到的第三个入口同样不该再开一条
    await flush()

    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])
  })

  it('配对失败不算启动过 —— 下一次事件（如后端起来了）仍能重试', async () => {
    // 曾经这里测的是「没配 baseUrl 就不探测，配好之后才连」——那条判据随 detectStreamUrl
    // 一起被换掉了：发现现在每次启动都用配对证明说话，不管 baseUrl 配没配（见 start() 头注
    // 的"代装扩展"那段）。这里改测同一个真正的不变量：配对失败时 `starting` 闸门要放回去，
    // 下一次事件才不会被"上一次已经启动过"卡死。
    const built = stubSockets()
    const chromeStub = makeChrome({ baseUrl: 'http://127.0.0.1:8900' })
    vi.stubGlobal('chrome', chromeStub)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') })) // 后端还没起
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    expect(built).toEqual([])

    // 后端起来了；下一次事件（浏览器唤醒等）重新调用 startExtCdp 必须能重试并连上
    vi.stubGlobal('fetch', honestBackendFetch())
    await mod.startExtCdp()
    await flush()
    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])
  })

  it('配对失败自己挂一次退避重试 —— 不必等任何别的事件（Chrome 自启动、后端还没就绪的窗口期）', async () => {
    // 上一条用例验的是"下一次事件能重试"；这条钉的是真正的回归点：Chrome 随 Windows 登录
    // 自启动、后端 40s 后才起来，这中间**没有任何别的事件会来**（周期闹钟已退役，见
    // background.ts 头注）——如果失败只是把 starting 闸门放回去就 return，那就再没有任何东西
    // 会去调用第二次 startExtCdp，扩展从此静默停摆。这里全程不手动再调 startExtCdp——只截住
    // 它自己排的那个退避 setTimeout，验证它存在、且真到点执行时能重试并连上。
    //
    // 不用 vi.useFakeTimers()：`start()`/`connect()`/`verifyBackend()` 之间隔着好几跳
    // WebCrypto + Promise 微任务，fake timer 的 `advanceTimersByTimeAsync` 不保证把它们
    // 全部冲干净（实测会在这条链路中间假绿成"没连上"）。改成只拦截"退避那一类"长延迟的
    // setTimeout 调用（真实 setTimeout 太慢，测试不等它），短延迟的（`flush` 用的 0ms 等）
    // 原样放行给真实定时器，两者互不干扰。
    const built = stubSockets()
    vi.stubGlobal('chrome', makeChrome({ baseUrl: 'http://127.0.0.1:8900' }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') })) // 后端还没起
    const realSetTimeout = globalThis.setTimeout
    const capturedRetries: Array<{ fn: () => void; delay: number }> = []
    vi.stubGlobal(
      'setTimeout',
      ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (typeof delay === 'number' && delay >= 500) {
          capturedRetries.push({ fn: () => fn(...args), delay })
          return 0 as unknown as ReturnType<typeof setTimeout>
        }
        return realSetTimeout(fn, delay, ...args)
      }) as typeof setTimeout,
    )
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    expect(built).toEqual([])
    // 这是本条用例的核心断言：失败必须自己排一次退避重试，delay 与 connect() 用的是
    // 同一个起步值（1000ms）——没有这次修复，这里应为 0（一个都没排）。
    expect(capturedRetries).toHaveLength(1)
    expect(capturedRetries[0].delay).toBe(1000)

    // 后端起来了，触发那个被截住的重试回调（模拟它自然到点）——不手动再调 startExtCdp。
    vi.stubGlobal('fetch', honestBackendFetch())
    capturedRetries[0].fn()
    await flush()
    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])
  })
})

// ── 配对闸门 ──
// 这条通道的能力等于「用户的全部登录态」。握手会把 token 放进 Sec-WebSocket-Protocol，
// 所以**连上去这个动作本身就是在交出 secret**——必须先确认对端是谁。下面两条各钉一半。
describe('连之前先确认对端是我们那台 Stream', () => {
  it('对端算不出 proof（冒充者抢了这个口）→ 一条 WS 都不开', async () => {
    const built = stubSockets()
    vi.stubGlobal('chrome', makeChrome({ baseUrl: 'http://127.0.0.1:8900' }))
    // 抢到 8900 的进程读不到 data/ext-relay-token，只能瞎编一个 proof
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ proof: 'f'.repeat(64) }) })),
    )
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()

    expect(built).toEqual([])
  })

  it('native host 不在（还没 --register）→ 也是一条都不开，**绝不回退去问后端要 token**', async () => {
    const built = stubSockets()
    const chromeStub = makeChrome({ baseUrl: 'http://127.0.0.1:8900' })
    chromeStub.runtime.sendNativeMessage = vi.fn((_h: string, _m: unknown, cb: (r: unknown) => void) => {
      chromeStub.runtime.lastError = { message: 'Specified native messaging host not found.' } as never
      cb(undefined as never)
    })
    vi.stubGlobal('chrome', chromeStub)
    const fetchSpy = honestBackendFetch()
    vi.stubGlobal('fetch', fetchSpy)
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()

    expect(built).toEqual([])
    // 回退那条路一旦存在，这道锁就是装饰品：冒充者只要让 native 失败就能拿回旧行为。
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/api/ext/token'))).toBe(false)
  })
})

// ── 刚装上的扩展要自己找到后端 ──
// 「代装扩展」那条链路的最后一步：AI 把扩展装进用户的 Chrome，用户**什么都不用点**。
// baseUrl 的默认值是空串——曾经探测只写在 popup 里，于是扩展静默地不连，且两端各自都正常
// （卡片在、native host 也给得出 token）。实测 2026-08-31（win-test）撞到的就是它，连 debug
// bus 都是空的：`debugLog` 自己也要 baseUrl 才发得出去。修法是发现挪进 start()、每次启动都跑，
// 且候选表里本来就有 `PROBE_CANDIDATES` 兜底——baseUrl 是空的也照样能配对成功，不必等 popup。
describe('全新安装：没配后端地址时自己配对一次', () => {
  it('配对成功 → 存下来并连上（不必等用户打开 popup）', async () => {
    const built = stubSockets()
    // storage 要**有状态**：配对成功后自己把 baseUrl 写回去，紧接着的 getConfig 必须读到它。
    // 用一个无状态的 stub，这条用例会以"发现没生效"的样子假绿。
    const chromeStub = makeChrome(undefined)
    let stored: Record<string, unknown> | undefined
    chromeStub.storage.local.get = vi.fn(async () => (stored ? { config: stored } : {}))
    const setSpy = vi.fn(async (v: { config: Record<string, unknown> }) => { stored = v.config })
    chromeStub.storage.local.set = setSpy as never
    vi.stubGlobal('chrome', chromeStub)
    // 发现不再分两阶段（探端点 → 再验身份），候选就直接过挑战应答，honest 这一份就够。
    vi.stubGlobal('fetch', honestBackendFetch())
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()

    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ baseUrl: 'http://127.0.0.1:8900' }) }),
    )
    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])
  })

  it('探不到（后端没起）→ 一条都不开，且闸放回去让下次事件再试', async () => {
    const built = stubSockets()
    vi.stubGlobal('chrome', makeChrome(undefined))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()

    expect(built).toEqual([])
  })
})
