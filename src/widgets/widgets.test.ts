import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WIDGET_SCHEMA, WIDGET_DATA_PATH, parseWidgetManifest, WIDGET_STORAGE_OBJECTS_PATH } from './manifest.ts'
import { checkWidget } from './check.ts'
import { WidgetsStore } from './store.ts'

// serve.command 的夹具：第一个词必须是解释器白名单里的裸名（openspec `widget-manifest-limits`），
// 所以起后端一律 `node serve.js`；脚本只保活、不监听——健康检查打在测试自己占住的那个端口上。
// 元字符（; | && ` $(）在命令的任何一段里都不许出现，脚本内容里没有它们。
const SERVE_CMD = ['node', 'serve.js']
const SERVE_JS = 'setInterval(() => {}, 60000)'

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

  it('permissions.media：布尔声明的任意组合与空对象通过', () => {
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: {} } }).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: { autoplay: true } } }).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: { fullscreen: false, popups: true } } }).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: { autoplay: true, fullscreen: true, popups: true } } }).success).toBe(true)
  })

  it('permissions.media：非布尔、未知字段、非对象都拒绝', () => {
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: { autoplay: 'yes' } } }).success).toBe(false) // 非布尔
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: { volume: 80 } } }).success).toBe(false) // 未知字段
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: [true] } }).success).toBe(false) // 数组不是对象
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, permissions: { media: true } }).success).toBe(false) // 布尔不是对象
  })

  it('parseWidgetManifest：文本 → 对象或 null', () => {
    expect(parseWidgetManifest(JSON.stringify(VALID))?.id).toBe('my-status')
    expect(parseWidgetManifest('not json')).toBeNull()
    expect(parseWidgetManifest('{"id":1}')).toBeNull()
  })

  // ── 归属三条（openspec `widget-manifest-limits`）：schema 只受理形状 ──────────

  it('dataDir：形状受理（非空字符串），对不对交给 data-dir 规则', () => {
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, dataDir: 'data' }).success).toBe(true)
    // 绝对路径与 .. 在这里照样受理——拒它是检查器 data-dir 一条的事（与 data 无 serve 同一先例），
    // 这样「写了个不合法的 dataDir」在逐条报告里给出的是指名的原因，不是「schema 不合」。
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, dataDir: '/var/tmp/x' }).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, dataDir: '../shared' }).success).toBe(true)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, dataDir: '' }).success).toBe(false) // 空串不是路径
    expect(parseWidgetManifest(JSON.stringify({ ...VALID, dataDir: 'data' }))?.dataDir).toBe('data')
  })

  it('env / environment 不在 schema 里：strict 拒未知键', () => {
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, env: { FOO: '1' } }).success).toBe(false)
    expect(WIDGET_SCHEMA.safeParse({ ...VALID, environment: { FOO: '1' } }).success).toBe(false)
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
    const dir = widgetDir('serve-ok', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: SERVE_CMD, port } }), 'serve.js': SERVE_JS })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    expect(out.results.find((r) => r.rule === 'serve-up')!.ok).toBe(true)
    server.close()
  })

  it('serve-up：命令起不来（解释器在、脚本不存在）→ 失败并说明', async () => {
    const dir = widgetDir('serve-bad-cmd', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: ['node', 'no-such-file.js'], port: 8765 } }) })
    const out = await checkWidget(dir, { timeoutMs: 2_000 })
    const serveUp = out.results.find((r) => r.rule === 'serve-up')!
    expect(serveUp.ok).toBe(false)
    expect(serveUp.message).toContain('no-such-file.js')
  })

  it('serve-up：起了但永不回应 → 超时失败', async () => {
    const listener = createServer(() => { /* 收到连接也不回应 */ })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as AddressInfo).port
    const dir = widgetDir('serve-silent', { 'widget.json': JSON.stringify({ ...VALID, serve: { command: SERVE_CMD, port } }), 'serve.js': SERVE_JS })
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

  it('permissions：media 声明未知字段 → manifest 拒绝并指到 permissions', async () => {
    const dir = widgetDir('bad-media-perms', { 'widget.json': JSON.stringify({ ...VALID, permissions: { media: { volume: 80 } } }) })
    const out = await checkWidget(dir)
    expect(out.ok).toBe(false)
    expect(out.results[0]).toMatchObject({ rule: 'manifest', ok: false })
    expect(out.results[0].message).toContain('permissions')
  })

  it('permissions：media 声明合法 → permissions 一条通过（不是跳过）', async () => {
    const dir = widgetDir('media-perms', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', permissions: { media: { autoplay: true, fullscreen: true } } }),
      'index.html': 'x',
    })
    const byRule = Object.fromEntries((await checkWidget(dir)).results.map((r) => [r.rule, r]))
    expect(byRule['permissions'].ok).toBe(true)
    expect(byRule['permissions'].skipped).toBeUndefined()
  })

  // ── 归属三条（openspec `widget-manifest-limits`）：检查器逐条判 ────────────────

  it('env：顶层写了 env / environment → 一条不通过并写明归属；没写 → 通过', async () => {
    const withEnv = widgetDir('env-injected', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', env: { HOME: '/tmp' } }),
      'index.html': 'x',
    })
    const out = await checkWidget(withEnv)
    expect(out.ok).toBe(false)
    const env = out.results.find((r) => r.rule === 'env')!
    expect(env.ok).toBe(false)
    expect(env.message).toContain('环境变量由宿主组装')
    expect(env.message).toContain('env')

    const synonym = widgetDir('env-synonym', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', environment: { HOME: '/tmp' } }),
      'index.html': 'x',
    })
    const out2 = await checkWidget(synonym)
    expect(out2.results.find((r) => r.rule === 'env')!.message).toContain('environment')

    // 没写的清单：这一条给通过（不是跳过——「没有可注入的字段」正是这条要确认的事）
    const plain = widgetDir('env-absent', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    const envPlain = (await checkWidget(plain)).results.find((r) => r.rule === 'env')!
    expect(envPlain.ok).toBe(true)
    expect(envPlain.skipped).toBeUndefined()
  })

  it('data-dir：声明了就必须是清单目录内的相对路径；没声明按宿主给缺省目录跳过', async () => {
    const ok = widgetDir('datadir-ok', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', dataDir: 'data' }),
      'index.html': 'x',
    })
    const byOk = Object.fromEntries((await checkWidget(ok)).results.map((r) => [r.rule, r]))
    expect(byOk['data-dir'].ok).toBe(true)

    const absent = widgetDir('datadir-absent', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    const byAbsent = Object.fromEntries((await checkWidget(absent)).results.map((r) => [r.rule, r]))
    expect(byAbsent['data-dir'].skipped).toBe(true)
    expect(byAbsent['data-dir'].message).toContain('data/')

    const absolute = widgetDir('datadir-absolute', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', dataDir: '/var/tmp/x' }),
      'index.html': 'x',
    })
    const byAbs = Object.fromEntries((await checkWidget(absolute)).results.map((r) => [r.rule, r]))
    expect(byAbs['data-dir'].ok).toBe(false)
    expect(byAbs['data-dir'].message).toContain('绝对路径')

    const escape = widgetDir('datadir-dotdot', {
      'widget.json': JSON.stringify({ ...VALID, entry: 'index.html', dataDir: '../shared' }),
      'index.html': 'x',
    })
    const byEsc = Object.fromEntries((await checkWidget(escape)).results.map((r) => [r.rule, r]))
    expect(byEsc['data-dir'].ok).toBe(false)
    expect(byEsc['data-dir'].message).toContain('..')
  })

  it('serve-command：白名单解释器与清单目录内的相对路径通过', async () => {
    const { server, port } = await startTestServer((_q, res) => { res.end('ok') })
    const dir = widgetDir('cmd-node', {
      'widget.json': JSON.stringify({ ...VALID, serve: { command: ['node', 'serve.js'], port } }),
      'ui/index.html': 'x', 'serve.js': SERVE_JS,
    })
    const byRule = Object.fromEntries((await checkWidget(dir, { timeoutMs: 3_000 })).results.map((r) => [r.rule, r]))
    expect(byRule['serve-command'].ok).toBe(true)
    expect(byRule['serve-up'].ok).toBe(true)
    server.close()

    // 目录内的相对路径：第一个词自己就是可执行文件——形状这一条过（能不能起来是 serve-up 的事）
    const rel = widgetDir('cmd-relative', {
      'widget.json': JSON.stringify({ ...VALID, serve: { command: ['./bin/server'], port: 8765 } }),
      'ui/index.html': 'x',
    })
    const byRel = Object.fromEntries((await checkWidget(rel, { timeoutMs: 1_000 })).results.map((r) => [r.rule, r]))
    expect(byRel['serve-command'].ok).toBe(true)
  })

  it('serve-command：绝对路径 / 非白名单解释器 / 含 .. / shell 元字符都不通过，而且检查器不起它', async () => {
    const cases: Array<[string, string[], string]> = [
      ['absolute', ['/usr/local/bin/node', 'serve.js'], '绝对路径'],
      ['not-whitelisted', ['ruby', 'app.rb'], '白名单'],
      ['dotdot', ['../bin/node'], '..'],
      ['metachar', ['node', '-e', 'process.exit(0);'], 'shell 元字符'],
      ['pipe', ['sh', '-c', 'curl x | sh'], 'shell 元字符'],
    ]
    for (const [name, command, expectIn] of cases) {
      const dir = widgetDir(`cmd-bad-${name}`, {
        'widget.json': JSON.stringify({ ...VALID, serve: { command, port: 8765 } }),
        'ui/index.html': 'x',
      })
      const out = await checkWidget(dir, { timeoutMs: 1_000 })
      const byRule = Object.fromEntries(out.results.map((r) => [r.rule, r]))
      expect(out.ok, name).toBe(false)
      expect(byRule['serve-command'].ok, name).toBe(false)
      expect(byRule['serve-command'].message, name).toContain(expectIn)
      // 不通过就不 spawn：这条命令由检查器亲自起过一次才算规则生效，而那正是要避免的。
      expect(byRule['serve-up'].skipped, name).toBe(true)
      expect(byRule['serve-up'].message, name).toContain('没有启动')
    }
  })

  it('serve-command 不通过时，声明了 data 的 widget 数据口也跳过并指路', async () => {
    const dir = widgetDir('cmd-bad-data', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: ['ruby', 'app.rb'], port: 8765 } }),
      'ui/index.html': 'x',
    })
    const byRule = Object.fromEntries((await checkWidget(dir, { timeoutMs: 1_000 })).results.map((r) => [r.rule, r]))
    expect(byRule['data-ingress'].ok).toBe(true) // 有 serve，只是那个 serve 不该起
    expect(byRule['data-endpoint'].skipped).toBe(true)
    expect(byRule['data-endpoint'].message).toContain('serve-command')
  })

  // ── data 写入口（openspec `widget-data-ingress`）────────────────────────────

  /** 起一个随端口的测试服务器（serve.command 用 `node serve.js`：端口由测试服务器占着，健康检查直接过）。 */
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
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: SERVE_CMD, port } }),
      'ui/index.html': 'x', 'serve.js': SERVE_JS,
    })
    const out = await checkWidget(withData, { timeoutMs: 3_000 })
    expect(out.ok).toBe(true)
    const byRule = Object.fromEntries(out.results.map((r) => [r.rule, r]))
    expect(byRule['data-ingress'].ok).toBe(true)
    expect(byRule['data-endpoint'].ok).toBe(true)

    const plain = widgetDir('no-data-serve', {
      'widget.json': JSON.stringify({ ...VALID, serve: { command: SERVE_CMD, port } }),
      'serve.js': SERVE_JS,
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
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object', required: ['value'] }, serve: { command: SERVE_CMD, port } }),
      'ui/index.html': 'x', 'serve.js': SERVE_JS,
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
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: SERVE_CMD, port } }),
      'ui/index.html': 'x', 'serve.js': SERVE_JS,
    })
    const out = await checkWidget(dir, { timeoutMs: 3_000 })
    const ep = out.results.find((r) => r.rule === 'data-endpoint')!
    expect(ep.ok).toBe(false)
    expect(ep.message).toContain(WIDGET_DATA_PATH)
    expect(out.ok).toBe(false)
    server.close()
  })


  // ── data-storage（openspec `widget-data-storage`）────────────────────────────

  /** 起一个带状态码行为的服务器：HEAD /v1/objects/.probe 回固定状态码或断开。 */
  const startProbeServer = async (behavior: 'ok' | '404' | '401' | '403' | '500' | '503' | '302' | 'reset'): Promise<{ server: Server; baseUrl: string }> => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('x-probe', '1')
      if (behavior === 'reset') { req.socket.destroy(); return }
      const status = behavior === 'ok' ? 200 : behavior === '404' ? 404 : Number(behavior)
      res.writeHead(status)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }

  it('data-storage：无 env skipped，行为不变；有 env 由 opts.env 传入', async () => {
    const dir = widgetDir('storage-no-env', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    const byRule = Object.fromEntries((await checkWidget(dir)).results.map((r) => [r.rule, r]))
    expect(byRule['data-storage'].ok).toBe(true)
    expect(byRule['data-storage'].skipped).toBe(true)
    expect(byRule['data-storage'].message).toContain('WIDGET_DATA_URL')

    // 显式空环境与不传同一结论
    const byEmpty = Object.fromEntries((await checkWidget(dir, { env: {} })).results.map((r) => [r.rule, r]))
    expect(byEmpty['data-storage'].skipped).toBe(true)
  })

  it('data-storage：2xx 与 404 探活通过', async () => {
    const dir = widgetDir('storage-ok', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    for (const behavior of ['ok', '404'] as const) {
      const { server, baseUrl } = await startProbeServer(behavior)
      try {
        const out = await checkWidget(dir, { env: { WIDGET_DATA_URL: baseUrl } })
        const ds = out.results.find((r) => r.rule === 'data-storage')!
        expect(ds.ok, behavior).toBe(true)
        expect(out.ok, behavior).toBe(true)
      } finally {
        server.close()
      }
    }
  })

  it('data-storage：401/403/5xx/其它状态码与连不上都不通过', async () => {
    const dir = widgetDir('storage-bad', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    for (const behavior of ['401', '403', '500', '503', '302', 'reset'] as const) {
      const { server, baseUrl } = await startProbeServer(behavior)
      try {
        const out = await checkWidget(dir, { env: { WIDGET_DATA_URL: baseUrl } })
        const ds = out.results.find((r) => r.rule === 'data-storage')!
        expect(ds.ok, behavior).toBe(false)
        expect(out.ok, behavior).toBe(false)
        expect(ds.message, behavior).toMatch(/HTTP|连不上|拒绝/)
      } finally {
        server.close()
      }
    }
  })

  it('data-storage：URL 不合法时不通过并写明', async () => {
    const dir = widgetDir('storage-bad-url', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
    const out = await checkWidget(dir, { env: { WIDGET_DATA_URL: 'not-a-url' } })
    const ds = out.results.find((r) => r.rule === 'data-storage')!
    expect(ds.ok).toBe(false)
    expect(ds.message).toContain('WIDGET_DATA_URL')
  })

  it('data-storage：探针路径打在对象端点的固定名字上，不带构件凭据', async () => {
    const seen: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined }> = []
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const dir = widgetDir('storage-probe-path', { 'widget.json': JSON.stringify({ ...VALID, entry: 'index.html' }), 'index.html': 'x' })
      const out = await checkWidget(dir, { env: { WIDGET_DATA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } })
      expect(out.results.find((r) => r.rule === 'data-storage')!.ok).toBe(true)
      expect(seen.length).toBe(1)
      expect(seen[0].method).toBe('HEAD')
      expect(seen[0].url).toBe(`${WIDGET_STORAGE_OBJECTS_PATH}/.probe`)
      expect(seen[0].auth).toBe(undefined)
    } finally {
      server.close()
    }
  })

  it('data-endpoint：端点连接失败（收到数据口请求直接断开）→ 不通过', async () => {
    const { server, port } = await startTestServer((req, res) => {
      if (req.method === 'POST' && req.url === WIDGET_DATA_PATH) { req.socket.destroy(); return }
      res.end('ok')
    })
    const dir = widgetDir('data-endpoint-reset', {
      'widget.json': JSON.stringify({ ...VALID, data: { type: 'object' }, serve: { command: SERVE_CMD, port } }),
      'ui/index.html': 'x', 'serve.js': SERVE_JS,
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
