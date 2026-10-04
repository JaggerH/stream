import type { Context } from 'cordis'
import { DedupStore } from '../../dedup-store.ts'
import { ItemStore } from '../../item-store.ts'
import { StoryFoldStore } from '../../story-fold/store.ts'
import { ContentCache } from '../../content-cache.ts'
import { AudioArchive, DownloadQueue, type QueueDeps } from '../../audio/index.ts'
import { SourceHealthStore } from '../../source-health-store.ts'
import { UserStore, type RowDegradation } from '../../store/user-store.ts'
import { StreamSeenStore } from '../../stream-seen-store.ts'
import { CollectionsStore } from '../../collections/store.ts'
import { WatchProgressStore } from '../../watch-progress-store.ts'
import { DiscoveredChannels } from '../../search/discovered.ts'
import { cleanOrphanDbs, migrateCacheDb } from '../../store/import-legacy.ts'
import { join } from 'node:path'

declare module 'cordis' {
  interface Context {
    /** 落盘状态这一域（`src/kernel/plugins/storage.ts`）——一个聚合对象，不是十几个 ctx key。 */
    stores: Stores
  }
}

/**
 * 这台 Stream 的全部落盘状态。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名，
 * 免得每个消费点都要同时改两件事。
 */
export interface Stores {
  /** 采集去重指纹（cache.db，可重建那一侧）。 */
  dedup: DedupStore
  itemStore: ItemStore
  /** 同质内容归堆的账本（纯附加，住 cache.db）。 */
  storyFold: StoryFoldStore
  /** 逐条内容的 enrich 缓存；消费模块在自己的 `wire*` 里注册命名空间。 */
  contentCache: ContentCache
  audioArchive: AudioArchive
  downloadQueue: DownloadQueue
  /** 逐源健康账本——失败转移的选源依据 + doctor 报表。 */
  sourceHealth: SourceHealthStore
  /** 用户自己的 Channel/Stream/Provider 配置行（stream.db）。 */
  channels: UserStore
  seenStore: StreamSeenStore
  collections: CollectionsStore
  watchProgress: WatchProgressStore
  discoveredChannels: DiscoveredChannels
}

export interface StorageConfig {
  /** 可写状态根目录。 */
  dataDir: string
  /** 用户状态那一侧（`stream.db`）：删了就真丢东西。 */
  streamDb: string
  /** 可重建那一侧（`cache.db`）：内容 + 去重指纹，删光重采一遍就有。 */
  cacheDb: string
  /** 旧 `items.db` 的位置——cache.db 靠改名汇流它（105MB，从不逐行拷）。 */
  legacyItemDb: string
  /** 旧 dedup 库，`DedupStore` 自己按表拷贝收编。 */
  legacyDedupDb: string
  audioArchiveRoot: string
  audioArchiveDb: string
  log: (...args: unknown[]) => void
  /**
   * 下载队列的**行为侧**依赖（解析下载地址走 Provider 执行器、开关读用户的流配置）。
   * 它们跨域，所以由 bootstrap 现造；但要等本域先把 archive/channels 建出来，
   * 传的因此是「拿到这两样之后再造」的工厂，而不是一份现成的对象。
   */
  downloadQueueDeps: (own: { archive: AudioArchive; channels: UserStore }) => QueueDeps
  /**
   * stream.db 里某一行的某一列 JSON 读坏、被降级读出来了。**store 自己不认识通知中心**，
   * 只如实报现场；翻译成用户看得懂的那一条由 bootstrap 接到事件层上（缺席 = 只有日志）。
   */
  onRowDegraded?: (info: RowDegradation) => void
}

