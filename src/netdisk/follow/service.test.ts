import { describe, it, expect, vi } from 'vitest'
import { openNetdiskDb, type NetdiskDb } from '../db.ts'
import { MappingStore } from '../mapping-store.ts'
import type { MappingSet } from '../types.ts'
import { FollowService, type FollowDeps } from './service.ts'
import { ShareLedger } from './ledger.ts'
import type { ShareClient, ShareTreeFile } from './types.ts'

const NOW = new Date('2026-09-03T10:00:00Z')
// pdirFid 跟着分享内路径走：有目录层就是 `dir:<目录名>`，根就是 '0'——转存要按它分组，丢了就到根目录找不到文件（活体撞过）
const tf = (path: string, size = 2_000_000_000): ShareTreeFile => ({ fid: `fid:${path}`, token: 't', pdirFid: path.includes('/') ? `dir:${path.split('/')[0]}` : '0', name: path.split('/').pop()!, size, path })

function baseSet(): MappingSet {
  return {
    id: 'map_1', left: { kind: 'tmdb', id: '261471', media: 'tv', title: '脱口秀和Ta的朋友们' },
    right: { kind: 'alist-dir', path: '/quark/From Stream/tv-261471', boundAt: '2026-08-01T00:00:00Z' },
    rightHistory: [], autoSync: true, follow: { enabled: true, dryRuns: 0 },
    entries: [
      { leftKey: 'tmdb:261471:S03E13', leftTitle: '第 13 集', rightFile: 'S03E13.mkv', status: 'auto', airDate: '2026-08-23' },
      { leftKey: 'tmdb:261471:S03E14', leftTitle: '第 14 集', rightFile: null, status: 'unmatched', airDate: '2026-08-30' },
      { leftKey: 'tmdb:261471:S03E15', leftTitle: '第 15 集', rightFile: null, status: 'unmatched', airDate: '2026-09-06' },
    ],
  }
}

/** 假认集脑：文件名里含 `S03E14` 就配给 S03E14（auto），其余不配。 */
const fakeMatch = async (_set: MappingSet, files: { name: string }[]) => {
  const assignments = new Map<string, { rightFile: string; confidence: number; status: 'auto' | 'pending' }>()
  for (const f of files) {
    const m = /S(\d\d)E(\d\d)/.exec(f.name)
    if (m) assignments.set(`tmdb:261471:S${m[1]}E${m[2]}`, { rightFile: f.name, confidence: 1, status: 'auto' })
  }
  return { assignments, ambiguous: [], coverage: { left: { total: 0, matched: 0, ambiguous: 0, missing: 0 }, right: { total: 0, matched: 0, orphan: 0 }, missingEpisodes: [], orphanFiles: [] } }
}

