/**
 * CDP 绑定的端到端：**真的 Stream 实例 + 真的设备网关 + 真的 Chromium**。
 *
 * 这条链路要证明的是：服务端眼里它和装了扩展的浏览器**没有区别**——
 *
 *   签 ext 配对码 → CDP 绑定配对 → verify → WS /api/ext → `binding online`
 *   → `cdp_look({target:'device:<id>/chrome'})` 在真浏览器里读到页面
 *   → 杀掉浏览器 → `binding offline`
 *
 * 也是验收清单里那两条硬指标的自动化版本：
 *
 * - 浏览器被杀之后服务端收到离线（不是一条对着死浏览器的连接挂在那里）。
 * - `cdp_act({kind:'login'})` 跑一遍，**密码一个字符都不进任何日志**（日志里 grep 金丝雀 = 0）。
 *
 * 没有 Chromium → 整组跳过并打印原因（静默跳过会让人以为跑过了）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createRuntime } from '../engine/runtime.ts'
import { createStream, type Stream } from '../engine/index.ts'
import { deviceGateway, type DeviceGateway } from '../engine/device-gateway.ts'
import { readConfig } from '../bootstrap.ts'
import type { DeviceChange } from '../engine/devices.ts'
import type { SecretSource } from '../../shared/browser-relay/secret-fill.ts'
import { startCdpBinding, type CdpBinding } from './index.ts'
import { chromiumExecutable, launchChromium, type TestChromium } from './__fixtures__/chromium.ts'

const hasChromium = (await chromiumExecutable()) !== null
if (!hasChromium) {
  console.warn('[cdp-binding] 本机没有 Chromium（playwright-core 的浏览器没下载）——端到端用例跳过')
}

/** 密码的金丝雀：这个字符串只许活在 secretSource 的返回值里。 */
const CANARY = 'Canary-Secret-4f1c9e'
/** 用户名也用一个可搜的串，顺手一起验。 */
const USERNAME = 'canary-user-4f1c9e'

const roots: string[] = []
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      /* 收尾失败不该盖掉用例本身的结论 */
    }
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

interface Harness {
  stream: Stream
  port: number
  logs: string[]
  changes: DeviceChange[]
  /** 签一台设备 + 一条 ext 配对码，返回设备 id 与那条码。 */
  pairDevice(): Promise<{ deviceId: string; code: string }>
}

async function harness(opts: { secretSource?: SecretSource; sitePort?: number } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'stream-cdp-e2e-'))
  roots.push(root)
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  const config = { ...base, packages_dir: join(root, 'packages'), rsshub_catalog: '', deployment: { ...base.deployment, scheduler: false } }
  const logs: string[] = []
  const stream = await createStream({
    dataDir: root,
    config,
    runtime: createRuntime(),
    log: (l) => logs.push(String(l)),
    hooks: {
      onDebug: (e) => logs.push(JSON.stringify(e)),
      ...(opts.secretSource ? { secretSource: opts.secretSource } : {}),
    },
  })
  cleanup.push(() => stream.close())

  // basePath 用 '/api/stream'：扩展那几口是写死的绝对路径（`/api/ext/*`），宿主把它们挂在
  // '/api' 上——这正是嵌入方的形状，CDP 绑定必须走同一套。
  const gateway: DeviceGateway = deviceGateway(stream, {
    basePath: '/api/stream',
    isAdmin: () => true,
    backendUrls: () => ['http://127.0.0.1:8900'],
    log: (l) => logs.push(String(l)),
  })
  const app = new Hono()
  for (const m of gateway.mounts) app.route(m.path, m.app)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  server.on('upgrade', (req, socket, head) => {
    gateway.handleUpgrade(req, socket as Duplex, head)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const http = server as unknown as Server
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.()
        http.close(() => resolve())
      }),
  )
  const port = (server.address() as AddressInfo).port

  const changes: DeviceChange[] = []
  stream.devices.onChange((c) => changes.push(c))

  const json = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  }

  return {
    stream,
    port,
    logs,
    changes,
    async pairDevice() {
      const code = await json('POST', '/api/stream/devices/pairing-code')
      expect(code.status).toBe(200)
      const pair = await json('POST', '/api/stream/devices/pair', { code: code.body!.code, name: 'CDP 测试机', platform: 'linux' })
      expect(pair.status).toBe(200)
      const deviceId = pair.body!.deviceId as string
      const ext = await json('POST', `/api/stream/devices/${deviceId}/ext-pairing-code`)
      expect(ext.status).toBe(200)
      return { deviceId, code: ext.body!.code as string }
    },
  }
}

/** 起一份绑定（配对码从回调给，等价于 CLI 从 stdin 读）。 */
async function bind(h: Harness, browser: TestChromium, code: string, log: (l: string) => void): Promise<CdpBinding> {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'stream-cdp-e2e-state-')), 'state.json')
  roots.push(join(stateFile, '..'))
  const b = await startCdpBinding({
    cdpUrl: browser.cdpUrl,
    serverUrl: `http://127.0.0.1:${h.port}`,
    stateFile,
    readPairingCode: async () => code,
    log,
    reconnectMs: 50,
    cdpRetryMs: 50,
  })
  cleanup.push(() => b.close())
  return b
}

