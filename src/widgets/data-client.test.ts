import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { WidgetDataClient, WidgetDataError, objectPathProblem } from './data-client.ts'
import {
  WIDGET_STORAGE_DOCUMENT_PATH,
  WIDGET_STORAGE_OBJECTS_PATH,
} from './manifest.ts'

/**
 * 参考客户端对假服务端的契约测试（openspec `widget-data-storage`）：
 * 文档/对象往返、条件写的头形状、错误码 409/412/413/429/503/507 的映射、路径规范化先拒不发。
 */

let server: Server
let baseUrl = ''
const requests: Array<{ method: string; url: string; ifMatch?: string; ifNoneMatch?: string }> = []

/** 内存里的一只假对象存储：path → bytes，带 revision。 */
const store = new Map<string, Uint8Array>()
let doc: Uint8Array | null = null
let docRevision = 0
let revision = 0

const etagOf = (rev: number) => `W/"t:${rev}"`

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ method: req.method ?? '', url: req.url ?? '', ifMatch: req.headers['if-match'] as string | undefined, ifNoneMatch: req.headers['if-none-match'] as string | undefined })
      const url = req.url ?? ''
      if (url.startsWith('/fail')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unavailable', message: '后端不可达' })); return }
      if (url === WIDGET_STORAGE_DOCUMENT_PATH) {
        if (req.method === 'GET') {
          if (doc === null) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found', message: '没有写过' })); return }
          res.writeHead(200, { etag: etagOf(docRevision), 'x-widget-revision': String(docRevision) })
          res.end(doc)
          return
        }
        if (req.method === 'PUT') {
          const im = req.headers['if-match']
          const inm = req.headers['if-none-match']
          if (doc !== null && docRevision > 0 && !im) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'conflict', message: '覆盖必须带 If-Match' })); return }
          if (doc !== null && im && im !== etagOf(docRevision)) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'conflict', message: '版本不符' })); return }
          if (doc === null && inm !== '*') { res.writeHead(412, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'precondition', message: '新建用 If-None-Match: *' })); return }
          if (body.length > 1024) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'too_large', message: '文档超过本服务上限' })); return }
          doc = new Uint8Array(body)
          docRevision += 1
          res.writeHead(200, { etag: etagOf(docRevision), 'x-widget-revision': String(docRevision) })
          res.end()
          return
        }
      }
      const urlPath = url.split('?')[0]
      if (urlPath === WIDGET_STORAGE_OBJECTS_PATH && req.method === 'GET') {
        const prefix = new URL(url, 'http://x').searchParams.get('prefix') ?? ''
        const items = [...store.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, bytes]) => ({
          path: p, revision: '1', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, updatedAt: 1,
        }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items }))
        return
      }
      const m = url.match(new RegExp(`^${WIDGET_STORAGE_OBJECTS_PATH}/(.+)$`))
      if (m) {
        const path = decodeURIComponent(m[1])
        const probe = url.endsWith('/.probe')
        if (req.method === 'HEAD') {
          if (probe || !store.has(path)) { res.writeHead(store.has(path) ? 200 : 404); res.end(); return }
          const bytes = store.get(path)!
          res.writeHead(200, { etag: etagOf(1), 'x-widget-sha256': createHash('sha256').update(bytes).digest('hex'), 'content-length': String(bytes.length), 'x-widget-updated-at': '1' })
          res.end()
          return
        }
        if (req.method === 'GET') {
          const bytes = store.get(path)
          if (!bytes) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found', message: '没有写过' })); return }
          res.writeHead(200, { etag: etagOf(1), 'x-widget-revision': '1', 'x-widget-sha256': createHash('sha256').update(bytes).digest('hex') })
          res.end(bytes)
          return
        }
        if (req.method === 'PUT') {
          if (req.headers.authorization !== 'Bearer t0k3n') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized', message: '凭据不对' })); return }
          const im = req.headers['if-match']
          const inm = req.headers['if-none-match']
          if (store.has(path) && !im && inm !== '*') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'conflict', message: '覆盖必须带 If-Match' })); return }
          if (store.has(path) && im && im !== etagOf(1)) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'conflict', message: '版本不符' })); return }
          if (!store.has(path) && inm !== '*' && !im) { res.writeHead(412, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'precondition', message: '新建用 If-None-Match: *' })); return }
          if (path === 'big.bin' && body.length > 1024) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'object_too_large', message: '对象超过本服务上限' })); return }
          if (path === 'quota.bin') { res.writeHead(507, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'quota_exceeded', message: '总量超限' })); return }
          if (path === 'rate.bin') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited', message: '慢一点' })); return }
          store.set(path, new Uint8Array(body))
          revision += 1
          res.writeHead(200, { etag: etagOf(revision), 'x-widget-revision': String(revision) })
          res.end()
          return
        }
        if (req.method === 'DELETE') {
          if (!store.delete(path)) { res.writeHead(404); res.end(); return }
          res.writeHead(204)
          res.end()
          return
        }
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  store.clear()
  doc = null
  docRevision = 0
  revision = 0
  requests.length = 0
})