function harness(over: {
  shares?: Partial<ShareClient>
  search?: FollowDeps['videoSearch']
  reconcile?: FollowDeps['reconcile']
  adjudicate?: FollowDeps['adjudicate']
  matchExternalFiles?: FollowDeps['netdisk']['matchExternalFiles']
} = {}) {
  const db: NetdiskDb = openNetdiskDb(':memory:')
  const store = new MappingStore(db)
  store.save(baseSet())
  const saved: Array<{ pwdId: string; files: string[]; subdir?: string }> = []
  const shareTrees = new Map<string, ShareTreeFile[]>()
  const shares: ShareClient = {
    supports: (n) => n === 'quark',
    list: async (_n, pwdId) => ({ validity: shareTrees.has(pwdId) ? 'alive' : 'not-usable', files: shareTrees.get(pwdId) ?? [] }),
    save: async (_n, pwdId, o) => {
      // 父目录必须原样递到转存那边（否则它到根目录找不到子文件夹里的文件）——在这儿钉死，别让它静默丢
      for (const f of o.files) if (f.pdirFid === undefined) throw new Error(`save got file without pdirFid: ${f.fid}`)
      saved.push({ pwdId, files: o.files.map((f) => f.fid), subdir: o.subdir }); return { saved: true, stage: 'done', message: 'ok' }
    },
    ...over.shares,
  }
  // sync 的假身：转存过的文件出现在货架上 → 配上
  const netdisk = {
    sync: vi.fn(async (set: MappingSet) => {
      for (const s of saved) for (const fid of s.files) {
        const m = /S(\d\d)E(\d\d)/.exec(fid)
        const e = m && set.entries.find((x) => x.leftKey === `tmdb:261471:S${m[1]}E${m[2]}`)
        if (e) { e.rightFile = fid; e.status = 'auto' }
      }
      store.save(set); return set
    }),
    bind: vi.fn(), bindingForTmdb: vi.fn(), matchExternalFiles: vi.fn(over.matchExternalFiles ?? fakeMatch),
  }
  const events: Array<Record<string, unknown>> = []
  const mkdir = vi.fn(async () => {})
  // 默认给一个空手而归的归档器桩：不这样的话，测试指南针「零缺集」「auth 失败」这些既有用例会
  // 平白多出一行 `archive: 归档器未装配`，把 rec.errors 从空变非空、把 notify 从不发变发。
  // 要测「真没装配」那一条，显式传 `reconcile: undefined`（'reconcile' in over 为 true 但值是 undefined）。
  const reconcile: FollowDeps['reconcile'] = 'reconcile' in over
    ? over.reconcile
    : { executeBinding: vi.fn(async () => ({ moved: 0, deleted: 0, renamed: 0, removedDirs: 0, pending: 0, errors: [], runId: 'run_noop', ledger: {} })) }
  const svc = new FollowService({
    db, store, netdisk: netdisk as never, shares, mkdir, reconcile,
    videoSearch: over.search ?? (() => undefined),
    ...(over.adjudicate ? { adjudicate: over.adjudicate } : {}),
    events: { append: (e) => events.push(e as unknown as Record<string, unknown>) }, now: () => NOW, sleep: async () => {}, log: () => {},
  })
  return { db, store, svc, saved, shareTrees, netdisk, events, mkdir }
}