describe.skipIf(!hasChromium)('CDP 绑定端到端（真 Stream + 真 Chromium）', () => {
  it('配对 → 绑定上线 → cdp_look 读到真页面 → 杀掉浏览器 → 离线', async () => {
    const h = await harness()
    const browser = (await launchChromium())!
    cleanup.push(() => browser.close())

    const { deviceId, code } = await h.pairDevice()
    const bindingLogs: string[] = []
    const binding = await bind(h, browser, code, (l) => bindingLogs.push(l))
    expect(binding.bindingId).toBeTruthy()

    // 服务端眼里它就是一条普通的扩展绑定
    await vi.waitFor(() => {
      expect(h.changes).toContainEqual(
        expect.objectContaining({ kind: 'binding', deviceId, online: true, bindingId: binding.bindingId }),
      )
    })
    expect(h.stream.devices.online().bindings.map((b) => b.bindingId)).toContain(binding.bindingId)

    // 在真浏览器里开一张临时标签读页面：inventory 的返回值里有 url / title
    const look = await h.stream.tools.call('cdp_look', {
      target: `device:${deviceId}/chrome`,
      url: 'data:text/html,<title>x3</title>',
      inventory: true,
    })
    expect(look.isError, JSON.stringify(look.content)).toBeFalsy()
    const inv = (look.value as { value: { title: string; url: string } }).value
    expect(inv.title).toBe('x3')
    expect(inv.url).toContain('data:text/html')

    // 浏览器没了：绑定主动断开中继，服务端收到离线
    await browser.close()
    await vi.waitFor(
      () => {
        expect(h.changes).toContainEqual(expect.objectContaining({ kind: 'binding', deviceId, online: false }))
      },
      { timeout: 10_000 },
    )
    // 日志里没有配对码（它只活在这一次调用里）
    expect(bindingLogs.join('\n')).not.toContain(code)
  }, 60_000)

  it('cdp_act({kind:\'login\'}) 走通真浏览器；用户名与密码一个字符都不进任何日志', async () => {
    // 一个真的登录页：提交后导航走（runLogin 以「文档换了」判成功）
    const site: Server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (req.url?.startsWith('/done')) res.end('<title>done</title><p>ok</p>')
      else if (req.url === '/login')
        res.end('<title>login</title><form action="/done" method="get"><input id="u" name="u"><input id="p" name="p" type="password"><button type="submit" id="go">go</button></form>')
      else res.end('<title>home</title>')
    })
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
    cleanup.push(() => new Promise<void>((r) => site.close(() => r())))
    const sitePort = (site.address() as AddressInfo).port

    const secretSource: SecretSource = {
      get: async (ref) =>
        ref === 'canary-ref' ? { origins: [`http://127.0.0.1:${sitePort}`], username: USERNAME, password: CANARY } : null,
    }
    const h = await harness({ secretSource })
    const browser = (await launchChromium())!
    cleanup.push(() => browser.close())
    const { deviceId, code } = await h.pairDevice()
    const bindingLogs: string[] = []
    await bind(h, browser, code, (l) => bindingLogs.push(l))
    await vi.waitFor(() => {
      expect(h.changes).toContainEqual(expect.objectContaining({ kind: 'binding', deviceId, online: true }))
    })

    // 开一张登录页并留着（interactive:true 回执里的 target 就是下一步的地址）
    const opened = await h.stream.tools.call('cdp_look', {
      target: `device:${deviceId}/chrome`,
      url: `http://127.0.0.1:${sitePort}/login`,
      js: 'document.title',
      interactive: true,
    })
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy()
    const target = (opened.value as { target: string }).target
    expect(target).toMatch(new RegExp(`^device:${deviceId}/chrome:\\d+$`))

    const login = await h.stream.tools.call('cdp_act', {
      target,
      kind: 'login',
      domain: '127.0.0.1',
      secret: 'canary-ref',
      usernameSelector: '#u',
      passwordSelector: '#p',
      // 显式给提交按钮：headless Chromium 对"不带 text 的 Enter keyDown"不做隐式提交
      // （真窗口里会），默认的"在最后一个字段上回车"在这里不生效。这一条与中继无关，
      // 是浏览器那一侧的行为——见交付报告里的说明。
      submitSelector: '#go',
      confirmed: true,
    })
    expect(login.isError, JSON.stringify(login.content)).toBeFalsy()
    const result = login.value as { status: string; result?: { status: string; navigated: boolean } }
    expect(result.status).toBe('done')
    expect(result.result).toMatchObject({ status: 'logged-in', navigated: true })

    // 硬指标：所有日志（实例 + 网关 + 绑定 + 调试总线）里都搜不到密码与用户名
    const all = [...h.logs, ...bindingLogs].join('\n')
    expect(all).not.toContain(CANARY)
    expect(all).not.toContain(USERNAME)
    // 但这条链路本身在日志里看得见
    expect(bindingLogs.join('\n')).toContain('中继已连上')
  }, 90_000)
})
