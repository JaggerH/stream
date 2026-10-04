import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ImportRunStore, type ImportItem } from '../sharing/import-run-store.ts'
import { registerSharingRoutes } from './sharing-routes.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'

function app() {
  const store = new UserStore(':memory:')
  store.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
  store.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: {} })
  const runs = new ImportRunStore(join(tmpdir(), `ir-${randomUUID()}.json`))
  const a = new Hono()
  registerSharingRoutes(a, {
    store, registry: new Registry([]), plugins: [{ id: 'rsshub' } as never], recipePackages: () => [],
    recipesUserDir: join(tmpdir(), `ru-${randomUUID()}`), runs,
    bindings: new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES)),
    directory: new ProviderDirectory(store, SYSTEM_IDENTITIES),
  })
  return { a, store, runs }
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const capsBundle = () => ({
  format: 'stream-bundle/v1',
  meta: { title: 'Caps', created: '2026-07-19', revision: '1.0.0' },
  channels: [], streams: [],
  providers: [{ id: 'their-quark', label: '作者的夸克', description: '', category: 'resolve', serves: ['aliyun-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
  requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
  embedded: { recipes: {} },
})

describe('sharing routes — exports', () => {
  it('POST /api/sharing/exports 产包；旧 /export 路径已删', async () => {
    const { a } = app()
    const res = await a.request('/api/sharing/exports', json({ root: { kind: 'channel', id: 'mine' } }))
    expect(res.status).toBe(200)
    const body = await res.json() as { bundle: { format: string } }
    expect(body.bundle.format).toBe('stream-bundle/v1')
    expect((await a.request('/api/sharing/export', json({ root: { kind: 'channel', id: 'mine' } }))).status).toBe(404)
  })

  it('缺 root → 400 且 errorBody 形状（error.code/message）', async () => {
    const { a } = app()
    const res = await a.request('/api/sharing/exports', json({}))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_error')
    expect(typeof body.error.message).toBe('string')
  })
})

describe('sharing routes — imports 资源', () => {
  it('POST /api/sharing/imports → 201 建 run；GET /:id 可寻址；GET 列表带 openCount', async () => {
    const { a, store } = app()
    const exp = await (await a.request('/api/sharing/exports', json({ root: { kind: 'channel', id: 'mine' } }))).json() as { bundle: unknown }
    const dst = app()
    const res = await dst.a.request('/api/sharing/imports', json({ bundle: exp.bundle }))
    expect(res.status).toBe(201)
    const run = await res.json() as { id: string; items: ImportItem[] }
    expect(run.id).toMatch(/^imp-/)
    expect(dst.store.getChannel('mine')).toBeTruthy()

    const got = await dst.a.request(`/api/sharing/imports/${run.id}`)
    expect(got.status).toBe(200)
    expect((await got.json() as { id: string }).id).toBe(run.id)

    const listed = await (await dst.a.request('/api/sharing/imports')).json() as { items: { id: string; openCount: number }[] }
    expect(listed.items[0].id).toBe(run.id)
    expect(typeof listed.items[0].openCount).toBe('number')

    expect((await dst.a.request('/api/sharing/imports/imp-nope')).status).toBe(404)
    void store
  })

  it('坏 bundle → 400 errorBody；旧 /import、/import-problems、/parked-providers 路径已删', async () => {
    const { a } = app()
    const res = await a.request('/api/sharing/imports', json({ bundle: { nope: 1 } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error')
    expect((await a.request('/api/sharing/import', json({}))).status).toBe(404)
    expect((await a.request('/api/sharing/import-problems')).status).toBe(404)
    expect((await a.request('/api/sharing/parked-providers')).status).toBe(404)
  })

  it('导入带 Provider 的包 → run 带 parked-provider item（附实时 conflicts 投影）→ decision 激活', async () => {
    const { a, store } = app()
    const res = await a.request('/api/sharing/imports', json({ bundle: capsBundle() }))
    const run = await res.json() as { id: string; items: (ImportItem & { conflicts?: unknown[] })[] }
    const item = run.items.find((i) => i.kind === 'parked-provider')!
    expect((item.subject as { providerId?: string }).providerId).toBe('their-quark')
    expect(item.conflicts).toEqual([]) // 实时冲突投影（无冲突）
    expect(store.getProvider('their-quark')?.options.parked).toBe(true)

    const dec = await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ itemId: item.id, choice: 'use-imported' }))
    expect(dec.status).toBe(200)
    expect(store.getProvider('their-quark')?.options.parked).toBeUndefined()
    expect(((await dec.json()) as { item: ImportItem }).item.status).toBe('decided')
  })

  it('decision：重复拍板 → 409；非法 choice → 400；未知 item → 404', async () => {
    const { a } = app()
    const run = await (await a.request('/api/sharing/imports', json({ bundle: capsBundle() }))).json() as { id: string; items: ImportItem[] }
    const itemId = run.items[0].id
    expect((await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ itemId, choice: 'nope' }))).status).toBe(400)
    expect((await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ itemId: 'itm-99', choice: 'dismiss' }))).status).toBe(404)
    expect((await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ itemId, choice: 'dismiss' }))).status).toBe(200)
    const again = await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ itemId, choice: 'dismiss' }))
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('conflict')
  })

  it('GET /:id 实时投影：provider 已在别处被删 → open item 显示为失效（decided/dismissed 态）', async () => {
    const { a, store } = app()
    const run = await (await a.request('/api/sharing/imports', json({ bundle: capsBundle() }))).json() as { id: string; items: ImportItem[] }
    store.removeProvider('their-quark')
    const got = await (await a.request(`/api/sharing/imports/${run.id}`)).json() as { items: ImportItem[] }
    expect(got.items.find((i) => i.kind === 'parked-provider')!.status).not.toBe('open')
  })
})

