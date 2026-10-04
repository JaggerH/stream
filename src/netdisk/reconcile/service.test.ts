import { describe, it, expect, vi } from 'vitest'
import { ReconcileService, ValidationError } from './service.ts'
import { openNetdiskDb } from '../db.ts'
import { SuggestionLog } from './suggestions.ts'
import { RunLedger } from './ledger.ts'
import type { MatchSpec } from '../types.ts'
import { OPENLIST_TRAITS } from '../shelf.ts'
import { MemoryShelf } from '../memory-shelf.ts'

/** 单文件版 fixture——只用来测 identityFor 的借规则/覆盖接线，不关心三分流分类本身。
 *  matchSpec 挂在假绑定上（identityRulesFromSpec 的取数口），identity 挂在 show 配置上
 *  （逐字段覆盖口，见 service.ts identityFor）。 */
function mkServiceForIdentity(binding: { matchSpec?: MatchSpec }, identity?: { titleStrip?: string[]; epNumRegex?: string }) {
  const alist = {
    listDirRecursive: vi.fn(async (path: string) => {
      if (path === '/src/dirA') return [{ name: '750.探秘人体特殊实验.mp3', size: 111 * 1024 * 1024, isDir: false }]
      return []
    }),
    mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    id: 'openlist', traits: OPENLIST_TRAITS,
  }
  const listLeft = vi.fn(async () => ({ entries: [], source: 'stream:test' }))
  const svc = new ReconcileService({
    db: openNetdiskDb(':memory:'),
    alist: alist as never,
    listLeft: listLeft as never,
    // 付费货架 = 绑定的落地目录；下架货架 = 下架 stream 扫的目录（P8：两个地址都不在 show 配置里）
    getBinding: vi.fn(() => ({ id: 'map_id', left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' }, matchSpec: binding.matchSpec }) as never),
    offlineDirOf: () => '/lib/下架',
    log: () => {},
  })
  svc.putConfig({ shows: [{
    id: 'yile', label: '怡楽播客', bindingId: 'map_id',
    sourceDirs: ['/src/dirA'],
    subShows: [], autoExecute: false,
    ...(identity ? { identity } : {}),
  }] })
  return svc
}

/** bindingId（= 假 streamId）→ 它的两个货架。整理配置里不再有这两个地址（P8）。 */
const SHELVES: Record<string, { claimed: string; offline: string }> = {
  map_02ec21: { claimed: '/lib/付费', offline: '/lib/下架' },
  map_a: { claimed: '/quark/From Stream/A/付费', offline: '/quark/From Stream/A/下架' },
  map_b: { claimed: '/quark/From Stream/B/付费', offline: '/quark/From Stream/B/下架' },
}

function mkService(over?: { autoExecute?: boolean }) {
  const db = openNetdiskDb(':memory:')
  const alist = {
    // listDirRecursive 的 name 是相对 root 的路径（AlistClient 契约）
    listDirRecursive: vi.fn(async (path: string) => {
      if (path === '/src/dirA') return [
        { name: '750.探秘人体特殊实验.mp3', size: 111 * 1024 * 1024, isDir: false },
        { name: '子目录/092.穿衣服.mp3', size: 222 * 1024 * 1024, isDir: false },
        // 非媒体：判定层的每条判据（时长、码率、认集身份）都是给音视频设的,这些一进池就是噪音。
        // 它们不该改变下面任何一条断言——扫描层就把它们挡住了。
        { name: '750.探秘人体特殊实验.ass', size: 5, isDir: false },
        { name: '子目录/cover.jpg', size: 6, isDir: false },
        { name: '子目录/说明.nfo', size: 7, isDir: false },
      ]
      return [] // 库目录首轮为空
    }),
    mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    id: 'openlist', traits: OPENLIST_TRAITS,
    rawUrl: vi.fn(async (p: string) => `http://raw${p}`),
  }
  // 时长：750 与权威那条一致（同一集，走标题命中付费）；092 的时长源站一条都没有 → 真下架
  const DURATIONS: Record<string, number> = { 'http://raw/src/dirA/750.探秘人体特殊实验.mp3': 1000, 'http://raw/src/dirA/子目录/092.穿衣服.mp3': 777 }
  const probeDuration = vi.fn(async (url: string) => DURATIONS[url] ?? null)
  const listLeft = vi.fn(async () => ({
    entries: [
      { title: '750.探秘人体特殊实验', durationS: 1000 },
      { title: '091.前一集', durationS: 1100 },
      { title: '093.后一集', durationS: 1200 },
    ],
    source: 'stream:test',
  }))
  const events = { append: vi.fn() }
  const svc = new ReconcileService({
    db,
    alist: alist as never,
    listLeft: listLeft as never,
    // 两个货架各有真相源（P8）：付费 = 绑定的落地目录，下架 = 那条下架 stream 扫的目录。
    // 按 bindingId 分别给——跨 show 的重叠校验要的正是"别人的货架在哪"。
    getBinding: vi.fn((id: string) => ({ id, left: { kind: 'stream', streamId: id, title: 'x' }, right: { path: SHELVES[id]?.claimed ?? '/lib/付费' } }) as never),
    offlineDirOf: (streamId: string) => SHELVES[streamId]?.offline ?? '/lib/下架',
    events, probeDuration, log: () => {},
  })
  svc.putConfig({ shows: [{
    id: 'yile', label: '怡楽播客', bindingId: 'map_02ec21',
    sourceDirs: ['/src/dirA'],
    subShows: [{ name: '玄关笔记', dir: '/lib/付费/玄关笔记', numPattern: '^\\d{2}\\.' }],
    autoExecute: over?.autoExecute ?? false,
  }] })
  return { svc, alist, events, db, listLeft }
}

describe('ReconcileService', () => {
  it('preview: 扫来源+权威出分流计数,零写操作', async () => {
    const { svc, alist } = mkService()
    const r = await svc.preview('yile')
    expect(r.counts).toMatchObject({ move: 2, deleteDup: 0, deleteLoser: 0, pending: 0, moveClaimed: 1, moveSecondary: 1 }) // 750→付费, 092→下架
    // 相对路径拼绝对：子目录文件的 src.path 是 /src/dirA/子目录/092.穿衣服.mp3
    expect(r.plan.map((a) => (a as { src: { path: string } }).src.path)).toContain('/src/dirA/子目录/092.穿衣服.mp3')
    expect(alist.move).not.toHaveBeenCalled()
    expect(alist.remove).not.toHaveBeenCalled()
    // 每条 plan action 都带 key（UI 豁免要按集身份传,不能传文件名）
    expect(r.plan.every((a) => typeof a.key === 'string' && a.key.length > 0)).toBe(true)
  })

  // 字幕/封面/说明档：**不参与匹配、不产生 hold 噪音、永不删、永不搬**，也不进账本行——
  // 它们压根没进池,`input` 计数不含它们,守恒仍然成立。活体证据:负缓存里 16 个"探不到时长"的
  // 全是 .ass/.srt/.jpg/.nfo/.zip,每轮都在问句里占一行。
  it('非媒体文件不进池:不进账本、零动作、执行时一步都不动', async () => {
    const { svc, alist } = mkService({ autoExecute: true })
    const r = await svc.preview('yile')
    const NON_MEDIA = ['.ass', '.jpg', '.nfo']
    expect(r.plan.filter((a) => NON_MEDIA.some((e) => a.src.path.endsWith(e)))).toEqual([])
    expect(r.ledger.rows.map((x) => x.path)).toEqual([
      '/src/dirA/750.探秘人体特殊实验.mp3',
      '/src/dirA/子目录/092.穿衣服.mp3',
    ])
    expect(r.ledger.counts.input).toBe(2)
    expect(r.ledger.conservation).toBe(true)

    await svc.execute('yile')
    for (const [, , names] of alist.move.mock.calls as unknown as [string, string, string[]][]) {
      expect(names.some((n) => NON_MEDIA.some((e) => n.endsWith(e)))).toBe(false)
    }
    expect(alist.remove).not.toHaveBeenCalled()
  })

  // 问句的另一半答案要真的能落下去。过去只有「不是这一集」——它只能把文件推走，推不出
  // "那它是哪一集"，于是匹配器判不出的那些只能一轮轮问下去。答「就是这一集」之后它变成
  // **匹配层的 pin**：在任何 stage 跑之前钉死这一对，绑定同步与归档器自动都尊重同一个答案。
  it('人答「就是这一集」→ 下一轮按认领走，不再进下架', async () => {
    const { svc } = mkService()
    const ORPHAN = '/src/dirA/子目录/092.穿衣服.mp3'
    const before = await svc.preview('yile')
    expect(before.ledger.rows.find((r) => r.path === ORPHAN)).toMatchObject({ verdict: 'offline', action: 'move:/lib/下架' })

    svc.setIsEpisode('091.前一集', ORPHAN)
    const after = await svc.preview('yile')
    expect(after.ledger.rows.find((r) => r.path === ORPHAN)).toMatchObject({ verdict: 'claimed', episode: '091.前一集', action: 'move:/lib/付费' })

    // 撤回 → 回到原样（问句必须可逆，否则点错一次就永久钉死）
    svc.setIsEpisode('091.前一集', ORPHAN, false)
    const undone = await svc.preview('yile')
    expect(undone.ledger.rows.find((r) => r.path === ORPHAN)).toMatchObject({ verdict: 'offline', action: 'move:/lib/下架' })
  })

  it('runScheduled 观察档: 只报告,零写操作,通知带 dedupeKey', async () => {
    const { svc, alist, events } = mkService({ autoExecute: false })
    const out = await svc.runScheduled()
    expect(alist.move).not.toHaveBeenCalled()
    expect(out.summary).toContain('观察')
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'reconcile:yile' }))
  })

  it('runScheduled autoExecute: 真执行 move', async () => {
    const { svc, alist } = mkService({ autoExecute: true })
    await svc.runScheduled()
    expect(alist.move).toHaveBeenCalled()
  })

  it('未知 show → 抛错，且把现有 id 摆出来（省掉调用方再列一轮清单）', async () => {
    const { svc } = mkService()
    await expect(svc.preview('nope')).rejects.toThrow(/unknown show: nope/)
    await expect(svc.preview('nope')).rejects.toThrow(/现有 show：yile/)
  })

  // 对话那一侧手里是**订阅 id**（`@` 引用插进草稿的是 `「名字」(stream:<id>)`），而这里要的是
  // show id。两者今天常常相等（show id 由 streamId 派生），但那是巧合不是契约——撞名时 show id
  // 会带数字后缀。活体实测（2026-08-25）：模型先拿显示名试、失败，再列一次清单，第三次才蒙对。
  it('show 参数也认订阅 id 和节目名——不然对话那一侧要瞎试三轮', async () => {
    const { svc } = mkService()
    // 这个夹具里绑定的 streamId 就等于 bindingId（见 mkService 的 getBinding），所以订阅 id
    // 是 'map_02ec21'——**它和 show id 'yile' 不相等**，正好是要守的那个形状。
    await expect(svc.preview('map_02ec21')).resolves.toBeTruthy() // 订阅 id
    await expect(svc.preview('怡楽播客')).resolves.toBeTruthy()    // 节目名
    await expect(svc.preview('yile')).resolves.toBeTruthy()       // show id 本身照旧
  })

  // 货架地址来自绑定/下架 stream（P8），不在这份配置里——校验拿现解出来的那两个地址去比。
  it('putConfig: sourceDir 与货架重叠 → 拒绝(ValidationError),不落盘', () => {
    const { svc } = mkService()
    const bad = {
      shows: [{
        id: 'yile', label: '怡楽播客', bindingId: 'map_02ec21',
        sourceDirs: ['/lib/付费/dirA'], // 落在付费货架之下——会把库内自身误判成"重复"
        subShows: [], autoExecute: false,
      }],
    }
    expect(() => svc.putConfig(bad)).toThrow(ValidationError)
    // 拒绝后原配置保持不变
    expect(svc.getConfig().shows[0].sourceDirs).toEqual(['/src/dirA'])
  })

  it('putConfig: show.identity 带不可编译正则 → 拒绝(ValidationError),不落盘', () => {
    const { svc } = mkService()
    const badTitleStrip = {
      shows: [{
        id: 'yile', label: '怡楽播客', bindingId: 'map_02ec21',
        sourceDirs: ['/src/dirA'],
        subShows: [], autoExecute: false,
        identity: { titleStrip: ['(unclosed'] },
      }],
    }
    expect(() => svc.putConfig(badTitleStrip)).toThrow(ValidationError)
    expect(svc.getConfig().shows[0].sourceDirs).toEqual(['/src/dirA'])

    const badEpNumRegex = {
      shows: [{
        id: 'yile', label: '怡楽播客', bindingId: 'map_02ec21',
        sourceDirs: ['/src/dirA'],
        subShows: [], autoExecute: false,
        identity: { epNumRegex: '(unclosed' },
      }],
    }
    expect(() => svc.putConfig(badEpNumRegex)).toThrow(ValidationError)
  })

  it('putConfig: 两个 show 认领同一来源目录 → 拒绝(ValidationError)', () => {
    const { svc } = mkService()
    const showA = { id: 'a', label: 'A', bindingId: 'map_a', sourceDirs: ['/quark/来自：分享/合集/甲'], subShows: [], autoExecute: false }
    const showB = { ...showA, id: 'b', label: 'B', bindingId: 'map_b' }
    expect(() => svc.putConfig({ shows: [showA, { ...showB, sourceDirs: ['/quark/来自：分享/合集/甲'] }] })).toThrow(ValidationError)
  })

  it('putConfig: show 的来源目录是另一 show 来源目录的祖先 → 拒绝', () => {
    const { svc } = mkService()
    const showA = { id: 'a', label: 'A', bindingId: 'map_a', sourceDirs: ['/quark/来自：分享/合集/甲'], subShows: [], autoExecute: false }
    const showB = { ...showA, id: 'b', label: 'B', bindingId: 'map_b' }
    expect(() => svc.putConfig({ shows: [showA, { ...showB, sourceDirs: ['/quark/来自：分享/合集'] }] })).toThrow(ValidationError)
  })

  it('putConfig: show 的来源目录落在另一 show 的库目录之下 → 拒绝', () => {
    const { svc } = mkService()
    const showA = { id: 'a', label: 'A', bindingId: 'map_a', sourceDirs: ['/quark/来自：分享/合集/甲'], subShows: [], autoExecute: false }
    const showB = { ...showA, id: 'b', label: 'B', bindingId: 'map_b' }
    expect(() => svc.putConfig({ shows: [showA, { ...showB, sourceDirs: ['/quark/From Stream/A/付费/子目录'] }] })).toThrow(ValidationError)
  })

  it('putConfig: 两个 show 目录互不相干 → 通过', () => {
    const { svc } = mkService()
    const showA = { id: 'a', label: 'A', bindingId: 'map_a', sourceDirs: ['/quark/来自：分享/合集/甲'], subShows: [], autoExecute: false }
    const showB = { ...showA, id: 'b', label: 'B', bindingId: 'map_b' }
    expect(() => svc.putConfig({ shows: [showA, { ...showB, sourceDirs: ['/quark/来自：分享/合集/乙'] }] })).not.toThrow()
  })

  it('identityFor 借绑定 matchSpec 的 titleStrip——换一条规则 key 跟着变(证明真的在借,不是走死代码)', async () => {
    const bare = await mkServiceForIdentity({}).preview('yile') // 无 matchSpec → identityRulesFromSpec(undefined) 走 DEFAULT
    const withRule = await mkServiceForIdentity({
      matchSpec: { version: 2, stages: [{ by: 'title', titleStrip: ['探秘'], threshold: 0.85, margin: 0.15 }] },
    }).preview('yile')
    expect(bare.plan[0].key).toContain('探秘') // DEFAULT_TITLE_STRIP 对这个文件名无信号,"探秘"原样留在 key 里
    expect(withRule.plan[0].key).not.toContain('探秘') // 绑定 matchSpec 的 titleStrip 被借来剥掉了它
    expect(withRule.plan[0].key).not.toBe(bare.plan[0].key)
  })

  // 运行账本（spec 2026-07-30-duplicate-episode-decision-design §4）——「错误也没记录」的机制性回答。
  describe('运行账本', () => {
    it('preview 的响应带账本：每个文件一行、守恒律自证、清单覆盖率在案', async () => {
      const { svc } = mkService()
      const { ledger } = await svc.preview('yile')
      expect(ledger.mode).toBe('preview')
      expect(ledger.show).toBe('yile')
      expect(ledger.counts).toEqual({ input: 2, claimed: 1, offline: 1, copy: 0, hold: 0, dup: 0, exempt: 0 })
      expect(ledger.conservation).toBe(true)
      expect(ledger.rows).toHaveLength(2)
      expect(ledger.rows.map((r) => r.path).sort()).toEqual(
        ['/src/dirA/750.探秘人体特殊实验.mp3', '/src/dirA/子目录/092.穿衣服.mp3'],
      )
      // ② 播单这一区的验证点：条数/付费数/时长覆盖率——骤降 = feed 变了，先停手
      expect(ledger.authority).toEqual({ entries: 3, paid: 0, withDuration: 3, needsSupply: 0 })
      expect(ledger.errors).toEqual([])
    })

    it('每次 preview/execute 各落一行 reconcile_runs', async () => {
      const { svc, db } = mkService()
      await svc.preview('yile')
      const exec = await svc.execute('yile')
      const rows = db.prepare('SELECT run_id, mode FROM reconcile_runs ORDER BY rowid').all() as { run_id: string; mode: string }[]
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.mode)).toEqual(['preview', 'execute'])
      expect(rows[1].run_id).toBe(exec.ledger.runId)
    })

    it('探测失败是账本里的一行,不是只进 stdout', async () => {
      const alist = {
        listDirRecursive: vi.fn(async (p: string) => (p === '/src/dirA' ? [{ name: '888.探不到.mp3', size: 8 * 1024 * 1024, isDir: false }] : [])),
        mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
        id: 'openlist', traits: OPENLIST_TRAITS,
        rawUrl: vi.fn(async (p: string) => `http://raw${p}`),
      }
      const svc = new ReconcileService({
        db: openNetdiskDb(':memory:'),
        alist: alist as never,
        listLeft: (async () => ({ entries: [{ leftKey: 'L1', title: '750.正片', durationS: 1000 }], source: 'stream:test' })) as never,
        getBinding: vi.fn(() => ({ id: 'b', left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' } }) as never),
        offlineDirOf: () => '/lib/下架',
        probeDuration: async () => null, // ffprobe 探不到（凭证/网络）
        log: () => {},
      })
      svc.putConfig({ shows: [{
        id: 'yile', label: '怡楽播客', bindingId: 'b',
        sourceDirs: ['/src/dirA'], subShows: [], autoExecute: false,
      }] })
      const { ledger } = await svc.preview('yile')
      expect(ledger.errors).toEqual([
        { path: '/src/dirA/888.探不到.mp3', stage: 'probe', detail: expect.stringContaining('探不到时长') },
      ])
      // 探不到 ≠ 时长不对：只能进 hold，绝不进下架
      expect(ledger.counts).toMatchObject({ hold: 1, offline: 0 })
    })

    it('AList 报错进账本的 errors（execute 档）', async () => {
      const { svc, alist } = mkService()
      alist.move.mockRejectedValue(new Error('403 名字冲突'))
      const res = await svc.execute('yile')
      expect(res.errors.length).toBeGreaterThan(0)
      expect(res.ledger.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'move', detail: expect.stringContaining('403 名字冲突') }),
      ]))
    })
  })

  it('show.identity 覆盖优先于绑定 matchSpec(逐字段替换,不是合并)', async () => {
    const svc = mkServiceForIdentity(
      { matchSpec: { version: 2, stages: [{ by: 'title', titleStrip: ['探秘'], threshold: 0.85, margin: 0.15 }] } },
      { titleStrip: ['人体'] },
    )
    const r = await svc.preview('yile')
    // identity 覆盖口设了 titleStrip → 绑定那条 "探秘" 整个不再生效(替换语义,非并集)
    expect(r.plan[0].key).toContain('探秘')
    expect(r.plan[0].key).not.toContain('人体')
  })
})

