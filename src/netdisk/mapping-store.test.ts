import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MappingStore, newMappingId } from './mapping-store.ts'
import { openNetdiskDb, migrateLegacyNetdiskData, type NetdiskDb } from './db.ts'
import type { MappingSet, MappingEntry } from './types.ts'

function makeSet(over: Partial<MappingSet> = {}): MappingSet {
  return {
    id: over.id ?? 'map_test01',
    left: over.left ?? { kind: 'stream', streamId: 's1', title: 'T' },
    right: over.right ?? { kind: 'alist-dir', path: '/dir', boundAt: '2026-07-07T00:00:00Z' },
    rightHistory: over.rightHistory ?? [],
    autoSync: over.autoSync ?? true,
    lastSyncAt: over.lastSyncAt,
    entries: over.entries ?? [],
  }
}

function entry(over: Partial<MappingEntry> & Pick<MappingEntry, 'leftKey' | 'status'>): MappingEntry {
  return {
    leftTitle: over.leftTitle ?? over.leftKey,
    rightFile: over.rightFile ?? null,
    ...over,
  }
}

describe('MappingStore', () => {
  let db: NetdiskDb
  beforeEach(() => {
    db = openNetdiskDb(':memory:')
  })

  it('persists across reload (save → new instance on same db → get)', () => {
    const s1 = new MappingStore(db)
    const set = makeSet({ id: 'map_a', entries: [entry({ leftKey: 'netease:1', status: 'auto', rightFile: '01.m4a' })] })
    s1.save(set)

    const s2 = new MappingStore(db)
    expect(s2.get('map_a')).toEqual(set)
    expect(s2.list()).toHaveLength(1)
  })

  it('findByLeftKey hits auto/confirmed, misses pending/rejected/unmatched/null', () => {
    const store = new MappingStore(db)
    store.save(
      makeSet({
        id: 'map_b',
        lastSyncAt: '2026-07-07T00:00:00Z',
        entries: [
          entry({ leftKey: 'k:auto', status: 'auto', rightFile: 'a.m4a' }),
          entry({ leftKey: 'k:confirmed', status: 'confirmed', rightFile: 'c.m4a' }),
          entry({ leftKey: 'k:pending', status: 'pending', rightFile: 'p.m4a' }),
          entry({ leftKey: 'k:rejected', status: 'rejected', rightFile: 'r.m4a' }),
          entry({ leftKey: 'k:unmatched', status: 'unmatched', rightFile: null }),
          entry({ leftKey: 'k:nullfile', status: 'auto', rightFile: null }),
        ],
      }),
    )
    expect(store.findByLeftKey('k:auto')?.rightFile).toBe('a.m4a')
    expect(store.findByLeftKey('k:confirmed')?.rightFile).toBe('c.m4a')
    expect(store.findByLeftKey('k:pending')).toBeUndefined()
    expect(store.findByLeftKey('k:rejected')).toBeUndefined()
    expect(store.findByLeftKey('k:unmatched')).toBeUndefined()
    expect(store.findByLeftKey('k:nullfile')).toBeUndefined()
  })

  it('leftKey collision: newer lastSyncAt wins', () => {
    const store = new MappingStore(db)
    store.save(
      makeSet({
        id: 'map_old',
        lastSyncAt: '2026-01-01T00:00:00Z',
        right: { kind: 'alist-dir', path: '/old', boundAt: '2026-01-01T00:00:00Z' },
        entries: [entry({ leftKey: 'dup', status: 'auto', rightFile: 'old.m4a' })],
      }),
    )
    store.save(
      makeSet({
        id: 'map_new',
        lastSyncAt: '2026-07-07T00:00:00Z',
        right: { kind: 'alist-dir', path: '/new', boundAt: '2026-07-07T00:00:00Z' },
        entries: [entry({ leftKey: 'dup', status: 'auto', rightFile: 'new.m4a' })],
      }),
    )
    const hit = store.findByLeftKey('dup')
    expect(hit?.setId).toBe('map_new')
    expect(hit?.dirPath).toBe('/new')
    expect(hit?.rightFile).toBe('new.m4a')
  })

  it('remove deletes rows and clears index', () => {
    const store = new MappingStore(db)
    store.save(makeSet({ id: 'map_x', entries: [entry({ leftKey: 'x:1', status: 'auto', rightFile: 'x.m4a' })] }))
    store.remove('map_x')
    expect(store.get('map_x')).toBeUndefined()
    expect(store.findByLeftKey('x:1')).toBeUndefined()
    const reloaded = new MappingStore(db)
    expect(reloaded.get('map_x')).toBeUndefined()
  })

  it('entries 顺序 = 保存时的数组顺序（清单顺序，重载后不变）', () => {
    const store = new MappingStore(db)
    const names = ['第十集', '第一集', '第五集']
    store.save(makeSet({ id: 'map_ord', entries: names.map((n, i) => entry({ leftKey: `k:${i}`, leftTitle: n, status: 'unmatched' })) }))
    const reloaded = new MappingStore(db)
    expect(reloaded.get('map_ord')!.entries.map((e) => e.leftTitle)).toEqual(names)
  })

  it('newMappingId shape: map_ + 6 hex chars', () => {
    expect(newMappingId()).toMatch(/^map_[0-9a-f]{6}$/)
  })

  // 播放反查是键无关的：leftKey 长什么样它都收。作品级绑定的键形状不同（tmdb:1399:S01E05），
  // 这条把「不用为新左侧改播放侧」钉住。
  it('findByLeftKey 认得 tmdb 形状的键 —— 播放侧不因左侧来源分叉', () => {
    const store = new MappingStore(db)
    store.save(makeSet({
      id: 'map_tmdb',
      left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权力的游戏' },
      entries: [entry({ leftKey: 'tmdb:1399:S01E01', status: 'auto', rightFile: 'GoT.S01E01.mkv' })],
    }))
    expect(store.findByLeftKey('tmdb:1399:S01E01')?.rightFile).toBe('GoT.S01E01.mkv')
  })
})

