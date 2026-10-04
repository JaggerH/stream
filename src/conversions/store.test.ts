import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversionStore } from './store.ts'

function mem() {
  return new ConversionStore(':memory:')
}

describe('ConversionStore', () => {
  it('creates a queued record with a sortable id and createdAt', () => {
    const s = mem()
    const rec = s.create({ kind: 'extract', itemId: 'item-1', snapshot: { title: 'T' } })
    expect(rec.id).toMatch(/^cv_[0-9a-z]+$/)
    expect(rec.status).toBe('queued')
    expect(rec.kind).toBe('extract')
    expect(rec.itemId).toBe('item-1')
    expect(rec.snapshot?.title).toBe('T')
    expect(rec.createdAt).toBe(rec.updatedAt)
    expect(rec.startedAt).toBeUndefined()
    expect(rec.timing).toBeUndefined()
  })

  it('ids sort in creation order even within the same millisecond', () => {
    const s = mem()
    const ids = Array.from({ length: 50 }, () => s.create({ kind: 'identify', itemId: 'x' }).id)
    expect([...ids].sort()).toEqual(ids)
  })

  it('round-trips a done record with timing and a kind-discriminated result', () => {
    const s = mem()
    const rec = s.create({ kind: 'extract', itemId: 'item-1' })
    s.update(rec.id, {
      status: 'done',
      result: { text: 'hello', lang: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }] },
      timing: { totalMs: 300, stages: [{ name: 'media', ms: 100 }, { name: 'asr', ms: 200 }] },
      finishedAt: new Date().toISOString(),
    })
    const got = s.get(rec.id)!
    expect(got.status).toBe('done')
    expect((got.result as { text: string }).text).toBe('hello')
    expect(got.timing?.stages.map((x) => x.name)).toEqual(['media', 'asr'])
    expect(got.timing?.totalMs).toBe(300)
    expect(got.finishedAt).toBeTruthy()
  })

  it('stores a structured error body, not a bare string', () => {
    const s = mem()
    const rec = s.create({ kind: 'identify', itemId: 'i' })
    s.update(rec.id, { status: 'error', error: { code: 'no_source', message: 'no parseable source' } })
    expect(s.get(rec.id)!.error).toEqual({ code: 'no_source', message: 'no parseable source' })
  })

  it('update preserves fields the patch does not mention', () => {
    const s = mem()
    const rec = s.create({ kind: 'extract', itemId: 'i', snapshot: { title: 'Keep me', url: 'u' } })
    s.update(rec.id, { status: 'running', startedAt: new Date().toISOString() })
    s.update(rec.id, { status: 'done', result: { text: 'x' } })
    const got = s.get(rec.id)!
    expect(got.snapshot?.title).toBe('Keep me')
    expect(got.snapshot?.url).toBe('u')
    expect(got.startedAt).toBeTruthy()
  })

  it('update on an unknown id returns null and writes nothing', () => {
    const s = mem()
    expect(s.update('cv_nope', { status: 'done' })).toBeNull()
  })

  it('latestFor finds the newest record for an (item, kind) pair', () => {
    const s = mem()
    s.create({ kind: 'extract', itemId: 'i' })
    const second = s.create({ kind: 'extract', itemId: 'i' })
    s.create({ kind: 'identify', itemId: 'i' })
    expect(s.latestFor('i', 'extract')!.id).toBe(second.id)
    expect(s.latestFor('i', 'summary')).toBeNull()
  })

  it('lists newest-first, filters by item/kind/status', () => {
    const s = mem()
    const a = s.create({ kind: 'extract', itemId: 'i1' })
    const b = s.create({ kind: 'identify', itemId: 'i1' })
    const c = s.create({ kind: 'extract', itemId: 'i2' })
    s.update(c.id, { status: 'done' })

    expect(s.list({}).items.map((r) => r.id)).toEqual([c.id, b.id, a.id])
    expect(s.list({ item: 'i1' }).items.map((r) => r.id)).toEqual([b.id, a.id])
    expect(s.list({ kind: 'extract' }).items.map((r) => r.id)).toEqual([c.id, a.id])
    expect(s.list({ status: 'done' }).items.map((r) => r.id)).toEqual([c.id])
  })

  it('paginates with a stable cursor that survives later updates', () => {
    const s = mem()
    const ids = Array.from({ length: 5 }, () => s.create({ kind: 'identify', itemId: 'i' }).id).reverse()
    const page1 = s.list({ limit: 2 })
    expect(page1.items.map((r) => r.id)).toEqual(ids.slice(0, 2))
    expect(page1.nextCursor).toBe(ids[1])

    // touching an older row must NOT move it into a page the caller already read
    s.update(ids[4], { status: 'running' })
    const page2 = s.list({ limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((r) => r.id)).toEqual(ids.slice(2, 4))
    const page3 = s.list({ limit: 2, cursor: page2.nextCursor })
    expect(page3.items.map((r) => r.id)).toEqual([ids[4]])
    expect(page3.nextCursor).toBeUndefined()
  })

  it('list omits result unless asked to expand it', () => {
    const s = mem()
    const rec = s.create({ kind: 'identify', itemId: 'i' })
    s.update(rec.id, { status: 'done', result: { markdown: '# big' } })
    expect(s.list({}).items[0].result).toBeUndefined()
    expect(s.list({ expandResult: true }).items[0].result).toEqual({ markdown: '# big' })
  })

  // ladder 是**信封字段**：和 timing 一样，列表里也要有。它正是「这条结果信不信得过」的依据，
  // 藏进详情等于逼前端为每一行再打一次请求。
  it('梯子走法进列表，不像 result 那样被摘掉', () => {
    const s = mem()
    const rec = s.create({ kind: 'identify', itemId: 'i' })
    const ladder = { via: 'zhipu', rungs: [{ member: 'zhipu', source: 'ocr-vlm', ms: 12, outcome: 'win' as const }] }
    s.update(rec.id, { status: 'done', result: { markdown: '# big' }, ladder })
    expect(s.list({}).items[0].ladder).toEqual(ladder)   // 没 expandResult 也在
    expect(s.get(rec.id)!.ladder).toEqual(ladder)
  })

  // 老库是 CREATE TABLE IF NOT EXISTS 建的，不会自己长出新列——不补列就是插入时报
  // "no such column"，而**只测 :memory: 永远发现不了**（内存库每次都是新建的）。
  it('存量库自动补 ladder 列（老行读出来是 undefined，不是伪造的空走法）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-store-'))
    const dbPath = join(dir, 'c.db')
    try {
      // 先造一张"老表"：没有 ladder 列，且带一行老数据
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE conversions (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL,
          input_id TEXT, result TEXT, error TEXT, snapshot TEXT, timing TEXT,
          created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
        );
        INSERT INTO conversions (id, kind, item_id, status, created_at, updated_at)
        VALUES ('cv_old', 'parse', 'i', 'done', '2026-01-01', '2026-01-01');
      `)
      legacy.close()

      const s = new ConversionStore(dbPath)
      expect(s.get('cv_old')!.ladder).toBeUndefined() // 那次转换确实没记，不补空对象
      const fresh = s.create({ kind: 'identify', itemId: 'i2' })
      const ladder = { via: 'm', rungs: [{ member: 'm', source: 's', ms: 1, outcome: 'win' as const }] }
      s.update(fresh.id, { status: 'done', ladder })
      expect(s.get(fresh.id)!.ladder).toEqual(ladder)
      s.close?.()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deletes a record', () => {
    const s = mem()
    const rec = s.create({ kind: 'identify', itemId: 'i' })
    s.delete(rec.id)
    expect(s.get(rec.id)).toBeNull()
    expect(s.list({}).items).toEqual([])
  })
})
