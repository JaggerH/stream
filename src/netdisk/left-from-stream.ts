import type { StoredItem } from '../item-store.ts'
import type { Item } from '../content/types.ts'
import { extractTrackRef } from '../audio/ref.ts'
import type { LeftEntry } from './sync.ts'

/**
 * 订阅流那一支左侧的两个读法（绑定 / 归档权威），从 bootstrap 的接线层搬出来。
 * 依赖只有「按 streamId 取这条流的条目」——注入，便于单测造夹具，不拖 ItemStore 进来。
 */
export interface StreamLeftDeps {
  /** 这条流的条目，**按入库顺序（asc）**。取数本身要 newest-first + `AUTHORITY_ITEM_LIMIT` 再倒回来，
   *  接线层负责（见 `kernel/plugins/netdisk.ts`）——`order:'asc'` 直接配 limit 丢的是最新入库的那批。 */
  recentItems: (streamId: string) => StoredItem[]
}

/** 权威清单一次最多取的条目数。到顶就申报 `truncated`——清单不全时归档器不许把"清单里没有它"当结论。 */
export const AUTHORITY_ITEM_LIMIT = 5000

/** 权威清单 + 它自己对"全不全"的申报。`source` 是取数口的名字，进账本：数字旁边写尺子。 */
export interface AuthorityListing {
  entries: LeftEntry[]
  /** 取数撞上了 `AUTHORITY_ITEM_LIMIT`，后面还有——**缺席**表示"全"，别写 false。
   *  判据看的是**取回来多少条**，不是过滤后 `entries` 有多少：货架层/muted 剔完之后条数天然少于上限，
   *  照 `entries.length` 判就永远说不出"不全"。 */
  truncated?: true
  source: string
}

/**
 * 权威支的依赖。**不 extends `StreamLeftDeps`**：两支的 `recentItems` 契约已经不同——
 * 绑定那支要 asc 全量，权威这支要 newest-first + limit（见下）。
 */
export interface AuthorityDeps {
  /** **newest-first**、最多 `limit` 条（`itemStore.recent({ stream, limit })` 的默认顺序）。
   *  倒序取是因为上限截断时丢的必须是最老的：asc + limit 丢的是最新入库的那一批。 */
  recentItems: (streamId: string, limit: number) => StoredItem[]
  /**
   * 这条 stream 上**网盘成员**（`alist`）产出条目的 canonical source id 集合，
   * 由成员表算出（不硬编码前缀）。没有网盘成员 → 空集。
   */
  shelfSourceIds: (streamId: string) => ReadonlySet<string>
}

/**
 * **绑定**用的左侧：只对齐「源站放不出的付费集」。
 * 与下面的权威清单是两支、故意不同——差异的 why 见 `authorityFromStream` 的头注。
 */
export function bindingLeftFromStream(deps: StreamLeftDeps): (streamId: string) => LeftEntry[] {
  return (streamId) =>
    deps.recentItems(streamId).flatMap((item) => {
      if (item.muted) return []
      // Align only episodes the SOURCE itself can't play (paid / app-exclusive → no
      // enclosure). Free episodes play from the origin, so aligning them to the netdisk is
      // off-goal — the netdisk exists as the fallback for exactly the un-playable ones.
      const raw = (item as { raw?: { enclosure_url?: unknown; link?: unknown } }).raw
      if (raw?.enclosure_url) return []
      const media = ((item as unknown as Item).content?.media ?? []) as Array<{ kind?: string; duration_s?: number }>
      // leftKey from the normalized media only — facility/track_id come from mapping.track_id
      // + the package's facility at normalize time (see content/normalize.ts), never guessed
      // back out of a raw URL here.
      const ref = extractTrackRef(item as unknown as Item)
      // paid 一路带到绑定左侧（SpecLeft.paid）。**认集不读它**；唯一用途是归档器的删除闸——
      // paid 集的字节全等副本降级成确认档、定时轮永不自动删，见 LeftEntry.paid 的头注。
      const paid = (item as unknown as Item).content?.paid === true || undefined
      if (ref?.id) {
        return [{ leftKey: `${ref.platform}:${ref.id}`, title: item.title ?? ref.id, durationS: media[0]?.duration_s, paid }]
      }
      // No audio/podcast track ref → a generic episode (video 分集 / vod). listLeft only runs
      // for streams the user EXPLICITLY bound, so keying by item id here is scoped to aligned
      // streams. Gate on "no audio media" so audio playlists keep their track-only left set;
      // the title drives the epnum/title match against netdisk filenames.
      const hasAudio = media.some((m) => m.kind === 'audio')
      if (!hasAudio && item.title) {
        return [{ leftKey: `item:${item.id}`, title: item.title, durationS: media[0]?.duration_s, paid }]
      }
      return []
    })
}

