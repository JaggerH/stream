import { describe, it, expect, vi } from 'vitest'
import { makeTransportLoginPage } from './transport-login-page.ts'
import type { Transport } from '../replay/transport.ts'
import type { PageDriver } from '../replay/actions.ts'

// 回归锁：这条路以前把 lease.rawPage 硬转成 Playwright Page 调 .locator()。采集早就在用户自己的
// Chrome 上了，rawPage 是扩展中继的句柄，一调就抛——只是当时 acquire 不声明 transport、被那个
// 已退役的默认值兜回了另一个浏览器才没炸。所以下面的 rawPage 是一个**不带任何 Playwright 方法**
// 的哨兵：谁再绕开 Transport 去用 Playwright 语义，这里立刻红。
const RAW = { tabId: 42, __notAPlaywrightPage: true }
const SHOT = Buffer.from('qr-jpeg-bytes')

const CHECK = { loggedIn: '.user', wall: '.login-modal' }

function fakes(over: { elementShot?: Transport['elementShot']; present?: string[] } = {}) {
  const calls: string[] = []
  // `present` lists the selectors that DO match; anything else does not. Defaults to the
  // logged-in signal so the common case reads as "already in".
  const present = over.present ?? [CHECK.loggedIn]
  const driver = {
    goto: vi.fn(async (url: string, wait?: string) => { calls.push(`goto:${url}:${wait}`) }),
    // 判不出来时 detectLoginState 会再看一眼，那一步要 sleep —— 桩少了它就会当场 TypeError。
    sleep: vi.fn(async () => { calls.push('sleep') }),
    exists: vi.fn(async (sel: string) => { calls.push(`exists:${sel}`); return present.includes(sel) }),
  } as unknown as PageDriver
  const transport = {
    driverFactory: vi.fn((raw: unknown) => { calls.push(`driverFactory:${raw === RAW}`); return driver }),
    bringToFront: vi.fn(async (raw: unknown) => { calls.push(`bringToFront:${raw === RAW}`) }),
    elementShot: over.elementShot ?? vi.fn(async (raw: unknown, sel: string) => {
      calls.push(`elementShot:${raw === RAW}:${sel}`)
      return SHOT
    }),
  } as unknown as Transport
  let released = 0
  const lease = { rawPage: RAW, release: async () => { released++ } }
  return { transport, driver, lease, calls, released: () => released }
}

describe('makeTransportLoginPage', () => {
  it('goto 走 driver，等到 load', async () => {
    const f = fakes()
    await makeTransportLoginPage(f.transport, f.lease).goto('https://x.test/login')
    expect(f.calls).toContain('goto:https://x.test/login:load')
  })

  it('qrDataUrl 经 Transport.elementShot 截那个元素，包成 data URL', async () => {
    const f = fakes()
    const qr = await makeTransportLoginPage(f.transport, f.lease).qrDataUrl('img.qrcode')
    // 截的是 lane 自己那个 rawPage，不是另开的页面
    expect(f.calls).toContain('elementShot:true:img.qrcode')
    expect(qr).toBe('data:image/jpeg;base64,' + SHOT.toString('base64'))
  })

  it('选择器没命中 → null（"还没出现"，不是失败）', async () => {
    const f = fakes({ elementShot: (async () => null) as Transport['elementShot'] })
    expect(await makeTransportLoginPage(f.transport, f.lease).qrDataUrl('.missing')).toBeNull()
  })

  it('扫码登录不抢屏 —— 二维码是送到 Stream 前端去看的', async () => {
    // 不抢屏是产品口径：把浏览器掀到用户面前，等于让他在两个窗口之间跳，而他要看的图就在
    // Stream 里。（bringToFront 也治不了"窗口没显示就没帧"，见 browser-qr-login-provider.ts。）
    const f = fakes()
    const page = makeTransportLoginPage(f.transport, f.lease)
    await page.goto('https://x.test/login')
    await page.qrDataUrl('img.qrcode')
    expect(f.calls.some((c) => c.startsWith('bringToFront'))).toBe(false)
  })

  it('loginState 复用采集那套三态判断，不另写一套', async () => {
    const walled = fakes({ present: [CHECK.wall] })
    expect(await makeTransportLoginPage(walled.transport, walled.lease).loginState(CHECK)).toBe('WALLED')

    const inside = fakes({ present: [CHECK.loggedIn] })
    expect(await makeTransportLoginPage(inside.transport, inside.lease).loginState(CHECK)).toBe('LOGGED_IN')

    // 两个信号都没画出来 —— 不是"没登录"，是"还不知道"，调用方据此继续等
    const blank = fakes({ present: [] })
    expect(await makeTransportLoginPage(blank.transport, blank.lease).loginState(CHECK)).toBe('UNKNOWN')
  })

  it('close 是 release，不是关掉标签——下一轮采集要接着用这个登录态', async () => {
    const f = fakes()
    await makeTransportLoginPage(f.transport, f.lease).close()
    expect(f.released()).toBe(1)
  })

  it('全程只碰 Transport 的原语，不碰 rawPage 上的 Playwright 方法', async () => {
    const f = fakes()
    const page = makeTransportLoginPage(f.transport, f.lease)
    await page.goto('https://x.test/login')
    await page.qrDataUrl('img.qrcode')
    await page.loginState(CHECK)
    // rawPage 上没有 locator/screenshot 可用；只要上面几步没抛，就说明没人走 Playwright 语义
    expect(RAW).not.toHaveProperty('locator')
    expect(f.calls).toContain('driverFactory:true')
  })
})
