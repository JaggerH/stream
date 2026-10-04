/**
 * 「就地开一次整理」——把一条订阅和一堆网盘来源目录接起来（spec 2026-08-25-reconcile-as-conversation §4.2）。
 *
 * **为什么是一把复合工具，不是三把散的写工具。** 开一次整理不是一个动作，是四步，而且顺序不能乱：
 *
 *  1. 建两个货架目录（认领 / 下架）；
 *  2. 建或复用绑定（认领货架的主人）；
 *  3. 给订阅补一条扫**下架目录**的 `alist` 来源——**缺了它，判为下架的文件搬过去没人扫得到，
 *     等于在用户那边直接消失**；
 *  4. 写整理配置。
 *
 * 这四步单独拿出来**每一步都能把用户数据弄乱**，而它们**只有按顺序一起做才有意义**。拆成三把
 * 工具交给模型编排，编排错了不会报错——它会安静地留下半个状态（最贵的那个半成品：绑定建好了、
 * 下架来源没补，于是整理照跑，下架的文件搬进一个没人扫的目录）。
 *
 * **失败要回滚到进来之前**。原来那条前端路径只回收绑定（`create` 成功、`putConfig` 400 之后
 * 留下一条孤儿绑定，用户改一改重交就变成双绑定双自动同步）；这里连成员表一起还原——补了一条
 * 来源却没写成配置，那条来源就是个扫着空目录的幽灵成员。
 *
 * **幂等**：模型会重试、会把同一句话说两遍。同一条订阅再开一次 = 复用它已有的绑定与 show，
 * 只把来源目录换成这一次给的（**替换不是追加**——"整理这个目录"说的是这一次要整理什么，
 * 不是往一份长期名单里加一项；来源目录本来就不该是长期名单，见 spec §1）。
 */

/** 一条订阅（只读这几样）。 */
export interface OpenStream {
  id: string
  label?: string
  members: { plugin: string; source: string; params?: Record<string, unknown> }[]
}

/** 一条绑定（只读这几样）。 */
export interface OpenBinding {
  id: string
  left: { kind: string; streamId?: string }
  right: { path: string }
}

/**
 * 一份整理配置里这里认得的那几个字段。
 *
 * **`putShows` 是整份写回，别的 show 身上的字段（尤其 `identity` 那个规则覆盖）必须原样活着。**
 * 这里只碰自己要改的那一条，其余靠 `...s` 原样带过——**别改成逐字段重建**，那会静默剥掉别人的
 * 覆盖（配置还在、规则变回默认，两边单看都正常）。类型上看不出这条约束，由 open.test.ts 里
 * 「不碰别人的 show」那条守着。
 */
export interface OpenShow {
  id: string
  bindingId: string
  sourceDirs?: string[]
  subShows?: unknown[]
  autoExecute?: boolean
}

export interface OpenReconcileDeps {
  getStream: (streamId: string) => OpenStream | undefined
  /** 整份成员表覆盖写（PATCH 语义在调用方，这里给的就是新的全量）。 */
  putMembers: (streamId: string, members: OpenStream['members']) => void
  listBindings: () => OpenBinding[]
  bind: (a: { streamId: string; title: string; dirPath: string }) => Promise<{ id: string }>
  removeBinding: (id: string) => void
  mkdir: (path: string) => Promise<void>
  getShows: () => OpenShow[]
  /** 整份写回（`ReconcileService.putConfig` 的语义）。校验失败会抛。 */
  putShows: (shows: OpenShow[]) => void
}

export interface OpenReconcileInput {
  streamId: string
  /** 这一次要整理的来源目录（绝对 AList 路径）。至少一个。 */
  sourceDirs: string[]
  /** 节目名——只在**新建**绑定/货架时用来拼目录名；缺省取订阅显示名。 */
  label?: string
}

export interface OpenReconcileResult {
  showId: string
  bindingId: string
  sourceDirs: string[]
  shelves: { claimed: string; offline: string }
  /** 这一次真的新建了什么（复用的那些为 false）——回执要说清"我动了什么"，别让人事后去猜。 */
  created: { binding: boolean; offlineSource: boolean; show: boolean }
}

/** 来源目录的挂载根（`/quark/来自：分享/x` → `/quark`）——派生的货架必须与来源同盘，跨盘搬运不成立。 */
export function mountRootOf(dir: string): string {
  const seg = dir.split('/').filter(Boolean)[0]
  return seg ? `/${seg}` : ''
}

