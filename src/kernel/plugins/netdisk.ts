import type { Context } from 'cordis'
import { join } from 'node:path'
import { MappingStore } from '../../netdisk/mapping-store.ts'
import { openNetdiskDb, migrateLegacyNetdiskData } from '../../netdisk/db.ts'
import { hostAlistClient } from '../../netdisk/alist-client.ts'
import { NetdiskService, type ListLeft } from '../../netdisk/sync.ts'
import { AUTHORITY_ITEM_LIMIT, authorityFromStream, bindingLeftFromStream } from '../../netdisk/left-from-stream.ts'
import { ReconcileService, type ListAuthority } from '../../netdisk/reconcile/service.ts'
import { DurationCache, durationOf, durationsFor, SYNC_PROBE_BUDGET } from '../../netdisk/reconcile/duration.ts'
import { makeAudioSampler } from '../../netdisk/reconcile/sample-audio.ts'
import { SampleCache } from '../../netdisk/reconcile/sample-cache.ts'
import type { InvokeLlm } from '../../netdisk/match-generate.ts'
import type { NetdiskDeps as NetdiskHttpDeps } from '../../http/netdisk-routes.ts'
import { canonicalSourceId } from '../../streams/store.ts'
import { openReconcile, type OpenReconcileInput, type OpenReconcileResult } from '../../netdisk/reconcile/open.ts'
import type { TranscribeResult } from '../../transcribe/client.ts'
import { FollowService } from '../../netdisk/follow/service.ts'
import { quarkShareClient } from '../../netdisk/follow/quark-share-client.ts'
import { makeShareCreate, makeShareDelete, makeShareList } from '../../netdisk/share-create.ts'
import type { VideoSearchResult } from '../../video/types.ts'
import { AdjudicationService } from '../../netdisk/adjudicate/service.ts'
import { SuggestionLog } from '../../netdisk/reconcile/suggestions.ts'

declare module 'cordis' {
  interface Context {
    /** 网盘（AList 对齐层）这一域（`src/kernel/plugins/netdisk.ts`）——一个聚合对象，不是三个 ctx key。 */
    netdisk: NetdiskDomain
  }
}

/**
 * 网盘域的聚合对象。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名。
 *
 * 类型名叫 `NetdiskDomain` 而不是 `NetdiskService`：后者是这个对象**装着**的那个引擎类
 * （`src/netdisk/sync.ts`）的名字，两个同名会让"谁是谁"在每一处 import 上重新问一遍。
 *
 * `netdisk` / `netdiskRoutes` **可为 undefined**：没配 AList（没 token，且不归 Stream 托管）时
 * 整块不装配（门在 `apply` 里）。域本身照样挂——「没配」不等于「没有这一域」，
 * 后者会让所有按 inject 取它的地方连带不激活。
 */
export interface NetdiskDomain {
  /** 网盘直链后备（AList 对齐层）的引擎。未配 token → undefined，播放路由自动跳过。 */
  netdisk?: NetdiskService
  /** 绑定管理面 + 归档器 + AI 判读的 HTTP 依赖包。 */
  netdiskRoutes?: NetdiskHttpDeps
  /** 字幕落盘缓存目录。跟着网盘域走（字幕来自网盘里的那份文件）。 */
  subtitleCacheDir: string
}

export interface NetdiskConfig {
  /** 可写状态根目录（`netdisk.db` / `subtitles/` 都在它下面）。 */
  dataDir: string
  log: (...args: unknown[]) => void
  /**
   * 「这条订阅的成员表改了，重排班」——`openReconcile` 给订阅补完下架来源之后要调它。
   *
   * **经 config 传，不走 inject**：写进 inject 会让本域在任何没挂调度域的地方整块不激活
   * （内核测试就是那样搭的）；而 Cordis 不允许绕过 inject 惰性取服务（`cannot get property
   * "scheduling" without inject`，活体实测）。bootstrap 那边调度域比本域先挂，直接递进来最省事。
   *
   * **缺席 = `openReconcile` 抛，不静默跳过**：补了来源却不重排班，那条来源到进程重启前一次
   * 都不会被采——「开成了但没生效」，而且没有任何一处会喊。
   */
  rescheduleStream?: (streamId: string) => void
  /**
   * 资源搜索（批量路）——追更找新分享用。
   *
   * **thunk，理由同 `rescheduleStream` 的"经 config 传"**：搜索域比本域**晚挂**，装配期取值
   * 等于把一个 undefined 冻进整个进程（「装配期取的值 = 冻住的答案」）。缺席 = 追更只回访旧源，
   * 并在那一轮的账本行里记一条 `search: 资源搜索未装配`——不静默跳过。
   */
  videoSearch?: () => ((q: string) => Promise<VideoSearchResult>) | undefined
}

