import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerNetdiskRoutes, type NetdiskDeps } from './netdisk-routes.ts'

/**
 * `POST /api/netdisk/fs/put`：multipart（path + file）→ 逐级 mkdir 父目录 → OpenList 流式 put。
 * 下游是一份 Python 导出脚本（每周传数据包），它只会调这一条，不碰登录态。
 */
function makeApp(over: Partial<{ put: unknown; mkdir: unknown }> = {}) {
  const received: Array<{ path: string; size: number; body: string }> = []
  const put = vi.fn(async (path: string, body: () => ReadableStream<Uint8Array>, size: number) => {
    const chunks: Uint8Array[] = []
    for await (const c of body() as unknown as AsyncIterable<Uint8Array>) chunks.push(c)
    received.push({ path, size, body: Buffer.concat(chunks).toString() })
  })
  const mkdir = vi.fn(async () => {})
  const app = new Hono()
  registerNetdiskRoutes(app, { alist: { put: over.put ?? put, mkdir: over.mkdir ?? mkdir }, service: {}, store: {} } as unknown as NetdiskDeps)
  return { app, put, mkdir, received }
}

function multipart(fields: Array<[name: string, value: string | Blob, filename?: string]>): { body: FormData } {
  const fd = new FormData()
  for (const [n, v, f] of fields) f ? fd.append(n, v as Blob, f) : fd.append(n, v as string)
  return { body: fd }
}

describe('POST /api/netdisk/fs/put', () => {
  it('上传：父目录 mkdir 一次（OpenList 递归建）→ put(path, 流, size) → {ok,size}', async () => {
    const { app, mkdir, received } = makeApp()
    const res = await app.request('/api/netdisk/fs/put', {
      method: 'POST', ...multipart([['path', '/quark/闲鱼数据包/pack-1/hello.txt'], ['file', new Blob(['hello world']), 'hello.txt']]),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, size: 11 })
    expect(mkdir).toHaveBeenCalledWith('/quark/闲鱼数据包/pack-1')
    expect(received).toEqual([{ path: '/quark/闲鱼数据包/pack-1/hello.txt', size: 11, body: 'hello world' }])
  })

  it('file 在 path 之前也行（先落盘再看 path，顺序不是契约的一部分）', async () => {
    const { app, received } = makeApp()
    const res = await app.request('/api/netdisk/fs/put', {
      method: 'POST', ...multipart([['file', new Blob(['abc']), 'a.bin'], ['path', '/quark/x/a.bin']]),
    })
    expect(res.status).toBe(200)
    expect(received[0]).toMatchObject({ path: '/quark/x/a.bin', size: 3, body: 'abc' })
  })

  it('不是 multipart / 缺 path / 缺 file / path 不是绝对路径或指向目录 → 400，不碰网盘', async () => {
    const { app, put, mkdir } = makeApp()
    const json = await app.request('/api/netdisk/fs/put', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(json.status).toBe(400)
    expect((await json.json() as { error: { code: string } }).error.code).toBe('validation_error')
    expect((await app.request('/api/netdisk/fs/put', { method: 'POST', ...multipart([['file', new Blob(['x']), 'x']]) })).status).toBe(400)
    expect((await app.request('/api/netdisk/fs/put', { method: 'POST', ...multipart([['path', '/quark/x']]) })).status).toBe(400)
    expect((await app.request('/api/netdisk/fs/put', { method: 'POST', ...multipart([['path', 'quark/x'], ['file', new Blob(['x']), 'x']]) })).status).toBe(400)
    expect((await app.request('/api/netdisk/fs/put', { method: 'POST', ...multipart([['path', '/quark/x/'], ['file', new Blob(['x']), 'x']]) })).status).toBe(400)
    expect(put).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('认不出的字段 → 400 并指出该写哪个（与 JSON 端点同一道闸）', async () => {
    const { app, put } = makeApp()
    const res = await app.request('/api/netdisk/fs/put', {
      method: 'POST', ...multipart([['paths', '/quark/x'], ['file', new Blob(['x']), 'x']]),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('paths')
    expect(body.error.message).toContain('path')
    expect(put).not.toHaveBeenCalled()
  })

  it('上游失败 → 502', async () => {
    const { app } = makeApp({ put: vi.fn(async () => { throw new Error('[alist] code 500: storage not found') }) })
    const res = await app.request('/api/netdisk/fs/put', {
      method: 'POST', ...multipart([['path', '/nope/x'], ['file', new Blob(['x']), 'x']]),
    })
    expect(res.status).toBe(502)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('upstream_error')
  })
})