/**
 * 落盘状态这一域：建库、跑一次性迁移、把每个句柄登记成内核 effect。
 *
 * **每个有 `close()` 的 store 一个 `ctx.effect()`**——这是本域存在的主要理由。搬进来之前只有
 * dedup 和 itemStore 在 `gracefulShutdown` 里被手写关掉，其余十来个句柄从没人关：进程退出前
 * 没人抱怨，但同一进程里跑第二次装配（测试、将来的重启）就是一堆泄漏的 sqlite 连接。
 * 撤销按注册反序发生；这里的 store 之间没有关停先后约束（各持各的连接）。
 *
 * 一个聚合对象而不是十几个 ctx key：ctx 的服务名是全局扁平命名空间，`itemStore`/`collections`
 * 这种通名铺上去迟早撞车。
 */
export function storagePlugin(ctx: Context, config: StorageConfig): void {
  /** 登记一个持句柄的 store：dispose 时关掉它。 */
  const own = <T extends { close(): void }>(store: T): T => {
    ctx.effect(() => () => store.close())
    return store
  }

  // items.db → cache.db 的汇流必须先于任何一个 store 开这两个库。
  migrateCacheDb(config.legacyItemDb, config.cacheDb)
  const dedup = own(new DedupStore(config.cacheDb, config.legacyDedupDb))
  const itemStore = own(new ItemStore(config.cacheDb))
  // 归堆的账本住 cache.db：**纯附加，删光就回到没有归堆的样子**（一条内容都不丢），
  // 正是"可重建"那一侧的定义。它里面没有一格是用户手输的——同质关系和领先度都是
  // 从采集到的内容自己攒出来的，删了重跑一遍采集就有。
  const storyFold = own(new StoryFoldStore(config.cacheDb))
  // 存量内容的形状要跟上 normalizer 的改动，走 `POST /api/items/renormalize`（按流 / 按源 / 全库），
  // 不在 boot 期扫库回填——boot 期回填只认一种源的形状，而且每次启动都要付一次全表扫描。
  // Per-item enrichment cache (tryGet pattern). Lives on the REGENERABLE side (cache.db):
  // losing it costs re-fetches, never user state.
  const contentCache = own(new ContentCache(config.cacheDb))
  const audioArchive = own(new AudioArchive(config.streamDb, config.audioArchiveRoot, config.audioArchiveDb))
  const sourceHealth = new SourceHealthStore(join(config.dataDir, 'source-health.json'))
  const channels = own(new UserStore(config.streamDb, undefined, config.onRowDegraded))
  const seenStore = own(new StreamSeenStore(join(config.dataDir, 'stream-seen.db')))
  cleanOrphanDbs(config.dataDir)
  // 统一收藏(video「正在追」+ audio「我的喜欢」两个系统列表)。老的两张表(v1 collected_work、
  // liked_track)若还在,构造函数会自动迁移进新 schema 再丢弃——见 CollectionsStore 头注,这里不用
  // 再手写一次迁移。
  const collections = own(new CollectionsStore(config.streamDb))
  const watchProgress = own(new WatchProgressStore(join(config.dataDir, 'watch-progress.db')))
  // 唯一一个不能只 `own()` 的 store：它自己有一条异步下载循环，关停有先后——先 `stop()`
  // 等当前 job 落账，再 `close()`。反过来的话，在途下载的那一轮循环下一次碰 sqlite 就抛在
  // 一个已经关掉的连接上。宽限期内没停就照实说，别静默当作停了。
  const downloadQueue = new DownloadQueue(
    config.streamDb,
    config.downloadQueueDeps({ archive: audioArchive, channels }),
    join(config.dataDir, 'download-jobs.db'),
  )
  ctx.effect(() => async () => {
    if (!(await downloadQueue.stop())) config.log('[stream] download queue still running at shutdown — closing anyway')
    downloadQueue.close()
  })
  // discovered pool: TG channels seen in meta-source (pansou) results accrete here,
  // making the black box legible (default pool + discovered = "what pansou can search").
  const discoveredChannels = own(new DiscoveredChannels(config.streamDb, join(config.dataDir, 'discovered.db')))

  ctx.provide('stores', {
    dedup,
    itemStore,
    storyFold,
    contentCache,
    audioArchive,
    downloadQueue,
    sourceHealth,
    channels,
    seenStore,
    collections,
    watchProgress,
    discoveredChannels,
  })
}
