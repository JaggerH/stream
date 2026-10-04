import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerConversionsRoutes, KINDS, DERIVED_KINDS } from './conversions-routes.ts'
import { ConversionRunner, type Converter } from '../conversions/runner.ts'
import { ConversionStore } from '../conversions/store.ts'

const settle = () => new Promise((r) => setTimeout(r, 0))

function converter(over: Partial<Converter> = {}): Converter {
  return {
    kind: 'extract',
    label: 'OCR / 解析',
    stages: ['fetch', 'ocr'],
    available: () => true,
    async run(ctx) {
      const md = await ctx.stage('ocr', async () => '# ok')
      return { ok: true, result: { markdown: md } }
    },
    ...over,
  }
}

function setup(converters: Converter[] = [converter()], known = true) {
  const store = new ConversionStore(':memory:')
  const runner = new ConversionRunner({ store, converters, derivations: [], costarts: [] })
  const app = new Hono()
  registerConversionsRoutes(app, {
    runner,
    resolveHandle: vi.fn(() => ({ known, snapshot: { title: 'T' }, media: [{ url: 'u', kind: 'image' } as never] })),
  })
  return { app, runner, store }
}

describe('POST /api/conversions', () => {
  it('creates a conversion and points Location at it', async () => {
    const { app } = setup()
    const res = await app.request('/api/conversions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'extract', item: 'item-1' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; kind: string; snapshot: { title: string } }
    expect(body.kind).toBe('extract')
    expect(body.snapshot.title).toBe('T')
    expect(res.headers.get('Location')).toBe(`/api/conversions/${body.id}`)
  })

  it('returns 200 (not 201) when the cached record is reused', async () => {
    const { app } = setup()
    const first = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i' }) })
    const firstBody = (await first.json()) as { id: string }
    await settle()
    const second = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i' }) })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { id: string }).id).toBe(firstBody.id)
  })

  it('rejects an unknown kind with 400 before touching the store', async () => {
    const { app, store } = setup()
    const res = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'nope', item: 'i' }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error')
    expect(store.list({}).items).toEqual([])
  })

  it('requires an item', async () => {
    const { app } = setup()
    const res = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'parse' }) })
    expect(res.status).toBe(400)
  })

  it('404s an item that is neither stored nor netdisk-bound', async () => {
    const { app } = setup([converter()], false)
    const res = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'ghost' }) })
    expect(res.status).toBe(404)
  })

  it('503s a kind whose backend is not configured, leaving no record behind', async () => {
    const { app, store } = setup([converter({ available: () => false })])
    const res = await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i' }) })
    expect(res.status).toBe(503)
    expect(store.list({}).items).toEqual([])
  })

  it('lets a derived kind run for an item that no longer exists in the inbox', async () => {
    const summary = converter({
      kind: 'summary',
      label: '摘要',
      stages: ['summarize'],
      async run() { return { ok: true, result: { summary: 'x' } } },
    })
    const { app } = setup([summary], false) // handle unknown, but summary reads its input from upstream
    const res = await app.request('/api/conversions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'summary', item: 'gone', input: 'cv_upstream' }),
    })
    expect(res.status).toBe(201)
  })

  it('frames 也是派生类 kind：item 不在库里照样受理（它读的是上游那条 extract）', async () => {
    const frames = converter({
      kind: 'frames',
      label: '抽帧取画面文字',
      stages: ['source', 'sample', 'probe-ocr', 'plan', 'ocr'],
      async run() { return { ok: true, result: { track: [], probe: { stop: 'no_source' } } } },
    })
    const { app } = setup([frames], false)
    const res = await app.request('/api/conversions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'frames', item: 'gone', input: 'cv_upstream' }),
    })
    expect(res.status).toBe(201) // 漏进 DERIVED_KINDS 的表现就是这里 404
  })

  it('DERIVED_KINDS 只收 KINDS 里真有的 kind——名单是判据不是备注', () => {
    for (const k of DERIVED_KINDS) expect(KINDS).toContain(k)
    expect(DERIVED_KINDS).toContain('frames')
  })
})

