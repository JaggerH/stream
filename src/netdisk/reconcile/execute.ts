// executor（spec §4.8）:move 不 copy;只允许 mkdir/move/rename/remove。rename **只加 `SxxExx - ` 编号前缀**、
// 绝不写入标题（§4.2 和谐规避：分享者用规避字就是为了躲扫描，编号不触及它）。
// 每个动作先记溯源再动手(移错能查能撤);单条失败不中断整轮。
import { isObjectNotFound } from '../alist-client.ts'
import { PURE_CUT_DIR, type PlanAction, type RFile } from './plan.ts'
import type { ProvenanceLog } from './decisions.ts'

export interface ExecDeps {
  alist: {
    mkdir: (path: string) => Promise<void>
    move: (srcDir: string, dstDir: string, names: string[]) => Promise<void>
    /** 同目录改名（`FileShelf.rename`）。只用来加编号前缀，见头注。 */
    rename: (path: string, newName: string) => Promise<void>
    remove: (dir: string, names: string[]) => Promise<void>
    /** 删前核对用：单层（maxDepth 0）、refresh。与 `FileShelf.listDirRecursive` 同签名
     *  （含 `includeDirs`——空目录检查靠它看见"这一层还有个子目录"，不必递归找文件）。 */
    listDirRecursive: (path: string, maxDepth?: number, refresh?: boolean, includeDirs?: boolean) => Promise<{ name: string; size: number; isDir: boolean }[]>
  }
  provenance: ProvenanceLog
  /** 决定行的路径迁移（`DecisionStore.migratePath`）。**每搬成一份就调**——决定的组合键里
   *  拼着文件路径，搬完不迁，用户采纳过的裁决在新路径上全部跟丢、同一份文件二次出卡
   *  （2026-08-24 活体，见 migratePath 头注）。可选：影视一键去重那类没有决定语义的调用方不接。 */
  decisions?: { migratePath: (oldPath: string, newPath: string) => void }
  /** 本轮的 id，盖在这一轮写下的每一条溯源行上——`undoRun` 靠它把一轮当一个整体撤回来。
   *  缺席就不盖（老调用方、以及影视一键去重那类没有"一轮"概念的入口），那些行只能单条撤。 */
  runId?: string
  log: (m: string) => void
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

/**
 * 删是不可逆的（本地盘）或半可逆的（网盘回收站），而规划到执行之间文件可能被人动过：同名换了
 * 内容、或已经不在。删之前对目标目录单层 refresh 列一次，比 size；对不上就不删，返回一句
 * `stale: expected <size> got <size|missing>` 进错误行。搬不核——撞名 403 本来就会响。
 */
export async function staleBeforeRemove(
  alist: ExecDeps['alist'], path: string, size: number,
): Promise<string | null> {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const now = (await alist.listDirRecursive(dirOf(path), 0, true)).find((f) => !f.isDir && f.name === name)
  if (!now) return `stale: expected ${size} got missing`
  if (now.size !== size) return `stale: expected ${size} got ${now.size}`
  return null
}

export interface ExecOptions {
  /**
   * 允许执行**确认档**动作：删同集落选副本（`delete-loser`）与换正主（`replace`）。缺省 true；
   * **定时轮传 false**——这两类都是"比出来的"，删之前必须过一次人眼预览确认（spec 2026-07-31 §5），
   * autoExecute 也不例外。false 时这些行不调 remove、计入 `pending`（它们确实还等着人裁），
   * 下一轮照旧出现在预览里。
   * 字节全等的 `delete-dup` 不受这个开关管：那是"同一份文件"的硬判据，不需要比质量。
   * `delete-redundant`（免费集副本）同样不受管：它删的依据是"源站自己放得出这一集"，不是比出来的，
   * 用户 2026-08-01 拍板直接删（转存成本极低 + 夸克回收站兜底）。**唯一的例外**是规划器给它盖了
   * `noTrash`（货架自述没有回收站）：兜底没了，这条豁免的前提就不成立，跟落选副本同档进 pending。
   */
  losers?: boolean
  /** 本轮有文件搬出、搬完为空的目录删掉（只限严格在 `root` 之下、非 `root` 本身、非季目录 `S\d\d` 的目录）。
   *  分享转存落进 `<作品目录>/<分享子文件夹>/`，认领的集搬进季文件夹后那个壳就空了（spec §3.1）。 */
  cleanupEmptiedDirs?: { root: string }
}

export async function executePlan(plan: PlanAction[], deps: ExecDeps, opts: ExecOptions = {}) {
  const losers = opts.losers ?? true
  const res = { moved: 0, renamed: 0, deleted: 0, pending: 0, removedDirs: 0, errors: [] as string[] }
  /** 这一轮的每条溯源行都要盖上 runId，否则 `undoRun` 看不见它——写成一个口子，别逐处记得加。 */
  const rec = (e: Parameters<ProvenanceLog['record']>[0]) =>
    deps.provenance.record({ ...e, ...(deps.runId ? { runId: deps.runId } : {}) })
  /** 原 path → 改名后的 name。后面的 move 分组按它取名、拼路径——溯源里 rename 的 dst 与 move 的
   *  src 必须首尾相接，`undoRun` 才能倒着一步步走回原样。 */
  const renamedName = new Map<string, string>()
  const tryRename = async (src: RFile, newName: string, basis: string): Promise<boolean> => {
    const dir = dirOf(src.path)
    try {
      await deps.alist.rename(src.path, newName)
      rec({ action: 'rename', src: src.path, dst: `${dir}/${newName}`, size: src.size, basis })
      deps.decisions?.migratePath(src.path, `${dir}/${newName}`)
      renamedName.set(src.path, newName)
      res.renamed++
      return true
    } catch (e) {
      // 改名失败不断轮：文件留着旧名照搬（位置比名字重要），错误行记下，下一轮以 `rename` 动作再试。
      res.errors.push(`rename ${src.path}: ${(e as Error).message}`)
      return false
    }
  }
  // 换正主排在所有搬运之前：它删掉的那份正占着目标目录里的位置,先腾出来,后面的 move 才不会撞名。
  // 顺序在**单条之内**也是硬的——先 remove 旧的、再 move 新的（反过来同名必 403）。remove 失败就
  // 不搬了：旧的还在，搬进去只会再撞一次，错误行已经记下，下一轮重来。
  /** 换正主搬走之后腾空的源目录——`moveGroups` 收不到它（replace 的搬运不走那条分组），
   *  漏进候选集的话这一类分享子目录永远清不掉。 */
  const replacedFrom = new Set<string>()
  for (const a of plan) {
    if (a.kind !== 'replace') continue
    if (!losers) { res.pending++; continue }
    const oldDir = dirOf(a.oldPath)
    const oldName = a.oldPath.slice(a.oldPath.lastIndexOf('/') + 1)
    // 旧正主的体量在 compare 的并排数据里（planner 一定带上了它）——删前核对拿它当期望值，
    // 审计行也拿它答"删掉了多大一份"。**两个角色分开**：找不到就不能拿 0 去核对——那会把
    // "我不知道该是多大"报成 `expected 0 got N`（读起来像"文件变了"），错误行必须说真话。
    const oldSize = a.compare?.candidates.find((c) => c.path === a.oldPath)?.size
    try {
      if (oldSize == null) {
        res.errors.push(`delete ${a.oldPath}: stale: expected unknown（replace 没带 compare，拒删）`)
        continue
      }
      const stale = await staleBeforeRemove(deps.alist, a.oldPath, oldSize)
      if (stale) { res.errors.push(`delete ${a.oldPath}: ${stale}`); continue }
      await deps.alist.remove(oldDir, [oldName])
      rec({ action: 'delete', src: a.oldPath, size: oldSize, basis: a.basis })
      res.deleted++
    } catch (e) {
      res.errors.push(`delete ${a.oldPath}: ${(e as Error).message}`)
      continue
    }
    // 前缀加在源目录里（与 move 同待遇），但**排在删成功之后**：删被 stale / 无 compare 拒掉时
    // 这一条整个不发生，盘上那份文件的名字就该原封不动。反过来（先改名）会留下一次
    // "文件没搬、位置没变、名字却已经带上编号前缀"的半成品，而下一轮看到的是一个改过名的输入。
    if (a.newName) await tryRename(a.src, a.newName, a.basis)
    const srcDir = dirOf(a.src.path)
    if (srcDir === a.dstDir) continue // 新的本来就在目标目录里（同架换版）——只需要删掉旧的
    // 改名成了就按新名搬（源路径也跟着变），改名败了就按旧名——两处必须同源，否则 move 指着一个不存在的名字。
    const srcName = renamedName.get(a.src.path) ?? a.src.name
    const srcPath = `${srcDir}/${srcName}`
    try {
      await deps.alist.mkdir(a.dstDir)
      await deps.alist.move(srcDir, a.dstDir, [srcName])
      rec({ action: 'move', src: srcPath, dst: `${a.dstDir}/${srcName}`, size: a.src.size, basis: a.basis })
      deps.decisions?.migratePath(srcPath, `${a.dstDir}/${srcName}`)
      replacedFrom.add(srcDir)
      res.moved++
    } catch (e) {
      res.errors.push(`move ${srcDir}→${a.dstDir}: ${(e as Error).message}`)
    }
  }
  // 三种删同一条路：`delete-dup`(字节全等)、`delete-loser`(同集择优的落选副本)、
  // `delete-redundant`(免费集副本,源站自己能播)在执行面没有区别——都是先记溯源再 remove,
  // 失败进 errors 不断轮。区别只在 basis(为什么删)与要不要人点头(`losers` 只管中间那种),原样进账。
  //
  // **删排在搬前面**：换槽位（`move.evicts`）要在同一轮里做完，就得先让那个位置真的空出来。
  // 反过来（旧顺序）会先搬、撞上还在的同名文件 403——那正是过去只能压成 `swap-hold` 等下一轮
  // 的原因。代价是这一轮里删比搬更早落地；三种删各自的门槛没变（`losers` 照旧只管落选副本），
  // 夸克回收站仍然兜底。
  /** 没真删掉的占位者（跳过或失败）——等着它腾位的那条搬运必须跟着不跑，否则必撞名。 */
  const stillThere = new Set<string>()
  for (const a of plan) {
    if (a.kind === 'delete-loser' && !losers) { res.pending++; stillThere.add(a.src.path); continue }
    // 免费集副本平时不受 `losers` 管（见 ExecOptions 头注）——**除非这份货架没有回收站**
    // （规划器盖的 `noTrash`）：那条豁免的底气就是"删错了还捞得回来"，捞不回来就跟落选副本同档。
    if (a.kind === 'delete-redundant' && a.noTrash && !losers) { res.pending++; stillThere.add(a.src.path); continue }
    if (a.kind === 'delete-dup' || a.kind === 'delete-loser' || a.kind === 'delete-redundant') {
      try {
        const stale = await staleBeforeRemove(deps.alist, a.src.path, a.src.size)
        if (stale) { res.errors.push(`delete ${a.src.path}: ${stale}`); stillThere.add(a.src.path); continue }
        await deps.alist.remove(dirOf(a.src.path), [a.src.name])
        rec({ action: 'delete', src: a.src.path, size: a.src.size, basis: a.basis })
        res.deleted++
      } catch (e) {
        res.errors.push(`delete ${a.src.path}: ${(e as Error).message}`)
        stillThere.add(a.src.path)
      }
    } else if (a.kind === 'pending') res.pending++
  }
  // 改名：原地 `rename` 动作，以及带 `newName` 的 move 先在源目录改名。排在搬之前是因为
  // 名字要在**源目录**里改完，move 那一批才能按新名字整批递过去（AList 的 move 只收名字列表）。
  for (const a of plan) {
    if (a.kind === 'rename') await tryRename(a.src, a.newName, a.basis)
    // 等位那条本轮不跑（占位者还在），名字也别改：改了它下一轮就不再是账本里那份文件。
    else if (a.kind === 'move' && a.newName && !(a.evicts && stillThere.has(a.evicts))) await tryRename(a.src, a.newName, a.basis)
  }
  // move 按 (srcDir → dstDir) 分组批量执行（AList move 是批量 API）
  const moveGroups = new Map<string, { srcDir: string; dstDir: string; files: RFile[] }>()
  for (const a of plan) {
    if (a.kind !== 'move') continue
    // 前置那一步没做成 → 这条不跑，本轮计入 pending，位置还占着，下一轮重来。
    if (a.evicts && stillThere.has(a.evicts)) {
      res.pending++
      continue
    }
    const srcDir = dirOf(a.src.path)
    const gk = `${srcDir} ${a.dstDir}`
    const g = moveGroups.get(gk) ?? { srcDir, dstDir: a.dstDir, files: [] }
    // 改名成了就整条按新名走（name + path 一起换）：这一批往下的每一步——递给 move 的名字、
    // 溯源的 src、迁决定键、失败回读的比对——都读这一份，只换一半就会两边指着不同的文件。
    const renamed = renamedName.get(a.src.path)
    g.files.push(renamed ? { ...a.src, name: renamed, path: `${srcDir}/${renamed}` } : a.src)
    moveGroups.set(gk, g)
  }
  const basisOf = new Map(plan.filter((a) => a.kind === 'move').map((a) => {
    const renamed = renamedName.get(a.src.path)
    return [renamed ? `${dirOf(a.src.path)}/${renamed}` : a.src.path, (a as { basis: string }).basis]
  }))
  for (const g of moveGroups.values()) {
    try {
      await deps.alist.mkdir(g.dstDir)
      await deps.alist.move(g.srcDir, g.dstDir, g.files.map((f) => f.name))
      for (const f of g.files) {
        rec({ action: 'move', src: f.path, dst: `${g.dstDir}/${f.name}`, size: f.size, basis: basisOf.get(f.path) ?? '' })
        deps.decisions?.migratePath(f.path, `${g.dstDir}/${f.name}`)
        res.moved++
      }
    } catch (e) {
      // 批量 API 一个失败整批抛，但可能已经搬走了几份。回读源目录：不在的就是搬成了——
      // 不记溯源、不迁决定键，下一轮它们在新路径上出现时人裁过的决定全部跟丢（2026-08-24 那类）。
      let stillHere: Set<string> | null
      try {
        stillHere = new Set((await deps.alist.listDirRecursive(g.srcDir, 0, true)).map((f) => f.name))
      } catch (le) {
        // 源目录整个没了 = 这一批全搬走了；其他回读错误说明"现状读不到"，只能保持旧行为。
        stillHere = isObjectNotFound(String((le as Error).message)) ? new Set() : null
      }
      if (stillHere === null) { res.errors.push(`move ${g.srcDir}→${g.dstDir}: ${(e as Error).message}`); continue }
      const failed: string[] = []
      for (const f of g.files) {
        if (stillHere.has(f.name)) { failed.push(f.name); continue }
        rec({ action: 'move', src: f.path, dst: `${g.dstDir}/${f.name}`, size: f.size, basis: basisOf.get(f.path) ?? '' })
        deps.decisions?.migratePath(f.path, `${g.dstDir}/${f.name}`)
        res.moved++
      }
      if (failed.length) res.errors.push(`move ${g.srcDir}→${g.dstDir}: ${(e as Error).message}（未搬成：${failed.join(', ')}）`)
    }
  }
  // 搬空的分享子目录清掉。候选只取**本轮真搬过东西的源目录**：没动过的空目录不是这一轮造成的，
  // 不归这里管（顺手删掉别人的目录，撤销时也无从还原它原本装着什么）。
  if (opts.cleanupEmptiedDirs) {
    const root = opts.cleanupEmptiedDirs.root.replace(/\/$/, '')
    const candidates = new Set([...[...moveGroups.values()].map((g) => g.srcDir), ...replacedFrom])
    for (const dir of candidates) {
      // 根目录（作品目录本身）、季目录、纯享货架（`纯享/` 与它下面的 `S<nn>/`）都是归档结构的
      // 一部分，空了也留着：下一轮还要往里搬。删了只是下一轮再建一次，撤销时还无从还原它装过什么。
      // `纯享/S<nn>` 的叶子名就是 `S<nn>`，已被下面那条正则覆盖，这里只需再认一层 `纯享` 自己。
      const leaf = dir.slice(dir.lastIndexOf('/') + 1)
      if (dir === root || !dir.startsWith(`${root}/`) || leaf === PURE_CUT_DIR || /^S\d{2}$/.test(leaf)) continue
      try {
        // refresh 真列一次：本轮之外还可能有别的东西在里面（.nfo、字幕、没认领的集），删错就是删用户的文件。
        //
        // **单层（maxDepth 0）+ includeDirs:true，不是递归深挖**：只看这一层，但把目录条目本身也
        // 算进来——「只剩一个 `花絮/` 子目录」的目录，这一层就能看见"花絮"这一条目录行，不必递归
        // 进去找文件（子目录本身可能是空的，递归找不到文件不等于这一层没东西）。任何一条返回
        // （文件或目录）都算"还有东西"。
        const left = await deps.alist.listDirRecursive(dir, 0, true, true)
        if (left.length) continue
        await deps.alist.remove(dirOf(dir), [dir.slice(dir.lastIndexOf('/') + 1)])
        rec({ action: 'rmdir', src: dir, size: 0, basis: 'emptied-share-dir' })
        res.removedDirs++
      } catch (e) {
        res.errors.push(`rmdir ${dir}: ${(e as Error).message}`)
      }
    }
  }
  return res
}

/**
 * 整轮撤销：按写入倒序，move 搬回、rename 改回、rmdir 重建；delete 撤不了（回收站自己捞）只计数。
 *
 * **必须倒序**：这一轮里同一份文件可能先改名再搬走，正序撤会拿旧名字去搬一个已经改过名的文件。
 * 单条失败记日志继续，不中断——能撤的先撤回来，比"一条卡住整轮停在半路"好。
 */
export async function undoRun(runId: string, deps: ExecDeps): Promise<{ undone: number; skipped: number }> {
  const out = { undone: 0, skipped: 0 }
  for (const e of [...deps.provenance.listByRun(runId)].reverse()) {
    if (e.undone) continue
    if (e.action === 'delete') { out.skipped++; continue }
    try {
      if (e.action === 'move' && e.dst) {
        await deps.alist.move(dirOf(e.dst), dirOf(e.src), [e.dst.split('/').pop()!])
        deps.decisions?.migratePath(e.dst, e.src)
      } else if (e.action === 'rename' && e.dst) {
        await deps.alist.rename(e.dst, e.src.split('/').pop()!)
        deps.decisions?.migratePath(e.dst, e.src)
      } else if (e.action === 'rmdir') {
        await deps.alist.mkdir(e.src)
      } else continue
      deps.provenance.markUndone(e.id)
      out.undone++
    } catch (err) {
      deps.log(`[reconcile] undoRun ${runId}: ${e.action} ${e.src} 撤不回：${(err as Error).message}`)
    }
  }
  return out
}

export async function undoMove(provenanceId: string, deps: ExecDeps): Promise<void> {
  const e = deps.provenance.get(provenanceId)
  if (!e) throw new Error(`no provenance entry: ${provenanceId}`)
  // 单条撤销只受理"挪过位置的"（move / rename）——删和 rmdir 的单条撤回没有意义：前者要去回收站捞，
  // 后者单独重建一个空目录并不还原任何东西（整轮撤走 `undoRun`）。
  if ((e.action !== 'move' && e.action !== 'rename') || !e.dst) throw new Error('cannot undo a delete（夸克回收站自行捞）')
  if (e.undone) throw new Error(`already undone: ${provenanceId}`)
  if (e.action === 'rename') {
    await deps.alist.rename(e.dst, e.src.split('/').pop()!)
    deps.decisions?.migratePath(e.dst, e.src)
    deps.provenance.markUndone(provenanceId)
    return
  }
  await deps.alist.move(dirOf(e.dst), dirOf(e.src), [e.dst.split('/').pop()!])
  deps.decisions?.migratePath(e.dst, e.src) // 撤销把文件搬回去——决定行也得跟回去，方向相反同一条理
  deps.provenance.markUndone(provenanceId)
}
