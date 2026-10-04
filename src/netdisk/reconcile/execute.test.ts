import { describe, it, expect, vi } from 'vitest'
import { executePlan, undoMove, undoRun } from './execute.ts'
import { ProvenanceLog } from './decisions.ts'
import { openNetdiskDb } from '../db.ts'
import type { PlanAction } from './plan.ts'

// listing = 网盘此刻的现状（目录 → 这一层的文件）。删前核体量就读它;没给的目录 = 空目录。
const mkDeps = (listing: Record<string, { name: string; size: number }[]> = {}) => ({
  alist: {
    mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    // 单层列（maxDepth 0）：删前核对只看这一层
    listDirRecursive: vi.fn(async (dir: string) => (listing[dir] ?? []).map((f) => ({ ...f, isDir: false }))),
  },
  provenance: new ProvenanceLog(openNetdiskDb(':memory:')),
  log: () => {},
})

describe('executePlan', () => {
  it('move: 先 mkdir 目标目录,再按目录分组批量 move,并记溯源', async () => {
    const deps = mkDeps()
    const plan: PlanAction[] = [
      { kind: 'move', src: { path: '/src/a/092.穿衣服.mp3', name: '092.穿衣服.mp3', size: 1 }, dstDir: '/lib/下架', basis: 'num' },
      { kind: 'move', src: { path: '/src/a/093.后一集.mp3', name: '093.后一集.mp3', size: 2 }, dstDir: '/lib/下架', basis: 'auth' },
    ]
    const r = await executePlan(plan, deps)
    expect(r.moved).toBe(2)
    expect(deps.alist.mkdir).toHaveBeenCalledWith('/lib/下架')
    expect(deps.alist.move).toHaveBeenCalledWith('/src/a', '/lib/下架', ['092.穿衣服.mp3', '093.后一集.mp3'])
    expect(deps.provenance.list()).toHaveLength(2)
  })

  it('delete-dup: 调 remove 并记溯源', async () => {
    const deps = mkDeps({ '/src/a': [{ name: '750.x.mp3', size: 1 }] })
    const plan: PlanAction[] = [
      { kind: 'delete-dup', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 1 }, dupOf: '/lib/付费/750.x.mp3', basis: 'size-dup' },
    ]
    const r = await executePlan(plan, deps)
    expect(r.deleted).toBe(1)
    expect(deps.alist.remove).toHaveBeenCalledWith('/src/a', ['750.x.mp3'])
  })

  // 同集择优的落选副本与字节全等重复走同一条路：溯源里都是 action:'delete'，只有 basis 不同
  //（`quality-loser-of:` vs `size-dup-of:`）——为什么删,账本里必须留得住。
  it('delete-loser: 调 remove 并记溯源(basis 原样进账)', async () => {
    const deps = mkDeps({ '/lib/剧集/某剧': [{ name: 'Show.S01E01.1080p.mkv', size: 1 }] })
    const plan: PlanAction[] = [
      {
        kind: 'delete-loser',
        src: { path: '/lib/剧集/某剧/Show.S01E01.1080p.mkv', name: 'Show.S01E01.1080p.mkv', size: 1 },
        keptPath: '/lib/剧集/某剧/Show.S01E01.2160p.mkv',
        basis: 'quality-loser-of:/lib/剧集/某剧/Show.S01E01.2160p.mkv',
      },
    ]
    const r = await executePlan(plan, deps)
    expect(r.deleted).toBe(1)
    expect(deps.alist.remove).toHaveBeenCalledWith('/lib/剧集/某剧', ['Show.S01E01.1080p.mkv'])
    expect(deps.provenance.list()[0]).toMatchObject({
      action: 'delete',
      src: '/lib/剧集/某剧/Show.S01E01.1080p.mkv',
      basis: 'quality-loser-of:/lib/剧集/某剧/Show.S01E01.2160p.mkv',
    })
  })

  it('delete-loser 单条失败进 errors,不中断整轮', async () => {
    const deps = mkDeps({ '/lib': [{ name: 'a.mkv', size: 1 }, { name: 'b.mkv', size: 1 }] })
    deps.alist.remove.mockRejectedValueOnce(new Error('alist 500'))
    const mk = (n: string): PlanAction => ({ kind: 'delete-loser', src: { path: `/lib/${n}`, name: n, size: 1 }, keptPath: '/lib/keep.mkv', basis: 'quality-loser-of:/lib/keep.mkv' })
    const r = await executePlan([mk('a.mkv'), mk('b.mkv')], deps)
    expect(r.errors).toHaveLength(1)
    expect(r.deleted).toBe(1)
  })

  // 删质量落选者必须过人眼（spec §5）。定时轮就是靠这个开关做到的：判定照出，手不动。
  it('losers:false 跳过 delete-loser（不调 remove、计入 pending）,delete-dup 照删', async () => {
    const deps = mkDeps({
      '/lib/剧集/某剧': [{ name: '1080p.mkv', size: 1 }],
      '/src/a': [{ name: '750.x.mp3', size: 1 }],
    })
    const plan: PlanAction[] = [
      { kind: 'delete-loser', src: { path: '/lib/剧集/某剧/1080p.mkv', name: '1080p.mkv', size: 1 }, keptPath: '/lib/剧集/某剧/2160p.mkv', basis: 'quality-loser-of:/lib/剧集/某剧/2160p.mkv' },
      { kind: 'delete-dup', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 1 }, dupOf: '/lib/付费/750.x.mp3', basis: 'size-dup-of:/lib/付费/750.x.mp3' },
    ]
    const r = await executePlan(plan, deps, { losers: false })
    expect(deps.alist.remove).toHaveBeenCalledTimes(1)
    expect(deps.alist.remove).toHaveBeenCalledWith('/src/a', ['750.x.mp3'])
    expect(r).toMatchObject({ deleted: 1, pending: 1 })
    expect(deps.provenance.list().map((e) => e.src)).toEqual(['/src/a/750.x.mp3'])
  })

  // 免费集副本（付费货架契约）：删的依据是"源站自己放得出这一集"，不是比出来的，所以**不进确认档**
  // ——定时轮（`losers:false`）照删。用户 2026-08-01 拍板：转存成本极低 + 夸克回收站兜底。
  it('delete-redundant: losers:false 也照删,basis 原样进溯源', async () => {
    const deps = mkDeps({ '/lib/付费': [{ name: '600.免费那一集.mp3', size: 7 }] })
    const plan: PlanAction[] = [
      {
        kind: 'delete-redundant',
        src: { path: '/lib/付费/600.免费那一集.mp3', name: '600.免费那一集.mp3', size: 7 },
        basis: 'redundant-free:LF',
        episode: '600.免费那一集',
      },
    ]
    const r = await executePlan(plan, deps, { losers: false })
    expect(r).toMatchObject({ deleted: 1, pending: 0 })
    expect(deps.alist.remove).toHaveBeenCalledWith('/lib/付费', ['600.免费那一集.mp3'])
    expect(deps.provenance.list()[0]).toMatchObject({ action: 'delete', src: '/lib/付费/600.免费那一集.mp3', basis: 'redundant-free:LF', size: 7 })
  })

  // 上一条那个豁免的**前提是回收站兜底**。规划器在没有回收站的货架上会给这条动作盖 `noTrash`，
  // 前提没了，豁免也就没了：定时轮必须跟落选副本同档跳过，等人点头。
  it('delete-redundant + noTrash: losers:false 时跳过（不调 remove、计入 pending）', async () => {
    const deps = mkDeps({ '/lib/付费': [{ name: '600.免费那一集.mp3', size: 7 }] })
    const plan: PlanAction[] = [
      {
        kind: 'delete-redundant',
        src: { path: '/lib/付费/600.免费那一集.mp3', name: '600.免费那一集.mp3', size: 7 },
        basis: 'redundant-free:LF',
        episode: '600.免费那一集',
        noTrash: true,
      },
    ]
    const r = await executePlan(plan, deps, { losers: false })
    expect(r).toMatchObject({ deleted: 0, pending: 1 })
    expect(deps.alist.remove).not.toHaveBeenCalled()
    // 人点头的那一次（显式 execute，`losers` 缺省 true）照删——降级只降定时轮，不是禁删。
    const deps2 = mkDeps({ '/lib/付费': [{ name: '600.免费那一集.mp3', size: 7 }] })
    expect(await executePlan(plan, deps2)).toMatchObject({ deleted: 1, pending: 0 })
  })

  // 换正主：顺序是硬的——先 remove 旧的、再 move 新的。反过来同名必 403（旧的还占着那个名字）。
  describe('replace', () => {
    const swap = (over?: Partial<Extract<PlanAction, { kind: 'replace' }>>): PlanAction => ({
      kind: 'replace',
      src: { path: '/src/a/05.太极.mp3', name: '05.太极.mp3', size: 300 },
      oldPath: '/lib/付费/05.太极.mp3',
      dstDir: '/lib/付费',
      basis: 'quality-upgrade:/lib/付费/05.太极.mp3',
      compare: { candidates: [
        { path: '/src/a/05.太极.mp3', size: 300, inLib: false },
        { path: '/lib/付费/05.太极.mp3', size: 111, inLib: true },
      ] },
      ...over,
    })
    // 旧正主此刻的现状与 compare 里那份对得上 → 删前核对放行
    const libNow = { '/lib/付费': [{ name: '05.太极.mp3', size: 111 }] }

    it('先 remove 旧正主、再 move 新的进目标目录;溯源两条(delete + move)', async () => {
      const deps = mkDeps(libNow)
      const order: string[] = []
      deps.alist.remove.mockImplementation(async () => { order.push('remove') })
      deps.alist.move.mockImplementation(async () => { order.push('move') })
      const r = await executePlan([swap()], deps)
      expect(order).toEqual(['remove', 'move'])
      expect(deps.alist.remove).toHaveBeenCalledWith('/lib/付费', ['05.太极.mp3'])
      expect(deps.alist.move).toHaveBeenCalledWith('/src/a', '/lib/付费', ['05.太极.mp3'])
      expect(r).toMatchObject({ deleted: 1, moved: 1 })
      // 删掉的那份体量从 compare 的并排数据里取——审计行要能答"删掉了多大一份"
      expect(deps.provenance.list()).toMatchObject([
        { action: 'delete', src: '/lib/付费/05.太极.mp3', size: 111, basis: 'quality-upgrade:/lib/付费/05.太极.mp3' },
        { action: 'move', src: '/src/a/05.太极.mp3', dst: '/lib/付费/05.太极.mp3', size: 300 },
      ])
    })

    it('新的本来就在目标目录里 → 只删旧的,不搬', async () => {
      const deps = mkDeps(libNow)
      const r = await executePlan([swap({ src: { path: '/lib/付费/05.太极.2160p.mp3', name: '05.太极.2160p.mp3', size: 300 } })], deps)
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r).toMatchObject({ deleted: 1, moved: 0 })
    })

    // 旧的没删掉就别搬:名字还占着,搬过去只会再撞一次 403。错误行照记,下一轮重来。
    it('remove 失败 → 不搬新的,错误进 errors', async () => {
      const deps = mkDeps(libNow)
      deps.alist.remove.mockRejectedValueOnce(new Error('alist 500'))
      const r = await executePlan([swap()], deps)
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r.errors).toEqual([expect.stringContaining('delete /lib/付费/05.太极.mp3')])
      expect(r.deleted).toBe(0)
    })

    // 与 delete-loser 同属确认档：定时轮（losers:false）一步都不许动它。
    it('losers:false → 跳过,不调 remove/move,计入 pending', async () => {
      const deps = mkDeps()
      const r = await executePlan([swap()], deps, { losers: false })
      expect(deps.alist.remove).not.toHaveBeenCalled()
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r).toMatchObject({ pending: 1, deleted: 0, moved: 0 })
      expect(deps.provenance.list()).toHaveLength(0)
    })

    // 换正主排在所有搬运之前:它腾出来的位置,后面那些 move 才用得上。
    it('先于普通 move 执行', async () => {
      const deps = mkDeps(libNow)
      const order: string[] = []
      deps.alist.remove.mockImplementation(async () => { order.push('replace-remove') })
      deps.alist.move.mockImplementation(async () => { order.push('move') })
      await executePlan([
        { kind: 'move', src: { path: '/src/a/x.mp3', name: 'x.mp3', size: 1 }, dstDir: '/lib/下架', basis: 'b' },
        swap(),
      ], deps)
      expect(order[0]).toBe('replace-remove')
    })
  })

  /**
   * 换槽位一轮做完。过去删排在搬后面，"删掉占位那份 + 把新的搬进来"排进同一轮必然先搬、
   * 撞上还在的同名文件 403——所以计划器只能把它压成 `swap-hold` 等下一轮。
   */
  describe('换槽位（move.evicts）', () => {
    const occupant = '/lib/付费/750.x.mp3'
    const pair = (): PlanAction[] => [
      // 顺序故意反着摆：保证的是执行器的阶段顺序，不是数组顺序。
      { kind: 'move', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 2 }, dstDir: '/lib/付费', basis: 'freed-by', evicts: occupant },
      { kind: 'delete-redundant', src: { path: occupant, name: '750.x.mp3', size: 1 }, basis: 'redundant-free:L750' },
    ]
    const libNow = { '/lib/付费': [{ name: '750.x.mp3', size: 1 }] }

    it('删排在搬前面——位置先空出来，搬进去才不撞名', async () => {
      const deps = mkDeps(libNow)
      const order: string[] = []
      deps.alist.remove.mockImplementation(async () => { order.push('remove') })
      deps.alist.move.mockImplementation(async () => { order.push('move') })
      const r = await executePlan(pair(), deps)
      expect(order).toEqual(['remove', 'move'])
      expect(r).toMatchObject({ deleted: 1, moved: 1 })
    })

    /** 前置那一步没做成，这条搬运就必须跟着不跑——否则搬进去撞上还在的同名文件 403。 */
    it('删失败 → 那条搬运不跑，计入 pending，位置还占着下一轮重来', async () => {
      const deps = mkDeps(libNow)
      deps.alist.remove.mockRejectedValueOnce(new Error('alist 500'))
      const r = await executePlan(pair(), deps)
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r).toMatchObject({ deleted: 0, moved: 0, pending: 1 })
      expect(r.errors).toHaveLength(1)
    })

    /** 别的搬运不受牵连——一条前置失败只锁它自己那一条。 */
    it('同一轮里不依赖它的搬运照跑', async () => {
      const deps = mkDeps(libNow)
      deps.alist.remove.mockRejectedValueOnce(new Error('alist 500'))
      const r = await executePlan([
        ...pair(),
        { kind: 'move', src: { path: '/src/a/092.穿衣服.mp3', name: '092.穿衣服.mp3', size: 3 }, dstDir: '/lib/下架', basis: 'num' },
      ], deps)
      expect(deps.alist.move).toHaveBeenCalledTimes(1)
      expect(deps.alist.move).toHaveBeenCalledWith('/src/a', '/lib/下架', ['092.穿衣服.mp3'])
      expect(r).toMatchObject({ moved: 1, pending: 1 })
    })
  })

  // 规划到执行之间文件可能被人动过：同名换了内容、或已经不在。删之前对目标目录单层 refresh
  // 列一次比 size，对不上就不删。
  describe('删前核体量', () => {
    it('现状里大小对得上 → 删', async () => {
      const deps = mkDeps({ '/src/a': [{ name: '750.x.mp3', size: 1 }] })
      const r = await executePlan([{ kind: 'delete-dup', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 1 }, dupOf: '/lib/750.x.mp3', basis: 'size-dup' }], deps)
      expect(r.deleted).toBe(1)
      expect(deps.alist.listDirRecursive).toHaveBeenCalledWith('/src/a', 0, true)
    })

    it('大小变了 → 不删，错误行写 stale: expected/got', async () => {
      const deps = mkDeps({ '/src/a': [{ name: '750.x.mp3', size: 999 }] })
      const r = await executePlan([{ kind: 'delete-dup', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 1 }, dupOf: '/lib/750.x.mp3', basis: 'size-dup' }], deps)
      expect(r.deleted).toBe(0)
      expect(deps.alist.remove).not.toHaveBeenCalled()
      expect(r.errors[0]).toMatch(/stale: expected 1 got 999/)
    })

    it('已经不在了 → 不删，错误行写 got missing', async () => {
      const deps = mkDeps({ '/src/a': [] })
      const r = await executePlan([{ kind: 'delete-loser', src: { path: '/src/a/750.x.mp3', name: '750.x.mp3', size: 1 }, keptPath: '/lib/750.x.mp3', basis: 'q' }], deps)
      expect(r.errors[0]).toMatch(/stale: expected 1 got missing/)
    })

    it('replace 删旧正主前同样核；stale 则新的也不搬', async () => {
      const deps = mkDeps({ '/lib': [{ name: 'old.mp3', size: 5 }], '/src': [{ name: 'new.mp3', size: 9 }] })
      const plan: PlanAction[] = [{ kind: 'replace', src: { path: '/src/new.mp3', name: 'new.mp3', size: 9 }, oldPath: '/lib/old.mp3', dstDir: '/lib', basis: 'q',
        compare: { candidates: [{ path: '/lib/old.mp3', size: 7, inLib: true }, { path: '/src/new.mp3', size: 9, inLib: false }] } as never }]
      const r = await executePlan(plan, deps)
      expect(deps.alist.remove).not.toHaveBeenCalled()
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r.errors[0]).toMatch(/stale: expected 7 got 5/)
    })

    // 期望值不知道就别拿 0 去核——那会报成 `expected 0 got N`，把"没带 compare"说成"文件变了"。
    it('replace 没带 compare（期望值不知道）→ 拒删拒搬，错误行写 expected unknown', async () => {
      const deps = mkDeps({ '/lib': [{ name: 'old.mp3', size: 5 }], '/src': [{ name: 'new.mp3', size: 9 }] })
      const plan: PlanAction[] = [{ kind: 'replace', src: { path: '/src/new.mp3', name: 'new.mp3', size: 9 }, oldPath: '/lib/old.mp3', dstDir: '/lib', basis: 'q' }]
      const r = await executePlan(plan, deps)
      expect(deps.alist.remove).not.toHaveBeenCalled()
      expect(deps.alist.move).not.toHaveBeenCalled()
      expect(r).toMatchObject({ deleted: 0, moved: 0 })
      expect(r.errors[0]).toMatch(/expected unknown/)
    })
  })

  it('pending 不产生任何 alist 调用', async () => {
    const deps = mkDeps()
    const r = await executePlan([{ kind: 'pending', src: { path: '/s/x', name: 'x', size: 1 }, reason: 'r', pendingKind: 'no-duration' }], deps)
    expect(r.pending).toBe(1)
    expect(deps.alist.move).not.toHaveBeenCalled()
    expect(deps.alist.remove).not.toHaveBeenCalled()
  })

  it('单条失败不中断整轮,进 errors', async () => {
    // 失败那一批回读时文件还在源目录 —— 真失败，整批进错误行
    const deps = mkDeps({ '/a': [{ name: '1.mp3', size: 1 }] })
    deps.alist.move.mockRejectedValueOnce(new Error('alist 500'))
    const plan: PlanAction[] = [
      { kind: 'move', src: { path: '/a/1.mp3', name: '1.mp3', size: 1 }, dstDir: '/lib/付费', basis: 'b' },
      { kind: 'move', src: { path: '/b/2.mp3', name: '2.mp3', size: 1 }, dstDir: '/lib/下架', basis: 'b' },
    ]
    const r = await executePlan(plan, deps)
    expect(r.errors).toHaveLength(1)
    expect(r.moved).toBe(1)
  })
})

