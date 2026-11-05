import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WIDGET_SCHEMA, WIDGET_DATA_PATH, parseWidgetManifest } from './manifest.ts'
import { checkWidget } from './check.ts'
import { WidgetsStore } from './store.ts'

const VALID = {
  id: 'my-status',
  name: '我的状态牌',
  version: '0.1.0',
  entry: 'ui/index.html',
  size: 'card',
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'widget-test-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const widgetDir = (name: string, files: Record<string, string>) => {
  const dir = join(root, name)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return dir
}

// ── schema ──────────────────────────────────────────────────────────────────

describe('widget.json schema', () => {
  it('合法描述通过', () => {
    expect(WIDGET_SCHEMA.safeParse(VALID).success).toBe(true)
  })

  it('非法字段逐个被拒', () => {
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, id: 'My-Status' }).success).toBe(false) // 非 kebab-case
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, version: '1.0' }).success).toBe(false) // 非 semver
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, entry: 'ui/index.js' }).success).toBe(false) // 不是 .html
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, size: 'huge' }).success).toBe(false) // 不认识的 size
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, unknownField: 1 }).success).toBe(false) // 未知字段
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, serve: { command: ['x'], port: 8900 } }).success).toBe(false) // 撞主实例端口
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, serve: { command: ['x'], port: 80 } }).success).toBe(false) // 特权端口
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, preview: { type: 'text' } }).success).toBe(false) // text 缺 text 字段
  })

  it('network 白名单：主机名与 *.后缀可以，别的格式不行', () => {
    const ok = { ...VALID, permissions: { network: ['api.example.com', '*.example.org'] } }
    const bad = { ...VALID, permissions: { network: ['https://api.example.com'] } }
    expect(WIDGET_SCHEMA.safeParse(ok).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse(bad).success).toBe(false)
  })

  it('parseWidgetManifest：文本 → 对象或 null', () => {
    expect(parseWidgetManifest(JSON.stringify(VALID))?.id).toBe('my-status')
    expect(parseWidgetManifest('not json')).toBeNull()
    expect(parseWidgetManifest('{"id":1}')).toBeNull()
  })
})

// ── 检查器 ──────────────────────────────────────────────────────────────────

