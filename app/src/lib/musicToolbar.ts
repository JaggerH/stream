import type { ChannelView, ChannelStream } from './types.ts'

/**
 * 音乐 L2 顶部工具栏的决策层。
 *
 * 工具栏台面上恒定只有「播放全部 / 多选 / ⋯」三件——三种列表(普通歌单/播单/我喜欢的)
 * 一模一样，差异全部沉进 ⋯ 菜单。菜单项按「能力在不在」出现，而不是按列表类型换一套：
 * 播单和「我喜欢的」背后没有 stream，同步源、挂载目标、整理对象都无从谈起，所以这三项
 * 是真的不存在，不是被藏起来了。
 *
 * 决策抽在这里而不是写在 JSX 里，是因为 Radix 菜单在 jsdom 下用 fireEvent.click 展不开
 * (它监听 pointerdown，仓库没有 user-event)，靠渲染断言测不到菜单内容。
 */

export type ToolbarMenuEntry =
  | { kind: 'item'; key: string; label: string; destructive?: boolean }
  | { kind: 'checkbox'; key: string; label: string; checked: boolean }
  | { kind: 'separator'; key: string }

/** 每个字段 = 一项能力在不在。null / false 一律表示这个列表压根没有这项能力。 */
export type ToolbarCaps = {
  downloadAll: boolean
  sync: { on: boolean } | null
  /**
   * 「网盘」——**一项**，打开这条订阅的网盘全景面板。
   *
   * 别在菜单里再拆出第二项网盘动作。用户在点之前根本分不清自己要哪个（"网盘文件直接当新节目"
   * 还是"网盘文件补到节目单已有的某一集上"），把这道选择题摆进菜单等于甩给他，而面板自己
   * 答得出来（见 `NetdiskAdvice`）。
   */
  netdisk: boolean
  rename: boolean
  remove: boolean
  /** 「生成 m3u」——只读 AudioArchive 现状导出播放列表,与 sync(自动下载)彻底解耦。 */
  exportM3u: boolean
}

export function toolbarMenuItems(caps: ToolbarCaps): ToolbarMenuEntry[] {
  // 上组 = 对内容做事，下组 = 对这个列表本身做事(改名/删掉)。分隔线只在两组都非空时出现,
  // 否则会在菜单顶部或底部留一条无意义的横线。
  const content: ToolbarMenuEntry[] = []
  if (caps.downloadAll) content.push({ kind: 'item', key: 'downloadAll', label: '下载整单' })
  if (caps.sync) content.push({ kind: 'checkbox', key: 'sync', label: '自动下载新曲目', checked: caps.sync.on })
  if (caps.netdisk) content.push({ kind: 'item', key: 'netdisk', label: '网盘' })
  if (caps.exportM3u) content.push({ kind: 'item', key: 'exportM3u', label: '生成 m3u' })

  const manage: ToolbarMenuEntry[] = []
  if (caps.rename) manage.push({ kind: 'item', key: 'rename', label: '重命名' })
  if (caps.remove) manage.push({ kind: 'item', key: 'remove', label: '删除播单', destructive: true })

  if (content.length === 0) return manage
  if (manage.length === 0) return content
  return [...content, { kind: 'separator', key: 'sep' }, ...manage]
}

/**
 * 「这个列表当前在显示哪些行」——只有一条判定规则，被「下载整单」和 L2 搜索过滤共用。
 * 优先级：collectionRows(播单成员) > scopeRows(chip 收窄的歌单成员) > 都没有时按
 * isLikedPlaylist 落到 likedRows 或 tableRows。注意 `??` 语义：非 null 但空的数组也算
 * "有值"，直接赢，不会继续往后落——一个空播单必须下载 0 首，不能掉回整条 stream 的曲目。
 * 抽成单一函数是因为这条规则曾经在两处各写一份 `??` 链，两份一旦手改跑偏，「下载整单」
 * 就会悄悄操作一批和列表实际显示不一致的曲目。
 */
export function pickListRows<R>(ctx: {
  collectionRows: R[] | null
  scopeRows: R[] | null
  isLikedPlaylist: boolean
  likedRows: R[]
  tableRows: R[]
}): R[] {
  return ctx.collectionRows ?? ctx.scopeRows ?? (ctx.isLikedPlaylist ? ctx.likedRows : ctx.tableRows)
}

export type DownloadAllPlan = { kind: 'stream'; streamId: string } | { kind: 'rows' }

/**
 * 「下载整单」走哪条路。整单端点(一次请求)只在"这个列表就是一整个 stream"时成立;
 * chip 收窄、播单、我喜欢的都只能逐行下——它们的成员来自别处，整单端点表达不了。
 */
export function planDownloadAll(ctx: {
  isCollection: boolean
  isLikedPlaylist: boolean
  scopeId: string | null
  streamId: string | null
}): DownloadAllPlan {
  if (ctx.isCollection || ctx.isLikedPlaylist || ctx.scopeId || !ctx.streamId) return { kind: 'rows' }
  return { kind: 'stream', streamId: ctx.streamId }
}

export type ExportTarget = { kind: 'stream'; id: string } | { kind: 'collection'; id: string } | null

/**
 * 「生成 m3u」导出谁——Stream 还是 Collection。我喜欢的(isLikedPlaylist)v1 不接这个功能
 * （它虽然底层也是个系统 Collection，但前端目前走的是独立的 likedTracks 状态，不经过
 * collectionItems，这里不强行接上），任一该有的 id 还没到货也不导出。
 */