describe('批量搬失败回读', () => {
  it('一批里部分已经搬走 → 那几份按成功记溯源+迁决定键，其余进错误行', async () => {
    const listing = { '/src': [{ name: 'b.mp3', size: 2 * 1024 * 1024 }] } // a 已不在源目录，b 还在
    const deps = mkDeps(listing)
    deps.alist.move.mockRejectedValueOnce(new Error('HTTP 500'))
    const migrate = vi.fn()
    const plan: PlanAction[] = [
      { kind: 'move', src: { path: '/src/a.mp3', name: 'a.mp3', size: 1024 * 1024 }, dstDir: '/lib', basis: 'x' },
      { kind: 'move', src: { path: '/src/b.mp3', name: 'b.mp3', size: 2 * 1024 * 1024 }, dstDir: '/lib', basis: 'y' },
    ]
    const r = await executePlan(plan, { ...deps, decisions: { migratePath: migrate } })
    expect(r.moved).toBe(1)
    expect(deps.provenance.list()).toHaveLength(1)
    expect(deps.provenance.list()[0]).toMatchObject({ action: 'move', src: '/src/a.mp3', dst: '/lib/a.mp3' })
    expect(migrate).toHaveBeenCalledWith('/src/a.mp3', '/lib/a.mp3')
    // 必须 refresh：AList 的目录列表带缓存，读到搬之前那份快照就会把"已搬走"误判成"还在"
    expect(deps.alist.listDirRecursive).toHaveBeenCalledWith('/src', 0, true)
    expect(r.errors).toEqual([expect.stringMatching(/move \/src→\/lib: HTTP 500（未搬成：b\.mp3）/)])
  })
  it('源目录整个没了（object not found）→ 全部按搬成记', async () => {
    const deps = mkDeps()
    deps.alist.move.mockRejectedValueOnce(new Error('timeout'))
    deps.alist.listDirRecursive.mockRejectedValueOnce(new Error('object not found'))
    const r = await executePlan([{ kind: 'move', src: { path: '/src/a.mp3', name: 'a.mp3', size: 1024 * 1024 }, dstDir: '/lib', basis: 'x' }], deps)
    expect(r.moved).toBe(1)
    expect(r.errors).toEqual([])
  })
})

