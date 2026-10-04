/**
 * `embed`（外接面板）频道走 `/api/channels`：建得出来、`options.url` 的形状在写入口被拦。
 * 真 `UserStore`——CHECK 约束收不收 'embed' 也在这条里一起验。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createHttpApp } from './app.ts'
import { UserStore } from '../store/user-store.ts'

describe('/api/channels — embed present', () => {
  let dir: string
  let store: UserStore
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-embed-'))
    store = new UserStore(join(dir, 'stream.db'))
    app = createHttpApp({
      service: { streamsResource: () => [] },
      itemStore: { get: () => undefined, recent: () => [] },
      channelStore: store,
      health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
    } as never)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const postJson = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const patchJson = (path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('POST present=embed + http(s) url → 201，存进 options.url', async () => {
    const r = await postJson('/api/channels', { label: '监控', present: 'embed', stream_ids: [], options: { url: 'http://127.0.0.1:8123/live' } })
    expect(r.status).toBe(201)
    const created = await r.json() as { id: string; present: string; options: { url: string } }
    expect(created.present).toBe('embed')
    expect(store.getChannel(created.id)!.options).toEqual({ url: 'http://127.0.0.1:8123/live' })
  })

  it('POST 没给 url 也建得出来（面板画占位，去配置分页再填）', async () => {
    const r = await postJson('/api/channels', { label: '监控', present: 'embed', stream_ids: [], options: {} })
    expect(r.status).toBe(201)
  })

  it.each([
    ['javascript:alert(1)'],
    ['/relative/path'],
    ['not a url'],
    ['ftp://host/x'],
  ])('POST options.url=%s → 400 validation_error，与其它 options 校验同一错误形状', async (url) => {
    const r = await postJson('/api/channels', { label: '监控', present: 'embed', stream_ids: [], options: { url } })
    expect(r.status).toBe(400)
    const body = await r.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_error')
    expect(body.error.message).toMatch(/options\.url/)
  })

  it('POST options.url 不是字符串 → 400', async () => {
    const r = await postJson('/api/channels', { label: '监控', present: 'embed', stream_ids: [], options: { url: 42 } })
    expect(r.status).toBe(400)
  })

  it('PATCH 改 url 走同一条校验；合法的写进去，非法的整条拒绝、原值不动', async () => {
    const created = await (await postJson('/api/channels', { label: '监控', present: 'embed', stream_ids: [], options: { url: 'https://a.example/' } })).json() as { id: string }
    expect((await patchJson(`/api/channels/${created.id}`, { options: { url: 'javascript:void(0)' } })).status).toBe(400)
    expect(store.getChannel(created.id)!.options).toEqual({ url: 'https://a.example/' })
    expect((await patchJson(`/api/channels/${created.id}`, { options: { url: 'https://b.example/dash' } })).status).toBe(200)
    expect(store.getChannel(created.id)!.options).toEqual({ url: 'https://b.example/dash' })
  })
})
