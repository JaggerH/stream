import { PICK_SURFACES, type PickSurface, type SourceManifest } from './types.ts'

/**
 * 「这个源能在哪个**选择面**被人挑到」——今天有两个面，它们要的是两种不同的东西：
 *
 * - `stream` —— 给频道加一条**会持续来内容的流**（订阅面）。
 * - `provider` —— 给 Provider 行挑一个**干活的成员**（能力成员面）。搜索腿住在这里：
 *   google/brave/telegram 不是一条流，但确实该能被挑中当成员。
 *
 * **为什么必须显式申报、不能从 `capabilities` 推**：`xhs-search` 和 `google-search` 的能力
 * 都是 `search`，前者是可订阅的流、后者只当成员——能力回答"它会干什么"，回答不了"该在哪儿
 * 挑它"。
 *
 * **别拿 `discoverable` 当这个用。** 那个字段只管两处（首页精选列表、按意图搜源的排序），
 * 它说的是"别在推荐里出现"。两件事被混用的代价实测过，而且是反着来的两个方向：
 *   - 该藏的没藏住——通用选择器不看 `discoverable`，于是"给笔记点赞"这个写操作和"去建一把
 *     API key"这个流程都能被当成来源挑中；
 *   - 该露的藏过头——网盘那个源因为 `discoverable:false` 在通用入口里挑不到，逼得面板里
 *     复制了一份成员编辑器（`NetdiskPanel.tsx` 的头注还记着这笔）。
 */
/**
 * 缺省 = 两个面都能挑到。
 *
 * 这个方向是刻意的：绝大多数源（3000+ 条 RSSHub 路由、各站时间线）本来就两边都成立，让它们
 * 保持沉默；**要收窄的那些自己申报**。反过来做（默认谁都挑不到、逐个开）会让任何一份忘了申报
 * 的新 manifest 静默地从两个入口一起消失——而"少了一个源"是没人会收到通知的那类失败。
 */
export function pickableIn(manifest: Pick<SourceManifest, 'pick_in'>, surface: PickSurface): boolean {
  return manifest.pick_in?.includes(surface) ?? true
}

/** 请求里带来的 `surface=` 是不是一个真的面。**不认识的值一律拒**，不静默当成"总览"——
 *  拼错一个面名却拿到一份更宽的列表，正是这条线要消灭的那种"看起来正常"的失败。 */
export function isPickSurface(value: unknown): value is PickSurface {
  return typeof value === 'string' && (PICK_SURFACES as readonly string[]).includes(value)
}

/** 任何一个面挑得到 = 它还是个「给人挑的源」。总览页用这一档（谁都挑不到的就别列了）。 */
export function pickableAnywhere(manifest: Pick<SourceManifest, 'pick_in'>): boolean {
  return PICK_SURFACES.some((surface) => pickableIn(manifest, surface))
}
