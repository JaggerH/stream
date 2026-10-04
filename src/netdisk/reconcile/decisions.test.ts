import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DecisionStore, ProvenanceLog, fileKeyOf } from './decisions.ts'
import { openNetdiskDb, migrateLegacyNetdiskData } from '../db.ts'

describe('DecisionStore', () => {
  it('豁免/墓碑写入并可查,revoke 撤销,新实例同库还在(落库)', () => {
    const db = openNetdiskDb(':memory:')
    const s = new DecisionStore(db, 'openlist')
    s.exempt('k1', '不属于本电台')
    s.tombstone('k2')
    expect(s.verdictFor('k1')).toBe('exempt')
    expect(s.verdictFor('k2')).toBe('tombstone')
    expect(s.verdictFor('k3')).toBeNull()
    const s2 = new DecisionStore(db, 'openlist')
    expect(s2.verdictFor('k1')).toBe('exempt')
    expect(s2.list().exemptions.k1.note).toBe('不属于本电台')
    s2.revoke('k1')
    expect(s2.verdictFor('k1')).toBeNull()
  })

  // 「不是这一集」是**一个文件 + 一集**的组合，不是一条身份键：换任一侧都得重新问。
  it('notEpisode 按 集+文件 的组合生效,换任一侧都不命中', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setNotEpisode('L756', '/lib/付费/玄关笔记/37.申与酉.mp3')
    expect(s.isNotEpisode('L756', '/lib/付费/玄关笔记/37.申与酉.mp3')).toBe(true)
    expect(s.isNotEpisode('L037', '/lib/付费/玄关笔记/37.申与酉.mp3')).toBe(false) // 同文件、别的集
    expect(s.isNotEpisode('L756', '/lib/付费/756.mp3')).toBe(false)                // 同集、别的文件
    s.setNotEpisode('L756', '/lib/付费/玄关笔记/37.申与酉.mp3', false)
    expect(s.isNotEpisode('L756', '/lib/付费/玄关笔记/37.申与酉.mp3')).toBe(false)  // 撤回 → 下一轮重新问
  })

  // 问句的另一半答案。它落下去之后是匹配层的 pin，所以两条互斥性必须由 store 保证，
  // 不能指望调用方记得：与同一对的「不是」互斥；一集只能钉一份。
  it('isEpisode：与同一对的 notEpisode 互斥,一集只钉一份,撤回只撤这一对', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setNotEpisode('L005', '/lib/付费/A.mp3')
    s.setIsEpisode('L005', '/lib/付费/A.mp3')
    expect(s.pinnedFor('L005')).toBe('/lib/付费/A.mp3')
    expect(s.isNotEpisode('L005', '/lib/付费/A.mp3')).toBe(false) // 答了"是"就把那条"否"撤掉

    // 同一集换一份 → 旧的那条必须消失，否则 pin 有两条、谁生效取决于遍历顺序
    s.setIsEpisode('L005', '/lib/付费/B.mp3')
    expect(s.pinnedFor('L005')).toBe('/lib/付费/B.mp3')
    expect(Object.keys(s.list().isEpisodes)).toHaveLength(1)

    // 别的集互不影响
    s.setIsEpisode('L020', '/lib/付费/C.mp3')
    expect(s.pinnedFor('L005')).toBe('/lib/付费/B.mp3')
    expect(s.pinnedFor('L020')).toBe('/lib/付费/C.mp3')

    // 撤回只撤这一对：不许顺手清掉这一集别的决定，也不许碰别的集
    s.setIsEpisode('L005', '/lib/付费/B.mp3', false)
    expect(s.pinnedFor('L005')).toBeNull()
    expect(s.pinnedFor('L020')).toBe('/lib/付费/C.mp3')
  })

  it('isEpisode 不冒充豁免/墓碑：verdictFor 只认两种,list 单列一格', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setIsEpisode('L005', '/lib/x.mp3')
    const listed = s.list()
    expect(Object.keys(listed.tombstones)).toHaveLength(0)
    expect(Object.keys(listed.exemptions)).toHaveLength(0)
    expect(Object.keys(listed.isEpisodes)).toHaveLength(1)
    for (const key of Object.keys(listed.isEpisodes)) expect(s.verdictFor(key)).toBeNull()
  })

  // 它绝不能被读成豁免：`verdictFor` 只认 exempt/tombstone，list() 也单列一格
  // （落进 tombstones 会让那条组合键在 UI 里冒充一条"这一集别再提了"）。
  it('notEpisode 不冒充豁免/墓碑：verdictFor 只认两种,list 单列一格', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setNotEpisode('L756', '/lib/x.mp3')
    const listed = s.list()
    expect(Object.keys(listed.tombstones)).toHaveLength(0)
    expect(Object.keys(listed.exemptions)).toHaveLength(0)
    expect(Object.keys(listed.notEpisodes)).toHaveLength(1)
    for (const key of Object.keys(listed.notEpisodes)) expect(s.verdictFor(key)).toBeNull()
  })

  // 存量库那条 CHECK 是建表时写死的，`CREATE TABLE IF NOT EXISTS` 改不动——不重建的话，
  // 活体那些库上点一次「不是这一集」就是一条 SqliteError，而新库上永远复现不出来。
  it('存量库（旧 CHECK 只认两种）重开后能写 not-episode,老决定不丢', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'netdisk-db-')), 'netdisk.db')
    const old = new Database(path)
    old.exec(`CREATE TABLE decisions (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('exempt','tombstone')),
      note TEXT,
      at INTEGER NOT NULL
    );`)
    old.prepare('INSERT INTO decisions (key, kind, note, at) VALUES (?, ?, ?, ?)').run('k1', 'exempt', '老决定', 1)
    old.close()

    const s = new DecisionStore(openNetdiskDb(path), 'openlist')
    expect(s.verdictFor('k1')).toBe('exempt')          // 搬数据别搬丢了
    expect(s.list().exemptions.k1.note).toBe('老决定')
    s.setNotEpisode('L756', '/lib/x.mp3')              // 不再被 CHECK 拒
    expect(s.isNotEpisode('L756', '/lib/x.mp3')).toBe(true)
  })
})

