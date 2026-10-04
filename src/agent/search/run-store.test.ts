// src/agent/search/run-store.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SearchRunStore, RESULT_MAX_BYTES } from './run-store.ts'

const store = () => new SearchRunStore(':memory:')

describe('SearchRunStore', () => {
  it('create → get round-trips a queued run with empty trajectory', () => {
    const s = store()
    const rec = s.create('怡楽播客')
    expect(rec.goal).toBe('怡楽播客')
    expect(rec.status).toBe('queued')
    expect(rec.trajectory).toEqual([])
    const got = s.get(rec.runId)
    expect(got?.runId).toBe(rec.runId)
    expect(got?.goal).toBe('怡楽播客')
  })

  it('appendStep assigns incrementing seq + an ISO timestamp, preserved across put', () => {
    const s = store()
    const { runId } = s.create('g')
    s.appendStep(runId, { kind: 'seed', decision: { q: 'g' } })
    s.appendStep(runId, { kind: 'search', output: { count: 3 } })
    s.put(runId, { status: 'running' }) // a status update must not clobber the trajectory
    const t = s.get(runId)!.trajectory
    expect(t.map((x) => x.seq)).toEqual([0, 1])
    expect(t[0].kind).toBe('seed')
    expect(typeof t[0].at).toBe('string')
    expect(s.get(runId)!.status).toBe('running')
  })

  it('put stores targets + onboardable and marks done', () => {
    const s = store()
    const { runId } = s.create('g')
    s.put(runId, {
      status: 'done',
      targets: [{ link: 'https://pan.quark.cn/x', netdisk: 'quark', sourceId: 'pansou', topicality: 3 }],
      onboardable: ['pansou'],
    })
    const got = s.get(runId)!
    expect(got.status).toBe('done')
    expect(got.targets?.[0].netdisk).toBe('quark')
    expect(got.onboardable).toEqual(['pansou'])
  })

  // `list()` 没了（它是启动期那颗炸弹：全表 SELECT * 再逐行 JSON.parse，而 `result` 这一列在活体上
  // 是 GB 级的）。唯一的调用方——重启后判死孤儿 run——改成一条 UPDATE。
  it('failOrphanedRuns: 只判死 running/queued，done/error 一个都不碰，且一行 JSON 都不读', () => {
    const s = store()
    const queued = s.create('q')                       // create 落的就是 queued
    const running = s.create('r')
    s.put(running.runId, { status: 'running' })
    const done = s.create('d')
    s.put(done.runId, { status: 'done', result: { big: 'x'.repeat(1000) } })

    expect(s.failOrphanedRuns()).toBe(2)

    expect(s.get(queued.runId)!.status).toBe('error')
    expect(s.get(queued.runId)!.error).toMatch(/重启/)
    expect(s.get(running.runId)!.status).toBe('error')
    // 已经落定的那条纹丝不动——连它的 result 都还在（判死不许顺手擦别人的产物）。
    expect(s.get(done.runId)!.status).toBe('done')
    expect(s.get(done.runId)!.result).toEqual({ big: 'x'.repeat(1000) })

    // 再扫一次：没有孤儿了，改动 0 行（幂等，重启多少次都不会把 error 又写一遍）。
    expect(s.failOrphanedRuns()).toBe(0)
  })

  /**
   * **这条是那次启动崩溃的回归闸，而且它有牙。**
   *
   * 2026-09-22：后端连崩 14 次起不来，`FATAL ERROR: Reached heap limit`，V8 的 native stack 停在
   * `JsonParse`。真因是重启扫孤儿那一格走的是「全表 SELECT * 再逐行 rowToRecord」，而 rowToRecord
   * 会解析每一行的 `result`——活体那一列光文本就 2.07 GB（最大单行 74 MB，整份导出文件的 base64）。
   *
   * 用「大数据」当判据太慢也太脆，所以这里换一个**等价而廉价的陷阱**：往一行里塞一段**解析不了的**
   * `result`。只要扫孤儿还去碰它，JSON.parse 当场抛；不碰它，这条就绿。
   */
  it('failOrphanedRuns 不读 result：哪怕某一行的 result 根本不是 JSON 也照样扫得过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-store-'))
    const path = join(dir, 'agent-runs.db')
    const s = new SearchRunStore(path)
    const orphan = s.create('还在跑的那条')
    s.put(orphan.runId, { status: 'running' })
    const poisoned = s.create('产物大到读不得的那条')
    s.put(poisoned.runId, { status: 'done' })
    // 绕开 store 直接写一段坏 JSON——真实世界里对应的是「大到解析不动」，代价一样、复现便宜。
    const raw = new Database(path)
    raw.prepare('UPDATE agent_runs SET result = ? WHERE run_id = ?').run('{{{ 这不是 JSON', poisoned.runId)
    raw.close()

    expect(() => s.failOrphanedRuns()).not.toThrow()
    expect(s.get(orphan.runId)!.status).toBe('error')
    s.close()
  })
})

