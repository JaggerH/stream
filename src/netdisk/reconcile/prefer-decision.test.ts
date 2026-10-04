import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNetdiskDb } from '../db.ts'
import { DecisionStore } from './decisions.ts'

/**
 * 「留哪一份」——第二货架上比不出高下时，人裁的那条写路径。
 *
 * **为什么组合键要带两侧**：这条判断只对**这一对**成立。把它做成"这份文件是落选的"这种单边标记，
 * 一旦留下的那份将来被删/挪走，落选那条决定还在，下一轮就会把仅存的一份也判掉——一个保护性的
 * 决定退化成删除依据。带上两侧则天然失效：另一半不在了，这条决定就不再套用，退回问句。
 */

let dir: string
let db: ReturnType<typeof openNetdiskDb>
let d: DecisionStore

const A = '/shelf/第03期 - 甲.mp3'
const B = '/inbox/第03期-乙.mp3'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prefer-'))
  db = openNetdiskDb(join(dir, 'netdisk.db'))
  d = new DecisionStore(db, 'openlist')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('DecisionStore.setPreferred / preferredOf', () => {
  it('没裁过 → null（不是"随便挑一个"）', () => {
    expect(d.preferredOf(A, B)).toBeNull()
  })

  it('裁「留 A」→ 问这一对，两个方向都答 A', () => {
    d.setPreferred(A, B)
    expect(d.preferredOf(A, B)).toBe(A)
    expect(d.preferredOf(B, A)).toBe(A)
  })

  it('改主意裁「留 B」→ 旧的那条不许留着，否则两条决定打架', () => {
    d.setPreferred(A, B)
    d.setPreferred(B, A)
    expect(d.preferredOf(A, B)).toBe(B)
  })

  it('撤回 → 回到没裁过，下一轮重新问', () => {
    d.setPreferred(A, B)
    d.setPreferred(A, B, false)
    expect(d.preferredOf(A, B)).toBeNull()
  })

  it('只对这一对成立：换了对手就不套用', () => {
    d.setPreferred(A, B)
    expect(d.preferredOf(A, '/shelf/别的.mp3')).toBeNull()
  })

  it('不污染豁免那一格——verdictFor 只认 exempt/tombstone', () => {
    d.setPreferred(A, B)
    expect(d.verdictFor(A)).toBeNull()
    expect(d.verdictFor(B)).toBeNull()
  })

  /** `list()` 原先是 `else → tombstones`：任何新 kind 都会被静默吞进墓碑格。 */
  it('list() 单列一格，绝不掉进墓碑格', () => {
    d.setPreferred(A, B)
    d.tombstone('某集身份键')
    const l = d.list()
    expect(Object.keys(l.prefers)).toHaveLength(1)
    expect(Object.keys(l.tombstones)).toEqual(['某集身份键'])
  })
})
