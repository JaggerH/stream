import { describe, it, expect, vi } from 'vitest'
import { BrowserQrLoginProvider } from './browser-qr-login-provider.ts'
import type { LoginEvent } from './login-provider.ts'
import type { LoginState } from '../replay/recipe.ts'

const spec = {
  type: 'session', facility: 'xhs', login: 'qr', loginUrl: 'https://x/explore', qrSelector: '.qr',
} as const
const ctx = { loginCheck: { loggedIn: '.user', wall: '.login-modal' } }

/** Each tick supplies what the page would answer that round. `qr: 'throw'` makes the screenshot
 *  blow up, standing in for the real failure mode: a backgrounded tab produces no frame, so
 *  `Page.captureScreenshot` runs into the relay's 30s timeout. */
function harness(ticks: { qr: string | null | 'throw'; state: LoginState }[]) {
  let i = 0
  const at = () => ticks[Math.min(i, ticks.length - 1)]
  const closed = { page: false }
  const released = { lock: false }
  const order: string[] = []
  const page = {
    goto: vi.fn(async () => { order.push('goto') }),
    qrDataUrl: vi.fn(async () => {
      order.push('qrDataUrl')
      const q = at().qr
      if (q === 'throw') throw new Error('ext-relay command timed out: Page.captureScreenshot')
      return q
    }),
    loginState: vi.fn(async () => at().state),
    close: vi.fn(async () => { closed.page = true }),
  }
  // advance the tick clock once per poll round, driven by the state probe (always called)
  page.loginState.mockImplementation(async () => at().state as never)
  const tick = () => { i += 1 }
  const browser = { openProfile: vi.fn(async () => page) }
  const lock = { acquire: vi.fn(async () => ({ release: async () => { released.lock = true } })) }
  return { page, browser, lock, closed, released, order, tick }
}

/** Drive the tick clock from the state probe so each poll round reads the next entry. */
function stepping(h: ReturnType<typeof harness>, ticks: { qr: string | null | 'throw'; state: LoginState }[]) {
  let round = 0
  h.page.loginState.mockImplementation(async () => {
    const s = ticks[Math.min(round, ticks.length - 1)].state
    round += 1
    h.tick()
    return s as never
  })
}

describe('BrowserQrLoginProvider', () => {
  it('不抢屏：二维码是送到 Stream 前端去看的，不该把浏览器掀到用户面前', async () => {
    // 不抢屏的理由是产品口径（用户要看的图在 Stream 里），不是"截图在后台一定没问题"——
    // bringToFront 只让标签在它那扇窗里变活动，窗口本身没显示照样没帧（见 provider 的注释）。
    const ticks = [{ qr: 'data:img,A', state: 'WALLED' as const }, { qr: 'data:img,A', state: 'LOGGED_IN' as const }]
    const h = harness(ticks); stepping(h, ticks)
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    await p.begin(spec, ctx, () => {}, new AbortController().signal)
    expect(h.order.slice(0, 2)).toEqual(['goto', 'qrDataUrl'])
    expect(h.order).not.toContain('bringToFront')
  })

  it('screenshots ONCE: after the QR is delivered it never captures again', async () => {
    // Five rounds still walled, then logged in. The QR lands on round 1 and must not be re-taken:
    // the user has to switch back to Stream to SEE it, which puts the tab back in the background.
    const ticks = [
      { qr: 'data:img,A', state: 'WALLED' as const },
      { qr: 'data:img,A', state: 'WALLED' as const },
      { qr: 'data:img,A', state: 'UNKNOWN' as const },
      { qr: 'data:img,A', state: 'WALLED' as const },
      { qr: 'data:img,A', state: 'LOGGED_IN' as const },
    ]
    const h = harness(ticks); stepping(h, ticks)
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    const events: LoginEvent[] = []
    await p.begin(spec, ctx, (e) => events.push(e), new AbortController().signal)
    expect(h.page.qrDataUrl).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.kind === 'challenge')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ kind: 'success', facility: 'xhs' })
  })

  it('keeps retrying the capture until a QR actually comes back', async () => {
    // Round 1 the login page has not painted the QR yet (null) — that is not a failure, and it
    // must not mean "no QR for the rest of this login".
    const ticks = [
      { qr: null, state: 'WALLED' as const },
      { qr: 'data:img,A', state: 'WALLED' as const },
      { qr: 'data:img,A', state: 'LOGGED_IN' as const },
    ]
    const h = harness(ticks); stepping(h, ticks)
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    const events: LoginEvent[] = []
    await p.begin(spec, ctx, (e) => events.push(e), new AbortController().signal)
    expect(events.filter((e) => e.kind === 'challenge')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ kind: 'success', facility: 'xhs' })
  })

  it('a capture that throws degrades to "no QR this round" instead of killing the login', async () => {
    // This is the live failure from 2026-07-28: the capture timed out and the exception escaped
    // `begin`, taking the whole login with it. The scan itself was fine — the user completed it
    // by hand in the tab.
    const ticks = [
      { qr: 'throw' as const, state: 'WALLED' as const },
      { qr: 'throw' as const, state: 'WALLED' as const },
      { qr: 'throw' as const, state: 'LOGGED_IN' as const },
    ]
    const h = harness(ticks); stepping(h, ticks)
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    const events: LoginEvent[] = []
    await p.begin(spec, ctx, (e) => events.push(e), new AbortController().signal)
    expect(events.filter((e) => e.kind === 'challenge')).toHaveLength(0)
    expect(events.at(-1)).toEqual({ kind: 'success', facility: 'xhs' })   // scanned in the tab
    expect(h.released.lock && h.closed.page).toBe(true)
  })

  it('WALLED and UNKNOWN both mean "keep waiting" — only LOGGED_IN ends it', async () => {
    const ticks = [
      { qr: 'A', state: 'UNKNOWN' as const },   // page still hydrating
      { qr: 'A', state: 'WALLED' as const },    // wall still up
      { qr: 'A', state: 'LOGGED_IN' as const },
    ]
    const h = harness(ticks); stepping(h, ticks)
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    const events: LoginEvent[] = []
    await p.begin(spec, ctx, (e) => events.push(e), new AbortController().signal)
    expect(h.page.loginState).toHaveBeenCalledTimes(3)
    expect(events.at(-1)).toEqual({ kind: 'success', facility: 'xhs' })
  })

  it('emits failed on timeout and still releases the lock', async () => {
    const ticks = [{ qr: 'A', state: 'WALLED' as const }]
    const h = harness(ticks); stepping(h, ticks)
    let t = 0
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 5, now: () => (t += 10) })
    const events: LoginEvent[] = []
    await p.begin(spec, ctx, (e) => events.push(e), new AbortController().signal)
    expect(events.at(-1)).toEqual({ kind: 'failed', facility: 'xhs', reason: 'login timed out' })
    expect(h.released.lock && h.closed.page).toBe(true)
  })

  it('calls onBefore so a running harvest is evicted first', async () => {
    const ticks = [{ qr: 'A', state: 'LOGGED_IN' as const }]
    const h = harness(ticks); stepping(h, ticks)
    const onBefore = vi.fn(async () => {})
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, onBefore, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    await p.begin(spec, ctx, () => {}, new AbortController().signal)
    expect(onBefore).toHaveBeenCalledWith('xhs')
  })
})

