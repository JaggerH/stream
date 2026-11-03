import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WIDGET_SCHEMA, parseWidgetManifest } from './manifest.ts'
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