describe('FollowService.runOnce', () => {
  it('回访旧分享：只转存新出现且配到缺集的文件，seenFiles 更新，通知说补了哪集', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E13.mkv'), tf('S03/S03E14.mkv'), tf('S03/readme.txt', 3)])
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(rec.missingAired).toEqual(['tmdb:261471:S03E14'])        // E15 未播出
    // E13 已有、readme 不配；落点带上分享里的父目录（S03），不平铺进作品根
    expect(h.saved).toEqual([{ pwdId: 'p1', files: ['fid:S03/S03E14.mkv'], subdir: 'From Stream/tv-261471/S03' }])
    expect(rec.synced).toEqual({ matchedBefore: 1, matchedAfter: 2 })
    expect(rec.searched).toBeUndefined()
    const row = h.svc.view('map_1').shares[0]
    expect(row).toMatchObject({ pwdId: 'p1', validity: 'alive' })
    expect(h.events).toHaveLength(1)
    expect(h.store.get('map_1')!.follow).toMatchObject({ dryRuns: 0, lastCheckAt: NOW.toISOString() })
  })

  it('缺集横跨几季就搜几季——缺得多的季先搜，不是只搜最小的那一季', async () => {
    const search = vi.fn(async () => ({ shows: [], loose: [], sources: [] }))
    const h = harness({ search: () => search as never })
    const set = h.store.get('map_1')!
    // 第 2 季缺 1 集（决赛），第 3 季缺 2 集 → 先搜第 3 季
    set.entries.push({ leftKey: 'tmdb:261471:S02E26', leftTitle: '第 26 集', rightFile: null, status: 'unmatched', airDate: '2025-10-01' })
    set.entries[2] = { ...set.entries[2], airDate: '2026-08-30' } // S03E15 也已播出
    h.store.save(set)
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.searched?.queries).toEqual([
      '脱口秀和Ta的朋友们 第3季', '脱口秀和Ta的朋友们 第三季',
      '脱口秀和Ta的朋友们 第2季', '脱口秀和Ta的朋友们 第二季',
    ])
  })

  it('见过但没转存成的文件，下一轮回访照样重试——候选池是"没转存过的"，不是"没见过的"', async () => {
    let fail = true
    const h = harness({ shares: { save: async (_n, pwdId, o) => {
      if (fail) return { saved: false, stage: 'save', message: 'token校验异常' }
      h.saved.push({ pwdId, files: o.files.map((f) => f.fid) }); return { saved: true, stage: 'done', message: 'ok' }
    } } })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv')])
    const r1 = await h.svc.runOnce('map_1', 'scheduled')
    expect(r1.saved).toEqual([]); expect(r1.errors[0]).toMatch(/token/)
    fail = false
    const r2 = await h.svc.runOnce('map_1', 'scheduled')
    expect(r2.revisited[0]).toMatchObject({ newFiles: 0, picked: 1 })
    expect(h.saved).toEqual([{ pwdId: 'p1', files: ['fid:S03/S03E14.mkv'] }])
  })

  it('第二轮同一分享没有新文件 → 不转存；旧源补不上才搜索', async () => {
    const search = vi.fn(async (q: string) => ({ shows: [], loose: q.includes('第三季') ? [{ source: 'pansou', title: 'x', quality: '1080p', sourceType: 'quark', coverage: {}, link: 'https://pan.quark.cn/s/p2', password: '' }] : [], sources: [] }))
    const h = harness({ search: () => search as never })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E13.mkv')])
    h.shareTrees.set('p2', [tf('S03E14.mkv')])
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(search).toHaveBeenCalled()
    expect(rec.searched).toMatchObject({ hits: 1, alive: 1, picked: 1 })
    expect(h.saved).toEqual([{ pwdId: 'p2', files: ['fid:S03E14.mkv'], subdir: 'From Stream/tv-261471' }])
    expect(h.svc.view('map_1').shares.map((s) => [s.pwdId, s.origin])).toEqual([['p1', 'manual'], ['p2', 'search']])
  })

  it('全无果 → dryRuns+1、通知说没找到；unknown 的分享不算无果也不动 validity', async () => {
    // 搜索要真接上并回空手：没装配是「没验到」而不是「找不到」，那种不该退避（见另一条用例）。
    const emptySearch = vi.fn(async () => ({ shows: [], loose: [], sources: [] }))
    const h = harness({ shares: { list: async () => ({ validity: 'unknown', files: [] }) }, search: () => emptySearch as never })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.saved).toEqual([])
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(1)
    expect(h.svc.view('map_1').shares[0].validity).toBeUndefined()
    // 一轮干净的无果不是故障——warn 留给真出了错的那种
    expect(h.events[0]).toMatchObject({ type: 'follow.round', severity: 'info' })
  })

  it('转存回 auth 失败 → 记 errors，dryRuns 不加', async () => {
    const h = harness({ shares: { save: async () => ({ saved: false, stage: 'auth', message: '没有夸克登录态' }) } })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03E14.mkv')])
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors[0]).toMatch(/auth/)
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('零缺集 → 不验活不搜索不发通知，只排下一次', async () => {
    const h = harness()
    const set = h.store.get('map_1')!
    set.entries[1].rightFile = 'x'; set.entries[1].status = 'auto'; h.store.save(set)
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.missingAired).toEqual([])
    expect(h.events).toHaveLength(0)
    expect(h.store.get('map_1')!.follow!.nextCheckAt).toBeTruthy()
  })

  it('首次 sync 挂了（TMDb/AList 不可用）→ 记错误行、不推进节奏、不动 dryRuns，但要出声', async () => {
    const h = harness()
    const before = h.store.get('map_1')!
    before.follow = { enabled: true, dryRuns: 2 }; h.store.save(before)
    h.netdisk.sync.mockRejectedValueOnce(new Error('TMDb 502'))
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors[0]).toMatch(/^sync: TMDb 502/)
    const follow = h.store.get('map_1')!.follow!
    expect(follow.dryRuns).toBe(2)
    expect(follow.nextCheckAt).toBeUndefined()
    expect(follow.lastCheckAt).toBeUndefined()
    // 这轮什么都没干成，但它是"出错了"而不是"没到时候"——静音的话没有一处会喊
    expect(h.events).toEqual([
      { type: 'follow.round', severity: 'warn', title: '《脱口秀和Ta的朋友们》追更这轮出错', body: 'sync: TMDb 502', dedupeKey: 'follow:map_1' },
    ])
    expect(h.svc.view('map_1').runs.map((r) => r.id)).toEqual([rec.id])   // 账本行仍然落了
  })

  it('搜索没装配 → 记一行错误，但不冻住退避（这仍然是一次"问到了、没有"）', async () => {
    const h = harness()   // videoSearch 默认 thunk 返回 undefined
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors).toEqual(['search: 资源搜索未装配'])
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(1)
  })

  it('中途抛错（认集脑挂了）→ 不把整轮掀掉，落成 errors 行，dryRuns 不加，事件是 warn', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03E14.mkv')])
    h.netdisk.matchExternalFiles.mockRejectedValue(new Error('认集脑炸了'))
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors.join('\n')).toMatch(/认集脑炸了/)
    expect(h.saved).toEqual([])
    // 「没验到」不是「找不到」：出了错就不能算一次无果
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
    expect(h.events[0]).toMatchObject({ type: 'follow.round', severity: 'warn' })
    expect(h.svc.view('map_1').runs).toHaveLength(1)
  })

  it('登录态掉了 → 后面的转存一律不再发起，另发一条 follow.auth', async () => {
    const save = vi.fn(async () => ({ saved: false, stage: 'auth', message: '没有夸克登录态' }))
    const h = harness({ shares: { save } })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.svc.recordShare('map_1', 'quark', 'p2', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03E14.mkv')])
    h.shareTrees.set('p2', [tf('S03E14.mkv')])
    await h.svc.runOnce('map_1', 'scheduled')
    expect(save).toHaveBeenCalledTimes(1)
    expect(h.events.filter((e) => e.type === 'follow.auth')).toEqual([
      { type: 'follow.auth', severity: 'warn', title: '追更转存需要夸克登录态', body: '没有夸克登录态', dedupeKey: 'follow-auth' },
    ])
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('搜索本身抛错 → 记错误行，不算一次无果', async () => {
    const search = vi.fn(async () => { throw new Error('pansou 超时') })
    const h = harness({ search: () => search as never })
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors.every((e) => e.startsWith('search '))).toBe(true)
    expect(rec.errors).toHaveLength(2)
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('搜到的分享列不出来 → 记 list 错误行并计进 searched.failed', async () => {
    const search = vi.fn(async () => ({ shows: [], loose: [{ source: 'pansou', title: 'x', quality: '1080p', sourceType: 'quark', coverage: {}, link: 'https://pan.quark.cn/s/p2', password: '' }], sources: [] }))
    const h = harness({
      search: () => search as never,
      shares: { list: async (_n, pwdId) => { if (pwdId === 'p2') throw new Error('分享页 500'); return { validity: 'not-usable' as const, files: [] } } },
    })
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.searched).toMatchObject({ hits: 1, alive: 0, picked: 0, failed: 1 })
    expect(rec.errors).toContain('list quark:p2: 分享页 500')
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('同一条分享被搜到两次 → 提取码不会被后一条的空值抹掉', async () => {
    const rel = (password: string) => ({ source: 'pansou', title: 'x', quality: '1080p', sourceType: 'quark', coverage: {}, link: 'https://pan.quark.cn/s/p2', password })
    const search = vi.fn(async () => ({ shows: [], loose: [rel('abcd'), rel('')], sources: [] }))
    const h = harness({ search: () => search as never })
    h.shareTrees.set('p2', [tf('S03E14.mkv')])
    await h.svc.runOnce('map_1', 'scheduled')
    expect(new ShareLedger(h.db).get('map_1', 'quark', 'p2')?.passcode).toBe('abcd')
  })

  it('转存后的 resync 挂了 → matchedAfter 不拿陈旧的数充数', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03E14.mkv')])
    const real = h.netdisk.sync.getMockImplementation()!
    let calls = 0
    let first: MappingSet | undefined
    h.netdisk.sync.mockImplementation(async (set: MappingSet) => {
      if (++calls === 1) { first = await real(set); return first }
      // 真实的 sync 是**就地改**：它完全可能先把分集标成配上了，再在写货架那一步炸。
      // 所以夹具必须先改再抛——否则 matchedCount 读到的还是转存前那个数，守卫拆了也照样绿。
      for (const e of first!.entries) if (!e.rightFile) { e.rightFile = `${e.leftKey}.mkv`; e.status = 'auto' }
      throw new Error('AList 掉了')
    })
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors.join('\n')).toMatch(/^resync: AList 掉了/)
    expect(rec.synced.matchedAfter).toBe(rec.synced.matchedBefore)
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })
})

describe('FollowService.recordShare', () => {
  it('第二次录同一条分享带上了提取码 → 补进账本，不覆盖别的字段', () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.svc.recordShare('map_1', 'quark', 'p1', 'abcd', 'search')
    const row = new ShareLedger(h.db).get('map_1', 'quark', 'p1')
    expect(row).toMatchObject({ passcode: 'abcd', origin: 'manual' })
  })
})