/**
 * 严格输入闸（docs/API.md §2）：写错一个键名过去是 200 + 一份看起来正常的响应，
 * 界面撞不到（字段名写死在前端），程序化调用方一撞一个准。逐端点钉三件事：
 * 400 + 指出该写哪个 + **副作用一个都没发生**。
 */
describe('sharing 写入面：不认识的键 → 400，绝不静默丢弃', () => {
  it('POST /api/sharing/exports 传 roots → 400 指向 root，且不产包', async () => {
    const { a } = app()
    const res = await a.request('/api/sharing/exports', json({ roots: { kind: 'channel', id: 'mine' } }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string }; bundle?: unknown }
    expect(body.error.code).toBe('validation_error')
    // 必须是**这道闸**说的话，不是碰巧撞上某条形状校验。
    expect(body.error.message).toContain('不认识的字段')
    expect(body.error.message).toContain('roots')
    expect(body.error.message).toContain('root')
    expect(body.bundle).toBeUndefined()
  })

  it('POST /api/sharing/imports 传 urls → 400 指向 url，且一条 run 都没落', async () => {
    const { a, runs } = app()
    const res = await a.request('/api/sharing/imports', json({ urls: 'https://x/y.json' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.message).toContain('不认识的字段')
    expect(body.error.message).toContain('urls')
    expect(body.error.message).toContain('url')
    expect(runs.list()).toHaveLength(0)
  })

  it('POST /api/sharing/imports/:id/decisions 传 item_id → 400 指向 itemId，item 仍是 open', async () => {
    const { a } = app()
    const run = await (await a.request('/api/sharing/imports', json({ bundle: capsBundle() }))).json() as { id: string; items: ImportItem[] }
    const itemId = run.items[0].id
    const res = await a.request(`/api/sharing/imports/${run.id}/decisions`, json({ item_id: itemId, choice: 'dismiss' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.message).toContain('不认识的字段')
    expect(body.error.message).toContain('item_id')
    expect(body.error.message).toContain('itemId')
    const after = await (await a.request(`/api/sharing/imports/${run.id}`)).json() as { items: ImportItem[] }
    expect(after.items.find((i) => i.id === itemId)!.status).toBe('open')
  })

  it('合法键照常放行——闸不是把正常调用挡在门外', async () => {
    const { a } = app()
    const res = await a.request('/api/sharing/exports', json({ root: { kind: 'channel', id: 'mine' }, meta: { title: 'T' } }))
    expect(res.status).toBe(200)
  })
})