export function planExportTarget(ctx: {
  isCollection: boolean
  isLikedPlaylist: boolean
  streamId: string | null
  collectionId: string | null
}): ExportTarget {
  if (ctx.isLikedPlaylist) return null
  if (ctx.isCollection) return ctx.collectionId ? { kind: 'collection', id: ctx.collectionId } : null
  return ctx.streamId ? { kind: 'stream', id: ctx.streamId } : null
}

/** 按 id 在所有 channel 的 streams 里找一条——集中成一处,别在每个调用点各自
 *  `channels.flatMap(t => t.streams).find(...)` 重写一遍查找逻辑。`ChannelStream` 的 TS 类型缺
 *  运行时才有的 `options` 字段(已知缺口,不在本次修复范围),这里统一做窄化 cast，调用方不用
 *  各自 cast。 */
export function findStream(channels: ChannelView[], id: string | null | undefined): (ChannelStream & { options?: Record<string, unknown> }) | undefined {
  if (!id) return undefined
  return channels.flatMap((t) => t.streams).find((s) => s.id === id) as (ChannelStream & { options?: Record<string, unknown> }) | undefined
}

/** L2 进入时「自动下载新曲目」开关的初始值——必须读 Stream 的真实 options，不能硬编码。之前
 *  这里被写成无条件 setSync(false)，UI 永远显示"关"、跟后端真实状态对不上（2026-08-03 修）。 */
export function autoDownloadEnabled(stream: { options?: Record<string, unknown> } | null | undefined): boolean {
  return !!(stream?.options as { autoDownload?: boolean } | undefined)?.autoDownload
}

/**
 * 「这一批要下哪些行、又有几行下不了」——「下载整单」和「多选下载」共用的同一次划分。
 *
 * 多选那一路必须传 selectedIds，且传进来的 rows 必须是**没过搜索框**的整份列表：
 * 浮动条上写的「已选 N 首」数的是 selectedIds 本身，如果这里改用搜索收窄后的行，
 * 用户勾了 10 首、再在搜索框里打两个字把 6 首藏起来，点下载就只下 4 首而提示里
 * 一个字都不解释——动作作用的集合必须和台面上那个数字说的是同一批。
 *
 * canDownload 用参数传进来而不是 import 组件里的判据，是为了让本文件不依赖组件类型
 * (同 pickListRows 的泛型写法)。
 *
 * selection 的 ids 和 idOf 捆成一个成员而不是两个独立的可选参数——分开传时，调用方漏传
 * idOf 会静默过滤成 0 个 target（`ids.has('')` 恒假），不会报错、也不会崩，只会在运行时
 * 悄悄"选中了却一个都下不了"。捆成一个成员后，传 selection 就必须同时给 idOf，TypeScript
 * 在调用点直接报错，这类误用连编译都过不了。
 */
export function pickDownloadTargets<R>(ctx: {
  rows: R[]
  canDownload: (row: R) => boolean
  selection?: { ids: ReadonlySet<string>; idOf: (row: R) => string } | null
}): { targets: R[]; skipped: number } {
  const sel = ctx.selection
  const candidates = sel ? ctx.rows.filter((r) => sel.ids.has(sel.idOf(r))) : ctx.rows
  const targets = candidates.filter(ctx.canDownload)
  return { targets, skipped: candidates.length - targets.length }
}

/**
 * 批量下载跑完之后说人话。
 *
 * 之所以是「跑完之后」：以前是发请求的同一刻就弹绿字「已加入下载队列：N 首」，
 * 后端挂着的时候用户会先看到这条绿的、再被 N 条红的失败盖住——那条绿字承诺的是
 * 意图不是结果。现在只报真正入队成功的数目，失败和「没有可下载来源」各自点名。
 */
export function downloadBatchMessage(n: {
  succeeded: number
  failed: number
  skipped: number
  /** 后端认定"已经下载好了"因而没有排队的数目——和 skipped(压根没有可下载来源)不是一回事,
   *  用户看到的是两种完全不同的处境:一个是"你已经有了",一个是"这首拿不到"。 */
  archived?: number
}): {
  kind: 'success' | 'error'
  text: string
} {
  const archived = n.archived ?? 0
  const notes: string[] = []
  if (n.failed > 0) notes.push(`${n.failed} 首失败`)
  if (archived > 0) notes.push(`${archived} 首已下载过`)
  if (n.skipped > 0) notes.push(`${n.skipped} 首无可下载来源`)
  const tail = notes.length ? `（${notes.join('，')}）` : ''
  if (n.succeeded > 0) return { kind: 'success', text: `已加入下载队列：${n.succeeded} 首${tail}` }
  // 一首都没排上队,但**什么都没失败**——那就不是失败,只是没事可做。红字要留给真出了错的时候,
  // 否则「这些你早就下过了」会被显示成一次故障,用户会去查根本不存在的问题。
  if (n.failed === 0) {
    if (archived > 0 && n.skipped === 0) return { kind: 'success', text: `这 ${archived} 首都已经下载过了` }
    return { kind: 'success', text: `没有需要下载的${tail}` }
  }
  return { kind: 'error', text: `加入下载队列失败${tail}` }
}