describe('GET /api/conversions', () => {
  it('omits result by default and includes it under expand=result', async () => {
    const { app } = setup()
    await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i' }) })
    await settle()

    const lean = (await (await app.request('/api/conversions')).json()) as { items: Array<{ result?: unknown; timing?: unknown }> }
    expect(lean.items[0].result).toBeUndefined()
    expect(lean.items[0].timing).toBeTruthy() // 计时是信封，永远带着

    const full = (await (await app.request('/api/conversions?expand=result')).json()) as { items: Array<{ result: unknown }> }
    expect(full.items[0].result).toEqual({ markdown: '# ok' })
  })

  it('filters by item and kind and validates both', async () => {
    const { app } = setup()
    await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'a' }) })
    await settle()
    await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'b' }) })
    await settle()

    const one = (await (await app.request('/api/conversions?item=a')).json()) as { items: unknown[] }
    expect(one.items).toHaveLength(1)
    expect((await app.request('/api/conversions?kind=bogus')).status).toBe(400)
    expect((await app.request('/api/conversions?status=bogus')).status).toBe(400)
    expect((await app.request('/api/conversions?limit=0')).status).toBe(400)
  })

  it('paginates with a cursor', async () => {
    const { app } = setup()
    for (const item of ['a', 'b', 'c']) {
      await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item }) })
      await settle()
    }
    const page1 = (await (await app.request('/api/conversions?limit=2')).json()) as { items: Array<{ id: string }>; nextCursor: string }
    expect(page1.items).toHaveLength(2)
    const page2 = (await (await app.request(`/api/conversions?limit=2&cursor=${page1.nextCursor}`)).json()) as {
      items: unknown[]
      nextCursor?: string
    }
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeUndefined()
  })
})

describe('GET/DELETE /api/conversions/:id', () => {
  it('reads one back, then deletes it', async () => {
    const { app } = setup()
    const created = (await (
      await app.request('/api/conversions', { method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i' }) })
    ).json()) as { id: string }
    await settle()

    const got = await app.request(`/api/conversions/${created.id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as { result: unknown }).result).toEqual({ markdown: '# ok' })

    expect((await app.request(`/api/conversions/${created.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/api/conversions/${created.id}`)).status).toBe(404)
  })

  it('404s an unknown id on both read and delete', async () => {
    const { app } = setup()
    expect((await app.request('/api/conversions/cv_ghost')).status).toBe(404)
    expect((await app.request('/api/conversions/cv_ghost', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('GET /api/conversion-kinds', () => {
  it('reports each kind, its stages and whether its backend is configured', async () => {
    const { app } = setup([
      converter(),
      converter({ kind: 'identify', label: '补说话人', stages: ['media', 'diarize'], available: () => false }),
    ])
    const body = (await (await app.request('/api/conversion-kinds')).json()) as {
      items: Array<{ kind: string; available: boolean; stages: string[] }>
    }
    expect(body.items).toEqual([
      { kind: 'extract', label: 'OCR / 解析', stages: ['fetch', 'ocr'], available: true, options: {} },
      { kind: 'identify', label: '补说话人', stages: ['media', 'diarize'], available: false, options: {} },
    ])
  })
})

/**
 * 严格输入闸（docs/API.md §2）：写错一个键名过去是 200/201 + 一条看起来正常的记录，
 * 而你要的那件事根本没发生（`items` 拼错时连转换对象都不是你以为的那条）。
 * 钉三件事：400 + 指出该写哪个 + **一条记录都没建**。
 */
describe('POST /api/conversions：不认识的键 → 400，绝不静默丢弃', () => {
  it('传 items → 400 指向 item，且没建任何记录', async () => {
    const { app, runner } = setup()
    const res = await app.request('/api/conversions', {
      method: 'POST', body: JSON.stringify({ kind: 'extract', items: 'i' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_error')
    // 必须是**这道闸**说的话，不是碰巧撞上 kind/item 的形状校验。
    expect(body.error.message).toContain('不认识的字段')
    expect(body.error.message).toContain('items')
    expect(body.error.message).toContain('item')
    expect(runner.list({}).items).toHaveLength(0)
  })

  it('传 option（正确是 options）→ 400 指向 options，且没建任何记录', async () => {
    const { app, runner } = setup()
    const res = await app.request('/api/conversions', {
      method: 'POST', body: JSON.stringify({ kind: 'extract', item: 'i', option: { a: 1 } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('不认识的字段')
    expect(body.error.message).toContain('option')
    expect(body.error.message).toContain('options')
    expect(runner.list({}).items).toHaveLength(0)
  })

  it('合法键照常放行——闸不是把正常调用挡在门外', async () => {
    const { app } = setup()
    const res = await app.request('/api/conversions', {
      method: 'POST',
      body: JSON.stringify({ kind: 'extract', item: 'i', options: {}, force: true, media: [], snapshot: { title: 'T' } }),
    })
    expect(res.status).toBe(201)
  })
})
