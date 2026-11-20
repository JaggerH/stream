/**
 * 可操作性检查的集成测试：**真的 Chromium + 真的 CDP 中继 + 共享的 PageDriver**。
 *
 * 路径与产品完全一致：`CdpConnection` → `CdpRelayOps` → `makeExtRawPage` →
 * `makeExtPageDriver`。扩展那侧只把同形状的 `{method,params}` 交给 `chrome.debugger`，
 * 定位逻辑与这里共用一份，所以这条链路覆盖到的就是两条 transport 共有的那一份。
 *
 * 没有 Chromium → 整组跳过并打印原因。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CdpConnection } from './cdp-connection.ts'
import { CdpRelayOps, type RelayReply } from './ops.ts'
import { makeExtPageDriver, makeExtRawPage, type ExtPageDriver, type RawPageRelay } from '../../shared/browser-relay/ext-page.ts'
import { launchChromium, chromiumExecutable, type TestChromium } from './__fixtures__/chromium.ts'
import { startActionabilitySite, type ActionabilitySite } from './__fixtures__/actionability-site.ts'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** playwright-core 期望的版本号可能比缓存里那份旧；缓存里有任何一份就先用它（CDP 形状一致）。 */
function cachedChromium(): string | null {
  const root = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-'))) {
    for (const sub of ['chrome-linux/chrome', 'chrome-linux-arm64/chrome', 'chrome-linux64/chrome']) {
      const p = join(root, dir, sub)
      if (existsSync(p)) return p
    }
  }
  return null
}

