// src/conversions/migrate-to-extract.ts
//
// 一次性改写：conversions 表里的 `stt` / `parse` 两个 kind → 统一的 `extract`。
//
// 与 migrate.ts 不是一回事：那个是「旧的两张表搬进这张表」，这个是「这张表内部把两个 kind 收成
// 一个」。设计见 docs/superpowers/specs/2026-07-31-extract-unified-content-design.md §8。
//
// 两处刻意的取舍：
//  - **不补造 ladder**。老记录跑的时候还没在记走法，补一个空走法等于声称「梯子上没人跑过」。
//  - **不动 id**。identify / summary 行的 inputId 指的是 conversion id，id 不变就不用跟着改。
import type Database from 'better-sqlite3'

export interface ExtractMigrationReport {
  stt: number
  ocr: number
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** 老 `stt` 产物 → extract 形状。lang/segments/media 是转写特产，进 detail 不进公共合同。 */
export function fromStt(result: Record<string, unknown>): Record<string, unknown> | null {
  const text = typeof result.text === 'string' ? result.text : ''
  if (!text) return null
  const detail: Record<string, unknown> = {}
  for (const k of ['lang', 'segments', 'media']) if (result[k] !== undefined) detail[k] = result[k]
  return { text, format: 'plain', branch: 'stt', ...(Object.keys(detail).length ? { detail } : {}) }
}

/** 老 `parse` 产物 → extract 形状。markdown 就是正文，只是要标明它是 markdown。 */
export function fromParse(result: Record<string, unknown>): Record<string, unknown> | null {
  const md = typeof result.markdown === 'string' ? result.markdown : ''
  return md ? { text: md, format: 'markdown', branch: 'ocr' } : null
}

/**
 * 把存量的 `stt` / `parse` 行改写成 `extract`。**幂等**：判据是「kind 还是不是老值」，
 * 第二次调用扫不到任何行，是空转。
 *
 * 没有 result 的行（queued / running / error）只改 kind，不造产物——它们本来就没有产物。
 */
export function migrateConversionsToExtract(db: Database.Database): ExtractMigrationReport {
  const rows = db
    .prepare("SELECT id, kind, result FROM conversions WHERE kind IN ('stt', 'parse')")
    .all() as Array<{ id: string; kind: string; result: unknown }>
  if (!rows.length) return { stt: 0, ocr: 0 }

  const update = db.prepare('UPDATE conversions SET kind = ?, result = ? WHERE id = ?')
  const report = { stt: 0, ocr: 0 }
  const run = db.transaction(() => {
    for (const row of rows) {
      const old = parseJson<Record<string, unknown>>(row.result)
      const mapped = old ? (row.kind === 'stt' ? fromStt(old) : fromParse(old)) : null
      update.run('extract', mapped ? JSON.stringify(mapped) : (row.result as string | null), row.id)
      if (row.kind === 'stt') report.stt++
      else report.ocr++
    }
  })
  run()
  return report
}