/**
 * **归档器**用的权威清单 = 这条流的**节目单层**：站外来的那些条目，「源站到底有哪些集」的全量。
 *
 * 一条 stream = 节目单层（站外来的条目）⊎ 货架层（网盘成员产出的条目）。权威只取节目单层——
 * 货架进节目单 = 把答案抄进题目：下架货架是一个挂在同一条 stream 上的 `alist` 成员（有意挂的，
 * 下架集本身就得是可播条目），采集会把货架文件写回库；权威若照单全收，自己刚挪去下架的文件
 * 下一轮就以「节目单上的一集」身份回流，归档器再也判不出它已下架。剔的只是「进不进权威」，
 * **不是拆成员**——货架层照常是可播条目、照常在 UI 里。
 *
 * 权威 ≠ 绑定的左侧：绑定只对齐「源站放不出的付费集」（`bindingLeftFromStream` 滤掉带 enclosure
 * 的免费集），而归档判「下架」的依据是「RSS 里有没有这一集」——必须用全量条目。首轮活体就
 * 栽在这：免费集被判「权威没有」、236 条错分下架（2026-07-24）。
 *
 * 清单**自己申报全不全**（`truncated`）：条目数到 `AUTHORITY_ITEM_LIMIT` 就说明后面还有，
 * 而归档器判「下架」用的正是「清单里没有它」——清单不全时那句话是错的，下游据此设闸。
 */
export function authorityFromStream(deps: AuthorityDeps): (streamId: string) => AuthorityListing {
  return (streamId) => {
    const shelf = deps.shelfSourceIds(streamId)
    // 多要一条：拿到 limit+1 就说明后面还有。截断丢的必须是最老的，所以倒序取、再倒回来。
    const newestFirst = deps.recentItems(streamId, AUTHORITY_ITEM_LIMIT + 1)
    const truncated = newestFirst.length > AUTHORITY_ITEM_LIMIT
    const entries = newestFirst
      .slice(0, AUTHORITY_ITEM_LIMIT)
      .reverse() // 回到入库顺序：消费方（账本、UI）按这个顺序读清单
      // 取节目单层：来源不在货架名册里的就是站外来的那些。source_id 缺失（字段引入前落的盘）
      // 天然留在节目单层——老条目本就没有网盘成员这回事。
      .filter((it) => !shelf.has(it.source_id ?? ''))
      .filter((it) => !it.muted && it.title)
      // 带上时长：归档器判「这一集源站还在不在」靠的是时长而非标题——标题会被规避字和
      // 错编号搅浑（`四谈`vs`十四谈` 是不同集却只差一字，`木仓下留人`vs`枪下留人` 是同一集
      // 却差两字），时长是内容自带的、不受命名影响。源站免费给，白拿。
      // `paid` 原样带出来**只为解释原因**（账本/证据卡上那句「源站要钱」）。判定层一个字都不读它，
      // 处置层也不读——「网盘这份要不要留」问的是 `needsSupply`，见下。
      .map((it) => ({
        leftKey: `item:${it.id}`,
        title: it.title!,
        durationS: (it.content?.media ?? []).flatMap((m) => (m.kind === 'audio' && m.duration_s ? [m.duration_s] : []))[0],
        paid: it.content?.paid === true,
        needsSupply: !hasPlayableMedia(it),
      }))
    return { entries, source: `stream:${streamId}`, ...(truncated ? { truncated: true as const } : {}) }
  }
}

/**
 * 这一集**自己带没带一个能直接放的地址**。它是 `needsSupply` 的唯一判据（取反）。
 *
 * **默认必须是「要供货」**：删不可逆、留着只占空间，所以只有**看见**一个自带可播地址的媒体项
 * 才敢说「不用供货」。反过来（默认不用供货、要证明才供）会把「源站没给地址、但也不要钱」的
 * app 独占集判成冗余删掉——而那种集源站根本放不出，网盘那份是唯一来源。
 *
 * **为什么不能用 `paid` 回答**：全仓唯一写 `content.paid` 的地方（`content/normalize.ts` 的
 * `withPaid`）只在 `price > 0` 时写 `true`，其余一律不写。于是「没人说它要钱」被读成「免费 =
 * 源站自己能播」，两件事被合并了。
 *
 * **为什么不用 `resolveOnly`**：那是 `normalize.ts` 播客分支自己打的标记（实现细节，只有那一条
 * 路会打）。地址在不在是所有 archetype 共通的、更根本的事实。
 *
 * **为什么只认 `audio`/`video` 的 `url`**：`kind:'image'`（封面）和 `kind:'link'` 的 `url` 是
 * 必填字段，却一秒都放不出来。放松成「media 里有任意 url」会把封面当成播放地址——活体实测全库
 * 3295 条（36 条流）正是这个形状，其中包含已绑网盘的 `tencent-talkshow-friends-season3`
 * （210 条，media 只有一张封面图），那条绑定的网盘文件会被整库判成冗余。
 * 只认这两类**不是写死播客**：新 archetype 只要能放，就会落在这两个 kind 上。
 */
function hasPlayableMedia(item: StoredItem): boolean {
  const media = ((item as unknown as Item).content?.media ?? []) as Array<{ kind?: string; url?: unknown }>
  return media.some((m) => (m.kind === 'audio' || m.kind === 'video') && typeof m.url === 'string' && m.url.length > 0)
}
