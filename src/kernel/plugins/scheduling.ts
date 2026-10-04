import type { Context } from 'cordis'
import { Scheduler } from '../../scheduler.ts'
import { StreamService } from '../../mcp/tools.ts'
import { StoryFoldRecorder } from '../../story-fold/recorder.ts'
import { RunProbe } from '../../replay/recipe-probe.ts'
import { DEFAULT_AD_RULES, mergeAdRules } from '../../content/ad-rules.default.ts'
import { streamRecordToStream } from '../../store/compat.ts'
import { backfillLabel } from '../../store/auto-name.ts'
import { extractTrackRef } from '../../audio/index.ts'
import { pluginIdForDescriptor } from '../../registry/seal.ts'
import { COOKIE_SNAPSHOT_MAX_AGE_MS } from './auth.ts'
import type { RuntimeConfigResolver } from './runtime-config.ts'
import type { ConversionsDomain } from './conversions.ts'
import type { AdRules } from '../../content/ad-filter.ts'
import type { Item } from '../../content/types.ts'
import type { StreamItem } from '../../types.ts'
import type { SourceType } from '../../manifest/types.ts'
import type { HealthInfo } from '../../http/app.ts'
import type { TrackFn, TrackSyncFn } from '../../op-track.ts'
import type { DebugEntry } from '../../debug.ts'

declare module 'cordis' {
  interface Context {
    /** 采集调度这一域（`src/kernel/plugins/scheduling.ts`）——一个聚合对象，不是六个 ctx key。 */
    scheduling: SchedulingDomain
  }
}

/**
 * 采集调度域的聚合对象。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名。
 *
 * 这一域装的是**一个真环**：`scheduler` 的 `onFeedTitle` 回调要调 `service.updateResourceStream`，
 * 而 `service` 构造时要吃 `scheduler`。两者在同一个 `apply` 里先后建、回调保持运行时解引用，
 * 环就在域内闭合——不再需要 bootstrap 那边的前向 `let`。断了的症状很安静：**新订阅的流永远
 * 「未命名」**（自动起名回写断了），而采集本身一切正常。
 */
export interface SchedulingDomain {
  /** 唯一的常驻采集引擎（ARCHITECTURE.md Data Scheduling 不变量 4）。 */
  scheduler: Scheduler
  /** MCP / HTTP 两面共用的行为核心（registry + scheduler + 频道库上的纯方法）。 */
  service: StreamService
  /** 内置默认 ⊕ config.yaml 全局 `ad_filter`，**只算一次**——每条流自己的 `ad_filter` 叠在它上面。
   *  HTTP 的 reclassify 端点吃的必须是同一份基线，否则重判出来的结论和入库时不一致。 */
  baseAdRules: AdRules
  /** `/api/health` 的完整体检（异步、会读盘）。 */
  health: () => Promise<HealthInfo>
  /** `last_harvest_at` 的**同步、只读、零 I/O** 取法——与 `health()` 分家，好让存活探针
   *  永远不会因为一件与存活无关的事失败或阻塞（见 HttpDeps）。 */
  lastHarvestAt: () => string | undefined
}

export interface SchedulingConfig {
  /** config.yaml 的全局 `ad_filter`（缺席就是只有内置默认）。 */
  adFilter?: AdRules
  vaultRoot: string
  vaultEnabled: boolean
  runtimeConfigFor: RuntimeConfigResolver
  /** 每条新落库的 item 额外播一份（WS 推前端）。 */
  onItem?: (item: StreamItem, type: SourceType) => void
  track?: TrackFn
  trackSync?: TrackSyncFn
  onDebug?: (entry: DebugEntry) => void
}

/**
 * 采集调度这一域：**「什么时候去采、采回来给谁」**。
 *
 * 装配序上它排在 Provider 执行面之后——`onItemPersisted` 要富化队列、`castNames` 那条腿要
 * `videoDetails`，两样都住 `ctx.provider`。**三个跨域引用一律调用时才从 ctx 取**，不在装配期
 * 解构成快照：
 *  - `ctx.provider.videoDetails` / `videoEnrich` —— 同一棵树上的邻居，inject 保证已挂。
 *  - `ctx.conversions.storyFoldWorker` —— 转换域**比本域晚挂**（它不在 inject 里，也不能在：
 *    那会把装配序倒过来）。所以这一格是 optional 读：归堆只是呈现层的附加能力，转换域还没挂
 *    的那个窗口里 kick 一下没人接，也不该让一轮采集出错。
 *
 * 句柄：scheduler 每条流一条链式 `setTimeout`（内部 Map），`stop()` 清干净。**两个 effect，
 * 注册顺序有语义**——见 `apply` 末尾那段。
 */