/**
 * 影视一键去重 = 播客整理的**退化配置**（无暂存区、无第二货架），不是平行实现：合成一份临时
 * show 配置走同一条 planFor/preview/execute（spec 2026-07-31 §2）。
 */
describe('任意绑定的原地整理（previewBinding/executeBinding）', () => {
  const EP4K = 'Show.S01E01.2160p.mkv'
  const EP1080 = 'Show.S01E01.1080p.mkv'

  function mkBindingSvc() {
    const db = openNetdiskDb(':memory:')
    const seen: string[] = []
    const alist = {
      listDirRecursive: vi.fn(async (p: string) => {
        seen.push(p)
        return p === '/lib/剧集/某剧'
          ? [{ name: EP4K, size: 3_000_000_000, isDir: false }, { name: EP1080, size: 1_000_000_000, isDir: false }]
          : []
      }),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      id: 'openlist', traits: OPENLIST_TRAITS,
      rawUrl: vi.fn(async (p: string) => `http://raw${p}`),
    }
    const svc = new ReconcileService({
      db,
      alist: alist as never,
      // TMDb 分集索引不给时长——两份的时长由探测给（同一集,两个压制,长度相同）
      listLeft: (async () => ({ entries: [{ leftKey: 'tmdb:9:S01E01', title: '第 1 集' }], source: 'tmdb:9' })) as never,
      getBinding: vi.fn((id: string) => ({
        id, left: { kind: 'tmdb', id: '9', media: 'tv', title: '某剧' }, right: { path: '/lib/剧集/某剧' },
      }) as never),
      offlineDirOf: () => undefined, // 影视没有下架 stream
      probeDuration: async () => 3600,
      log: () => {},
    })
    return { svc, alist, seen }
  }

  // 这是 **tmdb 剧集**绑定，所以多季归档模式开着（spec 2026-09-03）：留下的那份不止"留着"，
  // 它还要归位到 `<root>/S01`。名字本来就带着正确的 `S01E01`，所以不改名（`newName` 缺席）。
  it('同集两个清晰度 → 1080p 判 delete-loser、4K 归位到季目录;只扫绑定目录', async () => {
    const { svc, seen } = mkBindingSvc()
    const r = await svc.previewBinding('map_x')
    expect(seen).toEqual(['/lib/剧集/某剧'])
    expect(r.counts).toMatchObject({ move: 1, deleteDup: 0, deleteLoser: 1, moveClaimed: 1, moveSecondary: 0 })
    expect(r.plan).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'delete-loser',
        src: expect.objectContaining({ path: `/lib/剧集/某剧/${EP1080}` }),
        keptPath: `/lib/剧集/某剧/${EP4K}`,
      }),
      expect.objectContaining({
        kind: 'move', dstDir: '/lib/剧集/某剧/S01',
        src: expect.objectContaining({ path: `/lib/剧集/某剧/${EP4K}` }),
      }),
    ]))
    // 账本照落,show 记 binding:<id> 以便回查
    expect(r.ledger.show).toBe('binding:map_x')
    expect(r.ledger.conservation).toBe(true)
  })

  it('executeBinding 真删落选那份', async () => {
    const { svc, alist } = mkBindingSvc()
    const res = await svc.executeBinding('map_x')
    expect(alist.remove).toHaveBeenCalledWith('/lib/剧集/某剧', [EP1080])
    expect(res.deleted).toBe(1)
    // 剧集绑定的归档要把留下那份搬进季目录——删与归位在同一轮里做完。
    expect(alist.move).toHaveBeenCalledWith('/lib/剧集/某剧', '/lib/剧集/某剧/S01', [EP4K])
  })

  // 删不可逆，比搬运高一档：**定时轮永不自动删质量落选者**，哪怕 autoExecute 开着（spec §5）。
  // 判定照出（下一轮预览里还在），只是手不动——人在预览里点过确认才删。
  it('runScheduled autoExecute=true 也不删 delete-loser;显式 execute 才删', async () => {
    const { svc, alist } = mkBindingSvc()
    svc.putConfig({ shows: [{ id: 's', label: '某剧', bindingId: 'map_x', sourceDirs: [], subShows: [], autoExecute: true }] })
    await svc.runScheduled()
    expect(alist.remove).not.toHaveBeenCalled()

    const res = await svc.execute('s')
    expect(alist.remove).toHaveBeenCalledWith('/lib/剧集/某剧', [EP1080])
    expect(res.deleted).toBe(1)
  })

  it('绑定不存在 → 抛错', async () => {
    const db = openNetdiskDb(':memory:')
    const svc = new ReconcileService({
      db,
      alist: { listDirRecursive: vi.fn(async () => []), mkdir: vi.fn(), move: vi.fn(), remove: vi.fn(), id: 'openlist', traits: OPENLIST_TRAITS } as never,
      listLeft: (async () => ({ entries: [], source: 'stream:test' })) as never,
      getBinding: () => undefined,
      offlineDirOf: () => undefined,
      log: () => {},
    })
    await expect(svc.previewBinding('nope')).rejects.toThrow(/unknown binding/)
  })
})