const client = () => new WidgetDataClient({ baseUrl, token: 't0k3n' })

describe('objectPathProblem', () => {
  it('合法相对路径通过', () => {
    expect(objectPathProblem('lists/todo.json')).toBeNull()
    expect(objectPathProblem('a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p')).toBeNull()
  })

  it('绝对路径 / .. / 反斜杠 / NUL / 空段拒绝', () => {
    expect(objectPathProblem('/etc/passwd')).toContain('相对路径')
    expect(objectPathProblem('a/../b')).toContain('..')
    expect(objectPathProblem('./a')).toContain('.')
    expect(objectPathProblem('a\\b')).toContain('反斜杠')
    expect(objectPathProblem('a\0b')).toContain('NUL')
    expect(objectPathProblem('a//b')).toContain('空段')
    expect(objectPathProblem('')).toContain('非空')
  })

  it('超长段 / 超长路径 / 超深 / 保留名拒绝', () => {
    expect(objectPathProblem('x'.repeat(256))).toContain('255')
    expect(objectPathProblem(('a/'.concat('y'.repeat(200), '/')).concat('z'.repeat(200), '/').concat('w'.repeat(200)))).toContain('512')
    expect(objectPathProblem(Array.from({ length: 17 }, (_, i) => `s${i}`).join('/'))).toContain('16')
    expect(objectPathProblem('doc')).toContain('保留名')
    expect(objectPathProblem('doc/x')).toContain('保留名')
    expect(objectPathProblem('.well-known/widget-data')).toContain('保留名')
  })
})

