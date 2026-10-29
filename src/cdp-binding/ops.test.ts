/**
 * CDP 绑定的中继命令——**对着一台真的 Chromium** 跑。
 *
 * 为什么必须是真的：这一层的全部难点都在浏览器那一侧（target 生命周期、OOPIF 子会话、cookie
 * 形状、截图要不要合成器出帧）。假连接只能测到我们自己写的那层分支，测不到「Chrome 到底怎么回」。
 *
 * 覆盖口径：`extension/src/lib/driver.ts` 的 `dispatchInner` 里每一条 op 与每一类透传，
 * 在这里都有一条对应的用例（逐条对照见 `docs/` 里 CDP 绑定那一节）。
 *
 * 本机没有 Chromium（playwright-core 的浏览器没下载）→ 整组跳过并**打印原因**：静默跳过会让人
 * 以为跑过了。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromiumExecutable, launchChromium, type TestChromium } from './__fixtures__/chromium.ts'
import { CdpConnection } from './cdp-connection.ts'
import { CdpRelayOps, domainMatches, sameUrl, serializeCookie } from './ops.ts'

const hasChromium = (await chromiumExecutable()) !== null
if (!hasChromium) {
  console.warn('[cdp-binding] 本机没有 Chromium（playwright-core 的浏览器没下载）——浏览器侧用例跳过')
}

/** 日志 / cookie 值的探针：这个字符串不许出现在任何一行日志里。 */
const CANARY = 'canary-7f3a-input-text'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('纯函数：与扩展逐字对齐的那几个判据', () => {
  it('sameUrl：协议/主机/路径/查询/片段一致（尾斜杠不算差别）', () => {
    expect(sameUrl('https://a.example/x', 'https://a.example/x')).toBe(true)
    expect(sameUrl('https://a.example', 'https://a.example/')).toBe(true)
    expect(sameUrl('https://a.example/x/', 'https://a.example/x')).toBe(true)
    expect(sameUrl('https://a.example/x?a=1', 'https://a.example/x')).toBe(false)
    expect(sameUrl('http://a.example/x', 'https://a.example/x')).toBe(false)
    expect(sameUrl('不是 url', 'https://a.example')).toBe(false)
  })

  it('domainMatches：同域或它的子域（cookie 的 domain 带不带点都算）', () => {
    expect(domainMatches('.example.com', 'example.com')).toBe(true)
    expect(domainMatches('example.com', 'example.com')).toBe(true)
    expect(domainMatches('.sub.example.com', 'example.com')).toBe(true)
    expect(domainMatches('.notexample.com', 'example.com')).toBe(false)
    expect(domainMatches('.example.com', 'sub.example.com')).toBe(false)
  })

  it('serializeCookie：CDP 形状 → 扩展 serializeCookie 的形状', () => {
    expect(
      serializeCookie({
        name: 'k',
        value: 'v',
        domain: '.example.com',
        path: '/',
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        session: false,
        sameSite: 'None',
      }),
    ).toEqual({
      name: 'k',
      value: 'v',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: 1_800_000_000,
      hostOnly: false,
      session: false,
    })
    // 会话 cookie（expires -1）不带 expirationDate；无点域 = hostOnly
    const session = serializeCookie({
      name: 'k',
      value: 'v',
      domain: 'example.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      session: true,
      sameSite: 'Lax',
    })
    expect(session).toMatchObject({ hostOnly: true, session: true, sameSite: 'lax' })
    expect('expirationDate' in session && session.expirationDate !== undefined).toBe(false)
  })
})