/**
 * 两个货架的地址来自各自的真相源（spec §6 P8）：
 *  - 付费货架 = 绑定的落地目录（绑定负责给收费集补音频）
 *  - 下架货架 = 该订阅那条「下架 stream」扫的目录（下架集本身就是一条扫网盘的 stream）
 * 整理只持有来源目录。**存第二份拷贝就会分家**：别处改了地址，整理这边收不到通知，
 * 于是从一个目录读、往另一个目录搬，而且不报错。
 */
describe('货架地址从真相源现解（P8）', () => {
  /** `offline` 传函数 = 地址可以在配置写完之后再变（它本来就住在别处，随时会被改）。 */
  function mk(opts: { claimed?: string; offline?: string | (() => string | undefined); sourceDirs?: string[]; leftKind?: 'stream' | 'tmdb' }) {
    const offlineOf = () => (typeof opts.offline === 'function' ? opts.offline() : opts.offline)
    const db = openNetdiskDb(':memory:')
    const seen: string[] = []
    const alist = {
      listDirRecursive: vi.fn(async (p: string) => { seen.push(p); return [] }),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      id: 'openlist', traits: OPENLIST_TRAITS,
    }
    const svc = new ReconcileService({
      db,
      alist: alist as never,
      listLeft: (async () => ({ entries: [], source: 'stream:test' })) as never,
      getBinding: vi.fn(() => {
        // tmdb 绑定（影视）：没有 streamId，也就没有第二货架——那不是缺配置，见 shelvesOf。
        const left = opts.leftKind === 'tmdb'
          ? { kind: 'tmdb', id: '9', media: 'tv', title: '某剧' }
          : { kind: 'stream', streamId: 's1', title: 'x' }
        return (opts.claimed === undefined
          ? { id: 'b', left }
          : { id: 'b', left, right: { path: opts.claimed } }) as never
      }),
      offlineDirOf: () => offlineOf(),
      log: () => {},
    })
    svc.putConfig({ shows: [{
      id: 'yile', label: '怡楽播客', bindingId: 'b',
      sourceDirs: opts.sourceDirs ?? ['/src/dirA'], subShows: [], autoExecute: false,
    }] })
    return { svc, seen, db }
  }

  it('扫的就是绑定的落地目录和下架 stream 的目录——配置里没有这两个地址', async () => {
    const { svc, seen } = mk({ claimed: '/quark/From Stream/怡楽播客/付费', offline: '/quark/From Stream/怡楽播客/下架' })
    await svc.preview('yile')
    expect(seen).toEqual(expect.arrayContaining([
      '/src/dirA', '/quark/From Stream/怡楽播客/付费', '/quark/From Stream/怡楽播客/下架',
    ]))
    expect(Object.keys(svc.getConfig().shows[0])).not.toContain('libPaid')
    expect(Object.keys(svc.getConfig().shows[0])).not.toContain('libOffline')
  })

  // 存量配置里那两个字段是货架地址的旧拷贝——写回时剥掉，别留第二个真相源。
  it('putConfig 剥掉存量的 libPaid/libOffline，不写进库', () => {
    const { svc, db } = mk({ claimed: '/lib/付费', offline: '/lib/下架' })
    svc.putConfig({ shows: [{
      id: 'yile', label: '怡楽播客', bindingId: 'b', sourceDirs: ['/src/dirA'],
      libPaid: '/老地址/付费', libOffline: '/老地址/下架', // 存量数据里带着
      subShows: [], autoExecute: false,
    } as never] })
    const stored = (db.prepare('SELECT json FROM reconcile_shows').get() as { json: string }).json
    expect(stored).not.toContain('老地址')
    expect(stored).not.toContain('libPaid')
  })

  // 没有下架 stream = 没有下架货架。**不许拿配置里的路径顶上**：没人扫的目录，
  // 文件搬进去就从用户眼前消失了（不可播、不在任何清单里）。
  it('订阅没有下架 stream → 预览直接拒绝并指路，不搬任何东西', async () => {
    const { svc, seen } = mk({ claimed: '/lib/付费', offline: undefined })
    await expect(svc.preview('yile')).rejects.toThrow(/还没有「下架」来源/)
    expect(seen).toEqual([]) // 一个目录都没扫——地址不全就不该开工
  })

  it('绑定没有落地目录 → 付费货架无处可去，同样拒绝', async () => {
    const { svc } = mk({ claimed: undefined, offline: '/lib/下架' })
    await expect(svc.preview('yile')).rejects.toThrow(/没有落地目录/)
  })

  // 影视绑定（tmdb 左侧）压根没有「下架」这个概念——第二货架缺席是**正常态**，不是缺配置。
  // 把它当错误抛，影视的一键去重就永远跑不起来。
  it('tmdb 绑定：没有下架 stream 也照常解出货架,secondary 缺席、不报错', async () => {
    const { svc, seen } = mk({ claimed: '/lib/剧集/某剧', offline: undefined, leftKind: 'tmdb', sourceDirs: [] })
    expect(svc.shelvesOf(svc.getConfig().shows[0])).toEqual({ claimed: '/lib/剧集/某剧' })
    await svc.preview('yile')
    expect(seen).toEqual(['/lib/剧集/某剧']) // 只扫绑定目录:没有暂存区、没有第二货架
  })

  // 活体里真有这形状：一条订阅的 alist 成员指着来源暂存区而不是下架货架。
  // 那样整理会把文件搬进自己下一轮要扫的地方来回打转，那条 stream 还会把没整理的暂存文件当正式条目。
  it('下架 stream 指到来源目录 → 写入时就拒绝', () => {
    expect(() => mk({ claimed: '/lib/付费', offline: '/src/dirA', sourceDirs: ['/src/dirA'] }))
      .toThrow(/来源是待搬走的暂存区/)
  })

  // 货架地址住在别处（绑定 / 下架 stream），配置写完之后随时可能被改成不能用的——
  // 写入期那道闸门管不到这种情况，所以运行前必须再查一次。
  it('配置写好之后地址才被改到来源目录 → 运行前拦下，一个目录都不扫', async () => {
    let offline: string | undefined = '/lib/下架'
    const { svc, seen } = mk({ claimed: '/lib/付费', offline: () => offline, sourceDirs: ['/src/dirA'] })
    offline = '/src/dirA' // 有人把那条 stream 改到了暂存区
    await expect(svc.preview('yile')).rejects.toThrow(/来源是待搬走的暂存区/)
    expect(seen).toEqual([])
  })

  // 配置可以先于绑定/下架 stream 存在（用户先填来源目录很正常）——写入放行，
  // 但界面要看得见"还差什么"，所以读模型把原因带上。
  it('地址还解不出来时：配置写得进去，读模型带出问题原因', () => {
    const { svc } = mk({ claimed: '/lib/付费', offline: undefined })
    const view = svc.getConfigView()
    expect(view.shows[0].shelves).toBeNull()
    expect(view.shows[0].shelvesProblem).toMatch(/还没有「下架」来源/)
  })

  it('地址齐全时：读模型把两个货架原样给前端', () => {
    const { svc } = mk({ claimed: '/lib/付费', offline: '/lib/下架' })
    expect(svc.getConfigView().shows[0].shelves).toEqual({ claimed: '/lib/付费', secondary: '/lib/下架' })
  })
})