describe('FollowService.setEnabled / ensureBinding', () => {
  it('setEnabled 拒绝非剧集绑定；开启时清掉旧的 nextCheckAt', () => {
    const h = harness()
    const set = h.store.get('map_1')!
    set.follow = { enabled: false, dryRuns: 3, nextCheckAt: '2099-01-01T00:00:00Z' }; h.store.save(set)
    expect(h.svc.setEnabled('map_1', true).follow).toMatchObject({ enabled: true, dryRuns: 3 })
    expect(h.store.get('map_1')!.follow!.nextCheckAt).toBeUndefined()

    const movie = h.store.get('map_1')!
    movie.left = { kind: 'tmdb', id: '9', media: 'movie', title: '某电影' }; h.store.save(movie)
    expect(() => h.svc.setEnabled('map_1', true)).toThrow(/剧集/)
  })

  it('ensureBinding：已有绑定只开开关；没有就先建目录再绑，且回来是开着的', async () => {
    const h = harness()
    h.netdisk.bindingForTmdb.mockReturnValue(h.store.get('map_1'))
    const existing = await h.svc.ensureBinding({ id: '261471', media: 'tv', title: '脱口秀和Ta的朋友们' }, '/quark/x')
    expect(existing.follow).toMatchObject({ enabled: true })
    expect(h.mkdir).not.toHaveBeenCalled()
    expect(h.netdisk.bind).not.toHaveBeenCalled()

    h.netdisk.bindingForTmdb.mockReturnValue(undefined)
    h.netdisk.bind.mockImplementation(async () => {
      const fresh: MappingSet = { ...baseSet(), id: 'map_2', follow: undefined }
      h.store.save(fresh)
      return fresh
    })
    const made = await h.svc.ensureBinding({ id: '999', media: 'tv', title: '新剧' }, '/quark/新剧')
    expect(h.mkdir).toHaveBeenCalledWith('/quark/新剧')
    expect(h.netdisk.bind).toHaveBeenCalledTimes(1)
    expect(made.follow).toMatchObject({ enabled: true })
  })
})