const chromePath = (await chromiumExecutable()) ?? cachedChromium()
const hasChromium = chromePath !== null
if (!hasChromium) {
  console.warn('[browser-actionability] 本机没有 Chromium（playwright-core 的浏览器没下载）——集成用例跳过')
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let browser: TestChromium | null = null
let site: ActionabilitySite | null = null
let cdp: CdpConnection | null = null
let ops: CdpRelayOps | null = null
let nextId = 1

beforeAll(async () => {
  if (!hasChromium) return
  browser = (await launchChromium(chromePath ?? undefined))!
  site = await startActionabilitySite()
  cdp = await CdpConnection.connect(browser.cdpUrl)
  ops = new CdpRelayOps(cdp)
})

afterAll(async () => {
  ops?.dispose()
  ops = null
  cdp = null
  await browser?.close()
  browser = null
  site?.close()
  site = null
})

function reply(r: RelayReply | null): unknown {
  if (!r) throw new Error('no receipt')
  if (r.error) throw new Error(r.error)
  return r.result
}

function relay(tabId: number): RawPageRelay {
  return {
    async sendCommand(_tabId, method, params, expectDomain, sessionId) {
      const result = reply(
        await ops!.dispatch({
          id: nextId++,
          tabId,
          method,
          params,
          ...(expectDomain ? { expectDomain } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      )
      return result
    },
  }
}

async function open(path: string): Promise<{ tabId: number; driver: ExtPageDriver }> {
  const r = reply(await ops!.dispatch({ id: nextId++, op: 'newTab', url: `${site!.base}${path}`, waitUntil: 'load' })) as {
    tabId: number
  }
  const raw = makeExtRawPage(relay(r.tabId), r.tabId)
  return { tabId: r.tabId, driver: makeExtPageDriver(raw, { humanCursor: false }) }
}

async function close(tabId: number): Promise<void> {
  await ops!.dispatch({ id: nextId++, op: 'closeTab', tabId }).catch(() => null)
}

describe.skipIf(!hasChromium)('browser actionability over the relay path (real Chromium)', () => {
  it('被 cookie 横幅遮住的按钮：明确 covered，页面不变；关掉横幅后才点得动', async () => {
    const { tabId, driver } = await open('/overlay')
    try {
      const covered = await driver.clickReceipt('#next')
      expect(covered.ok).toBe(false)
      expect(covered.reason?.code).toBe('covered')
      expect(covered.reason?.reason).toContain('consent-banner')
      expect(await driver.evalJson!('document.title')).toBe('fixture overlay')

      const accept = await driver.clickReceipt('#accept')
      expect(accept).toMatchObject({ ok: true, delivery: 'confirmed' })

      const next = await driver.clickReceipt('#next')
      expect(next).toMatchObject({ ok: true, delivery: 'confirmed' })
      expect(await driver.evalJson!('document.title')).toBe('page 2')
    } finally {
      await close(tabId)
    }
  })

  it('disabled / display:none / opacity:0 都明确失败，日志没有点击记录', async () => {
    const { tabId, driver } = await open('/states')
    try {
      const off = await driver.clickReceipt('#off')
      expect(off).toMatchObject({ ok: false, reason: { code: 'disabled' } })
      const ghost = await driver.clickReceipt('#ghost')
      expect(ghost).toMatchObject({ ok: false, reason: { code: 'not-visible' } })
      const faded = await driver.clickReceipt('#faded')
      expect(faded).toMatchObject({ ok: false, reason: { code: 'not-visible' } })
      expect(await driver.evalJson!('document.getElementById("log").textContent')).toBe('')
    } finally {
      await close(tabId)
    }
  })

  it('视口外的元素先滚进来再点，页面收到点击', async () => {
    const { tabId, driver } = await open('/scroll')
    try {
      const before = (await driver.evalJson!('scrollY')) as number
      const r = await driver.clickReceipt('#deep')
      expect(r.ok).toBe(true)
      expect(r.delivery).toBe('confirmed')
      expect(await driver.evalJson!('document.getElementById("log").textContent')).toBe('deep')
      const after = (await driver.evalJson!('scrollY')) as number
      expect(after).toBeGreaterThan(before)
    } finally {
      await close(tabId)
    }
  })

  it('滚动也进不了视口的固定元素 → outside-viewport，零输入', async () => {
    const { tabId, driver } = await open('/offscreen')
    try {
      const r = await driver.clickReceipt('#fixed-out')
      expect(r).toMatchObject({ ok: false, reason: { code: 'outside-viewport' } })
      expect(await driver.evalJson!('document.getElementById("log").textContent')).toBe('')
    } finally {
      await close(tabId)
    }
  })

  it('填写三个字段并提交：type 回读一致，表单收到完整值', async () => {
    const { tabId, driver } = await open('/form')
    try {
      expect(await driver.typeReceipt('#name', 'Ada')).toMatchObject({ ok: true })
      expect(await driver.typeReceipt('#email', 'ada@example.invalid')).toMatchObject({ ok: true })
      expect(await driver.typeReceipt('#msg', 'hello from the relay')).toMatchObject({ ok: true })
      expect(await driver.clickReceipt('#send')).toMatchObject({ ok: true })
      expect(await driver.evalJson!('document.getElementById("ok").textContent')).toContain('Ada')
    } finally {
      await close(tabId)
    }
  })

  it('页面把输入值改写了 → value-mismatch，不报成功', async () => {
    const { tabId, driver } = await open('/form')
    try {
      const r = await driver.typeReceipt('#upper', 'abc')
      expect(r.ok).toBe(false)
      expect(r.reason?.code).toBe('value-mismatch')
    } finally {
      await close(tabId)
    }
  })

  it('列表整批换节点之后点击仍然到达（churn）', async () => {
    const { tabId, driver } = await open('/churn')
    try {
      await sleep(1100) // 节点在 800ms 时被整批替换
      for (let i = 0; i < 6; i++) {
        const r = await driver.clickReceipt('.row[data-id="3"]')
        expect(r.ok).toBe(true)
        expect(await driver.evalJson!('document.getElementById("clicked").textContent')).toBe('clicked 3')
      }
    } finally {
      await close(tabId)
    }
  })

  it('按下即被搬走的节点 → 不判失败，但 delivery=unconfirmed', async () => {
    const { tabId, driver } = await open('/vanish')
    try {
      const r = await driver.clickReceipt('#vanish')
      expect(r.ok).toBe(true)
      expect(r.delivery).toBe('unconfirmed')
    } finally {
      await close(tabId)
    }
  })
})