/**
 * 网盘（AList 对齐层）这一域：**「网盘里那个文件是哪一集」的全部零件**。
 *
 * 一库（`netdisk.db`）装下绑定 + 整理配置 + 裁决 + 账本 + 审计 + 时长缓存；启动时把存量
 * 散 JSON 一次性迁入。上面长出三层：绑定同步（`NetdiskService`）、归档（`ReconcileService`）、
 * 采样转写（`makeAudioSampler` —— `netdisk_transcribe` 工具的取数腿）。
 *
 * **整域在「有 token，或归 Stream 托管」这道门内**：没配 AList 就没有网盘目录可扫，绑定/归档/
 * 采样三样天然不成立。门关着时两个字段是 undefined，而不是这一域不挂。托管而启动时 token 还
 * 空着（容器在睡、登录没跑成）**算配了**——照常装配，client 用到时经 `refresh` 取。
 *
 * 依赖全部经 inject 从内核取：
 *  - `ctx.packages.alist` —— 地址与 token（config/settings 覆盖层 + 启动时的接管结果），
 *    外加 48h JWT 过期时的**重登通道**（见下面 `refresh` 那一行）。
 *  - `ctx.provider` —— `episodeIndex`（TMDb 分集索引）/ `netdiskFolder`（跳转网盘）/
 *    `providerExecutor`（转写梯子）。**从 ctx 现取，不解构存快照**。
 *  - `ctx.llm` —— `forTask`（调用点：`netdisk.spec.suggest`）——账本才有数，
 *    别绕过它直打 `ctx.provider.llmForTask`。
 *  - `ctx.stores` —— `itemStore`（订阅流左侧）与 `channels`（成员表/货架名册）。
 *  - `ctx.credentials` —— 挂载期的 cookie 来源。
 *  - `ctx.settings` —— 挂载期望态的落盘。
 *  - `ctx.streamEvents` —— 归档器往通知中心发的那条流。
 *
 * 句柄一个，登记成 effect：`netdisk.db` 的 sqlite 连接。`DurationCache` 不登记——它只在
 * 这条连接上 prepare 了两条语句，自己不持有可关的东西（现场核实过）。
 */
