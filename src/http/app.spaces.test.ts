/**
 * `/api/spaces` 四条 CRUD + 频道归属跟着走。真 `UserStore`，不 mock——这几条守的正是
 * "写进去的归属指向一个不存在的空间"这类问题，mock 掉存储就把要守的东西一起 mock 掉了。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createHttpApp } from './app.ts'
import { UserStore } from '../store/user-store.ts'
import { DEFAULT_SPACE_ID } from '../store/types.ts'

describe('/api/spaces', () => {
  let dir: string
  let store: UserStore
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-spaces-'))
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

  it('GET 至少有默认空间', async () => {
    const r = await app.request('/api/spaces')
    expect(r.status).toBe(200)
    expect((await r.json() as { id: string }[]).map((s) => s.id)).toEqual([DEFAULT_SPACE_ID])
  })

  it('POST 建一个空的空间，排在最后', async () => {
    const r = await postJson('/api/spaces', { label: '研究' })
    expect(r.status).toBe(201)
    const created = await r.json() as { id: string; label: string; position: number }
    expect(created.label).toBe('研究')
    expect(created.position).toBe(1) // 默认空间是 0
    expect((await (await app.request('/api/spaces')).json() as { id: string }[]).map((s) => s.id))
      .toEqual([DEFAULT_SPACE_ID, created.id])
  })

  it('POST 空名字被拒——一个没有名字的分组在侧栏里就是一条看不见的空行', async () => {
    expect((await postJson('/api/spaces', { label: '  ' })).status).toBe(400)
  })

  it('POST 不认识的字段响亮拒绝，不静默丢掉', async () => {
    const r = await postJson('/api/spaces', { label: 'x', name: 'x' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(await r.json())).toContain('name')
  })

  it('PATCH 改名 / 挪位置；默认空间也能改（不能删 ≠ 不能改）', async () => {
    const r = await patchJson(`/api/spaces/${DEFAULT_SPACE_ID}`, { label: '常用' })
    expect(r.status).toBe(200)
    expect((await r.json() as { label: string }).label).toBe('常用')
  })

  it('DELETE 把成员频道挪回默认空间，频道不跟着删', async () => {
    const created = await (await postJson('/api/spaces', { label: '研究' })).json() as { id: string }
    await postJson('/api/channels', { label: '甲', present: 'timeline', stream_ids: [], options: {}, space_id: created.id })
    expect((await app.request(`/api/spaces/${created.id}`, { method: 'DELETE' })).status).toBe(200)
    const channels = await (await app.request('/api/channels')).json() as { label: string; space_id: string }[]
    const moved = channels.find((ch) => ch.label === '甲')
    expect(moved).toBeTruthy()
    expect(moved!.space_id).toBe(DEFAULT_SPACE_ID)
  })

  it('DELETE 默认空间被拒——删了无主频道就没有落点了', async () => {
    expect((await app.request(`/api/spaces/${DEFAULT_SPACE_ID}`, { method: 'DELETE' })).status).toBe(400)
  })

  it('DELETE 不存在的空间是 404', async () => {
    expect((await app.request('/api/spaces/nope', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('频道的归属', () => {
  let dir: string
  let store: UserStore
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-ch-space-'))
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

  it('GET /api/channels 每条都带 space_id', async () => {
    const channels = await (await app.request('/api/channels')).json() as { space_id: string }[]
    expect(channels.length).toBeGreaterThan(0)
    for (const ch of channels) expect(ch.space_id).toBe(DEFAULT_SPACE_ID)
  })

  it('建频道不给归属就落默认空间', async () => {
    const created = await (await postJson('/api/channels', { label: '甲', present: 'timeline', stream_ids: [], options: {} })).json() as { space_id: string }
    expect(created.space_id).toBe(DEFAULT_SPACE_ID)
  })

  // 写之前拦：写进去一个不存在的空间，那个频道在侧栏里哪个空间下都不出现——
  // 一次静默消失，用户只会以为"频道没建成"。
  it('建频道指向不存在的空间：400，且什么都没建出来', async () => {
    const r = await postJson('/api/channels', { label: '甲', present: 'timeline', stream_ids: [], options: {}, space_id: 'ghost' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(await r.json())).toContain('ghost')
    expect(store.listChannels().some((ch) => ch.label === '甲')).toBe(false)
  })

  it('PATCH 换空间；指向不存在的空间同样 400 且不落库', async () => {
    const space = await (await postJson('/api/spaces', { label: '研究' })).json() as { id: string }
    const created = await (await postJson('/api/channels', { label: '甲', present: 'timeline', stream_ids: [], options: {} })).json() as { id: string }
    const ok = await patchJson(`/api/channels/${created.id}`, { space_id: space.id })
    expect(ok.status).toBe(200)
    expect((await ok.json() as { space_id: string }).space_id).toBe(space.id)
    expect((await patchJson(`/api/channels/${created.id}`, { space_id: 'ghost' })).status).toBe(400)
    expect(store.getChannel(created.id)!.space_id).toBe(space.id)
  })
})
