import { describe, expect, it } from 'vitest'
import type { Transport } from './transport.ts'
import type { RecipeSessionSpec } from './recipe.ts'
import { RecipeSessionManager } from './session-manager.ts'

// 命门回归锁：look/shot 是"看活页面"的读口。它们过去硬编码 Playwright 语义
// (page.evaluate(fn) / page.screenshot)，而真正在跑的是 ext-cdp——那里的 ReplayPage.evaluate
// 只吃函数、screenshot 根本不存在 → 静默坏。两条读口必须只经 Transport.evaluate /
// Transport.screenshot 走。下面这个 fake 的 ReplayPage 一被碰就抛，就是为了让"绕过 Transport"
// 这件事无法悄悄发生。

const SHOT_BYTES = Buffer.from('a-fake-jpeg-frame')
const SHOT_B64 = SHOT_BYTES.toString('base64')

/** 像页面里真评估一样，跑 look 包出来的自执行 IIFE 字符串，返回其值。 */
function runInPage(expr: string): unknown {
  return new Function('return ' + expr)()
}

function makeTransport(): Transport {
  const rawPage = { tabId: 9, evalExpr: async (e: string) => runInPage(e), cdp: async () => ({ data: SHOT_B64 }) }
  // ReplayPage 上的 Playwright 式入口全是雷：碰到就说明有人绕开了 Transport。
  const page = {
    evaluate: () => { throw new TypeError('ReplayPage.evaluate cannot run a string expression') },
  }
  return {
    launcher: { launch: async () => ({ page: page as never, rawPage, close: async () => {} }) },
    driverFactory: () => ({}) as never,
    relayFactory: () => undefined,
    evaluate: (raw, expr) => (raw as typeof rawPage).evalExpr(expr),
    screenshot: async (raw) => Buffer.from((await (raw as typeof rawPage).cdp()).data, 'base64'),
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => 'https://x.test/',
  }
}

const spec: RecipeSessionSpec = { facility: 'e', lifecycle: 'persistent', visibility: 'interactive' }

describe('RecipeSessionManager look/shot', () => {
  it('look 经 Transport.evaluate 求值，不碰 ReplayPage.evaluate', async () => {
    const mgr = new RecipeSessionManager(() => makeTransport())
    await (await mgr.acquire(spec, 'u')).release()

    expect(await mgr.look('e', '40 + 2')).toEqual({ value: 42 })
  })

  it('shot 经 Transport.screenshot 取帧，返回 base64', async () => {
    const mgr = new RecipeSessionManager(() => makeTransport())
    await (await mgr.acquire(spec, 'u')).release()

    expect(await mgr.shot('e')).toBe(SHOT_B64)
  })
})