export const netdiskPlugin = {
  name: 'netdisk',
  inject: ['settings', 'stores', 'credentials', 'packages', 'provider', 'llm', 'streamEvents'],
  apply(ctx: Context, config: NetdiskConfig): void {
    const { dataDir, log } = config
    const settings = ctx.settings
    const { itemStore, channels } = ctx.stores
    const credentials = ctx.credentials
    const events = ctx.streamEvents
    const alistFacet = ctx.packages.alist
    const subtitleCacheDir = join(dataDir, 'subtitles')

    let netdisk: NetdiskService | undefined
    let netdiskRoutes: NetdiskHttpDeps | undefined
    // 地址与 token 来自 packages 域的 AList 那一格（config/settings 覆盖层 + 启动时的接管结果）。
    // 门：手里有 token，或者这份 AList 归 Stream 托管——后者启动时可能还没 token（容器在睡、
    // 登录没跑成），那不是「没配」：照常装配，client 带着下面那条 `refresh` 用到时再取。
    const alistToken = alistFacet.token
    if (alistToken || alistFacet.managed()) {
      // 网盘域一库（netdisk.db）：绑定 + 整理配置/裁决/账本/审计/时长缓存。启动时把存量散 JSON
      // 一次性迁入（旧文件改名 .migrated 留备份）。
      const netdiskDb = openNetdiskDb(join(dataDir, 'netdisk.db'))
      // 句柄清欠：这条 sqlite 连接过去从没人关。同进程第二次装配（测试、将来的重启）就是泄漏。
      ctx.effect(() => () => netdiskDb.close())
      migrateLegacyNetdiskData(netdiskDb, { mappingsDir: join(dataDir, 'mappings'), reconcileDir: join(dataDir, 'reconcile') }, log)
      const mappingStore = new MappingStore(netdiskDb)
      // 宿主生产路径一律经 `hostAlistClient`：地址 thunk 现解析 + fetch 包进 standby 唤醒。
      const alist = hostAlistClient({
        baseUrl: alistFacet.url,
        token: alistToken ?? '',
        // 48h JWT 过期 → 用托管的 admin 凭证重登一次再重试（`AlistClient` 401 分支）；
        // token 还空着时也是它负责第一次取。
        // **别摘掉这一行**：没有它，症状是「跑了两天之后所有网盘操作一起 401」，而 token
        // 明明能自动换发。外接模式（没托管 admin 密码）由 packages 域自己抛，与「无 refresh
        // 通道」那条分支说的是同一句话。
        refresh: () => alistFacet.refresh(),
      })
      // 订阅流那一支左侧的两个读法（绑定 / 归档权威）住在 src/netdisk/left-from-stream.ts；
      // 这里只把 ItemStore 包成它要的 deps。为什么是两支、差在哪 → 那份文件的头注。
      // 取数一律 newest-first + limit，再倒回入库顺序交给绑定支：`order:'asc'` 直接配 limit，丢的是
      // **最新入库**的那批——超过上限的流，刚采到的集永远进不了绑定左侧。丢最老的至少只影响历史。
      const streamLeftDeps = {
        recentItems: (streamId: string) => itemStore.recent({ stream: streamId, limit: AUTHORITY_ITEM_LIMIT }).reverse(),
      }
      const leftFromStream = bindingLeftFromStream(streamLeftDeps)
      /**
       * 左侧分派：`left` 说的是「集清单从哪来」，不是「一个实体」。加一种来源 = 加一支。
       * 未知 kind 抛错、绝不回落到某个默认左侧——静默兜底会让一个配错的绑定看起来在正常工作。
       */
      const listLeft: ListLeft = async (left) => {
        if (left.kind === 'stream') return leftFromStream(left.streamId)
        if (left.kind === 'tmdb') {
          return await ctx.provider.episodeIndex({ id: left.id, media: left.media, title: left.title })
        }
        throw new Error(`未知的绑定左侧 kind: ${JSON.stringify((left as { kind?: unknown }).kind)}`)
      }
      // netdisk 的季归属（`resolveSeasonsByLlm`：结构指纹判不出时读文件夹名猜季号）走
      // netdisk.spec.suggest 调用点：模型由该调用点的绑定覆盖决定（旧代码把 netdiskLlmModel 拼进
      // input；迁移已把那个模型搬进绑定），没设覆盖就用梯子上成员自己的 model。梯子全 decline /
      // 行不存在 → null，调用方（match-generate）已按「LLM 无输出」处理，落 unresolved 进残留。
      // 匹配规格本身不在这里生成——那是对话里的模型读 netdisk_residue 自己写、preview 后 apply。
      const invokeLlm: InvokeLlm = async (input) => (await ctx.llm.forTask('netdisk.spec.suggest', input))?.content ?? null
      // 时长缓存：绑定匹配（时长档主锚）与归档器（判下架）共用同一份——key 是 `字节数:绝对路径`，
      // 两边看的是同一批网盘文件，分两份等于把已经付过的 ffprobe 钱再付一遍。
      const durationCache = new DurationCache(netdiskDb)
      const durations = (files: { path: string; size: number }[]) =>
        durationsFor(files, { rawUrl: (p) => alist.rawUrl(p), cache: durationCache, budget: SYNC_PROBE_BUDGET, log })
      // 「跳转网盘」解析夸克 fid 用的登录态（与 quark-save 同一份夸克 cookie）。
      netdisk = new NetdiskService({ store: mappingStore, alist, listLeft, invokeLlm, log, folder: ctx.provider.netdiskFolder, durations })
      // 挂载 reconcile 的 cookie 来源：调用时才读快照，所以取回的永远是最新那一份。
      const fetchCookies = async () => (await credentials.pushedCookies.fetch()) ?? {}
      // 归档器（spec §4）：复用同一 alist client，装配在 netdisk (alist) 这道门后面——AList 未配置
      // 就没有网盘目录可扫，归档天然不成立。数据与绑定同在 netdisk.db。
      // 权威 ≠ 绑定的 listLeft，两支为什么不同见 left-from-stream.ts 的 authorityFromStream 头注。
      // 货架名册走成员表算（不认前缀）：`alist` 成员的 canonical source id 就是它产出条目的
      // source_id（如 `alist:alist-audio`）——与 offlineDirOf 读的是同一张成员表、同一个字段。
      const authorityLeft = authorityFromStream({
        // 权威支要的是**没倒回来的那一份**（自己按 limit+1 判有没有截断，再倒回入库顺序），
        // 而 streamLeftDeps 已经替绑定支倒过一次了——两支的签名也不同，所以这里另包一份。
        recentItems: (streamId, limit) => itemStore.recent({ stream: streamId, limit }), // 默认 desc
        shelfSourceIds: (streamId) =>
          new Set(
            (channels.getStream(streamId)?.members ?? [])
              .filter((m) => m.plugin === 'alist')
              .map((m) => canonicalSourceId(m.plugin, m.source)),
          ),
      })
      const reconcileAuthority: ListAuthority = async (left) => {
        if (left.kind === 'stream') return authorityLeft(left.streamId)
        // tmdb 分集索引：一次性全量，没有截断这回事。
        return { entries: await listLeft(left), source: `tmdb:${left.id}` }
      }
      const reconcile = new ReconcileService({
        db: netdiskDb,
        alist,
        listLeft: reconcileAuthority,
        durationCache, // 与绑定匹配共用（见上）
        // 季归属与绑定同步**同一份**（同一个 llmSeasonCache、同一条 resolveFolderSeasons）：
        // 两边各判各的就是两个脑，表现是跨季同期号的文件被归档器判成同一集（活体 2026-09-03）。
        resolveSeasons: (id, groups, fingerprints) => netdisk!.resolveSeasons(id, groups, fingerprints),
        getBinding: (bindingId) => mappingStore.get(bindingId),
        // 下架货架的真相源（P8）：下架集本身就是一条扫网盘目录的 stream（`alist` 成员），
        // 扫到的文件直接是可播条目。整理不存这个路径，每轮问它要。
        offlineDirOf: (streamId) => {
          const member = (channels.getStream(streamId)?.members ?? []).find((m) => m.plugin === 'alist')
          const path = (member?.params as { path?: unknown } | undefined)?.path
          return typeof path === 'string' ? path : undefined
        },
        events: { append: (e) => events.emit(e) },
        log,
      })
      /**
       * 「听一段网盘音频」的装配（`netdisk_transcribe` 工具的取数腿）。四样依赖只有在这儿才同时
       * 够得着：网盘直链与元数据（alist）、时长缓存（`durationCache`）、采样缓存（netdisk.db）、
       * ASR（转写梯子）。策略层（听哪一段、缓存 key 怎么拼）在 `reconcile/sample-audio.ts`，
       * 给模型的形状层在 `mcp/netdisk-transcribe.ts`——这里只接线。
       *
       * `fetchRange` **必须跟随重定向**：AList 的 rawUrl 会 302 到网盘 CDN，`redirect: 'follow'`
       * 是 fetch 的默认值，但这里显式写出来——活体第一次实测就是忘了跟随，拿回 302 的 0 字节体，
       * 表现成"转写全空"，看起来像 ASR 挂了。
       */
      const transcribeSample = makeAudioSampler({
        rawUrl: (p) => alist.rawUrl(p),
        fetchRange: async (url, start, end) => {
          const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' })
          if (!res.ok) throw new Error(`range fetch HTTP ${res.status}`)
          return new Uint8Array(await res.arrayBuffer())
        },
        /**
         * 走**转写那条梯子**（`transcribe` Provider：Groq → Cloudflare → OpenAI，全是远端 API），
         * 不是自己去 new 一个后端 client。
         *
         * **能力有梯子就走梯子**。绕过它的代价很具体：单发绕过去的那版，两段 120 秒窗口要
         * 20–40 秒，而梯子第一档 Groq 是 217× 实时、同样两段约 1 秒；更糟的是据此推出了
         * "转写只有一路，所以整批必须串行"——一个接线错误长成了一条架构结论，把十来张卡的
         * 批量算成了十分钟。
         */
        transcribe: async (bytes, mime) => {
          const inv = await ctx.provider.providerExecutor.invoke('transcribe', { bytes, mime })
          const res = inv && inv.strategy === 'sequential' ? (inv.value as TranscribeResult[] | null)?.[0] : undefined
          if (!res) {
            const misses = inv && 'misses' in inv ? inv.misses : []
            throw new Error(`转写没成：${misses.map((x) => `${x.member}: ${x.reason}`).join('; ') || '梯子上没有可用成员'}`)
          }
          return res
        },
        fileSize: (p) => alist.fileSize(p),
        // 缓存 key 的首选那一档（夸克即 fid）。给不出的 driver 由 sampler 自己退档并记一行日志。
        fileId: (p) => alist.fileId(p),
        // 时长与绑定匹配/归档器共用同一份缓存——同一批网盘文件，分两份等于把 ffprobe 的钱再付一遍。
        durationOf: (f) => durationOf(f, { rawUrl: (p) => alist.rawUrl(p), cache: durationCache, log }),
        cache: new SampleCache(netdiskDb),
        log,
      })
      /**
       * 「就地开一次整理」（spec 2026-08-25 §4.2）。**必须装在这一层，不能装在 serve.ts。**
       *
       * 它有**两个**消费端，而且各读各的对象：HTTP 端点读 serve.ts 传下去的 `HttpDeps`，
       * MCP 工具面读的是这里 `provide` 出去的这一份（`kernel/plugins/agent.ts` 的
       * `netdiskRoutes: ctx.netdisk.netdiskRoutes`）。装在 serve.ts 里只能喂饱前者——
       * 活体实测（2026-08-25）：HTTP `POST /api/netdisk/reconcile/open` 好使，而模型手里
       * **压根没有 `reconcile_open` 这个工具**，它绕着 status/browse/bindings 试了七八步都
       * 走不通。没有任何一处报错：工具不存在和"模型不想用"长得一模一样。
       *
       * 重排班经 `config.rescheduleStream` 递进来（理由见那个字段的注释）。
       */
      const openReconcileHere = (input: OpenReconcileInput): Promise<OpenReconcileResult> => openReconcile({
        getStream: (id) => channels.getStream(id) ?? undefined,
        putMembers: (id, members) => {
          const current = channels.getStream(id)
          if (!current) throw new Error(`stream not found: ${id}`)
          if (!config.rescheduleStream) {
            throw new Error('没接重排班通道，补了来源也不会被采——拒绝半途而废（netdiskPlugin 的 rescheduleStream 没传）')
          }
          channels.putStream({ ...current, members: members as typeof current.members })
          config.rescheduleStream(id)
        },
        listBindings: () => mappingStore.list(),
        bind: ({ streamId, title, dirPath }) => netdisk!.bind({ left: { kind: 'stream', streamId, title }, dirPath }),
        removeBinding: (id) => mappingStore.remove(id),
        mkdir: (path) => alist.mkdir(path),
        getShows: () => reconcile.getConfig().shows,
        putShows: (shows) => reconcile.putConfig({ shows: shows as never }),
      }, input)
      // 凭证只经宿主派发的这一口拿（宿主派发，包不索取）——与 quark-save 同一份夸克 cookie。
      // 追更与裁决器的追更候选转存共用**同一个**分享客户端实例——两处各自 new 一份不是问题
      // （它本身无状态，只是拼参数打 API），但共用省一次装配、也省一处将来漂移的可能。
      const shareClient = quarkShareClient({ cookieFor: (d) => credentials.cookieProvider.cookieString(d).then((s) => s ?? undefined) })
      /**
       * 轮末裁决器（spec 2026-09-03-netdisk-llm-adjudicator）：追更轮归档之后、或手动入口，把归档
       * pending 卡与追更候选打包问一次模型，结论过代码闸后落决策账本。**必须先于 `follow` 装配**：
       * `FollowService` 靠结构类型注入它（`deps.adjudicate`），追更轮末那一步要调它。
       *
       * `invokeLlm` 走与 `netdisk.spec.suggest` 同一个调用点约定（`ctx.llm.forTask`，账本才有数），
       * 只是任务名换成 `netdisk.adjudicate`——两个任务的结论互不相干，账本上要能分清是谁问的。
       *
       * `suggestions` 另开一份 `SuggestionLog`（与 `ReconcileService` 内部那份指向同一张
       * `ai_suggestions` 表、同一个 `netdiskDb` 连接）：那张表本来就是无状态的 SQL 语句薄封装，
       * `ReconcileService` 没有把它对外暴露，裁决器要落审计行只能自己开一份，不是第二个真相源。
       */
      const adjudicateSuggestions = new SuggestionLog(netdiskDb)
      const adjudicate = new AdjudicationService({
        reconcile,
        store: mappingStore,
        suggestions: adjudicateSuggestions,
        invokeLlm: async (messages) => (await ctx.llm.forTask('netdisk.adjudicate', { messages: [...messages] }))?.content ?? null,
        shares: shareClient,
        events: { append: (e) => events.emit(e) },
        log,
      })
      /**
       * 追更（spec 2026-09-03-work-follow-loop）：缺集 → 回访旧分享 / 搜新分享 → 按文件转存 → 归位
       * → 轮末裁决（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 1）。
       *
       * 资源搜索经 config 的 **thunk** 进来：搜索域比本域晚挂，装配期取值就是冻住一个 undefined
       * （「装配期取的值 = 冻住的答案」）。缺席不是致命的——那一轮只回访旧源，并在账本行里记一条
       * `search: 资源搜索未装配`。
       */
      const follow = new FollowService({
        db: netdiskDb,
        store: mappingStore,
        netdisk: netdisk!,
        shares: shareClient,
        videoSearch: () => config.videoSearch?.(),
        mkdir: (p) => alist.mkdir(p),
        // 第 5 步归位复用同一个 reconcile 域（`losers:true` + `gated:true`，见 FollowService 里的注释）。
        reconcile,
        adjudicate,
        events: { append: (e) => events.emit(e) },
        log,
      })
      // 建分享（`POST /api/netdisk/share/create`）：挂载表 + 同一份宿主派发的夸克 cookie + 路径→fid。
      const shareCreate = makeShareCreate({ alist, cookieFor: (d) => credentials.cookieProvider.cookieString(d).then((s) => s ?? undefined), log })
      // 建出去的链接之后归谁管（列 / 删）。同一口 cookie，但不看挂载表：「我的分享」是账号级的一张表。
      const shareManageDeps = { cookieFor: (d: string) => credentials.cookieProvider.cookieString(d).then((s) => s ?? undefined) }
      const shareList = makeShareList(shareManageDeps)
      const shareDelete = makeShareDelete(shareManageDeps)
      netdiskRoutes = { service: netdisk, store: mappingStore, alist, settings, fetchCookies, reconcile, transcribeSample, openReconcile: openReconcileHere, follow, adjudicate, shareCreate, shareList, shareDelete }
      log('[stream] netdisk (alist) wired')
      // 播单侧 harvest 触发 autoSync 的轮询已收编进调度中心的 netdisk-autosync 任务
      // （src/tasks/builtin.ts，6 小时一轮，失败不再 .catch(() => {}) 静默吞——见该任务实现）。
      // serve.ts 的 TaskDeps 三格（netdisk / netdiskStore / reconcile）**直连内核这一域**，
      // 不走 HttpDeps；漏改那三格的症状是每轮「成功」实为 deps undefined 早退，几天不同步零报警。
    }

    ctx.provide('netdisk', { netdisk, netdiskRoutes, subtitleCacheDir } satisfies NetdiskDomain)
  },
}