describe('checkWidget', () => {
  it('静态页面（无 serve / permissions）：全部通过，serve 两条 skipped', async () => {
    const dir = widgetDir('static', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }),
      'index.html': '<h1>hi</h1>',
    })
    const out = await checkWidget(dir)
    expect(out.ok).toBe(true)
    const byRule = Object.fromEntries(out.results.map((r) => [r.rule, r]))
    expect(byRule['manifest'].ok).toBe(true)
    expect(byRule['entry'].ok).toBe(true)
    expect(byRule['serve-port'].skipped).toBe(true)
    expect(byRule['serve-up'].skipped).toBe(true)
    expect(byRule['permissions'].skipped).toBe(true)
  })

  it('manifest 缺失 / JSON 坏 / schema 坏：逐条给原因', async () => {
    const missing = join(root, 'no-manifest-here')
    expect((await checkWidget(missing)).results[0]).toMatchObject({ rule: 'manifest', ok: false })
    const badJson = widgetDir('bad-json', { 'widget.json': '{oops' })
    expect((await checkWidget(badJson)).results[0].rule).toBe('manifest')
    const badSchema = widgetDir('bad-schema', { 'widget.json': JSON.stringify({ ...VALID, id: 'Bad_ID' }) })
    const out = await checkWidget(badSchema)
    expect(out.results[0]).toMatchObject({ rule: 'manifest', ok: false })
    expect(out.results[0].message).toContain('id')
  })

  it('entry / icon 不存在：各自一条失败', async () => {
    const dir = widgetDir('missing-entry', { 'widget.json': JSON.stringify({ ...VALID, icon: 'icon.svg' }) })
    const byRule = Object.fromEntries((await checkWidget(dir)).results.map((r) => [r.rule, r]))
    expect(byRule['entry'].ok).toBe(false)
    expect(byRule['icon'].ok).toBe(false)
    // icon 存在即过
    const dir2 = widgetDir('has-icon', { 'widget.json': JSON.stringify({ ...VALID, icon: 'icon.svg' }), 'ui/index.html': 'x', 'icon.svg': '<svg/>' })
    const out2 = await checkWidget(dir2)
    expect(out2.ok).toBe(true)
  })

  it('serve-port：撞主实例端口 8900 一条失败', async () => {
    const dir = widgetDir('port-clash', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: ['true'], port: 8900 } }) })
    const out = await checkWidget(dir)
    // serve.port=8900 在 schema 就拒了——manifest 一条失败即整体失败；要单独测 serve-port 规则，
    // 用一个 schema 放行、规则拒绝的路径不存在，所以这里断言 manifest 失败且 message 提到端口。
    expect(out.results[0]).toMatchObject({ rule: 'manifest', ok: false })
    expect(out.results[0].message).toContain('8900')
  })

  it('serve-up：命令起得来、回应健康检查 → 通过', async () => {
    const server: Server = createServer((_q, res) => { res.end('ok') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const dir = widgetDir('serve-ok', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: ['true'], port } }) })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    expect(out.results.find((r) => r.rule === 'serve-up')!.ok).toBe(true)
    server.close()
  })

  it('serve-up：命令起不来（不存在的可执行文件）→ 失败并说明', async () => {
    const dir = widgetDir('serve-bad-cmd', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: ['definitely-not-a-real-binary-xyz'], port: 8765 } }) })
    const out = await checkWidget(dir, { timeoutMs: 2_000 })
    const serveUp = out.results.find((r) => r.rule === 'serve-up')!
    expect(serveUp.ok).toBe(false)
    expect(serveUp.message).toContain('definitely-not-a-real-binary-xyz')
  })

  it('serve-up：起了但永不回应 → 超时失败', async () => {
    const listener = createServer(() => { /* 收到连接也不回应 */ })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as AddressInfo).port
    const dir = widgetDir('serve-silent', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: ['sleep', '60'], port } }) })
    const out = await checkWidget(dir, { timeoutMs: 1_000 })
    expect(out.results.find((r) => r.rule === 'serve-up')!.ok).toBe(false)
    listener.close()
  })

  it('permissions：network 格式坏 → manifest 拒绝并指到 permissions', async () => {
    const dir = widgetDir('bad-perms', { 'widget.json': JSON.stringify({ ...VALID, permissions: { network: ['not a host!'] } }) })
    const out = await checkWidget(dir)
    expect(out.ok).toBe(false)
    expect(out.results[0]).toMatchObject({ rule: 'manifest', ok: false })
    expect(out.results[0].message).toContain('permissions')
  })

  // ── data 写入口（openspec `widget-data-ingress`）────────────────────────────

  /** 起一个随端口的测试服务器（serve.command 用 `true`：端口由测试服务器占着，健康检查直接过）。 */
  const startTestServer = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> => {
    const server: Server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { server, port: (server.address() as AddressInfo).port }
  }

  it('data 无 serve：schema 照样放行（拒给检查器），data-ingress 一条不通过', async () => {
    // 拒绝是检查器的规则而不是 schema：现存 widget.json 的解析行为不变。
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, data: { type: 'object' } }).success).toBe(true)
    const dir = widgetDir('data-no-serve', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' } }),
      'index.html': '<h1>hi</h1>',
    })
    const out = await checkWidget(dir)
    expect(out.ok).toBe(false)
    const byRule = Object.fromEntries(out.results.map((r) => [r.rule, r]))
    expect(byRule['data-ingress'].ok).toBe(false)
    expect(byRule['data-ingress'].message).toContain('数据无处可写')
    expect(byRule['data-endpoint'].skipped).toBe(true)
  })

  it('data + serve 且端点回 2xx → 通过；没有 data 的 widget 两条新规则都 skipped，行为不变', async () => {
    const { server, port } = await startTestServer((_q, res) => { res.end('ok') })
    const withData = widgetDir('data-endpoint-ok', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: ['true'], port } }),
      'ui/index.html': 'x',
    })
    const out = await checkWidget(withData, { timeoutMs: 3_000 })
    expect(out.ok).toBe(true)
    const byRule = Object.fromEntries(out.results.map((r) => [r.rule, r]))
    expect(byRule['data-ingress'].ok).toBe(true)
    expect(byRule['data-endpoint'].ok).toBe(true)

    const plain = widgetDir('no-data-serve', {
      'widget.json': JSON.stringify({ ...VALID, serve: { command: ['true'], port } }),
      'ui/index.html': 'x',
    })
    const out2 = await checkWidget(plain, { timeoutMs: 3_000 })
    const byRule2 = Object.fromEntries(out2.results.map((r) => [r.rule, r]))
    expect(byRule2['data-ingress'].skipped).toBe(true)
    expect(byRule2['data-endpoint'].skipped).toBe(true)
    expect(out2.ok).toBe(true)
    server.close()
  })

  it('data-endpoint：widget 校验数据后回 4xx 也是口在 → 通过', async () => {
    const { server, port } = await startTestServer((req, res) => {
      if (req.method === 'POST' && req.url === WIDGET_DATA_PATH) { res.statusCode = 400; res.end('bad data'); return }
      res.end('ok')
    })
    const dir = widgetDir('data-endpoint-4xx', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object', required: ['value'] }, serve: { command: ['true'], port } }),
      'ui/index.html': 'x',
    })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    const ep = out.results.find((r) => r.rule === 'data-endpoint')!
    expect(ep.ok).toBe(true)
    expect(ep.message).toContain('400')
    server.close()
  })

  it('data-endpoint：端点 404 → 不通过并指名路径', async () => {
    const { server, port } = await startTestServer((req, res) => {
      if (req.method === 'POST' && req.url === WIDGET_DATA_PATH) { res.statusCode = 404; res.end('nope'); return }
      res.end('ok')
    })
    const dir = widgetDir('data-endpoint-404', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: ['true'], port } }),
      'ui/index.html': 'x',
    })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    const ep = out.results.find((r) => r.rule === 'data-endpoint')!
    expect(ep.ok).toBe(false)
    expect(ep.message).toContain(WIDGET_DATA_PATH)
    expect(out.ok).toBe(false)
    server.close()
  })

  it('data-endpoint：端点连接失败（收到数据口请求直接断开）→ 不通过', async () => {
    const { server, port } = await startTestServer((req, res) => {
      if (req.method === 'POST' && req.url === WIDGET_DATA_PATH) { req.socket.destroy(); return }
      res.end('ok')
    })
    const dir = widgetDir('data-endpoint-reset', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: ['true'], port } }),
      'ui/index.html': 'x',
    })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    const ep = out.results.find((r) => r.rule === 'data-endpoint')!
    expect(ep.ok).toBe(false)
    expect(ep.message).toContain('连不上')
    server.close()
  })
})

// ── 挂载存储 ────────────────────────────────────────────────────────────────

describe('WidgetsStore', () => {
  it('add / get / delete；损坏文件容错为空表', () => {
    const file = join(root, 'widgets-store-test.json')
    const store = new WidgetsStore(file)
    expect(store.list()).toEqual({})
    store.set('a', { dir: '/x', device: 'local' })
    expect(store.get('a')).toEqual({ dir: '/x', device: 'local' })
    expect(JSON.parse(readFileSync(file, 'utf8')).a).toBeDefined()
    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
    writeFileSync(file, '{corrupt')
    expect(store.list()).toEqual({})
  })
})
