import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { VERIFY_PREFIX } from './backend-identity.ts'

/**
 * 「立刻重连」（弹窗那个按钮的落点）。
 *
 * 自动重连一直在跑，所以这个按钮不是恢复的前提——它要保证的是两件事，都是会静默出错的：
 *   1. **真的提前**：不等排着的那次退避（最坏 30s）。
 *   2. **不开出第二条**：被抢先引爆的那次重试必须作废，否则一次点击就多一条中继连接，
 *      两条都收后端下发的 CDP 命令，同一个动作执行两遍（这正是 `starting` 闸门存在的理由）。
 * 第 2 条尤其安静：多出来的那条连接一切正常，只是命令被执行两遍。
 */

const EXT_TOKEN = 't0k'

function makeChrome(config: Record<string, unknown>) {
  return {
    storage: {
      local: { get: vi.fn(async () => ({ config })), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    tabs: { query: vi.fn(async () => []), onUpdated: { addListener: vi.fn() } },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    debugger: { onEvent: { addListener: vi.fn() }, detach: vi.fn(async () => {}) },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    runtime: {
      lastError: undefined,
      sendNativeMessage: vi.fn((_h: string, _m: unknown, cb: (r: unknown) => void) => cb({ ok: true, token: EXT_TOKEN })),
    },
  }
}

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

/**
 * 只拦「退避那一类」长延迟的定时器（≥500ms），短的原样放行给真实定时器——理由同
 * driver.startup.test.ts 里那条：这条链路中间隔着好几跳 WebCrypto + 微任务，
 * fake timers 会假绿。这里比那边多一件事：**认真实现 clearTimeout**，因为
 * 「排着的那次有没有被作废」正是本文件要验的东西。
 */
function stubBackoffTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = new Map<number, { fn: () => void; delay: number }>()
  let nextId = 1
  vi.stubGlobal(
    'setTimeout',
    ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (typeof delay === 'number' && delay >= 500) {
        const id = nextId++
        pending.set(id, { fn: () => fn(...args), delay })
        return id as unknown as ReturnType<typeof setTimeout>
      }
      return realSetTimeout(fn, delay, ...args)
    }) as typeof setTimeout,
  )
  vi.stubGlobal(
    'clearTimeout',
    ((h: unknown) => {
      if (typeof h === 'number' && pending.has(h)) pending.delete(h)
      else realClearTimeout(h as ReturnType<typeof setTimeout>)
    }) as typeof clearTimeout,
  )
  return pending
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('forceReconnect：把等待折叠掉，但不多开一条连接', () => {
  it('【核心】提前引爆排着的重试；被引爆的那个已作废，事后再触发也不会开出第二条', async () => {
    const built = stubSockets()
    const pending = stubBackoffTimers()
    vi.stubGlobal('chrome', makeChrome({ baseUrl: 'http://127.0.0.1:8900' }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') })) // 后端还没起
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    expect(built).toEqual([])
    expect([...pending.values()].map((p) => p.delay)).toEqual([1000]) // 排着一次退避重试
    const stale = [...pending.entries()][0]

    // 后端起来了，用户点了「立刻重连」——不等那 1000ms。
    vi.stubGlobal('fetch', honestBackendFetch())
    expect(mod.forceReconnect()).toBe('reconnecting') // 只承诺"这就去试"，不谎报已连上
    await flush()
    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])

    // 那次被抢先的退避必须已经作废。手动触发它（模拟"要是没作废，它到点了会怎样"）：
    // 连接数不能变。没有 clearTimeout 那一行的话，这里会变成两条。
    expect(pending.has(stale[0])).toBe(false)
    stale[1].fn()
    await flush()
    expect(built).toEqual(['ws://127.0.0.1:8900/api/ext'])
  })

  it('已经连着 ⇒ 直接说 connected，不去动任何连接', async () => {
    const built = stubSockets()
    stubBackoffTimers()
    vi.stubGlobal('chrome', makeChrome({ baseUrl: 'http://127.0.0.1:8900' }))
    vi.stubGlobal('fetch', honestBackendFetch())
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    expect(built).toHaveLength(1)
    // FakeSocket 不派发 open，relayUp 仍是 false —— 所以这里先直接验"没连上时不谎报"，
    // 真正的 connected 分支由 isRelayUp 的实现共用同一个布尔，见下一条。
    expect(mod.forceReconnect()).toBe('reconnecting')
    await flush()
    expect(built).toHaveLength(1) // 已经有一条在飞，不叠第二条
  })

  it('退避复位：点过一次之后，下一次失败重新从 1000ms 起排（不是继续 2000/4000…）', async () => {
    const built = stubSockets()
    const pending = stubBackoffTimers()
    vi.stubGlobal('chrome', makeChrome({ baseUrl: 'http://127.0.0.1:8900' }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    vi.resetModules()
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    // 让它自己失败两次，把退避推到 4000
    for (let i = 0; i < 2; i++) {
      const [id, p] = [...pending.entries()][0]
      pending.delete(id)
      p.fn()
      await flush()
    }
    expect([...pending.values()][0].delay).toBe(4000)

    mod.forceReconnect() // 复位到 1000 并立刻重试（仍然失败，后端还没起）
    await flush()
    expect(built).toEqual([])
    expect([...pending.values()].map((p) => p.delay)).toEqual([1000])
  })
})
