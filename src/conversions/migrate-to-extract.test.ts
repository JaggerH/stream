import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversionStore } from './store.ts'
import { migrateConversionsToExtract } from './migrate-to-extract.ts'

/** 真盘：迁移改的是**一个已经存在的库**，`:memory:` 每次都是新建的，压根走不到那条路。 */
function onDisk<T>(fn: (store: ConversionStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'conv-extract-'))
  const store = new ConversionStore(join(dir, 'c.db'))
  try {
    return fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const SEGS = [{ start: 0, end: 2, text: 'a', speaker: 'SPEAKER_00' }]

/** 直接写库造一条**老 kind** 的行。`store.create` 已经造不出来了——`stt`/`parse` 正是这次
 *  退场掉的两个 kind，类型上不存在。这不是绕过类型，是如实表达：这些行只可能来自旧版本。 */
function seedLegacy(store: ConversionStore, kind: 'stt' | 'parse', itemId: string, patch: { status?: string; result?: unknown; error?: unknown } = {}) {
  const id = `cv_legacy_${kind}_${itemId}`
  const now = '2026-01-01T00:00:00.000Z'
  store.database
    .prepare('INSERT INTO conversions (id, kind, item_id, status, result, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, kind, itemId, patch.status ?? 'done', patch.result ? JSON.stringify(patch.result) : null, patch.error ? JSON.stringify(patch.error) : null, now, now)
  return id
}

describe('migrateConversionsToExtract', () => {
  it('stt 行 → extract：正文进 text，时间轴等特产收进 detail', () => {
    onDisk((store) => {
      const id = seedLegacy(store, 'stt', 'i', { result: { text: '说了这些', lang: 'zh', segments: SEGS, media: [{ url: 'm' }] } })

      expect(migrateConversionsToExtract(store.database)).toEqual({ stt: 1, ocr: 0 })

      const got = store.get(id)!
      expect(got.kind).toBe('extract')
      expect(got.result).toEqual({
        text: '说了这些', format: 'plain', branch: 'stt',
        detail: { lang: 'zh', segments: SEGS, media: [{ url: 'm' }] },
      })
    })
  })

  it('parse 行 → extract：markdown 就是正文，只是要标明它是 markdown', () => {
    onDisk((store) => {
      const id = seedLegacy(store, 'parse', 'i', { result: { markdown: '# 标题' } })

      expect(migrateConversionsToExtract(store.database)).toEqual({ stt: 0, ocr: 1 })
      expect(store.get(id)!.result).toEqual({ text: '# 标题', format: 'markdown', branch: 'ocr' })
    })
  })

  // 没跑完/失败的行本来就没有产物。只改 kind，不凭空造一份「空正文」出来——
  // 那会让一条失败的转换在下游看起来像成功了。
  it('没有产物的行只改 kind，不编造产物', () => {
    onDisk((store) => {
      const queued = seedLegacy(store, 'stt', 'a', { status: 'queued' })
      const failed = seedLegacy(store, 'parse', 'b', { status: 'error', error: { code: 'x', message: 'y' } })

      migrateConversionsToExtract(store.database)

      expect(store.get(queued)!.kind).toBe('extract')
      expect(store.get(queued)!.result).toBeUndefined()
      expect(store.get(failed)!.kind).toBe('extract')
      expect(store.get(failed)!.result).toBeUndefined()
      expect(store.get(failed)!.error).toEqual({ code: 'x', message: 'y' })
    })
  })

  it('幂等：第二次是空转，且不会把已迁移的行再拍一层', () => {
    onDisk((store) => {
      const id = seedLegacy(store, 'stt', 'i', { result: { text: 'x', segments: SEGS } })

      migrateConversionsToExtract(store.database)
      const after1 = store.get(id)!.result
      expect(migrateConversionsToExtract(store.database)).toEqual({ stt: 0, ocr: 0 })
      expect(store.get(id)!.result).toEqual(after1)
    })
  })

  // 老记录跑的时候还没在记走法。补一个空走法等于声称「梯子上没人跑过」——和 timing 同一条规矩。
  it('不给老记录补造 ladder', () => {
    onDisk((store) => {
      const id = seedLegacy(store, 'parse', 'i', { result: { markdown: 'x' } })
      migrateConversionsToExtract(store.database)
      expect(store.get(id)!.ladder).toBeUndefined()
    })
  })

  // identify / summary 行的 inputId 指的是 conversion id。id 不变，那些指针就不用跟着改——
  // 迁移一旦动了 id，全库的派生关系会当场断掉，而且是静默的。
  it('不动 id，派生行的 inputId 仍然指得中', () => {
    onDisk((store) => {
      const stt = seedLegacy(store, 'stt', 'i', { result: { text: 'x', segments: SEGS } })
      const sum = store.create({ kind: 'summary', itemId: 'i', inputId: stt })

      migrateConversionsToExtract(store.database)

      expect(store.get(sum.id)!.inputId).toBe(stt)
      expect(store.get(stt)).not.toBeNull()
      expect(store.get(sum.id)!.kind).toBe('summary') // 派生 kind 不受影响
    })
  })

  it('空库不炸', () => {
    onDisk((store) => expect(migrateConversionsToExtract(store.database)).toEqual({ stt: 0, ocr: 0 }))
  })
})