describe('FollowService · 转存之后', () => {
  it('转存后多同步几轮：夸克还在搬时前几轮看不到，认出来那一轮就停', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv')])
    // 第 1 次 sync 是算缺集；之后 3 次「还没上货架」；第 5 次才看见
    const real = h.netdisk.sync.getMockImplementation()!
    let n = 0
    h.netdisk.sync.mockImplementation(async (set: MappingSet) => (++n <= 4 ? set : real(set)))
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(rec.synced).toEqual({ matchedBefore: 1, matchedAfter: 2 })
    expect(n).toBe(5)
  })

  it('转存了但一轮都没认出 → 通知说「转存了 N 个文件，还没认出集」而不是「没补上」，dryRuns 不涨', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv')])
    h.netdisk.sync.mockImplementation(async (set: MappingSet) => set)   // 货架上始终看不到
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(rec.saved).toHaveLength(1)
    expect(rec.synced).toEqual({ matchedBefore: 1, matchedAfter: 1 })
    expect(String(h.events[0]?.title)).toContain('转存了 1 个文件，还没认出集')
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('同一条分享里不同父目录的文件分组落地，各自带上自己的子目录', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    const set = h.store.get('map_1')!
    set.entries[2] = { ...set.entries[2], airDate: '2026-08-30' }   // S03E15 也已播出
    h.store.save(set)
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv'), tf('S03E15.mkv')])
    await h.svc.runOnce('map_1', 'manual')
    expect(h.saved.map((s) => s.subdir).sort()).toEqual(['From Stream/tv-261471', 'From Stream/tv-261471/S03'])
  })

  it('第 5 步：resync 后调 executeBinding({losers:true,gated:true})，结果进 archived，再 sync 一次', async () => {
    const executeBinding = vi.fn(async () => ({ moved: 3, deleted: 1, renamed: 3, removedDirs: 1, pending: 0, errors: ['rename /x: bad'], runId: 'run_9', ledger: {} }))
    const h = harness({ reconcile: { executeBinding } })
    h.shareTrees.set('p1', [tf('第三季/S03E14.mkv')])
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    const syncCallsBefore = h.netdisk.sync.mock.calls.length
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(executeBinding).toHaveBeenCalledWith('map_1', { losers: true, gated: true })
    expect(rec.archived).toEqual({ runId: 'run_9', moved: 3, deleted: 1, renamed: 3 })
    expect(rec.errors).toContain('archive: rename /x: bad')
    expect(h.netdisk.sync.mock.calls.length).toBeGreaterThan(syncCallsBefore + 1) // resync 之外还多一次
  })

  it('归档被闸：archived.gated 带说明，不算无果', async () => {
    const executeBinding = vi.fn(async () => ({ moved: 0, deleted: 0, renamed: 0, removedDirs: 0, pending: 0, errors: [], runId: 'run_gated', ledger: { gated: { reason: 'health', detail: '清单健康闸没过' } } }))
    const h = harness({ reconcile: { executeBinding } })
    const set = h.store.get('map_1')!
    set.entries[1].rightFile = 'x'; set.entries[1].status = 'auto'; h.store.save(set)   // 清空缺集，别让 search 未装配那条错误混进来
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.archived).toEqual({ runId: 'run_gated', moved: 0, deleted: 0, renamed: 0, gated: '清单健康闸没过' })
    expect(rec.errors).toEqual([])
    // 被闸不是「没验到」——不该冻住退避的判定不受它影响，这里没有缺集所以本来就不涨
    expect(h.store.get('map_1')!.follow!.dryRuns).toBe(0)
  })

  it('归档器未装配：errors 有 archive 行，其余照旧', async () => {
    const h = harness({ reconcile: undefined })
    const set = h.store.get('map_1')!
    set.entries[1].rightFile = 'x'; set.entries[1].status = 'auto'; h.store.save(set)   // 清空缺集，隔离出 archive 这一行
    const rec = await h.svc.runOnce('map_1', 'scheduled')
    expect(rec.errors).toEqual(['archive: 归档器未装配'])
    expect(rec.archived).toBeUndefined()
  })
})