describe('BrowserQrLoginProvider —— 码换了要重新推', () => {
  /** 每一轮给一个 (签名, 图) 对；签名变了就代表页面上换了一张码。 */
  function harnessSig(rounds: Array<{ sig: string | null; qr: string; state: 'WALLED' | 'LOGGED_IN' }>) {
    let i = 0
    const page = {
      goto: vi.fn(async () => {}),
      qrSignature: vi.fn(async () => rounds[Math.min(i, rounds.length - 1)]!.sig),
      qrDataUrl: vi.fn(async () => rounds[Math.min(i, rounds.length - 1)]!.qr),
      loginState: vi.fn(async () => {
        const s = rounds[Math.min(i, rounds.length - 1)]!.state
        i++
        return s
      }),
      close: vi.fn(async () => {}),
    }
    return {
      page,
      browser: { openProfile: async () => page as never },
      lock: { acquire: async () => ({ release: async () => {} }) },
    }
  }

  it('扫完第一张、平台又压上来一张新的 → 第二张也要推给用户', async () => {
    // 活体 2026-07-29：xhs 在第一次扫码之后弹出第二个二维码（设备/异地验证）。只抓一次的话
    // 用户对着一张已经作废的图，怎么扫都不成，而且看不出为什么。
    const h = harnessSig([
      { sig: 'src:A', qr: 'data:img,A', state: 'WALLED' },
      { sig: 'src:B', qr: 'data:img,B', state: 'WALLED' },
      { sig: 'src:B', qr: 'data:img,B', state: 'LOGGED_IN' },
    ])
    const events: Array<{ kind: string; qr?: string; again?: boolean }> = []
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    await p.begin(spec, ctx, (e) => events.push(e as never), new AbortController().signal)
    const pushed = events.filter((e) => e.kind === 'challenge')
    expect(pushed.map((e) => e.qr)).toEqual(['data:img,A', 'data:img,B'])
    // 第二张要标记出来，前端才能说"出现了新的二维码，请再扫一次"，而不是让用户以为自己扫错了
    expect(pushed[0]!.again).toBeFalsy()
    expect(pushed[1]!.again).toBe(true)
  })

  it('码没换就不重推 —— 否则前端每隔几秒闪一下', async () => {
    const h = harnessSig([
      { sig: 'src:A', qr: 'data:img,A', state: 'WALLED' },
      { sig: 'src:A', qr: 'data:img,A', state: 'WALLED' },
      { sig: 'src:A', qr: 'data:img,A', state: 'LOGGED_IN' },
    ])
    const events: Array<{ kind: string }> = []
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    await p.begin(spec, ctx, (e) => events.push(e as never), new AbortController().signal)
    expect(events.filter((e) => e.kind === 'challenge')).toHaveLength(1)
  })

  it('签名读不到 → 退回"只推第一张"，绝不每轮都推', async () => {
    const h = harnessSig([
      { sig: null, qr: 'data:img,A', state: 'WALLED' },
      { sig: null, qr: 'data:img,A', state: 'WALLED' },
      { sig: null, qr: 'data:img,A', state: 'LOGGED_IN' },
    ])
    const events: Array<{ kind: string }> = []
    const p = new BrowserQrLoginProvider({ browser: h.browser, lock: h.lock, pollMs: 0, timeoutMs: 10_000, now: () => 0 })
    await p.begin(spec, ctx, (e) => events.push(e as never), new AbortController().signal)
    expect(events.filter((e) => e.kind === 'challenge')).toHaveLength(1)
  })
})

