import type { Context } from 'cordis'
import { ResolveEngine } from '../../resolve/engine.ts'
import { IntentResolver, DEFAULT_RULES } from '../../resolve/intent.ts'
import { RadarMatcher } from '../../resolve/radar.ts'
import { ProviderStatsStore } from '../../providers/stats-store.ts'
import { ProviderExecutor, type MemberResult } from '../../providers/executor.ts'
import { ProviderDirectory } from '../../providers/directory.ts'
import { providerDirectoryPlugin } from '../../providers/directory-plugin.ts'
import { ProviderBindings, type SlotContext } from '../../providers/bindings.ts'
import { ensureSystemRows, pruneDeadMembers } from '../../providers/seed.ts'
import { allIdentities } from '../../providers/identities.ts'
import { PROVIDER_CALLSITES } from '../../providers/callsites.ts'
import { memberCallArgs } from '../../providers/invoke-types.ts'
import { NETDISK_SAVE_DEST } from '../../../shared/netdisk/save-dest.ts'
import { makeLlmForTask, type LlmForTask } from '../../llm/task.ts'
import { makeLlmOpenAiFn } from '../../llm/sources.ts'
import { NetdiskShareCapability } from '../../netdisk/share-capability.ts'
import { NetdiskPlayCapability } from '../../netdisk/play-capability.ts'
import { NetdiskFolderCapability } from '../../netdisk/folder-capability.ts'
import type { LeftEntry } from '../../netdisk/sync.ts'
import { VideoDetailService } from '../../video/detail-service.ts'
import { VideoEnrichQueue } from '../../video/enrich-queue.ts'
import { tmdbEpisodeIndex } from '../../video/episode-index.ts'
import { resolveDownloads, type DownloadOption } from '../../video/resolve.ts'
import { fetchUrl } from '../../http/fetch-url.ts'
import { fetchArticleText } from '../../content/article-text.ts'
import { makeOpenAiSttFn } from '../../transcribe/sources.ts'
import { MineruClient } from '../../docparse/client.ts'
import { makeOcrVlmFn, makeOcrMineruFn } from '../../docparse/sources.ts'
import { quarkSave } from '../../../shared/netdisk/quark/save.ts'
import { quarkPlayStream } from '../../../shared/netdisk/quark/play.ts'
import { quarkFolderResolve } from '../../../shared/netdisk/quark/browse.ts'
import type { BuiltinAdapter } from '../../adapters/builtin/adapter.ts'
import { makeTmdbImagesFn, makeTmdbMetadataFn } from '../../adapters/builtin/video-metadata.ts'
import { makeTmdbTitleSearchFn } from '../../adapters/builtin/video-title-search.ts'
import { makeTmdbCanonicalFn } from '../../adapters/builtin/video-canonical.ts'
import { researchRunsFn } from '../../board/run-source.ts'
import type { DebugEntry } from '../../debug.ts'
import type { RuntimeConfigResolver } from './runtime-config.ts'

declare module 'cordis' {
  interface Context {
    /** Provider 执行面这一域（`src/kernel/plugins/provider.ts`）——一个聚合对象，不是十几个 ctx key。 */
    provider: ProviderService
  }
}

/**
 * 「谁去把这件事办了」的整条执行面。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名。
 */
