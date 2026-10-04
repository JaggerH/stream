/**
 * collection 分片替换的两层防线（2026-07-30 spec）。
 *
 * 背景：collection 模式每采一轮就用新快照 `replaceStream` 掉该 source 的分片。对"歌单真被清空"
 * 这是**正确**行为；对"上游抽风返回空"这就是数据丢失——而替换层看到的两者一模一样。
 * 2026-07-24 怡乐活体事故（RSS 上游间歇 403 → 一轮空 → 1015 条没了）就是后者。
 *
 * 第 1 层在采集侧：结果带**成功指针**（`AdapterFetchResult.authoritative`），"没采"不许化装成
 * "采到 0 条"。第 2 层在这里兜最后一种形状：采集自称成功、但新快照近乎全空——**连续两轮**都这么
 * 说才真替换。真清空只是晚一轮生效，不是不生效。
 */

/**
 * "近乎全空"的判据阈值：新快照条数 ≤ 这个数才算。
 *
 * **就是 0，不是某个百分比。** 2026-07-28 拍板否掉了"缩水 >50% 就拦"——那是拍脑袋的数，会误伤
 * 真实的大幅删减（1015 → 300 是用户自己删的，凭什么晚一个采集周期才生效）。而"近乎全空"里唯一
 * 不含拍脑袋成分的实例就是 0：任何 >0 的阈值（≤2？≤5？）都是同一类凭空定的数。
 * 将来真撞到"残缺但非空"的活体形状，改这一个常量，不用改结构。
 */
export const NEAR_EMPTY_MAX_ITEMS = 0

/** 分片没被替换的两种理由——事件的 dedupeKey 编的就是它（两个不同的终态，不该互相刷新）。 */
export type ReplaceHoldReason = 'not-authoritative' | 'near-empty'

export type ReplaceDecision = { replace: true } | { replace: false; reason: ReplaceHoldReason }

/**
 * 这一轮的快照该不该覆盖旧分片。纯函数——所有状态（armed 位、旧分片条数）都由调用方喂进来。
 */
export function decideCollectionReplace(input: {
  /** 采集侧的成功指针：这批 items 是不是"请求成功 + 解析成功"产出的 */
  authoritative: boolean
  /** 新快照条数 */
  nextCount: number
  /** 旧分片在库条数（同 source_id） */
  prevCount: number
  /** 上一轮它已经说过一次近乎全空了 */
  armed: boolean
}): ReplaceDecision {
  // 本轮没采到 —— 它的空不代表上游空了，一律不覆盖（带着 items 也不信：这批不是权威快照）。
  if (!input.authoritative) return { replace: false, reason: 'not-authoritative' }
  // 不是"近乎全空"这个形状 → 照常替换。缩水多少都不看：按百分比拦会误伤真实删减。
  if (input.nextCount > NEAR_EMPTY_MAX_ITEMS) return { replace: true }
  // 旧分片本来就没货 → 没有东西可保，不平白拖一轮。
  if (input.prevCount === 0) return { replace: true }
  // 连续第二轮仍然近乎全空 → 认了，真清空生效。
  if (input.armed) return { replace: true }
  return { replace: false, reason: 'near-empty' }
}

/**
 * "上一轮已经报过一次近乎全空"的 armed 位，按 (streamId, sourceId) 一格。
 *
 * 生产实现落在 `stream.db`（UserStore 的 `collection_guard` 表）——不持久的话一次后端重启就把它
 * 抹掉，一个真被清空的分片每次都要重新攒两轮；重启循环里更是永远攒不满。
 */
export interface CollectionGuardStore {
  isArmed(streamId: string, sourceId: string): boolean
  arm(streamId: string, sourceId: string): void
  clear(streamId: string, sourceId: string): void
}

/** 进程内实现：单测与 disk 档（那个进程不许写数据目录）用。 */
export class MemoryCollectionGuard implements CollectionGuardStore {
  private readonly armed = new Set<string>()
  private key(streamId: string, sourceId: string): string {
    return `${streamId}\0${sourceId}`
  }
  isArmed(streamId: string, sourceId: string): boolean {
    return this.armed.has(this.key(streamId, sourceId))
  }
  arm(streamId: string, sourceId: string): void {
    this.armed.add(this.key(streamId, sourceId))
  }
  clear(streamId: string, sourceId: string): void {
    this.armed.delete(this.key(streamId, sourceId))
  }
}