export const schedulingPlugin = {
  name: 'scheduling',
  inject: ['sources', 'adapters', 'stores', 'credentials', 'auth', 'streamEvents', 'packages', 'provider'],
  apply(ctx: Context, config: SchedulingConfig): void {
    const { registry } = ctx.sources
    const adapters = ctx.adapters
    const { dedup, itemStore, storyFold: storyFoldStore, sourceHealth, channels, downloadQueue } = ctx.stores
    const credentials = ctx.credentials
    const auth = ctx.auth
    const events = ctx.streamEvents
    const { plugins, isPluginEnabled } = ctx.packages

    const baseAdRules = mergeAdRules(DEFAULT_AD_RULES, config.adFilter)

    // scheduled streams come from stream.db (referencedStreamIds below); no file-based sources.
    const scheduler = new Scheduler({
      registry,
      streams: [],
      adapters,
      health: sourceHealth,
      resolveCreds: credentials.resolver.fn(),
      // 时机 ②：这一轮要用登录态了，快照太旧就先去浏览器取一次。Chrome 关着时立刻返回
      // （relay 未连），不拖慢采集。
      beforeTick: () => auth.cookiePuller.ensureFresh(COOKIE_SNAPSHOT_MAX_AGE_MS, 'before-harvest'),
      onHarvestError: (sourceId, failure) => events.emit({
        type: 'harvest.error', severity: 'error',
        title: `采集失败：${sourceId}`,
        body: failure.message,
        ref: { kind: 'stream', id: sourceId },
        dedupeKey: `harvest:${sourceId}:${failure.category}`,
      }),
      // 本轮没跑（浏览器没连）。**不是采集失败**，所以 severity 只到 warning、也不进 health。
      // dedupeKey 不带时间/次数：一整夜没开电脑会跳过几十轮，但用户要看到的是"这件事在发生"
      // 一条，而不是几十条同样的通知。
      onHarvestSkipped: (sourceId, reason) => events.emit({
        type: 'harvest.skipped', severity: 'warn',
        title: `本轮跳过：${sourceId}`,
        body: `采集环境没就绪，未执行（${reason}）。源本身没有问题。`,
        ref: { kind: 'stream', id: sourceId },
        dedupeKey: `harvest-skipped:${sourceId}`,
      }),
      // collection 分片这一轮没被替换，旧存量保住了。**不是失败**（数据一条没丢），所以 severity
      // 只到 warn。dedupeKey 里编进 reason：「没采到」和「上游说空」是两个不同的终态，从一个转到
      // 另一个必须是新的一条通知，而不是把旧那条刷新一下时间戳；同一终态连着几轮则合并成一条。
      onCollectionReplaceHeld: ({ streamId, sourceId, reason, kept }) => events.emit({
        type: 'harvest.snapshot-held', severity: 'warn',
        title: `保住了旧内容：${sourceId}`,
        body: reason === 'not-authoritative'
          ? `这一轮没真去采（采集侧自称未执行），已保留原有 ${kept} 条，不做替换。`
          : `上游这一轮返回近乎全空，已保留原有 ${kept} 条；下一轮仍然如此才认定真被清空。`,
        ref: { kind: 'stream', id: streamId },
        dedupeKey: `snapshot-held:${streamId}:${sourceId}:${reason}`,
      }),
      // armed 位落 stream.db —— 不持久的话一次重启就把"上一轮说过空了"抹掉，真被清空的分片永远
      // 攒不满两轮（见 collection-replace-guard.ts）。
      collectionGuard: {
        isArmed: (streamId, sourceId) => channels.isNearEmptyArmed(streamId, sourceId),
        arm: (streamId, sourceId) => channels.armNearEmpty(streamId, sourceId),
        clear: (streamId, sourceId) => channels.clearNearEmpty(streamId, sourceId),
      },
      runtimeConfigFor: config.runtimeConfigFor,
      vaultRoot: config.vaultRoot,
      vaultEnabled: config.vaultEnabled,
      dedup,
      itemStore,
      onItem: config.onItem,
      // 同质内容归堆：跨平台搬运的收成一堆。它自己吞异常（`StoryFoldRecorder.record`），
      // 这里不兜底也不 await——归堆是呈现层的附加能力，没有资格影响一轮采集。
      // 归堆：这一跳**只记账 + 排队**，判据（要文本，可能要转写）在后台 worker 里跑。
      // worker 住转换域，那一域比本域晚挂——所以这里是**调用时**才去 ctx 取的 optional 读，
      // 不是装配期解引用（那会拿到 undefined 并把它冻死）。
      storyFold: new StoryFoldRecorder({
        store: storyFoldStore,
        onQueued: () => (ctx.conversions as ConversionsDomain | undefined)?.storyFoldWorker.kick(),
      }),
      // 采集落库即富化（视频频道的流）——见 VideoEnrichQueue 头注：富化早就写好了，但唯一触发点是
      // "有人点开了详情页"，所以没被点开过的作品永远没有封面/中文名。**调用时**从 provider 域取
      // （inject 保证它已挂）；队列自己会把缓存命中的直接挡掉。
      onItemPersisted: (item) => ctx.provider.videoEnrich.consider(item),
      track: config.track,
      trackSync: config.trackSync,
      // Ordinary-harvest phase ledger — the counterpart of RecipeRunner's probe wiring
      // (recipes already post per-phase timing on the `recipe` channel; this gives every other
      // source the same treatment on `harvest`). RunProbe with logging OFF: timing is always
      // collected; the [recipe-probe] console line stays recipe-only.
      harvestTiming: {
        newProbe: (sourceId) => new RunProbe(sourceId, false),
        onTiming: (t) => {
          const at = Date.now()
          const total = t.timing.reduce((s, x) => s + x.ms, 0)
          const slow = t.timing.reduce((a, b) => (b.ms > a.ms ? b : a), t.timing[0])
          config.onDebug?.({
            id: `harvest:${t.streamId}:${t.sourceId}@${at}`,
            at,
            channel: 'harvest',
            key: t.sourceId,
            title: `${t.sourceId} 采集`,
            summary:
              `${(total / 1000).toFixed(1)}s · 抓 ${t.fetched} 写 ${t.written}` +
              `${t.limit != null ? `（目标 ${t.limit}）` : ''}` +
              `${t.cacheHit ? ' · 命中缓存' : ''}${t.scheduled ? '' : ' · 手动'}` +
              `${slow ? ` · 最慢 ${slow.phase} ${slow.ms}ms` : ''}`,
            ok: true,
            // value 形状与 recipe 频道一致(`<ms>ms`),前端 RecipeTimingTable 两个频道共用
            fields: t.timing.map((x) => ({
              label: x.phase,
              value: `${x.ms}ms`,
              tone: x.ms >= 3000 ? ('warn' as const) : ('muted' as const),
            })),
          })
        },
      },
      // Each real harvest outcome → refresh the facility auth projection; the notifier pushes
      // `auth-needed` only on the not-needing → needing edge (spec I3).
      onOutcome: () => auth.syncAuthBanner(),
      adRules: baseAdRules,
      onAudioHarvest: (streamId, items) => {
        if (!downloadQueue.isSync(streamId)) return
        const refs = items.map((it) => extractTrackRef(it as unknown as Item)).filter((r): r is NonNullable<typeof r> => !!r)
        const n = downloadQueue.syncPlaylist(streamId, refs)
        if (n > 0) void downloadQueue.drain()
      },
      // Auto-name a freshly-subscribed Stream from its first harvest's feed title. backfillLabel
      // no-ops once labelAuto is cleared (or the user renamed), so firing every harvest is safe.
      // **真环的那一半**：`service` 在下面几行才建，这个闭包只在采集时才跑，那时它早就在了。
      // 断了这一句的症状：新订的流永远「未命名」，而采集绿得毫无破绽。
      onFeedTitle: (streamId, title) => {
        const rec = channels.getStream(streamId)
        if (!rec) return
        const next = backfillLabel(rec, title)
        if (!next) return
        const updated = channels.putStream({ ...rec, label: next.label, options: next.options })
        service.updateResourceStream(streamRecordToStream(updated)) // refresh scheduler's copy → /api/streams shows the name
      },
      // Bridge scheduler catch-up policy to durable storage so lastHarvestAt survives process
      // restarts (spec: startup-catchup). ISO string in UserStore ↔ epoch ms in Scheduler.
      loadLastHarvest: (id) => {
        const iso = channels.getLastHarvestAt(id)
        return iso ? Date.parse(iso) : undefined
      },
      saveLastHarvest: (id, atMs) => channels.setLastHarvestAt(id, new Date(atMs).toISOString()),
      // audio-Channel membership → collection mode, resolved live at harvest time. A 歌单 subscribed
      // while the server runs (POST /api/streams → PATCH /api/channels) becomes order-preserving on
      // its first harvest. Membership is re-read every call and never written back to the stream.
      isAudioStream: (id) => channels.audioStreamIds().has(id),
    })

    // 真环的另一半：`service` 吃 `scheduler` 的**实例**（它就是围着 scheduler 的一层行为面），
    // 所以必须后建。上面那个 `onFeedTitle` 闭包引用的就是这个 const。
    const service = new StreamService({
      registry,
      scheduler,
      plugins,
      channels,
      // canonical-id enable predicate reading the live overlay map (hot: a toggle shows up without
      // rebuilding StreamService). Unknown id → enabled (don't hide sources over a lookup miss).
      pluginEnabled: (id) => {
        const d = plugins.find((p) => pluginIdForDescriptor(p) === id)
        return d ? isPluginEnabled(d) : true
      },
    })

    // 把「读一条源」回填给 packages 域——包的 `ctx.readSource` 背后就是这一个（形状与 auth 域回填
    // `setFacilityLogin` 相同：packages 域装配得更早，握不到 Scheduler，只能由这里接线）。
    // **不传 `userInitiated`**：包代码不是用户当场的一次点击，动作 recipe 照常被闸住。
    ctx.packages.setPackageReadSource((id, params, opts) => scheduler.readSource(id, params, { signal: opts?.signal }))

    // Drive the scheduler from the user store — the single channel source after retiring flow/binding.
    // 装的是 `collectedStreamIds()` 而不是 `referencedStreamIds()`：`data === 'live'` 的
    // present（research）不入库，它引用的流不该被采集（理由见那个方法的注释）。
    for (const id of channels.collectedStreamIds()) {
      const rec = channels.getStream(id)
      if (rec && !scheduler.has(rec.id)) scheduler.add(streamRecordToStream(rec))
    }

    // Tray recency tooltip (task 2.3): max lastHarvestAt across all scheduled streams, ISO.
    // No stream harvested yet → undefined (see HealthInfo doc comment). Sync + read-only + no
    // network I/O by construction (only touches the in-process scheduler list + UserStore reads) —
    // safe to call from /api/health directly, unlike health() below which is async and does I/O.
    const lastHarvestAt = (): string | undefined => {
      let latest: string | undefined
      for (const s of scheduler.list()) {
        const iso = channels.getLastHarvestAt(s.id)
        if (iso && (!latest || iso > latest)) latest = iso
      }
      return latest
    }

    const health = async (): Promise<HealthInfo> => {
      const at = lastHarvestAt()
      return {
        cookies: await credentials.cookieHealth(),
        manifests: registry.all().length,
        streams: scheduler.list().length,
        ...(at ? { last_harvest_at: at } : {}),
      }
    }

    // ── 关停：两个 effect，注册顺序就是语义 ────────────────────────────────────────
    // 撤销是**注册的反序**，所以先注册 shutdownAdapters、后注册 stop ⇒ 撤销时先 stop 再
    // shutdownAdapters。顺序不能反：先停派班（不再有新的一轮打进 adapter），再杀 adapter 名下的
    // 子进程。漏掉 shutdownAdapters 的症状是重启后遗留的 chrome 子进程堆积，最终把 WSL 打到 OOM。
    // 这两条以前是 bootstrap `shutdown()` 的手写清单 + `gracefulShutdown` 里那行 `scheduler.stop()`。
    // 顺序由 `scheduling.test.ts` 钉着，不靠这段注释。
    ctx.effect(() => () => scheduler.shutdownAdapters())
    ctx.effect(() => () => { scheduler.stop() })

    ctx.provide('scheduling', {
      scheduler,
      service,
      baseAdRules,
      health,
      lastHarvestAt,
    } satisfies SchedulingDomain)
  },
}