/**
 * 权威清单的只读查询口。存在的理由是**取证时别再去读 `/api/items`**——那条路上挂着播放投影
 * （付费集在网盘没配上 → 整条音频换成封面图，时长与 track_id 消失），照它判"库里存了什么"
 * 必然得出假结论（真事故：21 条付费集被误判"无时长"）。这里走的是 planFor 同一条取数路径。
 */
describe('ReconcileService.authority', () => {
  const ENTRIES = [
    { leftKey: 'item:a', title: '750.探秘人体特殊实验', durationS: 1000, paid: true, needsSupply: true },
    { leftKey: 'item:b', title: '091.前一集', paid: true, needsSupply: true }, // 付费但探不到时长
    { leftKey: 'item:c', title: '093.后一集', durationS: 1200, paid: false, needsSupply: false }, // 源站自己能播
  ]
  const STATS = { entries: 3, paid: 2, withDuration: 2, needsSupply: 2 }

  function mkAuthoritySvc(listing: { entries: typeof ENTRIES; truncated?: true; source: string } = { entries: ENTRIES, source: 'stream:s1' }) {
    const listLeft = vi.fn(async () => listing)
    const alist = {
      listDirRecursive: vi.fn(async () => []),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      id: 'openlist', traits: OPENLIST_TRAITS,
    }
    const svc = new ReconcileService({
      db: openNetdiskDb(':memory:'),
      alist: alist as never,
      listLeft: listLeft as never,
      getBinding: vi.fn((id: string) => ({ id, left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' } }) as never),
      offlineDirOf: () => '/lib/下架',
      log: () => {},
    })
    svc.putConfig({ shows: [{ id: 'yile', label: '怡楽播客', bindingId: 'map_id', sourceDirs: ['/src/dirA'], subShows: [], autoExecute: false }] })
    return { svc, listLeft, alist }
  }

  it('原样返回清单 + 账本同口径的三个数；只读（不扫网盘）', async () => {
    const { svc, listLeft, alist } = mkAuthoritySvc()
    const view = await svc.authority('yile')
    expect(view.entries).toEqual(ENTRIES)
    expect(view.stats).toEqual(STATS)
    expect(listLeft).toHaveBeenCalledWith({ kind: 'stream', streamId: 's1', title: '怡乐' })
    expect(alist.listDirRecursive).not.toHaveBeenCalled() // 不扫网盘、不规划、不落账
  })

  // 清单自己申报的「我全不全」必须原样穿过视图：下游的健康闸拿它决定敢不敢把"清单里没有它"
  // 当下架的结论。半路吃掉不会有任何东西报警——表现是闸门永远看到"清单是全的"。
  it('清单的 truncated/source 原样带进视图（三扇门同一份）', async () => {
    const { svc } = mkAuthoritySvc({ entries: ENTRIES, truncated: true, source: 'stream:s1' })
    for (const view of [await svc.authority('yile'), await svc.authorityForBinding('map_1'), await svc.authorityForStream('s1')]) {
      expect(view.truncated).toBe(true)
      expect(view.source).toBe('stream:s1')
    }
  })

  it('清单没截断 → 视图里也不带 truncated 字段（缺席，不是 false）', async () => {
    const { svc } = mkAuthoritySvc()
    expect('truncated' in (await svc.authority('yile'))).toBe(false)
  })

  // 与 preview 走的是同一条取数路径——两条路各取各的就是两份权威，迟早分家。
  it('与 preview 的账本口径一致', async () => {
    const { svc } = mkAuthoritySvc()
    const [view, preview] = [await svc.authority('yile'), await svc.preview('yile')]
    expect(view.stats).toEqual(preview.ledger.authority)
  })

  it('未知 show / 未知绑定 → 抛错（路由层映射 404）', async () => {
    const { svc } = mkAuthoritySvc()
    await expect(svc.authority('nope')).rejects.toThrow(/unknown show/)
  })

  it('按绑定取（影视原地模式没有 show 配置）', async () => {
    const { svc } = mkAuthoritySvc()
    expect((await svc.authorityForBinding('map_1')).stats).toEqual(STATS)
  })

  /**
   * 按订阅取存在的全部理由：回答「这条订阅该用整理还是该挂载」，而那一刻**什么都还没配**。
   * 所以它必须在没有 show 配置、也没有绑定时照样出数——真去查配置就等于答不了这一问。
   */
  it('按订阅取：不碰 show 配置、不碰绑定，直接问 listLeft 要这条流的清单', async () => {
    const { svc, listLeft } = mkAuthoritySvc()
    const view = await svc.authorityForStream('s-未配过整理')
    expect(view.stats).toEqual(STATS)
    expect(listLeft).toHaveBeenCalledWith({ kind: 'stream', streamId: 's-未配过整理', title: '' })
  })

  it('按订阅取：needsSupply 就是「源站放不出来」的集数——整理成不成立看它', async () => {
    const listLeft = vi.fn(async () => ({
      entries: [
        { leftKey: 'item:a', title: '第一集', durationS: 10 }, // needsSupply 未标 → 不计
        { leftKey: 'item:b', title: '第二集', durationS: 20 },
      ],
      source: 'stream:s2',
    }))
    const svc = new ReconcileService({
      db: openNetdiskDb(':memory:'),
      alist: { listDirRecursive: vi.fn(async () => []), mkdir: vi.fn(), move: vi.fn(), remove: vi.fn(), id: 'openlist', traits: OPENLIST_TRAITS } as never,
      listLeft: listLeft as never,
      getBinding: vi.fn(() => undefined) as never,
      offlineDirOf: () => undefined,
      log: () => {},
    })
    expect((await svc.authorityForStream('s2')).stats.needsSupply).toBe(0)
  })
})

/**
 * **`needsSupply` 要真的从清单接到归档器**（`LeftEntry` → `AuthorityEntry`）。这一段接线漏掉不会
 * 让任何单测变红——`plan.ts` 自己的用例直接构造 `AuthorityEntry`，`left-from-stream` 的用例只看
 * `LeftEntry`，中间这一跳两头都不管。漏了的表现是**静默退回保守档**：清单明说"源站自己放得出"，
 * 归档器却当它答不上来、一律留着。所以这条用例走完整取数路径，只钉那一位有没有过来。
 */
describe('needsSupply 从清单接到归档器（漏接线不会有别的用例报警）', () => {
  const mkSvc = (needsSupply?: boolean) => {
    const alist = {
      listDirRecursive: vi.fn(async (path: string) =>
        path === '/src/dirA' ? [{ name: '750.探秘人体特殊实验.mp3', size: 111 * 1024 * 1024, isDir: false }] : []),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      id: 'openlist', traits: OPENLIST_TRAITS,
    }
    const svc = new ReconcileService({
      db: openNetdiskDb(':memory:'),
      alist: alist as never,
      listLeft: (async () => ({
        entries: [{ leftKey: 'item:a', title: '750.探秘人体特殊实验', ...(needsSupply != null ? { needsSupply } : {}) }],
        source: 'stream:s1',
      })) as never,
      getBinding: vi.fn((id: string) => ({ id, left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' } }) as never),
      offlineDirOf: () => '/lib/下架',
      log: () => {},
    })
    svc.putConfig({ shows: [{ id: 'yile', label: '怡楽播客', bindingId: 'map_id', sourceDirs: ['/src/dirA'], subShows: [], autoExecute: false }] })
    return svc
  }

  it('清单说不用供货 → 归档器判 delete-redundant', async () => {
    const { plan: actions } = await mkSvc(false).preview('yile')
    expect(actions).toEqual([expect.objectContaining({ kind: 'delete-redundant' })])
  })

  it('清单说要供货 → 照常搬进货架', async () => {
    const { plan: actions } = await mkSvc(true).preview('yile')
    expect(actions).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费' })])
  })

  it('清单答不上来（这一位缺席）→ 按要供货办，绝不删', async () => {
    const { plan: actions } = await mkSvc(undefined).preview('yile')
    expect(actions.some((a) => a.kind === 'delete-redundant')).toBe(false)
    expect(actions).toEqual([expect.objectContaining({ kind: 'move', dstDir: '/lib/付费' })])
  })
})

/**
 * 「AI 建议 vs 人最终选择」的对照账本，**回填接线在写决定那一步上**——不是挂在某个 HTTP 入口上。
 * 挂在入口上的话，走另一条路（MCP 的 `reconcile_decide`、将来任何调用方）写下的决定就不进账，
 * 而账本漏掉的恰恰是最该看的那些。
 *
 * AI 那半截**已经没有生产写入方了**（判读搬进了对话），所以这里的建议行由 `SuggestionLog`
 * 直接种下——存量库里就是这样的行，人现在答的也正是它们。
 */
describe('决定回填对照账本', () => {
  const mkSvc = () => {
    const db = openNetdiskDb(':memory:')
    const svc = new ReconcileService({
      db,
      alist: { listDirRecursive: vi.fn(async () => []), mkdir: vi.fn(), move: vi.fn(), remove: vi.fn(), id: 'openlist', traits: OPENLIST_TRAITS } as never,
      listLeft: vi.fn(async () => ({ entries: [], source: 'stream:test' })) as never,
      getBinding: vi.fn(() => undefined) as never,
      offlineDirOf: () => undefined,
      log: () => {},
    })
    return { svc, log: new SuggestionLog(db) }
  }

  it('认领同一集 → 记成一致', () => {
    const { svc, log } = mkSvc()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    svc.setIsEpisode('L1', '/lib/a.mp3')
    expect(svc.listSuggestions().summary).toMatchObject({ countable: 1, agreed: 1, disagreed: 0 })
  })

  it('认领了别的集 → 记成分歧（这一格才是决定放不放开的实证）', () => {
    const { svc, log } = mkSvc()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1', 'L2'] })
    svc.setIsEpisode('L2', '/lib/a.mp3')
    expect(svc.listSuggestions().summary).toMatchObject({ agreed: 0, disagreed: 1 })
  })

  it('撤回不写账本——它不改变当时那一次的选择', () => {
    const { svc, log } = mkSvc()
    log.record({ path: '/lib/a.mp3', verdict: 'is-episode', leftKey: 'L1', quotes: 1, candidates: ['L1'] })
    svc.setIsEpisode('L1', '/lib/a.mp3', false)
    expect(svc.listSuggestions().summary).toMatchObject({ open: 1, agreed: 0 })
  })

  it('note 透传给决定账本；revokeAdjudication 按 runId 前缀整批撤回，不动人工决定', () => {
    const { svc } = mkSvc()
    svc.setIsEpisode('L1', '/lib/a.mp3', true, 'llm:run_1')
    svc.setNotEpisode('L2', '/lib/b.mp3', true, 'llm:run_1')
    svc.setIsEpisode('L3', '/lib/c.mp3') // 人裁，无 note
    expect(svc.revokeAdjudication('run_1')).toBe(2)
    // L1（is-episode）与 L2（not-episode）被撤，L3（人裁）没被殃及
    expect(Object.keys(svc.listDecisions().isEpisodes)).toHaveLength(1)
    expect(Object.keys(svc.listDecisions().notEpisodes)).toHaveLength(0)
  })
})

/**
 * 权威清单的健康闸接进定时轮（spec 2026-09-03 §2.1）。闸只在定时轮上——手动执行是那一轮的人眼确认。
 *
 * 闸住的那一轮不是"跳过"：照样规划、照样落一条 `preview` 账（每条本该执行的动作都在里面），
 * 只是一个文件都不动。用户在预览里看得见"本来会动、因为清单变了没动"。
 */
describe('runScheduled 的权威清单健康闸', () => {
  /** mkService 的 listLeft 是 vi.fn，但推断返回类型钉死在夹具那三条上；这里要喂形状不同的清单
   *  （带 needsSupply / truncated），所以放宽成"只用得上排队这一个方法"。 */
  type Queueable = { mockResolvedValueOnce: (v: unknown) => unknown }

  const full = { entries: [
    { title: '750.探秘人体特殊实验', durationS: 1000, needsSupply: true },
    { title: '091.前一集', durationS: 1100, needsSupply: true },
    { title: '093.后一集', durationS: 1200, needsSupply: true },
    { title: '094.再后一集', durationS: 1300, needsSupply: true },
    { title: '095.又一集', durationS: 1400, needsSupply: true },
  ], source: 'stream:map_02ec21' }
  /** 少 1 条 = 20%，过 SHRINK_RATIO。掉的是最后一条，750 那条（本轮唯一会被认领的）还在。 */
  const shrunk = { ...full, entries: full.entries.slice(0, 4) }

  it('清单缩水 → 本轮只记 preview 行、带 gated、一个文件都不动；通知抬头写差异', async () => {
    const { svc, alist, events, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled() // 第一轮：建立基线，会真搬
    alist.move.mockClear(); alist.remove.mockClear(); events.append.mockClear()

    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled()
    expect(alist.move).not.toHaveBeenCalled()
    expect(alist.remove).not.toHaveBeenCalled()
    // detail 这一格的 counts 记的是"本该动的"、autoExecute 记的是配置——两者在闸住那一轮和真执行
    // 那一轮一模一样。只读 detail 的人得能分出来，所以形状自己要说"这轮没跑"。
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBe('authority-shrink')
    const last = svc.listRuns({ show: 'yile', limit: 1 })[0]!
    expect(last.mode).toBe('preview')
    expect(last.gated).toMatchObject({ reason: 'authority-shrink' })
    // 闸住不等于不记账：本该执行的那几条动作照样在这一轮的账本行里。
    expect(last.rows.some((r) => r.action.startsWith('move:'))).toBe(true)
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warn',
      title: expect.stringContaining('清单变了'),
    }))
  })

  // 基线 = **最近一轮被接受的**运行，不是"最近一轮运行"。这条守的是最容易被面板顺手打掉的那一格：
  // 用户在整理面板里展开一个节目，前端就 POST 一次手动 preview——那一轮把缩水后的数字记进账本，
  // 下一次定时轮拿它当基线，缩水 vs 缩水 = 没变化 = 放行，闸等于没有。
  it('手动预览记下的缩水数字不当基线 —— 面板展开一次不该把闸打掉', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled() // 定时轮、没被闸 → 这一轮才是基线
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    await svc.preview('yile') // 面板展开：手动 preview，记的是缩水后的数字
    alist.move.mockClear()

    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled()
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBe('authority-shrink')
    expect(alist.move).not.toHaveBeenCalled()
  })

  // 闸住的那一轮也不是基线——否则"缩水 → 闸一次 → 下一轮拿闸住的数字当基线 → 放行"，
  // 一次真实的永久缩水只被拦住一晚，第二晚照样整库搬空。现在它每晚都拦，直到人工确认。
  it('闸住之后不会自动恢复：同一份缩水清单下一轮仍闸', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled()
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    await svc.runScheduled() // 闸
    alist.move.mockClear()
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled()
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBe('authority-shrink')
    expect(svc.listRuns({ show: 'yile', limit: 1 })[0]!.gated).toMatchObject({ reason: 'authority-shrink' })
    expect(alist.move).not.toHaveBeenCalled()
  })

  // 恢复的唯一出口 = 人工执行一轮（人看过预览、点了执行）。它记下的清单成为新基线。
  it('人工执行一轮 → 缩水成为新基线，下一轮定时恢复执行', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled()
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    await svc.runScheduled() // 闸
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    await svc.execute('yile') // 人工确认
    alist.move.mockClear()

    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled()
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBeUndefined()
    expect(svc.listRuns({ show: 'yile', limit: 1 })[0]!.gated).toBeUndefined()
    // 「恢复执行」得真的执行——只断言 gated 没了，闸改成"永远只记账"也照样绿。
    expect(alist.move).toHaveBeenCalled()
  })

  // 老账本行没有 trigger（字段后加的）——按"手动"读，永不当基线。把它读成 scheduled 就等于
  // 拿一轮来路不明的数字当尺子，而这类行在存量库里全都是。
  it('没有 trigger 的老账本行不当基线', async () => {
    const { svc, db, alist, listLeft } = mkService({ autoExecute: true })
    new RunLedger(db).append({
      runId: 'legacy01', at: new Date().toISOString(), show: 'yile', mode: 'preview',
      counts: { input: 0, claimed: 0, offline: 0, copy: 0, hold: 0, dup: 0, exempt: 0 },
      conservation: true,
      authority: { entries: 500, paid: 0, withDuration: 0, needsSupply: 0 },
      rows: [], errors: [],
    })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled() // 500 → 4 是天崩式缩水，但那条老行不是基线 → 无 prev → 放行
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBeUndefined()
    expect(alist.move).toHaveBeenCalled()
  })

  // 空清单是绝对地板：库里每一份文件都会被判"清单里没有它"，整库一次搬空。首轮就塌成 0 时
  // 没有基线可比，相对比较看不见它。
  it('清单塌成 0 条 → 闸，哪怕没有基线', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce({ entries: [], source: 'stream:map_02ec21' })
    const out = await svc.runScheduled()
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBe('authority-empty')
    expect(alist.move).not.toHaveBeenCalled()
  })

  // 基线不设回看窗：每被闸一晚就多一条"不算数"的行，窗口一有上限，基线迟早被这些行挤出去，
  // 于是 prev 变成 undefined、闸自己放行——**拦得越久越容易失守**，而且没有任何一处会喊。
  it('连闸 25 晚之后仍然闸（基线不会被挤出回看窗）', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled() // 唯一一条被接受的行，此后一直往前退
    for (let i = 0; i < 25; i++) {
      ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
      await svc.runScheduled()
    }
    alist.move.mockClear()
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(shrunk)
    const out = await svc.runScheduled()
    expect((out.detail as Record<string, { gated?: string }>).yile.gated).toBe('authority-shrink')
    expect(alist.move).not.toHaveBeenCalled()
  })

  // 闸住 + 本来也没有任何动作 = 没有任何东西被拦下来，没什么可告警的。空清单那一档天天如此
  // （一条刚建、还没采集的订阅就长这样），逐夜报 warn 是纯噪音，而噪音会把真的那一条淹掉。
  it('闸住但本轮一个动作都没有 → 不发 warn，账还是照落、summary 照说', async () => {
    const alist = {
      listDirRecursive: vi.fn(async () => []),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      id: 'openlist', traits: OPENLIST_TRAITS,
    }
    const events = { append: vi.fn() }
    const svc = new ReconcileService({
      db: openNetdiskDb(':memory:'),
      alist: alist as never,
      listLeft: (async () => ({ entries: [], source: 'stream:test' })) as never,
      getBinding: vi.fn(() => ({ id: 'map_id', left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' } }) as never),
      offlineDirOf: () => '/lib/下架',
      events, log: () => {},
    })
    svc.putConfig({ shows: [{ id: 'yile', label: '怡楽播客', bindingId: 'map_id', sourceDirs: ['/src/dirA'], subShows: [], autoExecute: true }] })

    const out = await svc.runScheduled()
    expect(out.summary).toContain('清单变了')
    expect(svc.listRuns({ show: 'yile', limit: 1 })[0]!.gated).toMatchObject({ reason: 'authority-empty' })
    expect(events.append).not.toHaveBeenCalled()
  })

  it('truncated 的清单 → 闸，且第一轮就闸（不需要上一轮）', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce({ ...full, truncated: true })
    await svc.runScheduled()
    expect(alist.move).not.toHaveBeenCalled()
    expect(svc.listRuns({ show: 'yile', limit: 1 })[0]!.gated).toMatchObject({ reason: 'authority-truncated' })
  })

  it('手动 execute 不过闸', async () => {
    const { svc, alist, listLeft } = mkService({ autoExecute: true })
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce(full)
    await svc.runScheduled()
    ;(listLeft as unknown as Queueable).mockResolvedValueOnce({ ...full, entries: full.entries.slice(0, 2) })
    alist.move.mockClear()
    await svc.execute('yile')
    expect(alist.move).toHaveBeenCalled()
  })
})

/**
 * 货架自述表从**货架自己**接到规划器（`planFor` 的 `shelf: this.deps.alist.traits`）。
 * 这一跳漏了不会有别的用例报警：规划器那一侧收到 undefined 只会静默按 OpenList 走，
 * 而两侧各自的用例都照常绿（同 `needsSupply` 那条的形状）。所以走完整取数路径，
 * 只钉「货架说没有回收站 → 出来的是确认档」这一件事。
 */
describe('shelf traits 从货架接到规划器（漏接线不会有别的用例报警）', () => {
  const EP = '750.探秘人体特殊实验.mp3'
  const SIZE = 111 * 1024 * 1024

  const mkSvc = (hasTrash: boolean) => {
    // 来源与认领货架上各有一份**字节全等**的同一集：平时判 `delete-dup`（不经人眼即删）。
    const alist = {
      listDirRecursive: vi.fn(async (p: string) =>
        p === '/src/dirA' || p === '/lib/付费' ? [{ name: EP, size: SIZE, isDir: false }] : []),
      mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
      rawUrl: vi.fn(async (p: string) => `http://raw${p}`),
      id: 'openlist', traits: { ...OPENLIST_TRAITS, hasTrash },
    }
    const svc = new ReconcileService({
      db: openNetdiskDb(':memory:'),
      alist: alist as never,
      listLeft: (async () => ({ entries: [{ leftKey: 'L750', title: '750.探秘人体特殊实验', durationS: 1000 }], source: 'stream:test' })) as never,
      getBinding: vi.fn(() => ({ id: 'map_id', left: { kind: 'stream', streamId: 's1', title: '怡乐' }, right: { path: '/lib/付费' } }) as never),
      offlineDirOf: () => '/lib/下架',
      probeDuration: async () => 1000,
      log: () => {},
    })
    svc.putConfig({ shows: [{ id: 'yile', label: '怡楽播客', bindingId: 'map_id', sourceDirs: ['/src/dirA'], subShows: [], autoExecute: false }] })
    return svc
  }

  it('货架自报没有回收站 → 字节全等那份出的是 delete-loser（确认档），不是 delete-dup', async () => {
    const r = await mkSvc(false).preview('yile')
    expect(r.plan.map((a) => a.kind)).toContain('delete-loser')
    expect(r.plan.map((a) => a.kind)).not.toContain('delete-dup')
  })

  it('负对照：有回收站的货架上仍是 delete-dup', async () => {
    const r = await mkSvc(true).preview('yile')
    expect(r.plan.map((a) => a.kind)).toContain('delete-dup')
  })
})

/**
 * 多季影视归档接进服务层（spec 2026-09-03-tv-season-archive §4）。这一段守的是**四条接线**，
 * 每一条断掉都不会让别的用例变红：
 *  1. `seasonFolders` 只在 tmdb 剧集绑定上打开——漏了，认领的集就落回作品目录根，季结构永远不出现；
 *  2. `gated` 那一档真的过健康闸，且被闸时**一个文件都不动**（追更循环无人值守走的正是这条）；
 *  3. `losers` 缺省不变、显式 false 时不删确认档；
 *  4. 同一条绑定的两次执行串行——`netdisk-follow` 与 `netdisk-reconcile` 会同时抄起同一条绑定，
 *     两轮交错就是"A 规划时看到的现状在 B 手里已经变了"，表现是幻影 move 与 403 撞名。
 * 外加整轮撤销：`undoRun(runId)` 把这一轮搬回去。
 */
describe('executeBinding 选项 / 互斥 / undoRun（spec 2026-09-03-tv-season-archive §4）', () => {
  const ROOT = '/lib/剧集/某剧'
  /** 一集一条，季集号写在 leftKey 里——季目录名与文件名前缀都从它推。 */
  const tvEntries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ leftKey: `tmdb:9:S01E0${i + 1}`, title: `第 ${i + 1} 集` }))

  /** tmdb **剧集**绑定的原地整理（`showForBinding` 那条退化配置）。货架换成传进来的那一个，
   *  好让「要真文件系统语义」（MemoryShelf）和「要按调用顺序断言」（vi.fn 假货架）共用一套接线。 */
  function mkTvSvc(shelf: unknown, opts: { entries?: number } = {}) {
    const db = openNetdiskDb(':memory:')
    const listLeft = vi.fn(async () => ({ entries: tvEntries(opts.entries ?? 1), source: 'tmdb:9' }))
    const svc = new ReconcileService({
      db,
      alist: shelf as never,
      listLeft: listLeft as never,
      getBinding: vi.fn((id: string) => ({
        id, left: { kind: 'tmdb', id: '9', media: 'tv', title: '某剧' }, right: { path: ROOT },
      }) as never),
      offlineDirOf: () => undefined, // 影视没有下架 stream
      // TMDb 分集索引不给时长——同一集的两个压制靠探测出的相同长度才认得出是同一集。
      probeDuration: async () => 3600,
      log: () => {},
    })
    return { svc, db, listLeft }
  }

  /** vi.fn 假货架：只要能被调用、能记顺序。`calls` 是断言互斥用的那条时间线。 */
  function mkFakeShelf(files: { name: string; size: number }[]) {
    const calls: string[] = []
    const shelf = {
      listDirRecursive: vi.fn(async (p: string) => {
        calls.push(`list ${p}`)
        return p === ROOT ? files.map((f) => ({ ...f, isDir: false })) : []
      }),
      mkdir: vi.fn(async (p: string) => { calls.push(`mkdir ${p}`) }),
      move: vi.fn(async (src: string, dst: string, names: string[]) => { calls.push(`move ${src}→${dst} ${names.join(',')}`) }),
      rename: vi.fn(async (p: string, n: string) => { calls.push(`rename ${p}→${n}`) }),
      remove: vi.fn(async (dir: string, names: string[]) => { calls.push(`remove ${dir} ${names.join(',')}`) }),
      rawUrl: vi.fn(async (p: string) => `http://raw${p}`),
      id: 'openlist', traits: OPENLIST_TRAITS,
    }
    return { shelf, calls }
  }

  it('tmdb tv 绑定的 planFor 传 seasonFolders：认领落点是 <root>/S<nn>、名字加编号前缀', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/分享合集/第1期.mkv`, 3_000_000_000)
    const { svc } = mkTvSvc(shelf)
    // 「这是哪一集」只有匹配器能答——这里用人裁的 pin 把它钉死，好让用例只考接线那一位。
    svc.setIsEpisode('tmdb:9:S01E01', `${ROOT}/分享合集/第1期.mkv`)

    const r = await svc.previewBinding('map_x')
    expect(r.plan).toEqual([
      expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/S01`, newName: 'S01E01 - 第1期.mkv' }),
    ])
  })

  it('gated:true 且清单缩水 → 不动文件、账本行带 gated、返回 moved 0', async () => {
    const { shelf, calls } = mkFakeShelf([{ name: '第1期.mkv', size: 3_000_000_000 }])
    const { svc, listLeft } = mkTvSvc(shelf, { entries: 6 })
    svc.setIsEpisode('tmdb:9:S01E01', `${ROOT}/第1期.mkv`)
    // 基线：人工执行一轮（`latestAccepted` 认它——人看过预览点了执行，那一眼就是确认）。
    await svc.executeBinding('map_x')
    calls.length = 0
    ;(listLeft as unknown as { mockResolvedValueOnce: (v: unknown) => unknown })
      .mockResolvedValueOnce({ entries: tvEntries(6).slice(0, 4), source: 'tmdb:9' })

    const res = await svc.executeBinding('map_x', { gated: true })
    expect(res.moved).toBe(0)
    expect(res.deleted).toBe(0)
    expect(res.renamed).toBe(0)
    expect(res.removedDirs).toBe(0)
    expect(res.ledger.mode).toBe('preview')
    expect(res.ledger.gated).toMatchObject({ reason: 'authority-shrink' })
    // 闸住那一轮记 `scheduled`——它就是无人值守那条路，下一轮的基线判据 `latestAccepted` 才认得出。
    expect(res.ledger.trigger).toBe('scheduled')
    expect(res.runId).toBe(res.ledger.runId)
    // 规划照跑（要列目录），但一个写操作都没有。
    expect(calls.filter((c) => !c.startsWith('list '))).toEqual([])
  })

  it('losers:false 不删 delete-loser；缺省 executeBinding 照删', async () => {
    const files = [{ name: 'Show.S01E01.2160p.mkv', size: 3_000_000_000 }, { name: 'Show.S01E01.1080p.mkv', size: 1_000_000_000 }]
    const a = mkFakeShelf(files)
    const svcA = mkTvSvc(a.shelf).svc
    const resA = await svcA.executeBinding('map_x', { losers: false })
    expect(a.shelf.remove).not.toHaveBeenCalled()
    expect(resA.deleted).toBe(0)

    const b = mkFakeShelf(files)
    const svcB = mkTvSvc(b.shelf).svc
    const resB = await svcB.executeBinding('map_x')
    expect(b.shelf.remove).toHaveBeenCalledWith(ROOT, ['Show.S01E01.1080p.mkv'])
    expect(resB.deleted).toBe(1)
  })

  it('同一绑定两次并发 executeBinding 串行：第二次的货架调用全部在第一次完成之后', async () => {
    const { shelf, calls } = mkFakeShelf([{ name: '第1期.mkv', size: 3_000_000_000 }])
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let moves = 0
    shelf.move.mockImplementation(async (src: string, dst: string, names: string[]) => {
      calls.push(`move ${src}→${dst} ${names.join(',')}`)
      if (++moves === 1) await gate // 第一轮卡在这儿：锁不生效的话第二轮会在这段窗口里插进来
    })
    const { svc } = mkTvSvc(shelf)
    svc.setIsEpisode('tmdb:9:S01E01', `${ROOT}/第1期.mkv`)

    const p1 = svc.executeBinding('map_x')
    const p2 = svc.executeBinding('map_x')
    while (moves === 0) await new Promise((r) => setTimeout(r, 1))
    const during = [...calls]
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1))
    expect(calls).toEqual(during) // 第二轮一个调用都还没发出

    release()
    await Promise.all([p1, p2])
    expect(calls.length).toBeGreaterThan(during.length)
  })

  /**
   * 撤销与执行动的是同一片网盘，**必须进同一把按绑定的锁**。不锁的表现不是报错：撤销把文件搬回
   * 分享子目录的同一时刻，另一轮执行手里那份快照还认为它在季目录里——幻影 move、目标目录撞名、
   * 以及最坏的那种，把"清单里没有它"的结论安在一份其实已经归好位的文件上。
   * 绑定从账本反查（`bindingOfRun`），不是从溯源行的路径猜。
   */
  it('undoRun 进按绑定的锁：执行还没跑完时，撤销一个调用都不发', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/分享合集/第1期.mkv`, 3_000_000_000)
    const { svc } = mkTvSvc(shelf, { entries: 2 })
    svc.setIsEpisode('tmdb:9:S01E01', `${ROOT}/分享合集/第1期.mkv`)
    const first = await svc.executeBinding('map_x')

    // 第二轮执行卡在 move 里；撤销第一轮必须排在它后面。
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const realMove = shelf.move.bind(shelf)
    let moves = 0
    const moveSpy = vi.fn(async (src: string, dst: string, names: string[]) => {
      if (++moves === 1) await gate
      return realMove(src, dst, names)
    })
    ;(shelf as unknown as { move: typeof moveSpy }).move = moveSpy
    shelf.put(`${ROOT}/分享合集/第2期.mkv`, 3_000_000_000)
    svc.setIsEpisode('tmdb:9:S01E02', `${ROOT}/分享合集/第2期.mkv`)

    const running = svc.executeBinding('map_x')
    while (moves === 0) await new Promise((r) => setTimeout(r, 1))
    const undoing = svc.undoRun(first.runId!)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 1))
    expect(moveSpy).toHaveBeenCalledTimes(1) // 撤销那一批 move 一个都还没发出

    release()
    await running
    const undone = await undoing
    expect(undone.undone).toBeGreaterThan(0)
    expect(moveSpy.mock.calls.length).toBeGreaterThan(1)
  })

  it('undoRun 把整轮搬回去（改名撤回、搬运搬回）', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/分享合集/第1期.mkv`, 3_000_000_000)
    const { svc } = mkTvSvc(shelf)
    svc.setIsEpisode('tmdb:9:S01E01', `${ROOT}/分享合集/第1期.mkv`)

    const res = await svc.executeBinding('map_x')
    expect(res.moved).toBe(1)
    expect(res.renamed).toBe(1)
    expect((await shelf.listDirRecursive(ROOT)).map((f) => f.name)).toEqual(['S01/S01E01 - 第1期.mkv'])

    const undone = await svc.undoRun(res.runId)
    expect(undone).toMatchObject({ undone: expect.any(Number), skipped: 0 })
    expect((await shelf.listDirRecursive(ROOT)).map((f) => f.name)).toEqual(['分享合集/第1期.mkv'])
  })
})