export interface ProviderService {
  /** target-resolve：一次性解析 + 意图分类（Provider 调用）。 */
  resolveEngine: ResolveEngine
  intentResolver: IntentResolver
  radarMatcher: RadarMatcher
  /** 调用计数（cache.db）。 */
  providerStats: ProviderStatsStore
  /** Provider 读模型（选行 / serves 判定 / parked 过滤的唯一入口）。 */
  providerDirectory: ProviderDirectory
  providerExecutor: ProviderExecutor
  providerBindings: ProviderBindings
  videoDetails: VideoDetailService
  /** 采集落库即富化的队列。scheduler 的 `onItemPersisted` 喂它——scheduler 比本域早建，
   *  所以 bootstrap 侧仍是一个前向 `let`，只是赋值点搬到了这里。 */
  videoEnrich: VideoEnrichQueue
  /** TMDb 分集索引取法（绑定左侧与详情页未绑剧集懒加载共用）；投影后的 LeftEntry[]。 */
  episodeIndex: (ref: { id: string; media: 'movie' | 'tv'; title: string }) => Promise<LeftEntry[]>
  /** 网盘分享的验活/转存（多个消费方共用一份，都不认识具体网盘）。 */
  netdiskShare: NetdiskShareCapability
  netdiskPlay: NetdiskPlayCapability
  /** 域内产物：netdisk 域（`NetdiskService.folder`）消费，Boot 上没有它。 */
  netdiskFolder: NetdiskFolderCapability
  /** 任务级 LLM 调用的唯一通道。域内产物——摘要/抽名/聊天/网盘四个消费方都在 bootstrap 后段。 */
  llmForTask: LlmForTask
  /** 「下载页引用 → 下载项」的唯一问答脑（HTTP `/api/download-options` 与 MCP `video_resolve` 共用）。
   *  经 download-resolve 行 decline-chain 分发——成员可从 Provider 管理页增删，所以两个门面都
   *  必须走这里、不许直调站点实现（直调会漏掉用户加的成员）。抛错语义：message 含
   *  'unsupported url' = 没有成员认领（调用方映 400），其余 = 上游失败（502）；SlotBrokenError
   *  原样上抛（HTTP 映 422）。 */
  resolveDownloads: (url: string, slot?: SlotContext) => Promise<DownloadOption[]>
}

export interface ProviderConfig {
  /** 可重建那一侧（`cache.db`）——调用计数落在它里面。 */
  cacheDb: string
  log: (...args: unknown[]) => void
  /**
   * 「这个 source 跑起来时该拿到哪份配置」。由 bootstrap 传进来而不是从 `ctx.runtimeConfig` 取：
   * 四个消费点（BuiltinAdapter / Scheduler / ResolveEngine / 分集索引）今天共用**同一个**闭包
   * 实例，从内核另取一份等于把"同一份判据"悄悄变成两份。
   */
  runtimeConfigFor: RuntimeConfigResolver
  /** 本地 MinerU 的地址（`ocr-mineru` 兜底档）；没配就由 `MineruClient` 自己判"这档不可用"。 */
  mineruUrl?: string
  onDebug?: (entry: DebugEntry) => void
}

/** null/undefined → `[]`（= decline），其余包成单元素数组：builtin 通道端到端是数组。 */
const one = (v: unknown | null | undefined): unknown[] => (v == null ? [] : [v])

/**
 * Provider 执行面这一域：**「谁去把这件事办了」的全部零件**。
 *
 * 三段，顺序是有语义的（改动前先读）：
 *  1. **解析面**（`resolveEngine` / `intentResolver` / `radarMatcher`）先建。它按行序执行、
 *     并往 `providerStats` 打点，所以它引用下面才建的 `providerExecutor`——那两个闭包**只在
 *     请求期调用**，装配期一次都不解引用（域内前向 `let`，与搬家前一字不差）。
 *  2. **进程内实现的注册**（`builtinAdapter.register(...)`）。成员一律是 Source：名称/描述的家
 *     是 `packages/builtin/manifests.yaml` 的 manifest，这里只按 mode 注册实现，返回 `[]` = decline。
 *     必须早于执行器**真正被调用**（不是早于构造）——放在这儿是因为依赖都在本域手边。
 *  3. **读模型 → 执行器 → 种子行 → 绑定 → 各能力面**。`ensureSystemRows` 必须先于
 *     `providerBindings.ensureDefaults`：绑定默认值要指向已经存在的系统行，否则种出一批指向
 *     不存在的行的绑定，表现是"这个调用点没配置"而不是任何一处报错。
 *
 * 依赖全部经 inject 从内核取：
 *  - `ctx.stores` —— `UserStore`（行/绑定/流的家）与 `sourceHealth`。
 *    **这条 inject 正是批次 1 挂的那笔账**：`providerDirectoryPlugin` 过去靠 bootstrap 里的
 *    行序保证"存储域已经挂好了"，换个挂载点就静默拿到一个还没有库的目录；现在由 inject 表达。
 *  - `ctx.sources` —— Source 目录（`registry`）。
 *  - `ctx.adapters` —— `builtin` 那一格（注册面）与 `ResolveEngine` 的 adapter 查表。
 *  - `ctx.credentials` —— 解析口 / cookie / BYOK key。
 *  - `ctx.streamEvents` —— 开机体检把某个 collect 调用点的存量绑定回落掉时的那条通知
 *    （只有日志的话，用户看到的就是"我配的 Provider 自己变了"而无处可查）。
 *
 * 句柄一个，登记成 effect：`providerStats.close()`（cache.db 上的一条 sqlite 连接，搬进来
 * 之前从没人关它）。
 */
