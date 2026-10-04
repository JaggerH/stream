import { describe, expect, it } from 'vitest'
import { ConversionStore } from './store.ts'
import { migrateLegacyConversions } from './migrate.ts'

function withLegacy(seed: (db: import('better-sqlite3').Database) => void) {
  const store = new ConversionStore(':memory:')
  const db = store.database
  db.exec(`
    CREATE TABLE transcripts (
      item_id TEXT PRIMARY KEY, status TEXT NOT NULL, text TEXT, lang TEXT, error TEXT,
      title TEXT, source TEXT, poster TEXT, url TEXT, segments TEXT, media TEXT, summary TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE parses (
      item_id TEXT PRIMARY KEY, status TEXT NOT NULL, markdown TEXT, error TEXT,
      title TEXT, source TEXT, url TEXT, updated_at TEXT NOT NULL
    );
  `)
  seed(db)
  return { store, db, run: () => migrateLegacyConversions(db, store) }
}

describe('migrateLegacyConversions', () => {
  it('moves a done transcript, preserving text/lang/segments/media and the snapshot', () => {
    const { store, db, run } = withLegacy((d) => {
      d.prepare(
        `INSERT INTO transcripts (item_id, status, text, lang, segments, media, title, source, url, poster, updated_at)
         VALUES ('i1', 'done', 'hello', 'zh', '[{"start":0,"end":1,"text":"hi"}]', '[{"url":"u"}]', 'T', 'bilibili', 'https://x', 'p.jpg', '2026-07-01T00:00:00Z')`
      ).run()
    })
    const report = run()
    expect(report).toMatchObject({ transcripts: 1, parses: 0, summaries: 0, migrated: true })

    const rec = store.latestFor('i1', 'extract')!
    expect(rec.status).toBe('done')
    // 旧表直接搬成当前形状（extract + 转写分支）：正文进 text，特产收进 detail
    expect(rec.result).toEqual({
      text: 'hello',
      format: 'plain',
      branch: 'stt',
      detail: { lang: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }], media: [{ url: 'u' }] },
    })
    expect(rec.snapshot).toEqual({ title: 'T', source: 'bilibili', poster: 'p.jpg', url: 'https://x' })
    // 历史记录没有分阶段耗时——留空，不是编造一串 0
    expect(rec.timing).toBeUndefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='transcripts'").get()).toBeUndefined()
  })

  it('splits a stored summary into its own conversion pointing at the transcript', () => {
    const { store, run } = withLegacy((d) => {
      d.prepare(
        `INSERT INTO transcripts (item_id, status, text, summary, updated_at)
         VALUES ('i1', 'done', 'body', '## 摘要', '2026-07-01T00:00:00Z')`
      ).run()
    })
    expect(run().summaries).toBe(1)
    const stt = store.latestFor('i1', 'extract')!
    const summary = store.latestFor('i1', 'summary')!
    expect(summary.status).toBe('done')
    expect(summary.result).toEqual({ summary: '## 摘要' })
    expect(summary.inputId).toBe(stt.id)
  })

  it('lands rows a crash left mid-flight as retryable errors, not as permanent limbo', () => {
    const { store, run } = withLegacy((d) => {
      d.prepare(`INSERT INTO transcripts (item_id, status, updated_at) VALUES ('i1', 'running', '2026-07-01T00:00:00Z')`).run()
      d.prepare(`INSERT INTO parses (item_id, status, updated_at) VALUES ('i2', 'queued', '2026-07-01T00:00:00Z')`).run()
    })
    run()
    expect(store.latestFor('i1', 'extract')!.error!.code).toBe('interrupted')
    expect(store.latestFor('i2', 'extract')!.error!.code).toBe('interrupted')
  })

  it('keeps a failed record failed, with its original message', () => {
    const { store, run } = withLegacy((d) => {
      d.prepare(
        `INSERT INTO parses (item_id, status, error, updated_at) VALUES ('i', 'error', 'MinerU 503', '2026-07-01T00:00:00Z')`
      ).run()
    })
    run()
    const rec = store.latestFor('i', 'extract')!
    expect(rec.status).toBe('error')
    expect(rec.error).toEqual({ code: 'legacy_error', message: 'MinerU 503' })
  })

  it('moves parses with their markdown', () => {
    const { store, run } = withLegacy((d) => {
      d.prepare(
        `INSERT INTO parses (item_id, status, markdown, title, updated_at) VALUES ('i', 'done', '# doc', 'Doc', '2026-07-01T00:00:00Z')`
      ).run()
    })
    expect(run().parses).toBe(1)
    const rec = store.latestFor('i', 'extract')!
    expect(rec.result).toEqual({ text: '# doc', format: 'markdown', branch: 'ocr' })
    expect(rec.snapshot?.title).toBe('Doc')
  })

  it('is a no-op the second time (old tables are gone) and on a fresh install', () => {
    const { store, db, run } = withLegacy((d) => {
      d.prepare(`INSERT INTO parses (item_id, status, markdown, updated_at) VALUES ('i', 'done', '#', '2026-07-01T00:00:00Z')`).run()
    })
    run()
    const second = migrateLegacyConversions(db, store)
    expect(second).toEqual({ transcripts: 0, parses: 0, summaries: 0, migrated: false })
    expect(store.list({}).items).toHaveLength(1) // 没有搬第二遍

    const fresh = new ConversionStore(':memory:')
    expect(migrateLegacyConversions(fresh.database, fresh).migrated).toBe(false)
  })

  it('tolerates an old DB whose transcripts table predates the summary column', () => {
    const store = new ConversionStore(':memory:')
    const db = store.database
    db.exec(`CREATE TABLE transcripts (item_id TEXT PRIMARY KEY, status TEXT NOT NULL, text TEXT, updated_at TEXT NOT NULL)`)
    db.prepare(`INSERT INTO transcripts (item_id, status, text, updated_at) VALUES ('i', 'done', 'x', '2026-07-01T00:00:00Z')`).run()
    const report = migrateLegacyConversions(db, store)
    expect(report.transcripts).toBe(1)
    expect(report.summaries).toBe(0)
  })
})