/** 认领货架的约定地址：`<挂载根>/From Stream/<节目名>/付费`。 */
export function claimedShelfFor(sourceDir: string, label: string): string {
  const root = mountRootOf(sourceDir.trim())
  if (!root || !label.trim()) throw new Error(`派生不出货架地址：sourceDir='${sourceDir}' label='${label}'`)
  return `${root}/From Stream/${label.trim()}/付费`
}

/** 下架货架 = 认领货架的同级 `下架`。判为下架的集搬去那儿，不是删掉。 */
export function offlineShelfFor(claimed: string): string {
  return `${claimed.slice(0, claimed.lastIndexOf('/'))}/下架`
}

/** streamId → 唯一 show id：清成 slug，撞了就加数字后缀。 */
export function showIdFor(streamId: string, existingIds: readonly string[]): string {
  const base = streamId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'show'
  if (!existingIds.includes(base)) return base
  let n = 2
  while (existingIds.includes(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export class OpenReconcileError extends Error {}

/**
 * 开一次整理。见文件头注的四步与回滚约定。
 * @param deps - 注入的原语（网盘 / 绑定 / 订阅成员 / 整理配置）。
 * @param input - 订阅 + 这一次的来源目录。
 * @returns 这次接起来的 show / binding / 两个货架地址 + 到底新建了什么。
 */
export async function openReconcile(
  deps: OpenReconcileDeps,
  input: OpenReconcileInput,
): Promise<OpenReconcileResult> {
  const sourceDirs = input.sourceDirs.map((d) => d.trim()).filter(Boolean)
  if (!sourceDirs.length) throw new OpenReconcileError('至少要给一个来源目录')
  const stream = deps.getStream(input.streamId)
  if (!stream) throw new OpenReconcileError(`订阅不存在：${input.streamId}`)
  const label = (input.label ?? stream.label ?? input.streamId).trim()

  // 复用优先：这条订阅已经有绑定就用它的落地目录当认领货架，**不按约定重新派生**——
  // 派生出的地址和用户当初手选的地址往往不是一个，重新派生等于把货架搬走，架上的文件全成孤儿。
  const existingBinding = deps.listBindings()
    .find((b) => b.left.kind === 'stream' && b.left.streamId === input.streamId)
  const claimed = existingBinding ? existingBinding.right.path : claimedShelfFor(sourceDirs[0], label)
  const offline = offlineShelfFor(claimed)

  const undo: (() => void)[] = []
  try {
    // ① 货架目录（mkdir 幂等）。先建出来，绑定一建好就会立刻拿它去同步。
    await deps.mkdir(claimed)
    await deps.mkdir(offline)

    // ② 绑定
    let bindingId: string
    let createdBinding = false
    if (existingBinding) {
      bindingId = existingBinding.id
    } else {
      bindingId = (await deps.bind({ streamId: input.streamId, title: label, dirPath: claimed })).id
      createdBinding = true
      undo.push(() => deps.removeBinding(bindingId))
    }

    // ③ 下架来源。**已经挂着网盘目录的就不动它**——那可能是用户自己指到别处的，这里不越权改；
    //    真相源是成员表本身（`offlineDirOf` 读的也是它），不是我们刚算出来的那个路径。
    let createdOfflineSource = false
    if (!stream.members.some((m) => m.plugin === 'alist')) {
      const before = stream.members
      deps.putMembers(input.streamId, [...before, { plugin: 'alist', source: 'alist-audio', params: { path: offline } }])
      createdOfflineSource = true
      undo.push(() => deps.putMembers(input.streamId, before))
    }

    // ④ 整理配置。同一条绑定已有 show 就替换它的来源目录（幂等，见头注）。
    const shows = deps.getShows()
    const mine = shows.find((s) => s.bindingId === bindingId)
    const showId = mine ? mine.id : showIdFor(input.streamId, shows.map((s) => s.id))
    deps.putShows(
      mine
        ? shows.map((s) => (s.id === mine.id ? { ...s, sourceDirs } : s))
        // `autoExecute: false` 恒定——**这里不给开自动执行的口子**。开任务和"不确认就动网盘
        // 文件"是两件事，后者的边界是实测出来的（08-24 spec §5：无人环不开）。
        : [...shows, { id: showId, bindingId, sourceDirs, subShows: [], autoExecute: false }],
    )

    return {
      showId,
      bindingId,
      sourceDirs,
      shelves: { claimed, offline },
      created: { binding: createdBinding, offlineSource: createdOfflineSource, show: !mine },
    }
  } catch (e) {
    // 倒着撤，且**每一步的失败都吞掉**：回滚里再抛会把真正的失败原因盖掉，那才是排查时最要命的。
    for (const step of undo.reverse()) {
      try { step() } catch { /* 回滚尽力而为——真因是外面那个 e */ }
    }
    throw e
  }
}