// 组合键里的"文件"格必须带货架 id：两个货架上同一个相对路径不是同一份文件。
// 对外 API 仍收/还裸路径——拼前缀是 store 内部的事，调用方一行不改。
describe('决定键带货架 id', () => {
  it('组合键的路径格是 <shelfId>:<path>；API 收裸路径', () => {
    const d = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    d.setNotEpisode('item:1', '/lib/a.mp3')
    const keys = Object.keys(d.list().notEpisodes)
    expect(keys).toEqual([`not-episode:${JSON.stringify(['item:1', 'openlist:/lib/a.mp3'])}`])
    expect(d.isNotEpisode('item:1', '/lib/a.mp3')).toBe(true)
  })
  it('两个货架同一相对路径互不干扰', () => {
    const db = openNetdiskDb(':memory:')
    const a = new DecisionStore(db, 'openlist'); const b = new DecisionStore(db, 'local')
    a.setNotEpisode('item:1', '/x.mp3')
    expect(b.isNotEpisode('item:1', '/x.mp3')).toBe(false)
  })
  it('存量行（没有前缀）在构造时迁成带前缀，决定不丢', () => {
    const db = openNetdiskDb(':memory:')
    db.prepare('INSERT INTO decisions (key, kind, note, at) VALUES (?, ?, NULL, 1)')
      .run(`is-episode:${JSON.stringify(['item:9', '/lib/old.mp3'])}`, 'is-episode')
    const d = new DecisionStore(db, 'openlist')
    expect(d.pinnedFor('item:9')).toBe('/lib/old.mp3') // 对外仍是裸路径
    expect(Object.keys(d.list().isEpisodes)[0]).toContain('openlist:/lib/old.mp3')
  })
  // 迁移在**每次**构造时跑（后端每重启一次就一遍）——不幂等的话前缀会越叠越多（`openlist:openlist:/…`），
  // 而且不报错、只是钉子一批批失效。
  it('迁移幂等：同一个库重复构造，键不会被二次加前缀', () => {
    const db = openNetdiskDb(':memory:')
    db.prepare('INSERT INTO decisions (key, kind, note, at) VALUES (?, ?, NULL, 1)')
      .run(`prefer:${JSON.stringify(['/lib/k.mp3', '/src/l.mp3'])}`, 'prefer')
    const first = Object.keys(new DecisionStore(db, 'openlist').list().prefers)
    const second = Object.keys(new DecisionStore(db, 'openlist').list().prefers)
    expect(second).toEqual(first)
    expect(second).toEqual([`prefer:${JSON.stringify(['openlist:/lib/k.mp3', 'openlist:/src/l.mp3'])}`])
  })
  it('migratePath 只迁本货架的键', () => {
    const db = openNetdiskDb(':memory:')
    const a = new DecisionStore(db, 'openlist'); const b = new DecisionStore(db, 'local')
    a.setPreferred('/k.mp3', '/l.mp3'); b.setPreferred('/k.mp3', '/l.mp3')
    a.migratePath('/l.mp3', '/moved/l.mp3')
    expect(a.preferredOf('/k.mp3', '/moved/l.mp3')).toBe('/k.mp3')
    expect(b.preferredOf('/k.mp3', '/l.mp3')).toBe('/k.mp3') // local 那份没动
  })
  it('fileKeyOf 的拼法钉死（改了就是整批掉钉）', () => {
    expect(fileKeyOf('openlist', '/a/b.mp3')).toBe('openlist:/a/b.mp3')
  })
})

