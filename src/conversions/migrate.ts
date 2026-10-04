// src/conversions/migrate.ts
//
// 一次性搬运：旧的 transcripts / parses 两张表 → 统一的 conversions 表。
// 搬完即把旧表 drop——数据已经搬走，留着就是第二份真相，下一个人不知道该信哪张。
//
// 两处刻意的取舍：
//  - 旧表没有 created_at，只有 updated_at：回填成同一个值，不编造。
//  - 旧记录没有分阶段耗时：timing 留空（null），不是写一串 0——「历史没这个信息」和
//    「这次跑了 0ms」必须能分开。
import type Database from 'better-sqlite3'
import type { ConversionStore } from './store.ts'
import { fromStt, fromParse } from './migrate-to-extract.ts'

export interface MigrationReport {
  transcripts: number
  parses: number
  summaries: number
  /** true = 本次真的搬了（旧表存在过）；false = 没有旧表，全新安装。 */
  migrated: boolean
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name)
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * 把旧的转写/解析记录搬进 conversions。幂等：只要旧表还在就搬，搬完 drop，所以第二次调用
 * 是空转。`store` 只用来复用它的 id 生成与写入语义（迁移直接走它的 create/update）。
 */
export function migrateLegacyConversions(db: Database.Database, store: ConversionStore): MigrationReport {
  const report: MigrationReport = { transcripts: 0, parses: 0, summaries: 0, migrated: false }

  if (tableExists(db, 'transcripts')) {
    report.migrated = true
    const cols = columnsOf(db, 'transcripts')
    const rows = db.prepare('SELECT * FROM transcripts ORDER BY updated_at ASC').all() as Record<string, unknown>[]
    for (const row of rows) {
      const itemId = row.item_id as string
      const status = row.status as string
      const rec = store.create({
        // 旧表搬进来时**直接落成当前形状**（extract + 转写分支），不留中间态：多一层
        // `kind:'stt'` 只会多一次改写，还得指望后面那步一定跑。映射复用同一份，别抄第二遍。
        kind: 'extract',
        itemId,
        snapshot: {
          title: (row.title as string) ?? undefined,
          source: (row.source as string) ?? undefined,
          poster: (row.poster as string) ?? undefined,
          url: (row.url as string) ?? undefined,
        },
      })
      store.update(rec.id, {
        status: status === 'done' || status === 'error' ? (status as 'done' | 'error') : 'error',
        // 上个进程留下的 queued/running 永远跑不完了，落成可重试的 error（与 runner 的孤儿清理同调）
        error:
          status === 'done'
            ? undefined
            : { code: status === 'error' ? 'legacy_error' : 'interrupted', message: (row.error as string) ?? '转换中断（服务重启）' },
        result:
          status === 'done'
            ? fromStt({
                text: (row.text as string) ?? undefined,
                lang: (row.lang as string) ?? undefined,
                segments: parseJson(row.segments),
                media: parseJson(row.media),
              }) ?? undefined
            : undefined,
      })
      // 旧表把摘要挂在转写行的一列上；它现在是自己的 kind，输入指向刚搬过来的那条转写。
      const summary = cols.has('summary') ? ((row.summary as string) ?? undefined) : undefined
      if (summary) {
        const s = store.create({ kind: 'summary', itemId, inputId: rec.id })
        store.update(s.id, { status: 'done', result: { summary } })
        report.summaries += 1
      }
      report.transcripts += 1
    }
    db.exec('DROP TABLE transcripts')
  }

  if (tableExists(db, 'parses')) {
    report.migrated = true
    const rows = db.prepare('SELECT * FROM parses ORDER BY updated_at ASC').all() as Record<string, unknown>[]
    for (const row of rows) {
      const status = row.status as string
      const rec = store.create({
        kind: 'extract',
        itemId: row.item_id as string,
        snapshot: {
          title: (row.title as string) ?? undefined,
          source: (row.source as string) ?? undefined,
          url: (row.url as string) ?? undefined,
        },
      })
      store.update(rec.id, {
        status: status === 'done' || status === 'error' ? (status as 'done' | 'error') : 'error',
        error:
          status === 'done'
            ? undefined
            : { code: status === 'error' ? 'legacy_error' : 'interrupted', message: (row.error as string) ?? '转换中断（服务重启）' },
        result: status === 'done' ? fromParse({ markdown: (row.markdown as string) ?? '' }) ?? undefined : undefined,
      })
      report.parses += 1
    }
    db.exec('DROP TABLE parses')
  }

  return report
}