export const providerPlugin = {
  name: 'provider',
  inject: ['settings', 'sources', 'stores', 'adapters', 'credentials', 'streamEvents'],
  apply(ctx: Context, config: ProviderConfig): void {
    const { log, runtimeConfigFor } = config
    const settings = ctx.settings
    const registry = ctx.sources.registry
    const adapters = ctx.adapters
    const { channels, sourceHealth } = ctx.stores
    const { cookieProvider, tokenProvider, resolver } = ctx.credentials
    const builtinAdapter = adapters.get('builtin') as BuiltinAdapter | undefined
    if (!builtinAdapter) {
      // adapters 域一定先挂（inject 保证），所以拿不到 builtin 只能是那边少织了一格。
      // 静默过去的下场：所有进程内成员一个都不注册，而每一处只会答"这个源 decline 了"。
      throw new Error('[stream] ctx.adapters 里没有 builtin 那一格——进程内 Provider 成员无处注册')
    }

    // ── 1. 解析面 ────────────────────────────────────────────────────────────
    // providerExecutor 在第 3 段构造；下面这两个闭包只在请求期调用，装配期不解引用。
    let providerExecutor!: ProviderExecutor
    const providerStats = new ProviderStatsStore(config.cacheDb)
    // 句柄清欠：cache.db 上的一条 sqlite 连接。同进程第二次装配（测试、将来的重启）不关它就是泄漏。
    ctx.effect(() => () => providerStats.close())

    const resolveEngine = new ResolveEngine({
      registry, adapters, health: sourceHealth, resolveCreds: resolver.fn(),
      runtimeConfigFor,
      // Force a cookie re-read, then re-resolve — one retry for a stale cookie (see fetchOne).
      refreshCreds: async (auth) => { await cookieProvider.refresh(); return resolver.resolve(auth) },
      buildParams: (m, key) => ({ ...(m.fixed_params ?? {}), [m.key_param ?? 'url']: key }),
      // Provider 行对齐：命中 resolve 行（serves 含该 target-type）时按行序/排除执行并计数。
      // 这两处经 executor.match 走 `fallback:true`：今天 category=resolve 没有兜底行，两个值
      // 等价，取与改造前一致的那个——口径变更不混进等价重构。
      providerRows: {
        order: (targetType) => {
          const rows = providerExecutor.match('resolve', targetType)
          if (!rows.length) return null
          // full members (name + row-bound params) — the resolve ladder IS the row's expansion now
          return providerExecutor.resolvedMembers(rows[0])
        },
        count: (targetType, member) => {
          const rows = providerExecutor.match('resolve', targetType)
          if (rows.length) providerStats.record(rows[0].id, member)
        },
      },
    })
    // candidates = the live resolve ladder (Provider row's expanded members, incl. matches-catalog
    // sources), not just provides-declaring manifests — so the intent view mirrors what resolve() runs.
    // 曲目 URL 的识别走 `trackRefFromUrl` 的默认实参——文法来自包声明（`stream.links.patterns`，kind track）。
    const intentResolver = new IntentResolver(registry, DEFAULT_RULES, (tt) => resolveEngine.resolveLadder(tt).map((m) => m.id))
    // Radar: URL → concrete candidate sources over the shared registry (RSSHub catalog + native
    // plugins). Additive alongside the targetType classifier above; feeds /api/intents + subscribe.
    const radarMatcher = new RadarMatcher(registry)

    // ── 2. 进程内实现的注册 ──────────────────────────────────────────────────
    // 播放解析与无损下载都退休了进程内 builtin 源——业务层（播放端点/下载队列）只调按平台派发选出的
    // 取歌 Provider 行，梯子经 registry 展开到目录 download 路由。builtin 这里不再注册任何 dl-*/play-* 实现。
    // content-search 与 resource-search 都已拆成 provides 逐源成员（种子行），经执行器并发扇出——
    // 不再有 content-search-aggregate / resource-search-aggregate builtin 聚合器。
    // 成员返回契约见 download-resolve 行：[{url,type,password?,name?}]；不认识的 URL 抛
    // 'unsupported url' = decline。
    builtinAdapter.register('magnet', async (input) => resolveDownloads(String(input)))
    // 视频播放解析源不在这里：每平台一行 resolve Provider 的成员住各自的包里
    // （`packages/<facility>/`，`package.json#stream.providers` 声明行、manifest 声明成员），
    // 分发由 provider serves-key 完成，宿主不认识任何平台。
    // 网页正文：与阅读器 `/api/enrich?source=link` 共用同一份抽取与缓存，投影成 markdown-lite
    //（保留 `![alt](url)`）。降级判据在 fetchArticleText 里（正文太短 = SPA 空壳 → null）——
    // 成员自己 decline，梯子落到下一档，走法进 ladder；分支层不做第二次判断。
    builtinAdapter.register('article-defuddle', async (_input, params) => {
      const got = await fetchArticleText(String((params as { url?: unknown } | undefined)?.url ?? _input))
      return got ? [got] : []   // 空 = decline，把机会让给梯子上的下一个成员
    })
    // content.enrich 的兜底行：只认直链图片 / 视频（包认领的站在派发那一步就被接走了）。
    // **不给它 resolveByLink**：这一行就是兜底行本身，传了就是自己调自己。
    builtinAdapter.register('fetch-url', async (input) => one(await fetchUrl(String(input), {})))
    // 研究 run 采集源：live present / research present 两个详情面靠它执行源函数
    // （直读 artifact，不再经看板那层查询）。
    builtinAdapter.register('research-runs', researchRunsFn)
    // 夸克分享转存（netdisk-save-quark Provider 行的成员）。是代码而不是 recipe，因为它**写**
    // 用户的网盘——热插数据只能读，写永远是审过的、随版本发布的代码（能力归一化 spec §2，
    // Gap C 拍板 2026-07-17）。引擎表达力已不是边界（jar/params 钩子都长出来了），信任模型才是。
    // 姊妹源 quark-share 是验活（只读），是 recipes/quark/ 里的 kind:'http' recipe。cookie 经
    // broker 取，无浏览器：夸克分享 API 只认 cookie、没有签名（同 AList 的做法）。
    // 百度分享验活已迁为 recipe（recipes/baidu/baidu-share.recipe.json）：引擎补齐 jar/params
    // 钩子/parse 模式（能力归一化 spec §4）后，那个「带 cookie jar 的过程」完全落在引擎表达力
    // 之内——验活是热插数据，加网盘不再发版。
    builtinAdapter.register('quark-save', async (input, params) =>
      one(await quarkSave(String(input), {
        dest: String(params.dest ?? NETDISK_SAVE_DEST),
        subdir: params.subdir == null ? undefined : String(params.subdir),
        passcode: params.passcode == null ? undefined : String(params.passcode),
      }, { cookieFor: (d) => cookieProvider.cookieString(d).then((s) => s ?? undefined) })),
    )
    // 夸克视频转码播放（netdisk-play-quark Provider 行的成员）。只读——调夸克 file/v2/play 拿它
    // 自家转码好的 H.264+AAC 流地址（原盘 AC3/DTS 浏览器无声，转码后有声）。null（无登录态/无转码）
    // → decline，播放侧回落原始 AList 直链。cookie 同 quark-save 经 broker 取，无签名。
    builtinAdapter.register('quark-play', async (input) =>
      one(await quarkPlayStream(String(input), { cookieFor: (d) => cookieProvider.cookieString(d).then((s) => s ?? undefined) })),
    )
    // 夸克文件夹跳转（netdisk-folder-quark Provider 行的成员）。只读——路径段逐层 file/sort 解析成
    // 夸克 fid，拼成网页文件夹 URL。input = 相对挂载根的路径段数组。null → decline，前端回落 AList。
    builtinAdapter.register('quark-folder', async (input) =>
      one(await quarkFolderResolve(Array.isArray(input) ? (input as string[]) : [], { cookieFor: (d) => cookieProvider.cookieString(d).then((s) => s ?? undefined) })),
    )
    // Speech-to-text builtin sources (members of the transcribe Provider row below). 厂商专用客户端住各自的包
    // （Cloudflare → packages/cloudflare 的 adapter）；宿主只留通用的 OpenAI 兼容档。
    // OpenAI-compatible cloud STT (BYOK) — /audio/transcriptions, vendors differ only by baseUrl+model+key.
    // 通用档不带任何默认值：端点 / 模型 / 钥匙名由声明它的包在 manifest 的 fixed_params 里给
    // （宿主不认识任何一家转写服务）；漏一样是抛错，不是 decline。
    builtinAdapter.register('transcribe-openai-compat', makeOpenAiSttFn({ tokenProvider, onDebug: config.onDebug }))
    builtinAdapter.register('transcribe-openai', makeOpenAiSttFn({ tokenProvider, tokenName: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', onDebug: config.onDebug }))
    // LLM builtin source (member of the system `llm` Provider row). 成员自带端点与模型，
    // key 经 params.tokenName 从 TokenProvider 取 —— 没有第二个配置来源要传进来。
    builtinAdapter.register('llm-chat', makeLlmOpenAiFn({ token: (n) => tokenProvider.token(n) }))
    // OCR 成员（`parse` 行）。视觉模型那档和 llm-chat 是同一个传输层——同一个 /chat/completions、
    // 同一种 BYOK 钥匙，只是消息里多一个 image 分片；本地 MinerU 那档兜底。
    builtinAdapter.register('ocr-vlm', makeOcrVlmFn({ token: (n) => tokenProvider.token(n) }))
    builtinAdapter.register('ocr-mineru', makeOcrMineruFn(new MineruClient(config.mineruUrl)))
    // Video detail enrichment Sources. Their API keys live in the hot settings overlay; the
    // Provider rows decide which of these Sources run and in what merge order. TMDb 是宿主的影视身份
    // 主键（领域模型）留在这里；补空的第三方元数据源住各自的包（OMDb → packages/omdb 的 adapter）。
    builtinAdapter.register('tmdb-canonical', makeTmdbCanonicalFn())
    builtinAdapter.register('tmdb-metadata', makeTmdbMetadataFn())
    builtinAdapter.register('tmdb-title-search', makeTmdbTitleSearchFn())
    builtinAdapter.register('tmdb-images', makeTmdbImagesFn())

    // ── 3. 读模型 → 执行器 → 种子行 → 绑定 → 各能力面 ────────────────────────
    // Provider 读模型：谁服务哪个键、谁在兜底、哪些行趴着——全部只在这一个对象里判。系统行的
    // 身份来自代码（`src/providers/system/`），行上只剩编排。内核里也挂一份同源实例，好让按
    // inject 取它的服务不必经本域的聚合对象（今天两处指向同一个 store + 同一张身份表）。
    const identities = allIdentities()
    const providerDirectory = new ProviderDirectory(channels, identities)
    void ctx.plugin(providerDirectoryPlugin, { store: channels, systemIdentities: identities })
    providerExecutor = new ProviderExecutor({
      directory: providerDirectory, registry, stats: providerStats,
      // builtin 源直呼实现（输入可为对象，不能经 String(key) 路径）；其余源走 engine 的
      // adapter/credential 路径。
      // 并发扇出的单成员墙钟上限。**搜索是用户盯着等的交互**，总耗时等于最慢那个成员，
      // 所以必须有人给它封顶——否则一个源就能绑架全场（活体 2026-07-29：douyin-search 跑了
      // 115s / 139s，整次搜索陪等两分钟，而 xhs 3s 的结果早就好了）。
      //
      // 25s 这个数是量出来的，不是拍的：拟人采集本来就慢（xhs 实测 3–8s，含开标签+滚动+等
      // 懒加载），得给它留足余量；纯 HTTP 的源都在 1s 内。douyin 现在过不了这道闸——那是它
      // 自己要修的问题（recipe 滚 6 次里 4 次没有新内容），不该让它继续拖着别人。
      perMemberTimeoutMs: 25_000,
      // 顺次梯子的健康度账：和 ResolveEngine 那条梯子**共用同一个账本**（健康是上游的属性，
      // 不是某条梯子的私产）。不接的后果见 ProviderExecutorDeps.health 的注释。
      health: { record: (id, o) => sourceHealth.record(id, o), get: (id) => sourceHealth.get(id) },
      fetchSource: async (sourceId, input, params): Promise<MemberResult> => {
        const m = registry.get(sourceId)
        // 对象输入的成员合同：对象整袋进 params，key 为空；调用点传 `{vid, format}` / `{url}` 这类
        // 结构化输入的行靠它（播放解析、贴链接抓媒体）。字符串输入仍是 key 本身。builtin 分支不经
        // 这里——实现函数直接拿整个输入对象。为什么必须有这条见 `memberCallArgs` 的头注。
        const call = memberCallArgs(input, params)
        const raw = m?.adapter === 'builtin'
          ? await builtinAdapter.fetch({ ...(m.fixed_params ?? {}), ...(params ?? {}), input }, m)
          : await resolveEngine.fetchSource(sourceId, call.key, call.params)
        // object 输出的 Source：adapter 通道端到端是数组，单个判决以 [obj] 骑到这里——在成员
        // 契约开始的缝上解包，让执行器拿到判决对象本身（spec §3.2）。
        if (m?.output === 'object') return Array.isArray(raw) ? ((raw[0] as Record<string, unknown>) ?? null) : (raw as MemberResult)
        return raw
      },
    })
    // 系统行的唯一保证，两个方向对称：缺的补上、已有的只重申标志、代码不再声明的那些清退掉。
    // 这里**没有迁移链**——系统行的身份住在代码里（`src/providers/system/`），库里那几列是死数据。
    // 从 2026-08-16 之前的版本升级要先跑一次旧版，见 README「升级须知」。
    //
    // 「这一轮哪些包装上了」**从 registry 自己推**，不去问包清单。理由是那两份会分家：一个包
    // 可能读出来了（在包清单里）却因为 manifest 撞 id 被逐包重试摘出了 registry
    // （`sources.ts` 的 skipPackage）。照包清单判就会把它名下的东西当成"代码删的"清掉，
    // 而那是**暂时**缺席——清掉却是永久的。registry 里有没有它出的源，才是"它这一轮真在场"。
    // 两条清理（清退孤儿行 / 清死成员）同吃这一个谓词。
    const loadedPackages = new Set<string>()
    for (const m of registry.all()) {
      const cut = m.id.lastIndexOf('/')
      if (cut > 0 && !m.id.startsWith('rsshub:')) loadedPackages.add(m.id.slice(0, cut))
    }
    const packageLoaded = (pkgName: string) => loadedPackages.has(pkgName)
    const ensuredProviders = ensureSystemRows(channels, packageLoaded)
    if (ensuredProviders.inserted) log(`[stream] backfilled ${ensuredProviders.inserted} missing system provider rows`)
    // 清退是把用户库里的行删掉，必须出声——静默删数据是不可接受的。
    for (const gone of ensuredProviders.retired) {
      const slots = gone.clearedSlots.map((s) => `${s.channelId}/${s.callsiteId}`).join('、')
      log(`[stream] retired orphan system provider row ${gone.id} (identity no longer exists)${slots ? `; cleared channel slots: ${slots}` : ''}`)
    }
    // 保住的那些同样要出声：一条"本该在、这轮不在"的行是暂时缺席，用户得知道它为什么不出结果。
    for (const kept of ensuredProviders.keptAbsent) {
      log(`[stream] 包 ${kept.packageName} 这一轮不在场，保留其 Provider 行 ${kept.id}（不清退——缺席是暂时的，清退是永久的）`)
    }
    // 第二条对称保证：行还在、但成员指向一个**被代码删掉的源**的，把那个成员清掉（见
    // `pruneDeadMembers` 头注）。清退管"身份没了"，这条管"成员指的那个源没了"——两者都必须
    // 出声：一个指向不存在 sourceId 的成员是**静默死**，界面上看着配好了，就是不出结果。
    // 退役表走 thunk 现取（与 catalog 同一份），不在这儿存一份快照。
    for (const dead of pruneDeadMembers(channels, registry, packageLoaded, () => ctx.sources.retiredRoutes())) {
      if (dead.movedTo) {
        log(`[stream] provider row ${dead.providerId}: member ${dead.sourceId} moved to ${dead.movedTo} (source changed package; params kept)`)
        continue
      }
      log(
        `[stream] pruned dead member ${dead.sourceId} from provider row ${dead.providerId} (source no longer exists)` +
        `${dead.restoredDefaults ? '; members 清空后已回该行的默认成员' : ''}`,
      )
    }
    const providerBindings = new ProviderBindings(channels, providerDirectory)
    const seededBindings = providerBindings.ensureDefaults(PROVIDER_CALLSITES)
    if (seededBindings.inserted) log(`[stream] seeded ${seededBindings.inserted} provider callsite bindings`)
    // 并进去的那些也要出声：它改的是用户库里一条**已有**的绑定（只往 dispatch 调用点加行）。
    if (seededBindings.augmented) log(`[stream] merged ${seededBindings.augmented} package-declared default rows into existing dispatch bindings`)
    // 存量体检：collect 调用点上绑着的、不支持全收语义的行清出去（判据与回落取舍见
    // ProviderBindings.auditCollect 的头注）。写入闸只管写入那一刻，拦不住升级前躺在库里的绑定，
    // 而这三个调用点炸起来是详情页整页级的。回落 + 一条通知 = 响但不瘫。
    for (const fallback of providerBindings.auditCollect(PROVIDER_CALLSITES)) {
      const bad = fallback.offending.map((o) => `${o.providerId}(${o.strategy})`).join('、')
      const where = fallback.scope === 'slot' ? `频道 ${fallback.channelId} 的槽位` : '全局绑定'
      const landed = fallback.fallbackProviderIds
        ? `已回落到默认 Provider：${fallback.fallbackProviderIds.join('、')}`
        : '该槽位已摘掉，改用全局绑定'
      log(`[stream] collect callsite ${fallback.callsiteId} ${fallback.scope} fell back (offending: ${bad})`)
      // 通知通道没资格掀翻 boot：回落本身已经写进库、也已经落进日志（上一行），emit 只是"告诉人一声"。
      // 事件层这会儿刚建起来、下游订阅者是谁并不由这里决定，让它的一次抛错带走整个后端不成比例。
      try {
        ctx.streamEvents.emit({
          type: 'provider.binding-fallback', severity: 'warn',
          title: `Provider 绑定已回落：${fallback.callsiteId}`,
          body: `${where}原来绑的 ${bad} 不支持全收语义（collect），这个调用点要把每个成员的结果都收回来合并，首胜（sequential）与两跳（expand）策略给不了。${landed}。要换回自定义 Provider，请改用并发（concurrent）策略的行。`,
          dedupeKey: `provider-collect-fallback:${fallback.scope}:${fallback.channelId ?? '-'}:${fallback.callsiteId}`,
        })
      } catch (e) {
        console.warn(`[stream] provider.binding-fallback notify failed for ${fallback.callsiteId}:`, e)
      }
    }
    /** 任务级 LLM 调用的唯一通道（llm/task.ts）：绑定的 model 覆盖经 executor overrides 下传，
     *  没绑就让梯子上各成员用自己的默认。四个消费方（摘要/抽名/聊天/网盘）都走它。 */
    const llmForTask = makeLlmForTask({ executor: providerExecutor, bindings: providerBindings })
    const netdiskShare = new NetdiskShareCapability({ executor: providerExecutor, directory: providerDirectory, bindings: providerBindings })
    const netdiskPlay = new NetdiskPlayCapability({ executor: providerExecutor, directory: providerDirectory, bindings: providerBindings })
    const netdiskFolder = new NetdiskFolderCapability({ executor: providerExecutor, directory: providerDirectory, bindings: providerBindings })
    const videoDetails = new VideoDetailService({
      store: channels,
      executor: providerExecutor,
      // 频道槽位上下文见 bindings.SlotContext，本调用点无频道语境故不传
      providerFor: (callsiteId) => providerBindings.fixed(callsiteId),
    })
    // 采集落库即富化的落点（钩子挂在 Scheduler 的 onItemPersisted）。范围就是视频频道的成员流
    // ——这是用户拍的板：视频频道之外的流不该为了一张海报去打 TMDb。
    const videoEnrich = new VideoEnrichQueue({
      details: videoDetails,
      videoStreamIds: () => channels.videoStreamIds(),
      onError: (message) => log(`[video-enrich] ${message}`),
    })

    // 分集索引取法在两处共用：绑定左侧（listLeft kind:'tmdb'）与详情页未绑剧集的懒加载。抽成一处，
    // 避免两边各写一份 tmdb 配置解析而漂移（language 一直落 en-US 的老 bug 就是那个形状）。配置走
    // tmdb-metadata 那份 manifest 的 runtime_config —— 同一个 ref、同一套 field 默认（含 language: zh-CN）。
    const episodeIndex = async (ref: { id: string; media: 'movie' | 'tv'; title: string }): Promise<LeftEntry[]> => {
      // manifest 缺席时（包被关掉/还没装载）退回裸 ref——这一层兜底是本处的语义，不进公共解析器。
      // 全名，不是裸名：宿主自己的调用不吃裸名解析——第三方装一个同名包就能把这一句推进歧义分支。
      // （上面 `builtinAdapter.register('tmdb-metadata', …)` 那一格**不改**：它的键是
      // `fixed_params.mode`，另一个命名空间。）
      const tmdbManifest = registry.get('@streamapp/builtin/tmdb-metadata')
      const cfg = tmdbManifest?.runtime_config ? runtimeConfigFor(tmdbManifest) : settings.runtimeConfig('tmdb')
      const apiKey = String(cfg.apiKey ?? '')
      if (!apiKey) throw new Error('TMDb 未配置 apiKey，无法取分集索引')
      return await tmdbEpisodeIndex(
        { apiKey, language: typeof cfg.language === 'string' ? cfg.language : undefined },
        { id: ref.id, media: ref.media, title: ref.title },
      )
    }

    // resolveDownloads 的实现（接口注释在 ProviderService 上）。invoke 的杂音在这里吸掉：
    // sequential 的 value 归一成数组、按形状滤掉不合契约的成员产物,没有产物就把 misses 的
    // reason 拼成一条人话抛出去——调用方只看 message 判 400/502。
    const resolveDownloadsCap = async (url: string, slot?: SlotContext): Promise<DownloadOption[]> => {
      const providerId = providerBindings.fixed('download.resolve', slot) ?? 'download-resolve'
      const r = await providerExecutor.invoke(providerId, url)
      const raw = r && r.strategy === 'sequential' ? r.value : null
      const arr = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
      const options = arr.filter(
        (o): o is DownloadOption => !!o && typeof o === 'object' && typeof (o as DownloadOption).url === 'string',
      )
      if (options.length) return options
      throw new Error((r?.misses ?? []).map((m) => m.reason).join('; ') || 'download not resolved')
    }

    ctx.provide('provider', {
      resolveEngine,
      intentResolver,
      radarMatcher,
      providerStats,
      providerDirectory,
      providerExecutor,
      providerBindings,
      videoDetails,
      videoEnrich,
      episodeIndex,
      netdiskShare,
      netdiskPlay,
      netdiskFolder,
      llmForTask,
      resolveDownloads: resolveDownloadsCap,
    } satisfies ProviderService)
  },
}