// 工具面的 `run` 是 fire-and-return（一轮要一两分钟，工作台 200 秒就超时），所以"这条绑定
// 正在跑吗"必须由服务自己答——记在调用方那一侧就漏掉定时轮那条路。
describe('FollowService.isRunning', () => {
  it('一轮跑着时为真，跑完自己归位', async () => {
    const h = harness()
    expect(h.svc.isRunning('map_1')).toBe(false)
    const p = h.svc.runOnce('map_1', 'manual')
    expect(h.svc.isRunning('map_1')).toBe(true)
    await p
    expect(h.svc.isRunning('map_1')).toBe(false)
  })

  it('整轮抛了也归位 —— 名册被一条不存在的绑定永久占住，那条绑定就再也开不了轮', async () => {
    const h = harness()
    await expect(h.svc.runOnce('nope', 'manual')).rejects.toThrow(/unknown binding/)
    expect(h.svc.isRunning('nope')).toBe(false)
  })
})

describe('FollowService.supports —— 认不认这个盘（不是第二份名单）', () => {
  it('夸克认，别的不认', () => {
    const h = harness()
    expect(h.svc.supports('quark')).toBe(true)
    expect(h.svc.supports('baidu')).toBe(false)
  })
})

// `matchExternalFiles` 假身：文件名带 SxxExx 就给它判成 pending（置信度不够自动转存），
// 用来喂裁决器接线那组测试——真实场景就是这一档触发轮末裁决（spec §3 触发点 1）。
const pendingMatch = async (_set: MappingSet, files: { name: string; size: number }[]) => {
  const assignments = new Map<string, { rightFile: string; confidence: number; status: 'auto' | 'pending' }>()
  for (const f of files) {
    const m = /S(\d\d)E(\d\d)/.exec(f.name)
    if (m) assignments.set(`tmdb:261471:S${m[1]}E${m[2]}`, { rightFile: f.name, confidence: 0.4, status: 'pending' })
  }
  return { assignments, ambiguous: [], coverage: { left: { total: 0, matched: 0, ambiguous: 0, missing: 0 }, right: { total: 0, matched: 0, orphan: 0 }, missingEpisodes: [], orphanFiles: [] } }
}