// 裁决器的批量撤回：一轮落的决定共用 `llm:<runId>` 前缀，人工决定（note 恒 null）永不命中。
describe('revokeByNotePrefix（裁决器批量撤回）', () => {
  it('is-episode/not-episode 带 note 的整批撤回，人裁的（note 为 null）不受影响', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setIsEpisode('L1', '/lib/a.mp3', true, 'llm:run_1')
    s.setNotEpisode('L2', '/lib/b.mp3', true, 'llm:run_1')
    s.setIsEpisode('L3', '/lib/c.mp3') // 人裁，无 note
    expect(s.revokeByNotePrefix('llm:run_1')).toBe(2)
    expect(s.pinnedFor('L1')).toBeNull()
    expect(s.isNotEpisode('L2', '/lib/b.mp3')).toBe(false)
    expect(s.pinnedFor('L3')).toBe('/lib/c.mp3') // 人裁的没被殃及
  })

  it('只撤同一个 runId 的那批，别的 runId 不动', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    s.setIsEpisode('L1', '/lib/a.mp3', true, 'llm:run_1')
    s.setIsEpisode('L2', '/lib/b.mp3', true, 'llm:run_2')
    expect(s.revokeByNotePrefix('llm:run_1')).toBe(1)
    expect(s.pinnedFor('L1')).toBeNull()
    expect(s.pinnedFor('L2')).toBe('/lib/b.mp3')
  })

  it('没有命中任何行时返回 0', () => {
    const s = new DecisionStore(openNetdiskDb(':memory:'), 'openlist')
    expect(s.revokeByNotePrefix('llm:nope')).toBe(0)
  })
})

describe('ProvenanceLog', () => {
  it('append + get + markUndone,新实例同库可读', () => {
    const db = openNetdiskDb(':memory:')
    const log = new ProvenanceLog(db)
    const id = log.record({ action: 'move', src: '/a/x.mp3', dst: '/b/x.mp3', size: 111, basis: 'num-match:092' })
    expect(log.get(id)?.dst).toBe('/b/x.mp3')
    log.markUndone(id)
    const log2 = new ProvenanceLog(db)
    expect(log2.get(id)?.undone).toBe(true)
    expect(log2.list()[0].id).toBe(id)
  })

  it('迁移旧 provenance.jsonl：碎尾行只丢那一行，完整行全进 run_actions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-'))
    const reconcileDir = join(dir, 'reconcile')
    mkdirSync(reconcileDir)
    // 两行完整 + 一行碎裂
    const line1 = '{"id":"x1","at":1000,"action":"move","src":"/a/x.mp3","dst":"/b/x.mp3","size":111,"basis":"num-match:092"}'
    const line2 = '{"id":"x2","at":2000,"action":"delete","src":"/c/y.mp3","size":222,"basis":"size-dup-of:/lib/x.mp3"}'
    const line3_torn = '{"id":"x3","at":3000,"ac'  // 碎裂，未闭合
    writeFileSync(join(reconcileDir, 'provenance.jsonl'), `${line1}\n${line2}\n${line3_torn}`)

    const db = openNetdiskDb(':memory:')
    migrateLegacyNetdiskData(db, { mappingsDir: join(dir, 'mappings'), reconcileDir }, () => {})
    const log = new ProvenanceLog(db)
    const entries = log.list()
    expect(entries).toHaveLength(2)
    expect(entries[0].id).toBe('x1')
    expect(entries[1].id).toBe('x2')
    expect(entries[1].dst).toBeUndefined()
  })
})

describe('ProvenanceLog run_id', () => {
  it('record 带 runId，listByRun 按写入顺序回；rename/rmdir 两种 action 落得下', () => {
    const log = new ProvenanceLog(openNetdiskDb(':memory:'))
    const a = log.record({ action: 'rename', src: '/x/a.mkv', dst: '/x/S01E01 - a.mkv', size: 1, basis: 'prefix', runId: 'run_1' })
    const b = log.record({ action: 'rmdir', src: '/x/empty', size: 0, basis: 'emptied', runId: 'run_1' })
    log.record({ action: 'move', src: '/y', dst: '/z', size: 1, basis: 'other', runId: 'run_2' })
    expect(log.listByRun('run_1').map((e) => e.id)).toEqual([a, b])
    expect(log.get(a)).toMatchObject({ action: 'rename', runId: 'run_1', dst: '/x/S01E01 - a.mkv' })
    expect(log.listByRun('nope')).toEqual([])
  })
  it('没有 runId 的行照旧能写（老调用方）', () => {
    const log = new ProvenanceLog(openNetdiskDb(':memory:'))
    const id = log.record({ action: 'move', src: '/a', dst: '/b', size: 1, basis: 'x' })
    expect(log.get(id)?.runId).toBeUndefined()
  })
})
