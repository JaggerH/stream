// widget 面（/widgets 列表、/widgets/:id 详情、凭证现取口）与 /api/* 过**同一道门**：
// Host/Origin 检查 + 本机回环免密、外来要 token。判据本身的单测在 access-guard.test.ts、
// 门的接线在 access-guard.app.test.ts；这里钉的是 widget 这三张脸也在门后——凭证口签的是
// 能开设备回环端口的转发凭证，绝不能在门外。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpApiFixture, type HttpApiFixture } from '../http/__fixtures__/app-harness.ts'
import { mountWidgetListPage } from './page.ts'
import { WidgetsStore } from './store.ts'
import { parseWidgetManifest } from './manifest.ts'

const TOKEN = 'c'.repeat(64)
const MANIFEST = {
  id: 'clock',
  name: 'Clock',
  version: '1.0.0',
  entry: 'index.html',
  size: 'card',
  serve: { command: ['node', 'server.js'], port: 4173 },
}

let fixture: HttpApiFixture
let dir: string
beforeEach(() => {
  fixture = createHttpApiFixture()
  dir = mkdtempSync(join(tmpdir(), 'widgets-gate-'))
})
afterEach(() => {
  fixture.close()
  rmSync(dir, { recursive: true, force: true })
})

/** routes() 的挂载形态：createHttpApp **之后**才 mountWidgetListPage。 */
function build() {
  const app = fixture.build(TOKEN)
  const store = new WidgetsStore(join(dir, 'widgets.json'))
  store.set('clock', { dir, device: 'dev-1' })
  mountWidgetListPage(app, {
    store,
    secret: 's'.repeat(32),
    directory: { isOnline: () => true, portsOf: () => [4173] },
    manifestOf: () => parseWidgetManifest(JSON.stringify(MANIFEST)),
  })
  return app
}

/** 伪造对端地址与 Host 头的办法照 access-guard.app.test.ts：第三参就是 node-server 的 env。 */
const req = (
  app: ReturnType<typeof build>,
  path: string,
  o: { address?: string; host?: string; origin?: string; bearer?: string } = {}
) => {
  const headers: Record<string, string> = { Host: o.host ?? '127.0.0.1:8900' }
  if (o.origin !== undefined) headers.Origin = o.origin
  if (o.bearer !== undefined) headers.Authorization = `Bearer ${o.bearer}`
  return app.request(
    path,
    { headers },
    o.address === undefined ? undefined : { incoming: { socket: { remoteAddress: o.address } } }
  )
}

const LAN = { address: '10.9.8.21', host: '10.9.8.21:8900' }

describe('widget 面在访问门之内（本机免密 / 外来要 token）', () => {
  for (const [label, path] of [
    ['/widgets 列表页', '/widgets'],
    ['/widgets/:id 详情页', '/widgets/clock'],
    ['凭证现取口', '/api/widgets/clock/credential'],
  ] as const) {
    it(`${label}：非回环对端无 token → 401`, async () => {
      const r = await req(build(), path, LAN)
      expect(r.status).toBe(401)
      if (path.includes('/credential')) {
        // 没过门的请求不该签到凭证（响应里不该出现任何可用的转发地址）
        const body = (await r.json()) as Record<string, unknown>
        expect(body.src).toBeUndefined()
      }
    })

    it(`${label}：非回环对端带对 token → 200`, async () => {
      expect((await req(build(), `${path}?token=${TOKEN}`, LAN)).status).toBe(200)
    })

    it(`${label}：本机回环免密 → 200`, async () => {
      const r = await req(build(), path, { address: '127.0.0.1' })
      expect(r.status).toBe(200)
      if (path.includes('/credential')) {
        const body = (await r.json()) as { src?: string }
        expect(body.src).toContain('/api/fwd/dev-1/4173/')
      }
    })
  }

  it('凭证口签出的凭证绑 (device, port, widget)，Host/Origin 检查同样生效', async () => {
    const app = build()
    // 本机上的恶意网页（来源地址是 loopback，只有 Origin 认得出它）照拦
    const web = await req(app, '/api/widgets/clock/credential', { address: '127.0.0.1', origin: 'https://evil.com' })
    expect(web.status).toBe(403)
    // 外来带 token 的现取也要过 Host 检查：没带 Host 头（进程内请求默认无）fail-closed
    const noHost = await app.request(`/api/widgets/clock/credential?token=${TOKEN}`, {
      headers: {},
    })
    expect(noHost.status).toBe(403)
  })
})
