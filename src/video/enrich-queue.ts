import type { StreamItem } from '../types.ts'
import type { VideoDetail, VideoLookupIdentity } from './types.ts'
import type { VideoDetailService } from './detail-service.ts'
import { videoDetailCacheKey } from './detail-service.ts'
import { videoWorkLookupIdentity } from './item-identity.ts'

/**
 * 缓存里那份是「没认出来」，而这次手上的标识符比当初多 —— 那份 miss 不该再挡着重试。
 *
 * 没有这一条会怎样：源学会了交出一个新的标识符（recipe 加了一格、上游补了一个链接），而库里
 * 那些当初因为"只有片名"被拒的作品，各自压着一份没过期的 miss。缓存键是按片名算的，新证据
 * 不改变它，于是**新证据被自己那次失败挡在门外整整一个 TTL**，而且一声不响——覆盖率纹丝不动，
 * 看起来就像"这些本来就认不出来"。实撞过：给这份奖项名单接上 Wikidata 之后 8 部作品当场能认，
 * 重跑采集却一部都没变。
 *
 * 判据只看**标识符**（externalIds），不看片名/年份：那两样每轮采集都可能有无意义的抖动，拿它们
 * 当"新证据"会把 miss 的节流整个废掉。
 */
function missWithNewEvidence(cached: VideoDetail, identity: VideoLookupIdentity): boolean {
  if (cached.canonical?.status !== 'miss') return false
  const had = cached.identity.externalIds ?? {}
  return Object.entries(identity.externalIds).some(([authority, id]) => id && had[authority] !== id)
}

export interface VideoEnrichQueueDeps {
  details: Pick<VideoDetailService, 'peek' | 'get'>
  /** 哪些流属于视频频道 —— 每次调用现取，频道成员随时会变。 */
  videoStreamIds: () => Set<string>
  /** 同时在飞的富化请求数。TMDb 不是我们的资源，采集完成是个背景动作，慢一点没人等。 */
  concurrency?: number
  now?: () => number
  onError?: (message: string) => void
}

/**
 * 采集落库之后把 TMDb 详情**顺手富化掉**——名字、年份、海报因此在卡片上直接有，而不是等谁去点开它。
 *
 * 为什么需要这个东西：富化本身早就写好了（VideoDetailService），但**唯一的触发点是打开详情页**。
 * 列表侧只有一个 `peek`（读缓存、不发请求），它的注释写着"prefetch 会在后台把缓存焐热"——而那个
 * prefetch 从来没被实现过。结果就是：没人点开过的作品永远没有封面，一份 112 条的奖项名单在墙上
 * 是 112 个灰框。源自己带图的流看不出问题（回落到源的图），奖项名单这种只有一行标题的源全军覆没。
 *
 * 三条硬约束，都是"别让背景动作伤到前台"：
 *  - **缓存命中直接不排队**（连队列都不进）。collection 流每轮采集把整份快照重放一遍，不先挡一道
 *    的话每周会白排 192 次。
 *  - **按 cacheKey 去重**：同一部作品的多集共享一个身份，排一次就够。
 *  - **失败只记一行日志**。富化是锦上添花，TMDb 挂了不该让采集看起来出了问题。
 */
export class VideoEnrichQueue {
  private readonly pending = new Map<string, StreamItem>()
  private readonly inFlight = new Set<string>()
  private readonly now: () => number
  private readonly concurrency: number

  constructor(private readonly deps: VideoEnrichQueueDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.concurrency = deps.concurrency ?? 2
  }

  /** 采集写完一条就叫一次（Scheduler 的 onItemPersisted）。不是视频频道的流、没有 videoRef、
   *  或者缓存里已经有一份没过期的详情 —— 三种情况都当场返回，不留任何痕迹。 */
  consider(item: StreamItem): void {
    if (!item.videoRef) return
    if (!this.deps.videoStreamIds().has(item.stream_id)) return
    const identity = videoWorkLookupIdentity(item)
    const key = videoDetailCacheKey(identity)
    if (this.pending.has(key) || this.inFlight.has(key)) return
    // 缓存里那份是不是还新鲜 —— 用 expiresAt 判，和 VideoDetailService.get 自己的判据同源。
    // 注意"没认出来"(canonical miss)也是一份会过期的缓存：它同样挡住重排，所以一部 TMDb 认不出的
    // 作品每周最多被问一次，而不是每条 item 问一次。**除非这次手上的证据比当初多**——见下。
    const cached = this.deps.details.peek(identity)
    if (cached && Date.parse(cached.expiresAt) > this.now() && !missWithNewEvidence(cached, identity)) return
    this.pending.set(key, item)
    this.pump()
  }

  /** 队列排空（含正在飞的那几个）—— 测试用；生产侧没人等它。 */
  async idle(): Promise<void> {
    while (this.pending.size || this.inFlight.size) await new Promise((r) => setTimeout(r, 0))
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency && this.pending.size) {
      const [key, item] = this.pending.entries().next().value as [string, StreamItem]
      this.pending.delete(key)
      this.inFlight.add(key)
      void this.deps.details
        .get(videoWorkLookupIdentity(item))
        .catch((e: unknown) => this.deps.onError?.(`${item.title}: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          this.inFlight.delete(key)
          this.pump()
        })
    }
  }
}