describe('文档', () => {
  it('没写过回 404 → null；新建用 If-None-Match: *，覆盖带 If-Match', async () => {
    expect(await client().getDocument()).toBeNull()
    const c = client()
    const put1 = await c.putDocument({ hello: 'world' }, { ifNoneMatchStar: true })
    expect(put1.revision).toBe('W/"t:1"')
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', ifNoneMatch: '*' })

    const got = await c.getDocument()
    expect(got?.body).toEqual({ hello: 'world' })
    expect(got?.revision).toBe('W/"t:1"')

    const put2 = await c.putDocument({ hello: 'world2' }, { ifMatch: 'W/"t:1"' })
    expect(put2.revision).toBe('W/"t:2"')
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', ifMatch: 'W/"t:1"' })
  })

  it('覆盖不带 If-Match → 409；过期 If-Match → 409；错误体进异常', async () => {
    const c = client()
    await c.putDocument({ a: 1 }, { ifNoneMatchStar: true })
    await expect(c.putDocument({ b: 2 })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await expect(c.putDocument({ b: 2 }, { ifMatch: 'W/"t:999"' })).rejects.toBeInstanceOf(WidgetDataError)
  })

  it('文档超限 413、服务不可达 503 映射为可读错误', async () => {
    const c = new WidgetDataClient({ baseUrl, token: 't0k3n' })
    await expect(c.putDocument({ big: 'x'.repeat(2000) }, { ifNoneMatchStar: true })).rejects.toMatchObject({ status: 413 })
    const c2 = new WidgetDataClient({ baseUrl: `${baseUrl}/fail`, token: 't0k3n' })
    await expect(c2.getDocument()).rejects.toMatchObject({ status: 503, code: 'unavailable' })
  })
})

describe('对象', () => {
  it('PUT → GET 往返；条件写头形状正确；DELETE 幂等', async () => {
    const c = client()
    const put = await c.putObject('lists/todo.json', new TextEncoder().encode('[]'), { ifNoneMatchStar: true }, 'application/json')
    expect(put.revision).toBe('W/"t:1"')
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', ifNoneMatch: '*' })

    const got = await c.getObject('lists/todo.json')
    expect(new TextDecoder().decode(got!.bytes)).toBe('[]')
    expect(got!.revision).toBe('W/"t:1"')

    const put2 = await c.putObject('lists/todo.json', new TextEncoder().encode('[1]'), { ifMatch: put.revision })
    expect(put2.revision).toBe('W/"t:2"')

    await c.deleteObject('lists/todo.json')
    await expect(c.getObject('lists/todo.json')).resolves.toBeNull()
    // 幂等：再删一次，404 也算删成
    await expect(c.deleteObject('lists/todo.json')).resolves.toBeUndefined()
  })

  it('HEAD 元数据；列举 prefix 过滤', async () => {
    const c = client()
    await c.putObject('a/one.txt', new TextEncoder().encode('1'), { ifNoneMatchStar: true })
    await c.putObject('b/two.txt', new TextEncoder().encode('22'), { ifNoneMatchStar: true })
    const stat = await c.statObject('a/one.txt')
    expect(stat?.bytes).toBe(1)
    expect(stat?.sha256).toBe(createHash('sha256').update('1').digest('hex'))

    const page = await c.list('a/')
    expect(page.items.map((i) => i.path)).toEqual(['a/one.txt'])
  })

  it('409/412/413/507/429/503 都映射为带状态码与 code 的异常', async () => {
    const c = client()
    await c.putObject('conflict.bin', new TextEncoder().encode('x'), { ifNoneMatchStar: true })
    await expect(c.putObject('conflict.bin', new TextEncoder().encode('y'))).rejects.toMatchObject({ status: 409 })
    await expect(c.putObject('fresh.bin', new TextEncoder().encode('y'))).rejects.toMatchObject({ status: 412 })
    await expect(c.putObject('big.bin', new TextEncoder().encode('y'.repeat(2000)), { ifNoneMatchStar: true })).rejects.toMatchObject({ status: 413, code: 'object_too_large' })
    await expect(c.putObject('quota.bin', new TextEncoder().encode('y'), { ifNoneMatchStar: true })).rejects.toMatchObject({ status: 507, code: 'quota_exceeded' })
    await expect(c.putObject('rate.bin', new TextEncoder().encode('y'), { ifNoneMatchStar: true })).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
    const c2 = new WidgetDataClient({ baseUrl: `${baseUrl}/fail`, token: 't0k3n' })
    await expect(c2.getObject('x')).rejects.toMatchObject({ status: 503 })
  })

  it('凭据进 Authorization 头；路径非法时客户端先拒不发请求', async () => {
    const c = client()
    await c.putObject('auth-check.txt', new TextEncoder().encode('x'), { ifNoneMatchStar: true })
    expect(requests.at(-1)?.url).toBe(`${WIDGET_STORAGE_OBJECTS_PATH}/auth-check.txt`)
    // 服务端校验凭据（假服务端 401）；这里另起一个错凭据的客户端证明头确实在传
    const bad = new WidgetDataClient({ baseUrl, token: 'wrong' })
    await expect(bad.putObject('auth-bad.txt', new TextEncoder().encode('x'), { ifNoneMatchStar: true })).rejects.toMatchObject({ status: 401 })

    const before = requests.length
    await expect(c.putObject('/abs.txt', new TextEncoder().encode('x'))).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(c.getObject('doc')).rejects.toMatchObject({ code: 'invalid_path' })
    expect(requests.length).toBe(before)
  })
})