describe('FollowService — 轮末裁决器接线（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 1）', () => {
  it('本轮判成 pending 的候选，归档之后打包交给裁决器；结果记进 rec.adjudicated，pending 的这一轮自己不转存', async () => {
    let captured: { setId: string; opts: { trigger: string; losers: boolean; followCandidates?: unknown } } | undefined
    const adjudicate = {
      run: vi.fn(async (setId: string, opts: { trigger: 'follow' | 'manual'; losers: boolean; followCandidates?: unknown }) => {
        captured = { setId, opts }
        return { runId: 'adj_1', asked: 1, applied: 1, rejected: 0, unsure: 0 }
      }),
    }
    const h = harness({ adjudicate, matchExternalFiles: pendingMatch })
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    const file = tf('S03/S03E14.mkv')
    h.shareTrees.set('p1', [file])
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(adjudicate.run).toHaveBeenCalledTimes(1)
    expect(captured!.setId).toBe('map_1')
    expect(captured!.opts).toMatchObject({ trigger: 'follow', losers: true })
    expect(captured!.opts.followCandidates).toEqual([{
      netdisk: 'quark', pwdId: 'p1', file,
      subdir: 'From Stream/tv-261471/S03',
      candidateLeftKeys: ['tmdb:261471:S03E14'],
    }])
    expect(rec.adjudicated).toEqual({ runId: 'adj_1', asked: 1, applied: 1, rejected: 0, unsure: 0 })
    // "宁可漏拿，不乱拿"仍然成立于本轮自己的转存那一步——pending 的候选不会被 saveFrom 转存,
    // 裁决器过闸之后才会转存（那一步已经在 AdjudicationService 自己的单测里钉住）。
    expect(h.saved).toEqual([])
  })

  it('裁决器没装配 → 那一步跳过，不算故障，既有轮次照常成立', async () => {
    const h = harness()
    h.svc.recordShare('map_1', 'quark', 'p1', undefined, 'manual')
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv')])
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(rec.adjudicated).toBeUndefined()
    expect(rec.errors).toEqual([])
  })
})