// Task 5 Step 1：domain / stopped 落库。两条都不是可有可无的字段——
// `domain` 是**读 targets 的前提**（两个域的候选形状不同、共用一格），
// `stopped` 分得开「摸到头了」和「被轮次掐断」（对覆盖范围的含义相反，spec §2.4）。
describe('SearchRunStore：domain 与 stopped', () => {
  it('create 默认 netdisk；显式传 catalog 则存 catalog', () => {
    const s = store()
    expect(s.get(s.create('g').runId)!.domain).toBe('netdisk')
    expect(s.get(s.create('g', 'catalog').runId)!.domain).toBe('catalog')
  })

  it('put 落 stopped，跨 get 读得回来', () => {
    const s = store()
    const { runId } = s.create('g', 'catalog')
    s.put(runId, { status: 'done', stopped: 'truncated' })
    expect(s.get(runId)!.stopped).toBe('truncated')
  })

  it('这一列之前建的库照样读得出来，且缺省按 netdisk', () => {
    // 真的建一份**老 schema**（没有 domain / stopped 两列）再交给 SearchRunStore 打开——
    // 迁移是 ALTER 补列，补出来的老行这两格是 NULL。缺省不给的话，存量 run 会读出
    // domain: undefined 一路流进回执，让「没记」和「不是网盘档」长得一模一样。
    const path = join(mkdtempSync(join(tmpdir(), 'stream-runstore-')), 'old.db')
    const old = new Database(path)
    old.exec(`
      CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
        trajectory TEXT NOT NULL, targets TEXT, onboardable TEXT, error TEXT, updated_at TEXT NOT NULL
      );
    `)
    old
      .prepare(
        `INSERT INTO agent_runs VALUES ('r1','老目标','done','[]',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z')`
      )
      .run()
    old.close()

    const s = new SearchRunStore(path)
    const got = s.get('r1')!
    expect(got.goal).toBe('老目标')
    expect(got.domain).toBe('netdisk')
    expect(got.stopped).toBeUndefined()
    expect(got.result).toBeUndefined()
    s.close()
  })

  it('`result`（非发现类 job 的最终产物）随 put 落库、随 get 读回，不动轨迹；status-only 的 put 不抹它', () => {
    const s = store()
    const { runId } = s.create('手机 0–5000 元', 'purchase')
    s.appendStep(runId, { kind: 'stage', decision: 'universe', note: '枚举全集' })
    s.put(runId, { status: 'done', result: { frontier: ['A'], coverage: { universe: 3 } }, stopped: 'truncated' })
    const got = s.get(runId)!
    expect(got.domain).toBe('purchase')
    expect(got.result).toEqual({ frontier: ['A'], coverage: { universe: 3 } })
    expect(got.trajectory.map((t) => t.kind)).toEqual(['stage'])
    s.put(runId, { status: 'done' })
    expect(s.get(runId)!.result).toEqual({ frontier: ['A'], coverage: { universe: 3 } })
  })
})