describe('undoMove', () => {
  it('按溯源反向 move 并标记 undone;已 undone 拒绝重复撤销', async () => {
    const deps = mkDeps()
    const id = deps.provenance.record({ action: 'move', src: '/src/a/x.mp3', dst: '/lib/付费/x.mp3', size: 1, basis: 'b' })
    await undoMove(id, deps)
    expect(deps.alist.move).toHaveBeenCalledWith('/lib/付费', '/src/a', ['x.mp3'])
    expect(deps.provenance.get(id)?.undone).toBe(true)
    await expect(undoMove(id, deps)).rejects.toThrow(/already undone/)
  })

  it('delete 记录不可撤销', async () => {
    const deps = mkDeps()
    const id = deps.provenance.record({ action: 'delete', src: '/src/a/x.mp3', size: 1, basis: 'b' })
    await expect(undoMove(id, deps)).rejects.toThrow(/cannot undo/)
  })
})

describe('rename / move+newName / 搬空目录 / undoRun', () => {
  const rf = (path: string, size = 1) => ({ path, name: path.split('/').pop()!, size })

  it('rename：调 alist.rename，溯源记 rename（src 旧路径、dst 新路径、runId）', async () => {
    const deps = { ...mkDeps(), runId: 'run_1' }
    const r = await executePlan([{ kind: 'rename', src: rf('/lib/S01/a.mkv'), newName: 'S01E01 - a.mkv', basis: 'prefix:S01E01' }], deps)
    expect(r.renamed).toBe(1)
    expect(deps.alist.rename).toHaveBeenCalledWith('/lib/S01/a.mkv', 'S01E01 - a.mkv')
    expect(deps.provenance.listByRun('run_1')).toEqual([expect.objectContaining({ action: 'rename', src: '/lib/S01/a.mkv', dst: '/lib/S01/S01E01 - a.mkv' })])
  })

  it('move + newName：先在源目录改名，再按新名搬；两条溯源；改名失败则按旧名照搬并记错误', async () => {
    const deps = { ...mkDeps(), runId: 'run_1' }
    const r = await executePlan([{ kind: 'move', src: rf('/lib/第三季/a.mkv'), dstDir: '/lib/S03', newName: 'S03E01 - a.mkv', basis: 'authority:k' }], deps)
    expect(r.moved).toBe(1); expect(r.renamed).toBe(1)
    expect(deps.alist.rename).toHaveBeenCalledWith('/lib/第三季/a.mkv', 'S03E01 - a.mkv')
    expect(deps.alist.move).toHaveBeenCalledWith('/lib/第三季', '/lib/S03', ['S03E01 - a.mkv'])
    expect(deps.provenance.listByRun('run_1').map((e) => [e.action, e.src, e.dst])).toEqual([
      ['rename', '/lib/第三季/a.mkv', '/lib/第三季/S03E01 - a.mkv'],
      ['move', '/lib/第三季/S03E01 - a.mkv', '/lib/S03/S03E01 - a.mkv'],
    ])

    const bad = { ...mkDeps(), runId: 'run_2' }
    bad.alist.rename.mockRejectedValueOnce(new Error('illegal char'))
    const r2 = await executePlan([{ kind: 'move', src: rf('/lib/第三季/b.mkv'), dstDir: '/lib/S03', newName: 'S03E02 - b.mkv', basis: 'authority:k' }], bad)
    expect(r2.moved).toBe(1); expect(r2.renamed).toBe(0)
    expect(r2.errors).toEqual([expect.stringContaining('rename /lib/第三季/b.mkv')])
    expect(bad.alist.move).toHaveBeenCalledWith('/lib/第三季', '/lib/S03', ['b.mkv'])
  })

  // `replace` 与 `move` 同待遇：新正主搬进季文件夹时也要带上编号前缀，否则换完版名字反而退回没前缀。
  // 顺序是硬的：**先确认旧正主真的被删掉了，再改名**。反过来的话，删被 stale / 无 compare 拒掉时
  // 这一份已经在盘上被改成了带前缀的新名字——文件没搬、位置没变，只多了一次不该发生的改名。
  it('replace + newName：先删旧正主，再改名，按新名搬进去', async () => {
    const deps = { ...mkDeps({ '/lib/S03': [{ name: 'old.mkv', size: 9 }] }), runId: 'run_r' }
    const plan = [{
      kind: 'replace', src: rf('/lib/第三季/new.mkv'), oldPath: '/lib/S03/old.mkv', dstDir: '/lib/S03',
      newName: 'S03E01 - new.mkv', basis: 'authority:k',
      compare: { candidates: [{ path: '/lib/S03/old.mkv', size: 9, inLib: true }] },
    }] as PlanAction[]
    const r = await executePlan(plan, deps)
    expect(r.renamed).toBe(1); expect(r.deleted).toBe(1); expect(r.moved).toBe(1)
    expect(deps.alist.rename).toHaveBeenCalledWith('/lib/第三季/new.mkv', 'S03E01 - new.mkv')
    expect(deps.alist.move).toHaveBeenCalledWith('/lib/第三季', '/lib/S03', ['S03E01 - new.mkv'])
    expect(deps.provenance.listByRun('run_r').map((e) => [e.action, e.src, e.dst])).toEqual([
      ['delete', '/lib/S03/old.mkv', undefined],
      ['rename', '/lib/第三季/new.mkv', '/lib/第三季/S03E01 - new.mkv'],
      ['move', '/lib/第三季/S03E01 - new.mkv', '/lib/S03/S03E01 - new.mkv'],
    ])
  })

  // 删被拒（没带 compare）时那次改名不该发生过——盘上的名字必须原封不动。
  it('replace 拒删时不改名', async () => {
    const deps = { ...mkDeps({ '/lib/S03': [{ name: 'old.mkv', size: 9 }] }), runId: 'run_m8' }
    const plan = [{
      kind: 'replace', src: rf('/lib/第三季/new.mkv'), oldPath: '/lib/S03/old.mkv', dstDir: '/lib/S03',
      newName: 'S03E01 - new.mkv', basis: 'authority:k',
    }] as PlanAction[]
    const r = await executePlan(plan, deps)
    expect(deps.alist.rename).not.toHaveBeenCalled()
    expect(r).toMatchObject({ renamed: 0, deleted: 0, moved: 0 })
  })

  it('cleanupEmptiedDirs：搬空的分享子目录删掉并记 rmdir；根目录、季目录、还有东西的目录不删', async () => {
    const listing: Record<string, { name: string; size: number }[]> = { '/lib/第三季': [], '/lib/第二季': [{ name: 'x.nfo', size: 1 }] }
    const deps = { ...mkDeps(listing), runId: 'run_1' }
    const plan: PlanAction[] = [
      { kind: 'move', src: rf('/lib/第三季/a.mkv'), dstDir: '/lib/S03', basis: 'k' },
      { kind: 'move', src: rf('/lib/第二季/b.mkv'), dstDir: '/lib/S02', basis: 'k' },
      { kind: 'move', src: rf('/lib/c.mkv'), dstDir: '/lib/S01', basis: 'k' },
    ]
    const r = await executePlan(plan, deps, { cleanupEmptiedDirs: { root: '/lib' } })
    expect(r.removedDirs).toBe(1)
    expect(deps.alist.remove).toHaveBeenCalledWith('/lib', ['第三季'])
    expect(deps.alist.remove).not.toHaveBeenCalledWith('/lib', ['第二季'])
    expect(deps.provenance.listByRun('run_1').filter((e) => e.action === 'rmdir')).toEqual([expect.objectContaining({ src: '/lib/第三季' })])
  })

  /**
   * 纯享货架（`<root>/纯享/` 与它下面的 `S<nn>/`）与季目录一样是**归档结构的一部分**：
   * 这一轮搬空了，下一轮还要往里搬。删掉它只会让下一轮再建一次，撤销时也无从还原。
   */
  it('cleanupEmptiedDirs：纯享货架根与它的季目录空了也不删', async () => {
    const listing: Record<string, { name: string; size: number }[]> = { '/lib/纯享': [], '/lib/纯享/S02': [] }
    const deps = { ...mkDeps(listing), runId: 'run_pc' }
    const plan: PlanAction[] = [
      { kind: 'move', src: rf('/lib/纯享/a.mkv'), dstDir: '/lib/纯享/S02', basis: 'pure-cut:S02' },
      { kind: 'move', src: rf('/lib/纯享/S02/b.mkv'), dstDir: '/lib/纯享/S03', basis: 'pure-cut:S03' },
    ]
    const r = await executePlan(plan, deps, { cleanupEmptiedDirs: { root: '/lib' } })
    expect(r.removedDirs).toBe(0)
    expect(deps.alist.remove).not.toHaveBeenCalled()
  })

  // 空检查现在按 maxDepth 0 + includeDirs:true 探——只看这一层，但把子目录条目本身也算进来：
  // 「只剩一个 `花絮/` 子目录」的目录，这一层就能看见「花絮」这一条目录行，不必递归进去找文件。
  it('cleanupEmptiedDirs：只剩子目录（花絮/）的目录不删——目录条目本身就算"还有东西"', async () => {
    const deps = { ...mkDeps(), runId: 'run_c1' }
    deps.alist.listDirRecursive = vi.fn(async (dir: string, _maxDepth = 5, _refresh = true, includeDirs = false) => (
      dir === '/lib/第三季' && includeDirs ? [{ name: '花絮', size: 0, isDir: true }] : []
    ))
    const r = await executePlan(
      [{ kind: 'move', src: rf('/lib/第三季/a.mkv'), dstDir: '/lib/S03', basis: 'k' }],
      deps, { cleanupEmptiedDirs: { root: '/lib' } },
    )
    expect(r.removedDirs).toBe(0)
    expect(deps.alist.remove).not.toHaveBeenCalled()
    expect(deps.provenance.listByRun('run_c1').filter((e) => e.action === 'rmdir')).toEqual([])
    expect(deps.alist.listDirRecursive).toHaveBeenCalledWith('/lib/第三季', 0, true, true)
  })

  // 换正主搬走之后，它原来待的那个分享子目录同样可能空了——候选集只取 `moveGroups` 的话
  // 这一类永远清不掉（`replace` 的搬运不走那条分组）。
  it('cleanupEmptiedDirs：换正主腾空的源目录也进候选', async () => {
    const deps = { ...mkDeps({ '/lib/S03': [{ name: 'old.mkv', size: 9 }], '/lib/第三季': [] }), runId: 'run_m7' }
    const plan = [{
      kind: 'replace', src: rf('/lib/第三季/new.mkv'), oldPath: '/lib/S03/old.mkv', dstDir: '/lib/S03',
      basis: 'authority:k', compare: { candidates: [{ path: '/lib/S03/old.mkv', size: 9, inLib: true }] },
    }] as PlanAction[]
    const r = await executePlan(plan, deps, { cleanupEmptiedDirs: { root: '/lib' } })
    expect(r.removedDirs).toBe(1)
    expect(deps.alist.remove).toHaveBeenCalledWith('/lib', ['第三季'])
  })

  it('undoRun：倒序撤销 move/rename/rmdir，delete 跳过计数，已撤销的不重复', async () => {
    const deps = { ...mkDeps({ '/lib/第三季': [], '/lib/S03': [{ name: 'dup.mkv', size: 1 }] }), runId: 'run_1' }
    await executePlan([
      { kind: 'move', src: rf('/lib/第三季/a.mkv'), dstDir: '/lib/S03', newName: 'S03E01 - a.mkv', basis: 'k' },
      { kind: 'delete-dup', src: rf('/lib/S03/dup.mkv'), dupOf: '/lib/S03/a.mkv', basis: 'size-dup' },
    ], deps, { cleanupEmptiedDirs: { root: '/lib' } })
    deps.alist.move.mockClear(); deps.alist.rename.mockClear(); deps.alist.mkdir.mockClear()
    const r = await undoRun('run_1', deps)
    expect(r).toEqual({ undone: 3, skipped: 1 })
    // 倒序：先重建目录、再搬回、再改回名
    expect(deps.alist.mkdir).toHaveBeenCalledWith('/lib/第三季')
    expect(deps.alist.move).toHaveBeenCalledWith('/lib/S03', '/lib/第三季', ['S03E01 - a.mkv'])
    expect(deps.alist.rename).toHaveBeenCalledWith('/lib/第三季/S03E01 - a.mkv', 'a.mkv')
    expect(deps.provenance.listByRun('run_1').filter((e) => e.action !== 'delete').every((e) => e.undone)).toBe(true)
    expect(await undoRun('run_1', deps)).toEqual({ undone: 0, skipped: 1 })
  })
})
