import { describe, it, expect } from 'vitest'
import { makeExtensionLauncher, type ExtRelayLike } from './browser-ext.ts'
import type { ResolvedFetch } from './interpret.ts'

function fakeRelay(overrides: Partial<ExtRelayLike> = {}) {
  const calls: { sendCommand: any[][]; newTab: any[][]; closeTab: any[][] } = {
    sendCommand: [], newTab: [], closeTab: [],
  }
  let nextTab = 10
  const relay: ExtRelayLike = {
    async newTab(url, waitUntil, background) { calls.newTab.push([url, waitUntil, background]); return nextTab++ },
    async closeTab(tabId) { calls.closeTab.push([tabId]) },
    async sendCommand(tabId, method, params) {
      calls.sendCommand.push([tabId, method, params])
      return { result: { value: { status: 200, text: '{"ok":1}' } } }
    },
    async list() { return [] },
    ...overrides,
  }
  return { relay, calls }
}

const arg: ResolvedFetch = { url: 'https://api.test/x', method: 'GET', headers: {}, body: undefined } as ResolvedFetch
const fetchFn = async (r: ResolvedFetch) => {
  const resp = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, credentials: 'include' })
  return { status: resp.status, text: await resp.text() }
}

describe('makeExtensionLauncher', () => {
  it('launch opens a tab via newTab and passes entryUrl + waitUntil; default = background tab (no window)', async () => {
    const { relay, calls } = fakeRelay()
    const launcher = makeExtensionLauncher(relay)
    await launcher.launch('https://entry.test', 'load')
    // 3rd arg = background: no opts → passive → background tab (true), never a window
    expect(calls.newTab).toEqual([['https://entry.test', 'load', true]])
  })

  it('launch with interactive opens a managed WINDOW (background=false) for scroll/render/input', async () => {
    const { relay, calls } = fakeRelay()
    await makeExtensionLauncher(relay).launch('https://entry.test', 'load', { interactive: true })
    expect(calls.newTab).toEqual([['https://entry.test', 'load', false]])
  })

  // 隐藏 tab 的可信输入在等一帧，而浏览器不给看不见的 tab 画 —— 实测每次点击 39.8–41.6s，
  // 开了这条是 162–185ms（比前台的 204–257ms 还快）。它是这条链路上最贵那件事的开关，
  // 所以断言钉的是 enabled:true 本身，不是"发过这条命令"。整段来龙去脉见 browser-ext.ts。
  it('launch turns focus emulation ON (a hidden tab must still render) and does NOT steal focus', async () => {
    const { relay, calls } = fakeRelay()
    await makeExtensionLauncher(relay).launch('https://entry.test')
    const focus = calls.sendCommand.find((c) => c[1] === 'Emulation.setFocusEmulationEnabled')
    expect(focus).toBeTruthy()
    expect(focus![2]).toEqual({ enabled: true })
    // The SSR-state harvest reads a `window` global at parse time — no foreground render
    // needed — so we must NOT bringToFront (that hijacks the user's screen for nothing).
    expect(calls.sendCommand.some((c) => c[1] === 'Page.bringToFront')).toBe(false)
  })

  it('evaluate wraps fn in an IIFE with a local __name shim and inlines arg as JSON', async () => {
    const { relay, calls } = fakeRelay()
    const { page } = await makeExtensionLauncher(relay).launch('https://entry.test')
    await page.evaluate(fetchFn, arg)
    const evalCall = calls.sendCommand.find((c) => c[1] === 'Runtime.evaluate')!
    const [tabId, method, params] = evalCall
    expect(tabId).toBe(10)
    expect(method).toBe('Runtime.evaluate')
    expect(params.awaitPromise).toBe(true)
    expect(params.returnByValue).toBe(true)
    expect(params.expression).toContain('const __name')
    expect(params.expression).toContain(JSON.stringify(arg)) // arg 内联
  })

  it('unpacks returnByValue result.result.value', async () => {
    const { relay } = fakeRelay()
    const { page } = await makeExtensionLauncher(relay).launch('https://entry.test')
    const out = await page.evaluate(fetchFn, arg)
    expect(out).toEqual({ status: 200, text: '{"ok":1}' })
  })

  it('rejects when Runtime.evaluate returns exceptionDetails (in-page throw)', async () => {
    const { relay } = fakeRelay({
      async sendCommand() {
        return { exceptionDetails: { text: 'Uncaught', exception: { description: 'login wall' } } }
      },
    })
    const { page } = await makeExtensionLauncher(relay).launch('https://entry.test')
    await expect(page.evaluate(fetchFn, arg)).rejects.toThrow(/login wall|Uncaught/)
  })

  it('close only closes this launcher tab', async () => {
    const { relay, calls } = fakeRelay()
    const { close } = await makeExtensionLauncher(relay).launch('https://entry.test')
    await close()
    expect(calls.closeTab).toEqual([[10]])
  })

  it('two launchers each own a distinct tab', async () => {
    const { relay, calls } = fakeRelay()
    const l = makeExtensionLauncher(relay)
    const a = await l.launch('https://a.test')
    const b = await l.launch('https://b.test')
    await a.page.evaluate(fetchFn, arg)
    await b.page.evaluate(fetchFn, arg)
    const evals = calls.sendCommand.filter((c) => c[1] === 'Runtime.evaluate')
    expect(evals[0][0]).toBe(10) // tab A
    expect(evals[1][0]).toBe(11) // tab B
  })

  it('adopt rides an existing group tab: no newTab, evaluates on that tabId, and close never closes it', async () => {
    const { relay, calls } = fakeRelay({
      async list() { return [{ tabId: 42, url: 'https://x.test/chat/1', title: 'chat' }] },
    })
    const l = makeExtensionLauncher(relay)
    expect(await l.listTabs!()).toEqual([{ tabId: 42, url: 'https://x.test/chat/1', title: 'chat' }])
    const { page, close } = await l.adopt!(42)
    await page.evaluate(fetchFn, arg)
    await close()
    expect(calls.newTab).toEqual([])
    expect(calls.sendCommand.filter((c) => c[1] === 'Runtime.evaluate')[0][0]).toBe(42)
    expect(calls.closeTab).toEqual([])
  })
})