describe('SearchRunStore：账本不是 blob 库', () => {
  it('result 超过 RESULT_MAX_BYTES → put 抛错（不截断、不落库），小的照收', () => {
    const s = store()
    const { runId } = s.create('action:photopea-run', 'action')
    const big = { items: [{ data: 'A'.repeat(RESULT_MAX_BYTES + 1) }] }
    expect(() => s.put(runId, { status: 'done', result: big })).toThrow(/output\.files/)
    expect(s.get(runId)!.result).toBeUndefined()
    s.put(runId, { status: 'done', result: { items: [{ file: '/data/action-artifacts/x.png' }] } })
    expect(s.get(runId)!.result).toEqual({ items: [{ file: '/data/action-artifacts/x.png' }] })
  })

  it('prune：按域的保留期删已落定的旧行；running/queued 不动；域缺省按 default', () => {
    const s = store()
    const day = 24 * 60 * 60_000
    const now = Date.parse('2026-09-23T00:00:00Z')
    const at = (runId: string, ageDays: number) =>
      (s as unknown as { db: Database.Database }).db
        .prepare('UPDATE agent_runs SET updated_at = ? WHERE run_id = ?')
        .run(new Date(now - ageDays * day).toISOString(), runId)
    const oldAction = s.create('action:x', 'action').runId
    s.put(oldAction, { status: 'done' }); at(oldAction, 31)
    const freshAction = s.create('action:y', 'action').runId
    s.put(freshAction, { status: 'done' }); at(freshAction, 29)
    const oldPurchase = s.create('买手机', 'purchase').runId
    s.put(oldPurchase, { status: 'done' }); at(oldPurchase, 89)
    const ancientNetdisk = s.create('找剧', 'netdisk').runId
    s.put(ancientNetdisk, { status: 'error', error: 'x' }); at(ancientNetdisk, 91)
    const stuck = s.create('action:z', 'action').runId
    s.put(stuck, { status: 'running' }); at(stuck, 400)

    const r = s.prune({ now })
    expect(r.removed).toBe(2)
    expect(s.get(oldAction)).toBeNull()
    expect(s.get(ancientNetdisk)).toBeNull()
    expect(s.get(freshAction)).not.toBeNull()
    expect(s.get(oldPurchase)).not.toBeNull()
    // 在飞的行永远不归 prune 管——它等的是下次开机的 failOrphanedRuns
    expect(s.get(stuck)!.status).toBe('running')
  })

  it('prune：存量里超过 RESULT_MAX_BYTES 的 result 不等保留期、当场抹掉，行留着并写明缘由', () => {
    const s = store()
    const raw = (s as unknown as { db: Database.Database }).db
    const { runId } = s.create('action:photopea-run', 'action')
    // 绕过 put 的护栏，模拟护栏立起来之前塞进去的那批
    raw.prepare(`UPDATE agent_runs SET status = 'done', result = ? WHERE run_id = ?`).run(JSON.stringify({ data: 'A'.repeat(RESULT_MAX_BYTES + 1) }), runId)
    const small = s.create('action:x', 'action').runId
    s.put(small, { status: 'done', result: { items: [{ file: '/p' }] } })
    const r = s.prune()
    expect(r.stripped).toBe(1)
    expect(r.removed).toBe(0)
    const got = s.get(runId)!
    expect(got.status).toBe('done')
    expect(got.result).toBeUndefined()
    expect(got.error).toMatch(/超过账本上限/)
    expect(s.get(small)!.result).toEqual({ items: [{ file: '/p' }] })
    expect(s.prune().stripped).toBe(0)
  })

  it('prune：删掉大半之后 VACUUM，磁盘真的还回来（空洞占比 > 1/4 才做）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runs-'))
    const path = join(dir, 'agent-runs.db')
    const s = new SearchRunStore(path)
    const now = Date.parse('2026-09-23T00:00:00Z')
    const old = new Date(now - 40 * 24 * 60 * 60_000).toISOString()
    const raw = (s as unknown as { db: Database.Database }).db
    for (let i = 0; i < 20; i++) {
      const { runId } = s.create('action:x', 'action')
      s.put(runId, { status: 'done', result: { data: 'B'.repeat(200_000) } })
      raw.prepare('UPDATE agent_runs SET updated_at = ? WHERE run_id = ?').run(old, runId)
    }
    raw.pragma('wal_checkpoint(TRUNCATE)')
    const before = statSync(path).size
    const r = s.prune({ now })
    expect(r.removed).toBe(20)
    expect(r.vacuumed).toBe(true)
    raw.pragma('wal_checkpoint(TRUNCATE)')
    expect(statSync(path).size).toBeLessThan(before / 4)
    // 没什么可删时不白写盘
    expect(s.prune({ now }).vacuumed).toBe(false)
    s.close()
  })
})