/**
 * 归档器与同步必须走**同一条季分区路**（Task 8）。活体 2026-09-03（脱口秀 map_c038e1）：
 * 128 行里 52 行两边判得不一样——归档器把第 2 季的「第2期上」当成第 3 季那一集的落选副本，
 * 要 replace / delete-loser。原因是它把所有季的清单和所有文件夹的文件混在一锅里裁决，而
 * 两季的期号一样、标题几乎一样、季号只写在文件夹名里。
 */
describe('多季绑定的归档走季分区（Task 8）', () => {
  const ROOT = '/lib/剧集/脱口秀'
  const TITLE = '第2期上：邱瑞谈冒犯的边界'
  /** 两季各 2 集，且跨季同期号、同标题——正是活体那条绑定的形状。 */
  const twoSeasonEntries = () => [
    { leftKey: 'tmdb:261471:S02E03', title: TITLE },
    { leftKey: 'tmdb:261471:S02E04', title: '第2期下：小帅讲相亲' },
    { leftKey: 'tmdb:261471:S03E04', title: TITLE },
    { leftKey: 'tmdb:261471:S03E05', title: '第2期下：小帅讲相亲' },
  ]

  function mk(opts: { entries: { leftKey: string; title: string }[]; resolveSeasons?: unknown; shelf: MemoryShelf }) {
    const db = openNetdiskDb(':memory:')
    const svc = new ReconcileService({
      db,
      alist: opts.shelf as never,
      listLeft: (async () => ({ entries: opts.entries, source: 'tmdb:261471' })) as never,
      getBinding: vi.fn((id: string) => ({
        id, left: { kind: 'tmdb', id: '261471', media: 'tv', title: '脱口秀' }, right: { path: ROOT },
      }) as never),
      offlineDirOf: () => undefined,
      probeDuration: async () => 3600,
      ...(opts.resolveSeasons ? { resolveSeasons: opts.resolveSeasons as never } : {}),
      log: () => {},
    })
    return svc
  }

  it('跨季同期号的两份文件各归各季：两条 move，没有 replace / delete-loser', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/S02.2025/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    shelf.put(`${ROOT}/第三季（4K）/2026-07-03 ${TITLE}.mp4`, 4_000_000_000)
    const resolveSeasons = vi.fn(async () => new Map<string, number | null>([['S02.2025', 2], ['第三季（4K）', 3]]))
    const svc = mk({ entries: twoSeasonEntries(), resolveSeasons, shelf })

    const r = await svc.previewBinding('map_c038e1')
    expect(resolveSeasons).toHaveBeenCalledTimes(1)
    expect(r.plan.filter((a) => a.kind === 'replace' || a.kind === 'delete-loser')).toEqual([])
    expect(r.plan).toContainEqual(expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/S02`, basis: 'authority:tmdb:261471:S02E03' }))
    expect(r.plan).toContainEqual(expect.objectContaining({ kind: 'move', dstDir: `${ROOT}/S03`, basis: 'authority:tmdb:261471:S03E04' }))
  })

  /**
   * 纯享剪辑要按**文件夹的季归属**落到 `<root>/纯享/S<nn>/`，而那份季归属只有服务层有
   * （`seasonPartitionedMatch` 问出来的那张表）。这条钉的正是那根接线：`seasonOfDir` 没传下去
   * 时规划器答不出季号，文件就静默留在原地——预览里少一条动作，没有任何一处会喊。
   */
  it('纯享剪辑进 <root>/纯享/S<nn>（证明 seasonOfDir 接线到了规划器）', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/S02.2025/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    shelf.put(`${ROOT}/S02.2025/2025-06-27 第2期纯享版.mkv`, 1_000_000_000)
    const resolveSeasons = vi.fn(async () => new Map<string, number | null>([['S02.2025', 2]]))
    const svc = mk({ entries: twoSeasonEntries(), resolveSeasons, shelf })

    const r = await svc.previewBinding('map_c038e1')
    expect(r.plan).toContainEqual(expect.objectContaining({
      kind: 'move', dstDir: `${ROOT}/纯享/S02`, basis: 'pure-cut:S02',
      src: expect.objectContaining({ path: `${ROOT}/S02.2025/2025-06-27 第2期纯享版.mkv` }),
    }))
  })

  it('多季绑定但 resolveSeasons 没接线 → ValidationError（不许退回单锅匹配）', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/S02.2025/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    const svc = mk({ entries: twoSeasonEntries(), shelf })
    await expect(svc.previewBinding('map_c038e1')).rejects.toThrow(ValidationError)
  })

  /**
   * 季归属的入料必须是**未过滤**的目录清单：季号常年只写在 `.zip`/`.nfo`/`.txt` 这类
   * 非媒体文件名里（`folderContext.extraFiles` 与 `nestedCleanNameSeason` 扫的路径段都吃它）。
   * 拿 `scanFiles` 那份 `EXT` 过滤后的清单去问，线索在进门口就被扔了，判出来的 `null`
   * 还会以文件夹名为键写进 `llmSeasonCache` 被同步那侧复用——静默且长久的分家。
   */
  it('季归属看得到非媒体文件：唯一的季线索在 .zip 名字里', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/合集/脱口秀 第二季.zip`, 1_000_000)
    shelf.put(`${ROOT}/合集/第1期.mkv`, 3_000_000_000)
    let seen: { folder: string; files: { name: string }[] }[] = []
    const resolveSeasons = vi.fn(async (_id: string, groups: { folder: string; files: { name: string }[] }[]) => {
      seen = groups
      return new Map<string, number | null>([['合集', 2]])
    })
    const svc = mk({ entries: twoSeasonEntries(), resolveSeasons, shelf })

    await svc.previewBinding('map_c038e1')
    expect(seen.flatMap((g) => g.files.map((x) => x.name))).toContain('合集/脱口秀 第二季.zip')
  })

  /**
   * 判不出季的文件夹整段不参与匹配——账本上要有它自己那一行（`season-unresolved:<绝对目录>`），
   * 不能掉进 `unhandled:`（那句话的意思是"某个终态漏接了"，会把一次正常的保守处置读成缺陷）。
   */
  it('resolveSeasons 判 null 的文件夹：自己一行 season-unresolved，不落 unhandled', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/来路不明/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    shelf.put(`${ROOT}/S02.2025/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    const resolveSeasons = vi.fn(async () => new Map<string, number | null>([['S02.2025', 2], ['来路不明', null]]))
    const svc = mk({ entries: twoSeasonEntries(), resolveSeasons, shelf })

    const r = await svc.previewBinding('map_c038e1')
    const row = r.ledger.rows.find((x) => x.path === `${ROOT}/来路不明/2025-06-28 ${TITLE}.mkv`)!
    expect(row.basis).toBe(`season-unresolved:${ROOT}/来路不明`)
    // 不搬不改名，但**看得见**：一条 `pending`，进 plan、进计数（`action: null` 的行两处都进不去，
    // 用户面前就是凭空少了一批文件）。
    expect(r.plan).toContainEqual(expect.objectContaining({
      kind: 'pending', pendingKind: 'season-unresolved',
      src: expect.objectContaining({ path: `${ROOT}/来路不明/2025-06-28 ${TITLE}.mkv` }),
    }))
    expect(r.ledger.rows.some((x) => x.basis.startsWith('unhandled:'))).toBe(false)
  })

  /**
   * 认领货架之外的来源目录**不进 resolveSeasons**：那份缓存的键是「相对认领货架根的叶子目录」，
   * 塞一个绝对路径进去既污染缓存、同步那侧也永远命不中。它们直接按"判不出季"办。
   */
  it('库外来源目录不问解析器，直接按判不出季办', async () => {
    const SRC = '/src/入库'
    const shelf = new MemoryShelf()
    shelf.put(`${SRC}/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    shelf.put(`${ROOT}/S02.2025/2025-06-28 ${TITLE}.mkv`, 3_000_000_000)
    let seen: { folder: string }[] = []
    const resolveSeasons = vi.fn(async (_id: string, groups: { folder: string }[]) => {
      seen = groups
      return new Map<string, number | null>([['S02.2025', 2]])
    })
    const svc = mk({ entries: twoSeasonEntries(), resolveSeasons, shelf })
    svc.putConfig({ shows: [{ id: 'ts', label: '脱口秀', bindingId: 'map_c038e1', sourceDirs: [SRC], subShows: [], autoExecute: false }] })

    const r = await svc.preview('ts')
    expect(seen.map((g) => g.folder)).toEqual(['S02.2025'])
    expect(r.ledger.rows.find((x) => x.path === `${SRC}/2025-06-28 ${TITLE}.mkv`)!.basis).toBe(`season-unresolved:${SRC}`)
  })

  it('单季绑定不分区：resolveSeasons 一次都不问', async () => {
    const shelf = new MemoryShelf()
    shelf.put(`${ROOT}/分享合集/${TITLE}.mkv`, 3_000_000_000)
    const resolveSeasons = vi.fn(async () => new Map<string, number | null>())
    const svc = mk({
      entries: [{ leftKey: 'tmdb:261471:S02E03', title: TITLE }, { leftKey: 'tmdb:261471:S02E04', title: '第2期下：小帅讲相亲' }],
      resolveSeasons, shelf,
    })
    await svc.previewBinding('map_c038e1')
    expect(resolveSeasons).not.toHaveBeenCalled()
  })
})
