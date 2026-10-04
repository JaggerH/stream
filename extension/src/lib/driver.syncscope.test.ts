import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { VERIFY_PREFIX } from './backend-identity.ts'

// ── 同步域名单（requiredDomains）唯一的主动更新路径 ──
//
// 那份名单是 `cookiePull` 的范围闸：后端能取到哪些域的登录态，由它说了算。它由后端下发，
// 但扩展这边只在 `runSync` 里更新——而 `runSync` 唯一的触发是"某个**已在名单里**的域 cookie
// 变了"。于是后端新增一个需要的域之后，扩展永远等不到更新：新域不在名单里，它的 cookie 变更
// 进不了那道门。鸡生蛋。
//
// 漏一个域的表现是**静默且会误导**：那个域被范围闸拒掉，后端只看到"一条 cookie 都没有"，
// 报成"用户没登录"。活体撞到过（eastmoneysec 刚进名单那次，一路查到扩展的缓存才明白）。
//
// 所以：**中继连上就刷一次**。这条测试钉的就是"连上那一刻真的刷了"。

const EXT_TOKEN = 't0k'

vi.mock('./sync.ts', () => ({ runSync: vi.fn(async () => ({ reason: 'nudged', counts: {} })) }))

function makeChrome() {
  return {
    storage: {
      local: { get: vi.fn(async () => ({ config: { baseUrl: 'http://127.0.0.1:8900' } })), set: vi.fn(async () => {}) },
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

/** 记下 open 监听器，好在断言时手动"连上"。 */
function stubSockets(): { fire: () => void } {
  let open: (() => void) | undefined
  class FakeSocket {
    constructor(_url: string) {}
    addEventListener(type: string, fn: () => void) {
      if (type === 'open') open = fn
    }
    send() {}
  }
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
  return { fire: () => open?.() }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('中继连上就刷新同步域名单', () => {
  it('open 之前一次都不刷；open 之后刷一次', async () => {
    const sock = stubSockets()
    vi.stubGlobal('chrome', makeChrome())
    vi.stubGlobal('fetch', honestBackendFetch())
    vi.resetModules()
    const { runSync } = await import('./sync.ts')
    const mod = await import('./driver.ts')

    await mod.startExtCdp()
    await flush()
    // 还没连上：名单是后端下发的，没连上就没有可信来源。
    expect(runSync).not.toHaveBeenCalled()

    sock.fire()
    await flush()
    expect(runSync).toHaveBeenCalledTimes(1)
  })
})