describe('先转存、过后才建绑定 —— 待认领分享', () => {
  it('落地目录命中绑定的 right.path → 这一轮开跑前领进账本，并当场回访它', async () => {
    const h = harness()
    // 转存那一刻还没有绑定可挂（用户没带 bind），只留下「落点 + 分享坐标」
    h.svc.recordPendingShare('quark', 'p1', 'abcd', '/quark/From Stream/tv-261471')
    h.shareTrees.set('p1', [tf('S03/S03E14.mkv')])
    expect(new ShareLedger(h.db).list('map_1')).toEqual([])   // 领之前账本里没有它（别用 view 问，它自己也会领）

    const rec = await h.svc.runOnce('map_1', 'manual')

    expect(rec.revisited.map((r) => r.pwdId)).toEqual(['p1'])
    expect(h.saved).toEqual([{ pwdId: 'p1', files: ['fid:S03/S03E14.mkv'], subdir: 'From Stream/tv-261471/S03' }])
    // 领进来的行带着提取码（丢了它，锁着的分享下一轮就列不出来）
    expect(h.svc.view('map_1').shares).toMatchObject([{ pwdId: 'p1', origin: 'manual' }])
    expect(new ShareLedger(h.db).get('map_1', 'quark', 'p1')!.passcode).toBe('abcd')
  })

  it('落地目录不是这条绑定的 → 一个字都不领（另一部作品的分享不能串到这儿）', async () => {
    const h = harness()
    h.svc.recordPendingShare('quark', 'p9', undefined, '/quark/From Stream/tv-999')
    h.shareTrees.set('p9', [tf('S03/S03E14.mkv')])
    const rec = await h.svc.runOnce('map_1', 'manual')
    expect(rec.revisited).toEqual([])
    expect(h.svc.view('map_1').shares).toEqual([])
  })
})

describe('FollowService.scanDue', () => {
  it('只跑 enabled 且 nextCheckAt 到期（或从没排过）的 tv 绑定', async () => {
    const h = harness()
    const set = h.store.get('map_1')!
    set.follow = { enabled: true, dryRuns: 0, nextCheckAt: '2099-01-01T00:00:00Z' }; h.store.save(set)
    expect(await h.svc.scanDue()).toEqual([])
    set.follow = { enabled: true, dryRuns: 0 }; h.store.save(set)
    expect(await h.svc.scanDue()).toEqual(['map_1'])
    set.follow = { enabled: false, dryRuns: 0 }; h.store.save(set)
    expect(await h.svc.scanDue()).toEqual([])
  })

  it('到期时间按当前分集现算，不信上一轮存下的那个数——上一轮之后集被补上/新集播出，节奏要跟着变', async () => {
    const h = harness()
    const set = h.store.get('map_1')!
    // 上一轮（20 小时前）存下的 nextCheckAt 在 4 小时后；但按**当前**分集算：E02 今天播出、还没拿到
    // → 新鲜缺集 → 自上一轮起 6 小时一查 → 早就到期了。
    const today = NOW.toISOString().slice(0, 10)
    set.entries = [
      { leftKey: 'tmdb:1399:S01E01', leftTitle: 'a', rightFile: 'S01E01.mkv', status: 'auto', airDate: '2026-01-01' },
      { leftKey: 'tmdb:1399:S01E02', leftTitle: 'b', rightFile: null, status: 'unmatched', airDate: today },
    ]
    const lastCheckAt = new Date(NOW.getTime() - 20 * 3600_000).toISOString()
    set.follow = { enabled: true, dryRuns: 0, lastCheckAt, nextCheckAt: new Date(NOW.getTime() + 4 * 3600_000).toISOString() }
    h.store.save(set)
    expect(await h.svc.scanDue()).toEqual(['map_1'])
  })

  it('现算出的到期时间比存下的晚 → 不跑，并把存下的数改成现算的（面板看到的才是真的）', async () => {
    const h = harness()
    const set = h.store.get('map_1')!
    set.entries = [{ leftKey: 'tmdb:1399:S01E01', leftTitle: 'a', rightFile: 'S01E01.mkv', status: 'auto', airDate: '2026-01-01' }]
    const lastCheckAt = new Date(NOW.getTime() - 3600_000).toISOString()
    set.follow = { enabled: true, dryRuns: 0, lastCheckAt, nextCheckAt: new Date(NOW.getTime() - 60_000).toISOString() }
    h.store.save(set)
    expect(await h.svc.scanDue()).toEqual([])
    // 无缺集无未播 → 30 天自 lastCheckAt
    expect(h.store.get('map_1')!.follow!.nextCheckAt).toBe(new Date(Date.parse(lastCheckAt) + 30 * 24 * 3600_000).toISOString())
  })
})