describe('迁移：data/mappings/*.json → netdisk.db', () => {
  let dir: string
  let db: NetdiskDb
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-'))
    db = openNetdiskDb(':memory:')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const legacy = (mappingsDir: string) => ({ mappingsDir, reconcileDir: join(dir, 'reconcile') })

  it('导入存量绑定，旧目录改名 .migrated 留备份', () => {
    const mappingsDir = join(dir, 'mappings')
    mkdirSync(mappingsDir)
    const good = makeSet({ id: 'map_good', entries: [entry({ leftKey: 'g:1', status: 'auto', rightFile: 'g.m4a' })] })
    writeFileSync(join(mappingsDir, 'map_good.json'), JSON.stringify(good))
    migrateLegacyNetdiskData(db, legacy(mappingsDir), () => {})
    const store = new MappingStore(db)
    expect(store.get('map_good')).toBeTruthy()
    expect(store.findByLeftKey('g:1')?.rightFile).toBe('g.m4a')
    expect(existsSync(mappingsDir)).toBe(false)
    expect(existsSync(`${mappingsDir}.migrated`)).toBe(true)
  })

  it('损坏文件只跳过那一份，其余照迁', () => {
    const mappingsDir = join(dir, 'mappings')
    mkdirSync(mappingsDir)
    writeFileSync(join(mappingsDir, 'broken.json'), '{ not valid json ][')
    const good = makeSet({ id: 'map_good', entries: [entry({ leftKey: 'g:1', status: 'auto', rightFile: 'g.m4a' })] })
    writeFileSync(join(mappingsDir, 'map_good.json'), JSON.stringify(good))
    migrateLegacyNetdiskData(db, legacy(mappingsDir), () => {})
    const store = new MappingStore(db)
    expect(store.get('map_good')).toBeTruthy()
    expect(store.list()).toHaveLength(1)
  })

  // left 的判别式从 'playlist' 改名为 'stream'（'playlist' 这个词来自音频歌单，它实际就是
  // 「一个订阅流」）。存量文件里全是 'playlist'——导入时归一，库里只有新名。改名绝不能丢掉存量绑定。
  it('存量 playlist 判别式导入时归一为 stream —— 改名不丢绑定', () => {
    const mappingsDir = join(dir, 'mappings')
    mkdirSync(mappingsDir)
    writeFileSync(
      join(mappingsDir, 'map_old.json'),
      JSON.stringify({
        id: 'map_old',
        left: { kind: 'playlist', streamId: 's-legacy', title: '老绑定' },
        right: { kind: 'alist-dir', path: '/dir', boundAt: '2026-01-01T00:00:00Z' },
        rightHistory: [], autoSync: true,
        entries: [{ leftKey: 'p:1', leftTitle: 'E1', rightFile: 'a.mp4', status: 'auto' }],
      }),
    )
    migrateLegacyNetdiskData(db, legacy(mappingsDir), () => {})
    const s = new MappingStore(db)
    const set = s.get('map_old')!
    expect(set.left).toEqual({ kind: 'stream', streamId: 's-legacy', title: '老绑定' })
    // 归一后照样可播
    expect(s.findByLeftKey('p:1')?.rightFile).toBe('a.mp4')
  })

  it('表已非空 → 不再导入（旧文件即便还在也不读）', () => {
    const store = new MappingStore(db)
    store.save(makeSet({ id: 'map_live' }))
    const mappingsDir = join(dir, 'mappings')
    mkdirSync(mappingsDir)
    writeFileSync(join(mappingsDir, 'map_stale.json'), JSON.stringify(makeSet({ id: 'map_stale' })))
    migrateLegacyNetdiskData(db, legacy(mappingsDir), () => {})
    const reloaded = new MappingStore(db)
    expect(reloaded.get('map_stale')).toBeUndefined()
    expect(existsSync(mappingsDir)).toBe(true) // 没迁就不改名
  })

  it('reconcile 存量（config/decisions/runs/provenance/durations）全部入库并改名', () => {
    const reconcileDir = join(dir, 'reconcile')
    mkdirSync(reconcileDir)
    writeFileSync(join(reconcileDir, 'config.json'), JSON.stringify({ shows: [{ id: 'yile', label: '怡楽', bindingId: 'map_1', sourceDirs: ['/src'], subShows: [], autoExecute: false }] }))
    writeFileSync(join(reconcileDir, 'decisions.json'), JSON.stringify({ exemptions: { k1: { note: '手动放行', at: 1 } }, tombstones: { k2: { at: 2 } } }))
    writeFileSync(join(reconcileDir, 'runs.jsonl'), `${JSON.stringify({ runId: 'r1', at: '2026-07-30T00:00:00Z', show: 'yile', mode: 'preview', conservation: true, counts: {}, authority: {}, rows: [], errors: [] })}\n`)
    const act = { id: 'a1', at: 3, action: 'move', src: '/s/x.mp3', dst: '/d', size: 9, basis: 'authority:k' }
    writeFileSync(join(reconcileDir, 'provenance.jsonl'), `${JSON.stringify(act)}\n${JSON.stringify({ ...act, undone: true })}\n`)
    writeFileSync(join(reconcileDir, 'durations.json'), JSON.stringify({ '9:/s/x.mp3': 3600, '5:/s/y.mp3': null }))

    migrateLegacyNetdiskData(db, { mappingsDir: join(dir, 'mappings'), reconcileDir }, () => {})

    expect((db.prepare('SELECT json FROM reconcile_shows').get() as { json: string }).json).toContain('yile')
    expect(db.prepare('SELECT kind FROM decisions WHERE key = ?').get('k1')).toEqual({ kind: 'exempt' })
    expect(db.prepare('SELECT kind FROM decisions WHERE key = ?').get('k2')).toEqual({ kind: 'tombstone' })
    expect((db.prepare('SELECT show FROM reconcile_runs WHERE run_id = ?').get('r1') as { show: string }).show).toBe('yile')
    // markUndone 的追加行（同 id 全量行）按行序覆盖 → undone 生效
    expect((db.prepare('SELECT undone FROM run_actions WHERE id = ?').get('a1') as { undone: number }).undone).toBe(1)
    expect((db.prepare('SELECT duration_s FROM durations WHERE key = ?').get('9:/s/x.mp3') as { duration_s: number }).duration_s).toBe(3600)
    // 负缓存（探过但失败）保住 NULL 语义
    expect((db.prepare('SELECT duration_s FROM durations WHERE key = ?').get('5:/s/y.mp3') as { duration_s: number | null }).duration_s).toBeNull()
    for (const f of ['config.json', 'decisions.json', 'runs.jsonl', 'provenance.jsonl', 'durations.json']) {
      expect(existsSync(join(reconcileDir, f))).toBe(false)
      expect(existsSync(join(reconcileDir, `${f}.migrated`))).toBe(true)
    }
  })
})