describe.skipIf(!hasChromium)('中继命令（真 Chromium）', () => {
  let browser: TestChromium
  let cdp: CdpConnection
  let ops: CdpRelayOps
  let site: Server
  let sitePort = 0
  const outbound: Array<Record<string, unknown>> = []
  let seq = 0

  /** 发一条中继命令，返回回执（不抛——错误是回执的一部分）。 */
  const send = (msg: Record<string, unknown>) =>
    ops.dispatch({ id: ++seq, ...msg }) as Promise<{ id: number; result?: any; error?: string; swMs: number }>
  const ok = async (msg: Record<string, unknown>) => {
    const r = await send(msg)
    if (r.error) throw new Error(r.error)
    return r.result
  }
  const refused = async (msg: Record<string, unknown>) => {
    const r = await send(msg)
    expect(r.error, `这条命令本该被拒：${JSON.stringify(msg)}`).toBeTruthy()
    return r.error!
  }

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (req.url === '/child') res.end('<title>child</title><p>child</p>')
      else if (req.url === '/login') res.end('<title>login</title><input id="user"><button id="go">go</button>')
      else if (req.url === '/link') res.end('<title>link</title><a id="l" href="/child" target="_blank">go</a>')
      else res.end(`<title>parent</title><iframe src="http://localhost:${sitePort}/child"></iframe>`)
    })
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
    sitePort = (site.address() as AddressInfo).port
    browser = (await launchChromium())!
    cdp = await CdpConnection.connect(browser.cdpUrl)
    ops = new CdpRelayOps(cdp)
    ops.onMessage((m) => outbound.push(m as Record<string, unknown>))
  }, 60_000)

  afterEach(async () => {
    // 认领的标签全部收掉（与 releaseProfile 同一条路）；用户的标签不动。
    await ok({ op: 'releaseProfile' }).catch(() => {})
    outbound.length = 0
  })

  afterAll(async () => {
    ops?.dispose()
    cdp?.close()
    await browser?.close()
    await new Promise<void>((r) => (site ? site.close(() => r()) : r()))
  })

  it('newTab：建一张认领的标签，透传命令读得到页面；list 报 origin / active', async () => {
    const { tabId } = await ok({ op: 'newTab', url: 'data:text/html,<title>x3</title>', waitUntil: 'load' })
    const title = await ok({ tabId, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } })
    expect(title.result.value).toBe('x3')

    const { tabs } = await ok({ op: 'list' })
    expect(tabs).toEqual([
      expect.objectContaining({ tabId, origin: 'created', grouped: true, active: true, title: 'x3', url: 'data:text/html,<title>x3</title>' }),
    ])
    expect(await ok({ op: 'activeTab' })).toEqual({ tabId })
  })

  it('newTab background:true → origin probe、不抢焦点', async () => {
    const a = await ok({ op: 'newTab', url: 'data:text/html,<title>a</title>' })
    const b = await ok({ op: 'newTab', url: 'data:text/html,<title>b</title>', background: true })
    const { tabs } = await ok({ op: 'list' })
    expect(tabs.find((t: { tabId: number }) => t.tabId === b.tabId).origin).toBe('probe')
    expect(await ok({ op: 'activeTab' })).toEqual({ tabId: a.tabId })
  })

  it('openTab：同 URL 找现有标签（created:false，**不认领**），新 URL 建一张（created:true）', async () => {
    // 用户自己的标签：绕过绑定直接建（绑定眼里它就是"不是我开的"）
    const user = (await cdp.send('Target.createTarget', { url: 'data:text/html,<title>user</title>' })) as { targetId: string }
    await sleep(300)

    const found = await ok({ op: 'openTab', url: 'data:text/html,<title>user</title>' })
    expect(found).toMatchObject({ created: false, title: 'user' })
    // 用户标签不入组：关它被拒（与扩展同一条红线）
    expect(await refused({ op: 'closeTab', tabId: found.tabId })).toContain('not in the session tab group')

    const opened = await ok({ op: 'openTab', url: 'data:text/html,<title>fresh</title>' })
    expect(opened).toMatchObject({ created: true, title: 'fresh' })
    expect(await ok({ op: 'closeTab', tabId: opened.tabId })).toEqual({})

    // 用户的标签还在
    const alive = ((await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string }> }).targetInfos.some(
      (t) => t.targetId === user.targetId,
    )
    expect(alive).toBe(true)
  })

  it('activateTab：把焦点还回去；认领的标签都关了就不碰用户的焦点（礼貌闸门）', async () => {
    const a = await ok({ op: 'newTab', url: 'data:text/html,<title>a</title>' })
    const b = await ok({ op: 'newTab', url: 'data:text/html,<title>b</title>' })
    expect(await ok({ op: 'activeTab' })).toEqual({ tabId: b.tabId })
    expect(await ok({ op: 'activateTab', tabId: a.tabId })).toEqual({ restored: true })
    expect(await ok({ op: 'activeTab' })).toEqual({ tabId: a.tabId })

    // 关掉当前焦点那张（认领的）：焦点交还给用户的标签，此后不再碰它
    await ok({ op: 'closeTab', tabId: a.tabId })
    expect(await ok({ op: 'activateTab', tabId: b.tabId })).toEqual({ restored: false })
  })

  it('cookieNames / cookiePull：CDP 的 cookie → 扩展形状；子域收得到父域查询', async () => {
    await cdp.send('Storage.setCookies', {
      cookies: [
        { name: 'k1', value: 'v1', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
        { name: 'k2', value: 'v2', domain: 'example.com', path: '/' },
        { name: 'k3', value: 'v3', domain: '.sub.example.com', path: '/' },
      ],
    })
    const names = await ok({ op: 'cookieNames', domain: 'example.com' })
    expect(names.names).toEqual(expect.arrayContaining(['k1', 'k2', 'k3']))

    const pulled = await ok({ op: 'cookiePull', domains: ['example.com', 'other.example'] })
    expect(pulled.refused).toEqual([])
    expect(Object.keys(pulled.cookies).sort()).toEqual(['example.com'])
    const k1 = pulled.cookies['example.com'].find((c: { name: string }) => c.name === 'k1')
    expect(k1).toMatchObject({ value: 'v1', hostOnly: false, session: true, sameSite: 'lax', httpOnly: true, secure: true })
    const k2 = pulled.cookies['example.com'].find((c: { name: string }) => c.name === 'k2')
    expect(k2).toMatchObject({ hostOnly: true })
    // 父域查询收不到无关域
    expect(pulled.cookies['other.example']).toBeUndefined()
  })

  it('subscribe / unsubscribe：订阅的域事件转发成 cdp-event，退订后不再转发', async () => {
    const { tabId } = await ok({ op: 'newTab', url: `http://127.0.0.1:${sitePort}/` })
    const { subscriptionId } = await ok({ op: 'subscribe', tabId, domains: ['Page'] })
    await ok({ tabId, method: 'Page.navigate', params: { url: `http://127.0.0.1:${sitePort}/child` } })
    await vi.waitFor(() => {
      expect(outbound.some((m) => m.type === 'cdp-event' && m.subscriptionId === subscriptionId && m.tabId === tabId)).toBe(true)
    })
    const ev = outbound.find((m) => m.type === 'cdp-event' && m.subscriptionId === subscriptionId)!
    expect(String(ev.method)).toMatch(/^Page\./)

    await ok({ op: 'unsubscribe', subscriptionId })
    const before = outbound.length
    await ok({ tabId, method: 'Page.navigate', params: { url: `http://127.0.0.1:${sitePort}/` } })
    await sleep(400)
    expect(outbound.length).toBe(before)

    // 组外拒；没有合法域名拒
    await refused({ op: 'subscribe', tabId: 999, domains: ['Page'] })
    await refused({ op: 'subscribe', tabId, domains: ['not a domain'] })
  })

  it('frames：列出 OOPIF 子会话，并能把命令打进去', async () => {
    const { tabId } = await ok({ op: 'newTab', url: `http://127.0.0.1:${sitePort}/`, waitUntil: 'load' })
    let sessions: Array<{ sessionId: string; url: string; targetId: string }> = []
    // auto-attach 在 newTab 里就开了，但子会话的 attachedToTarget 事件可能还在路上——问到为止。
    await vi.waitFor(async () => {
      sessions = (await ok({ op: 'frames', tabId })).sessions
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.url).toContain('/child')
    })
    const child = sessions[0]!
    const r = await ok({
      tabId,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title', returnByValue: true },
      sessionId: child.sessionId,
    })
    expect(r.result.value).toBe('child')
    // 不认识的子会话：拒（不是悄悄打回主会话）
    expect(await refused({ tabId, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'NOPE' })).toContain('not an iframe session')
  })

  it('expectDomain：域名对得上才动手；对不上就拒，且命令一条都没发出去', async () => {
    const { tabId } = await ok({ op: 'newTab', url: `http://127.0.0.1:${sitePort}/` })
    await ok({ tabId, method: 'Runtime.evaluate', params: { expression: '1' }, expectDomain: '127.0.0.1' })
    const err = await refused({ tabId, method: 'Runtime.evaluate', params: { expression: '1' }, expectDomain: 'other.example' })
    expect(err).toContain('domain changed')
    expect(err).toContain('127.0.0.1')
  })

  it('Input.insertText 发了就算、Page.captureScreenshot 真的出帧', async () => {
    const { tabId } = await ok({ op: 'newTab', url: `http://127.0.0.1:${sitePort}/login` })
    await ok({ tabId, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("user").focus()' } })
    expect(await ok({ tabId, method: 'Input.insertText', params: { text: CANARY } })).toEqual({})
    const value = await ok({
      tabId,
      method: 'Runtime.evaluate',
      params: { expression: 'document.getElementById("user").value', returnByValue: true },
    })
    expect(value.result.value).toBe(CANARY)

    const shot = await ok({ tabId, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 60 } })
    expect(typeof shot.data).toBe('string')
    expect(shot.data.length).toBeGreaterThan(100)
  })

  it('日志只记命令名：Input.insertText 的值与 cookie 值一个字符都不进日志', async () => {
    const lines: string[] = []
    const logged = new CdpRelayOps(cdp, { log: (l) => lines.push(l) })
    try {
      const { tabId } = (await logged.dispatch({ id: 1, op: 'newTab', url: `http://127.0.0.1:${sitePort}/login` }))!.result as { tabId: number }
      await logged.dispatch({ id: 2, tabId, method: 'Input.insertText', params: { text: CANARY } })
      await logged.dispatch({ id: 3, tabId, method: 'Runtime.evaluate', params: { expression: '1' }, expectDomain: 'wrong.example' })
      await logged.dispatch({ id: 4, op: 'cookiePull', domains: ['example.com'] })
      await logged.dispatch({ id: 5, op: 'closeTab', tabId })
    } finally {
      logged.dispose()
    }
    expect(lines.join('\n')).not.toContain(CANARY)
    expect(lines.join('\n')).not.toContain('v1')
  })

  it('认领标签自己开出来的标签被收下并报 tab-opened（用户自己的标签不会被认领）', async () => {
    const { tabId } = await ok({ op: 'newTab', url: `http://127.0.0.1:${sitePort}/link` })
    // 点一下 target=_blank 的链接：有用户手势，弹窗才不会被拦
    const rect = await ok({
      tabId,
      method: 'Runtime.evaluate',
      params: {
        expression: 'JSON.parse(JSON.stringify(document.getElementById("l").getBoundingClientRect()))',
        returnByValue: true,
      },
    })
    const box = rect.result.value as { x: number; y: number; width: number; height: number }
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await ok({ tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', button: 'left', clickCount: 1, ...at } })
    await ok({ tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', button: 'left', clickCount: 1, ...at } })

    await vi.waitFor(() => {
      expect(outbound.find((m) => m.type === 'tab-opened')).toBeTruthy()
    })
    const opened = outbound.find((m) => m.type === 'tab-opened')!
    expect(opened.openerTabId).toBe(tabId)
    const { tabs } = await ok({ op: 'list' })
    const adopted = tabs.find((t: { tabId: number }) => t.tabId === opened.tabId)
    expect(adopted).toMatchObject({ origin: 'created', grouped: true })
    // 认领之后就能关（在组内）
    expect(await ok({ op: 'closeTab', tabId: opened.tabId })).toEqual({})
  })

  it('holdProfile / releaseProfile：只关自己认领的标签，用户标签一个不动', async () => {
    const mine = await ok({ op: 'newTab', url: 'data:text/html,<title>mine</title>' })
    const user = (await cdp.send('Target.createTarget', { url: 'data:text/html,<title>user</title>' })) as { targetId: string }
    expect(await ok({ op: 'holdProfile' })).toEqual({})
    expect(await ok({ op: 'releaseProfile' })).toEqual({ closedTabs: 1, userWindows: 0, unloading: false })
    expect(await ok({ op: 'list' })).toEqual({ tabs: [] })

    const alive = ((await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string }> }).targetInfos.some(
      (t) => t.targetId === user.targetId,
    )
    expect(alive).toBe(true)
    expect(mine.tabId).toBeGreaterThan(0)
  })
})
