import type { Context } from 'cordis'
import { join } from 'node:path'
import { ConversionStore } from '../../conversions/store.ts'
import { ConversionRunner, type Converter, type ConversionContext } from '../../conversions/runner.ts'
import { migrateLegacyConversions } from '../../conversions/migrate.ts'
import { migrateConversionsToExtract } from '../../conversions/migrate-to-extract.ts'
import { makeSttConverter } from '../../conversions/converters/stt.ts'
import { makeParseConverter } from '../../conversions/converters/parse.ts'
import { makeExtractConverter, type ExtractBranchRunner } from '../../conversions/converters/extract.ts'
import { makeIdentifyConverter } from '../../conversions/converters/identify.ts'
import { makeFramesConverter } from '../../conversions/converters/frames.ts'
import { makeSummaryConverter } from '../../conversions/converters/summary.ts'
import { CONVERSION_DERIVATIONS, CONVERSION_COSTARTS } from '../../conversions/derive.ts'
import { identifyWindowingIn } from '../../conversions/windowing.ts'
import { CapabilityJobStore } from '../../jobs/store.ts'
import { SpeakerRegistryStore } from '../../voiceprint/store.ts'
import { VoiceprintEngineClient } from '../../voiceprint/engine-client.ts'
import { makeIdentifyFn } from '../../voiceprint/identify.ts'
import { resolveIntroNames } from '../../voiceprint/intro-names.ts'
import { migrateSegmentsToTimeline } from '../../voiceprint/migrate-segments.ts'
import { AudioCache } from '../../media/audio-cache.ts'
import { resolveAudioSource } from '../../transcribe/source.ts'
import { resolveTrackSource } from '../../audio/track-source.ts'
import { transcodeCandidatesFor } from '../../netdisk/transcode-candidates.ts'
import { resolveVideoSource } from '../../media/video-source.ts'
import { sampleFrames, planVideoFrames, frameAt } from '../../media/video-frames.ts'
import { makeVideoResolver } from '../../video/resolve-video.ts'
import { standbyManaged } from '../../plugins/standby/hook.ts'
import { videoWorkLookupIdentity, videoTmdbLookupIdentity } from '../../video/item-identity.ts'
import { ladderTrace, LadderError } from '../../providers/ladder-trace.ts'
import { parseLadderLit } from '../../conversions/parse-availability.ts'
import { imageUrls, resolveSourceBytes } from '../../docparse/media.ts'
import { resolveMineruUrl } from '../../docparse/client.ts'
import { safeFetchResponse } from '../../adapters/safe-fetch.ts'
import { ocrArticleImages, type OcrImagesDeps } from '../../content/images/ocr-images.ts'
import { withImageOcrCache } from '../../content/images/ocr-cache.ts'
import { makeParseOcrDep } from '../../content/images/parse-ocr-dep.ts'
import { makeArticleFetchDep } from '../../content/article/article-fetch-dep.ts'
import { StoryFoldWorker } from '../../story-fold/worker.ts'
import { makeFoldTextSource } from '../../story-fold/text-source.ts'
import { probeFingerprintEngine, fingerprintBytes, type FpEngine } from '../../media/audio-fingerprint.ts'
import { mediaToolAvailable } from '../../media/ffmpeg-bin.ts'
import { makeAudioFpConverter } from '../../conversions/converters/audio-fp.ts'
import { makeFoldFpSource } from '../../story-fold/fp-source.ts'
import { buildSummaryMessages } from '../../llm/client.ts'
import { summarizeViaLlm, llmContentQuiet } from '../../llm/task.ts'
import { ensureTranscribeRow } from '../../providers/seed.ts'
import { missingRequiredRuntimeFields } from '../../manifest/runtime-config.ts'
import type { Media } from '../../content/types.ts'
import type { TranscriptSegment } from '../../transcribe/client.ts'
import type { DebugEntry } from '../../debug.ts'

declare module 'cordis' {
  interface Context {
    /** 转换底座这一域（`src/kernel/plugins/conversions.ts`）——一个聚合对象，不是六个 ctx key。 */
    conversions: ConversionsDomain
  }
}

/**
 * 转换底座的聚合对象。**字段名与它们在 `Boot` 上的旧名字一字不差**——搬家不改名。
 *
 * `speakerRegistry` / `voiceprintEngine` / `capabilityJobs` **可为 undefined**：没有任何 STT
 * token 时整块声纹/账本不装配（门在 `apply` 里，语义与搬家前一字不差）。域本身照样挂。
 */
export interface ConversionsDomain {
  /** 统一的转换资源（OCR / 转写 / 补说话人 / 摘要）——**转换的唯一入口**：/api/conversions
   *  端点族、MCP 的 transcribe/parse/get_conversions、声纹路由读写转写 segments，全部经它。 */
  conversions: ConversionRunner
  /** 说话人身份库（声纹内核；只在配了转写源时构造）。 */
  speakerRegistry?: SpeakerRegistryStore
  /** sherpa-onnx 声纹引擎的 client（后端可选；没有它就退成匿名段）。 */
  voiceprintEngine?: VoiceprintEngineClient
  /** ConversionRunner 队列背后的 capability job 账本（只在配了转写源时构造）；
   *  serve.ts 的 jobs-sweep 任务直连它。 */
  capabilityJobs?: CapabilityJobStore
  /** 「把一个网页读成正文」：`article-extract` 梯子的唯一实现。extract 的 article 分支和
   *  MCP/对话的 `read_url` 工具是它的两个消费方。 */
  readUrl: ReturnType<typeof makeArticleFetchDep>
  /** 域内产物：归堆的后台工。scheduler 段（`StoryFoldRecorder.onQueued`）拿它 kick——
   *  scheduler 比本域早建，所以 bootstrap 侧仍是一个前向 `let`，只是赋值点搬到了这里。 */
  storyFoldWorker: StoryFoldWorker
  /** 域内产物：agent 域读转写正文的口径（chat 上下文补全）。agent 域 inject 本域，**调用时**
   *  才从 `ctx.conversions` 取——不是装配期解构，别把它冻成快照。 */
  agentGetTranscript: (itemId: string) => unknown
}

export interface ConversionsConfig {
  /** 可写状态根目录（`voiceprint.db` / `jobs.db` / `audio-tracks/` 都在它下面）。 */
  dataDir: string
  /** 持久那一侧（`stream.db`）——转换记录表住在它里面。 */
  streamDb: string
  log: (...args: unknown[]) => void
  /** 摘要 prompt 的 **thunk**：用户在设置里改完是热生效的（`setSummaryPrompt` 回读 settings），
   *  取值冻结在装配期就再也跟不上——改了 prompt 得重启才算数，而没有一处会报错。 */
  summaryPrompt: () => string | undefined
  onDebug?: (entry: DebugEntry) => void
  /** config.yaml 里 MinerU 地址的显式 override（`mineru_url`）——与 provider 域注册 `ocr-mineru`
   *  成员时用的是同一个值；这里只拿它判「管不管得着 MinerU」（`mineruInstalled`）。 */
  mineruUrl?: string
  /** 指纹引擎探测的注入口（测试用）；缺省走真探测。装配期只发起、不等待——available 是读结果的 thunk。 */
  probeFpEngine?: () => Promise<FpEngine | null>
}

/** 日志里的字节量统一用 MiB，且**标明单位**——之前写作 "MB" 实为 MiB，对外报数差 5%。 */
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MiB`

/**
 * 转换底座这一域：**「把这条 item 变成文本」的全部零件**。
 *
 * 一张表（`stream.db` 的 conversions）+ 一套队列/去重/取消/计时/账本（`ConversionRunner`），
 * 上面挂四个 kind：extract（三分支：转写 / OCR / 网页正文，外加 inline 直取）、identify
 * （补说话人）、frames（抽帧逐帧 OCR）、summary。
 *
 * **两个条件块**（语义与搬家前一字不差）：
 *  1. `transcribeRow`（环境里有 STT token）那一块：AudioCache / 声纹库 / 引擎 / 账本 /
 *     取音频那条腿 / stt 分支 / identify 与 summary 两个 converter。
 *  2. 无条件那一块：OCR 分支、网页正文、extract、frames。
 * runner 在两块之后统一构造一次——队列只有这一份。
 *
 * 依赖全部经 inject 从内核取：
 *  - `ctx.stores` —— `channels`（Provider 行/成员表）、`itemStore`、`storyFold`、`contentCache`
 *    （逐图 OCR 缓存）、`audioArchive`（取音频的统一漏斗第一档）。
 *  - `ctx.credentials` —— `tokenProvider`（哪些 STT 档在）与 `cookieProvider`（转码档探测）。
 *  - `ctx.provider` —— `providerExecutor` / `providerBindings` / `videoDetails`
 *    / `netdiskPlay`。**从 ctx 现取，不解构存快照。**
 *  - `ctx.llm` —— `forTask`（两个调用点：llm.summarize 的抽名与总结）——账本才有数，
 *    别绕过它直打 `ctx.provider.llmForTask`。
 *  - `ctx.netdisk` —— 取音频/取画面时的网盘那一档（没配 AList → undefined，自动跳过）。
 *  - `ctx.streamEvents` —— 「转成文字完成/失败」那条播报。
 *  - `ctx.sources` + `ctx.runtimeConfig` —— 转写梯子每一档「配没配好」：按成员 source id 取 manifest，
 *    用成员执行时同一个解析器解它的 runtime_config，看 required 字段齐不齐（见 `sttMemberConfigured`）。
 *
 * **不 inject `packages`**：`parse` 梯子兜底档（MinerU）算不算数问的是「管不管得着它」——
 * standby 名册 + 取址（`mineruInstalled`，见下），不是内置层的插件名单（MinerU 是用户层可选包，
 * 那份名单里永远没有它）。
 *
 * 句柄三个，登记成 effect：`ConversionStore`（stream.db）、`CapabilityJobStore`（jobs.db）、
 * `SpeakerRegistryStore`（voiceprint.db）三条 sqlite 连接，搬进来之前从没人关。外加两处
 * **定时器**（见下面 `trackedSchedule`）——`ConversionRunner` 的重排与 `StoryFoldWorker` 的
 * 兜底巡检，两者都没有 stop 面，但都收注入的 `schedule`，所以在本域这一侧记账清掉，
 * 不给它们本体加生命周期（那是它们自己的事）。
 */
export const conversionsPlugin = {
  name: 'conversions',
  inject: ['stores', 'credentials', 'provider', 'llm', 'netdisk', 'streamEvents', 'sources', 'runtimeConfig'],
  apply(ctx: Context, config: ConversionsConfig): void {
    const { dataDir, streamDb, log } = config
    const { channels, itemStore, storyFold: storyFoldStore, contentCache, audioArchive: archive } = ctx.stores
    const { cookieProvider, tokenProvider } = ctx.credentials
    const events = ctx.streamEvents

    /**
     * 记账版的定时器：`ConversionRunner`（失败重排）和 `StoryFoldWorker`（兜底巡检）都收
     * 注入的 `schedule`，默认实现是 `setTimeout().unref()` 且**没有任何 stop 面**——
     * 同进程第二次装配（测试、将来的重启）留下的那些回调会打在已经关掉的库上。
     * `unref()` 保住（进程退出不被它拖住），语义与默认实现一字不差。
     */
    const pending = new Set<ReturnType<typeof setTimeout>>()
    const trackedSchedule = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { pending.delete(t); fn() }, ms)
      t.unref?.()
      pending.add(t)
    }
    ctx.effect(() => () => { for (const t of pending) clearTimeout(t); pending.clear() })

    // 统一的转换底座：OCR / 转写 / 补说话人 / 摘要共用一张表、一套队列、一套计时
    // （见 docs/superpowers/specs/2026-07-25-conversions-unified-api-design.md）。
    // 各 kind 的 converter 由下面两个条件块按需塞进 conversionConverters，runner 在两块之后统一构造。
    const conversionStore = new ConversionStore(streamDb)
    // 句柄清欠：stream.db 上的这条连接过去从没人关。
    ctx.effect(() => () => conversionStore.close())
    const migration = migrateLegacyConversions(conversionStore.database, conversionStore)
    if (migration.migrated) {
      log(
        `[conversions] 迁移旧记录：转写 ${migration.transcripts} 条、摘要 ${migration.summaries} 条、解析 ${migration.parses} 条`
      )
    }
    // 顺序要紧：先把旧表搬进来，再把表内的 stt/parse 收成 extract——反过来的话，刚搬进来的
    // 那批老 kind 就赶不上这趟改写了。两个都幂等，第二次启动是空转。
    const toExtract = migrateConversionsToExtract(conversionStore.database)
    if (toExtract.stt || toExtract.ocr) {
      log(`[conversions] 收敛为 extract：转写 ${toExtract.stt} 条、解析 ${toExtract.ocr} 条`)
    }
    const conversionConverters: Converter[] = []
    // 声学指纹引擎：启动异步探测一次，converter 的 available 读探测结果的 thunk——
    // 装配期把它冻成布尔就是「开机那一刻的答案」，探测还没回来它就永远 false。
    const fpEngine: { current: FpEngine | null } = { current: null }
    void (config.probeFpEngine ?? probeFingerprintEngine)().then((engine) => {
      fpEngine.current = engine
      if (engine) log(`[audio-fp] 指纹引擎: ${engine === 'ffmpeg' ? 'ffmpeg chromaprint muxer' : 'fpcalc'}`)
      else log('[audio-fp] 无 chromaprint 能力(ffmpeg muxer 与 fpcalc 都不在)——归堆的媒体对回退到文本判据')
    })
    // 启动清扫（触发点 3，见 AudioCache.write 头注）：写入后的 unref 定时器不劫后重启，
    // 上一次进程留下的过期音轨靠这里收尸。
    const audioCache = new AudioCache(join(dataDir, 'audio-tracks'))
    void audioCache.sweep()
    // 取音频这一步 stt 与 identify 共用（identify 是「补名不重跑 STT」，音频还是同一份，
    // 走同一个落盘缓存所以重取很便宜）。
    // 这条漏斗现在有两个消费方：stt 分支（转写）与 audio-fp（声学指纹）。它不依赖
    // 任何 STT token，所以住在 transcribeRow 闸门外——指纹在零转写源的安装上也要工作。
    // 播放 / 转写 / 抽帧共用同一条派发（`src/video/resolve-video.ts`）——三处各拼一遍的年代，
    // 「只有抽帧那处认不出某种 id 形状」这类错只在一条路上出现，另外两条照常好使。
    const resolveVideo = makeVideoResolver({
      executor: ctx.provider.providerExecutor,
      bindings: ctx.provider.providerBindings,
    })
    const resolveTranscribeMedia = (handle: string, mediaHint: Media[] | undefined) =>
          resolveAudioSource(handle, mediaHint, {
            // 带 (provider, vid) 的视频：经上面那条派发要纯音轨（没有再退整片），见 media.ts。
            resolveVideo,
            netdisk: ctx.netdisk.netdisk,
            getItem: (id) => itemStore.get(id),
            // 音频的字节去哪儿取 = 播放那条**统一漏斗**（归档 → 网盘 → 官方梯子 → 回落直链）。
            // 转写层只收一个函数，不认识 provider executor / 归档索引——三样依赖在这里绑好。
            // 无频道语境（转写不是从某个频道发起的）→ dispatch 不传 ctx，走全局 binding。
            // fallback:false：绑定里没有认这个平台的行就诚实回 null，别拿一条兜底行去跑。
            resolveTrack: async (platform, id, fallbackUrl) =>
              (await resolveTrackSource(platform, id, { fallbackUrl }, {
                audioArchive: archive,
                netdisk: ctx.netdisk.netdisk,
                providers: { executor: ctx.provider.providerExecutor },
                providerFor: (p) => ctx.provider.providerBindings.dispatch('music.track.resolve', p, undefined, { fallback: false }),
              })).source,
            onError: (h, e) => log(`[transcribe] audio source ${h} failed: ${String((e as Error)?.message ?? e)}`),
            // 更小的容器候选：网盘自己的转码档（同一次 netdisk.play 解析，播放取最好那档、
            // 这里问每档多大）。判决本身在 audio-route.ts，这里只负责把候选连同取它的凭证递过去。
            transcodeCandidates: transcodeCandidatesFor({
              netdisk: ctx.netdisk.netdisk,
              netdiskPlay: ctx.provider.netdiskPlay,
              credentialProvider: cookieProvider,
              // 探测也问不出大小 = 这些档位会被判路丢掉、回落原盘（可能几 GiB）。这个回落以前是
              // 静默的，代价直到事后翻日志才看得见（一次 13.2GiB vs 应有的 115.6MiB）——所以出声。
              onUnknownSize: (unknown, total) =>
                log(`[transcribe] ${unknown}/${total} 个转码档大小未知(探测失败) → 判路只能回落原盘`),
            }),
            // 音轨落盘缓存：转写重试（ASR 被重启打断 / 切 diarize 重跑）不再重付整次容器传输。
            audioCache: audioCache,
            // 容器和产出分开报：containerBytes 是**过网**的量（贵的那个），bytes 是抽出来喂 ASR 的量。
            // 把两者印在同一行，是因为它们差着一到两个数量级——上一版把它们混成一个数，判反了 39 倍。
            onTiming: (h, t) =>
              t.cached
                ? log(`[transcribe] audio ${h}: cache hit → ${mib(t.bytes)} (零网络)`)
                : log(
                `[transcribe] audio ${h}: ${t.containerLabel} of ${t.containers} containers` +
                `${t.containerBytes ? ` (${mib(t.containerBytes)} over the wire)` : ''} · ` +
                `track ${t.track} of ${t.tracks} → ${mib(t.bytes)} · ` +
                `rawUrl ${t.rawUrlMs}ms` +
                `${t.prefetchMs ? ` · prefetch ${t.prefetchMs}ms ×${t.prefetchConnections}conn` : ''} · ` +
                `probe ${t.probeMs}ms · extract ${t.extractMs}ms`,
              ),
          })
    conversionConverters.push(
      makeAudioFpConverter({
        resolveMedia: resolveTranscribeMedia,
        fingerprint: (bytes, mime, signal) => {
          void mime // ffmpeg/fpcalc 按字节自嗅探
          if (!fpEngine.current) return Promise.reject(new Error('指纹引擎不可用'))
          return fingerprintBytes(bytes, fpEngine.current, { signal })
        },
        available: () => fpEngine.current !== null,
      })
    )
    // extract 的三条分支。stt 只在装了 STT 源的那一档里构造，所以先留空——
    // 缺席时给一个「恒不可用」的空分支，让 extract 照常注册（inline 一档不打后端，永远成立）。
    let sttBranch: ExtractBranchRunner | undefined
    // Transcription is a Provider row: members = STT sources present in this install (drop the
    // rest — 没配就不显示). The queue wraps executor.invoke('transcribe').
    let speakerRegistry: SpeakerRegistryStore | undefined
    let capabilityJobs: CapabilityJobStore | undefined
    let voiceprintEngine: VoiceprintEngineClient | undefined
    /**
     * 「这一档此刻配没配好」。梯子本身（有哪几档、什么顺序、为什么 Groq 排第一）住在身份
     * 模块 `src/providers/system/transcribe.ts`；这里只回答"这一档跑得动所需的东西在不在"，两样：
     *  1. 钥匙在（`tokenProvider.token(tokenName)`，存储优先、空着回落环境变量）；
     *  2. 成员 manifest 里 `runtime_config` 所有 `required` 的字段都解得出非空值——解析走
     *     `ctx.runtimeConfig`，就是成员**执行时**拿到配置的那一个解析器，所以「判配好了」和
     *     「跑起来有值」不会分家（cloudflare 的 accountId 填在配置页或环境变量里都算）。
     * 不按站名分支：哪一格必需由包自己在 manifest 里申报。没写 required 的字段不参与，manifest
     * 在注册表里找不到（包没装载）也只看钥匙——两种都保持「只看 token」的旧语义。
     */
    const sttMemberConfigured = (sourceId: string | undefined, tokenName: string): boolean => {
      if (!tokenProvider.token(tokenName)) return false
      const manifest = sourceId ? ctx.sources.registry.get(sourceId) : undefined
      if (!manifest?.runtime_config) return true
      return missingRequiredRuntimeFields(manifest.runtime_config, ctx.runtimeConfig(manifest)).length === 0
    }

    /**
     * 「转写此刻配没配得动」——**每次调用现问**，从库里现读那一行的成员。
     *
     * 绝不在装配期求值存下来：用户配上 key 的那一刻后端早就起来了，冻一份的表现是他申请完
     * key 功能仍然不可用、而且没有任何一处会喊（活体 2026-09-04，win-test）。
     *
     * 没有 `tokenName` 的成员一律算数：那是用户自己加的东西，我们无从判断它要不要钥匙，
     * 而它真跑不动时自己会 decline——**猜它不行**比让它自己说更坏。
     */
    const sttConfigured = (): boolean =>
      (channels.getProvider('transcribe')?.members ?? []).some((m) => {
        const tokenName = (m as { params?: { tokenName?: unknown } }).params?.tokenName
        const sourceId = 'source' in m && typeof m.source === 'string' ? m.source : undefined
        return typeof tokenName === 'string' ? sttMemberConfigured(sourceId, tokenName) : true
      })

    // 这一行无条件建，整份梯子都写进去（理由在 `ensureTranscribeRow` 头注：成员自己现读 token，
    // 筛与不筛运行时一个样，而筛掉的代价是能力的存在与否被绑在启动那一刻）。
    const transcribeRow = ensureTranscribeRow(channels)
    // 这里是个**裸块**，不是条件分支：里面那一串 const 只服务于这一段（identify / 抽名 /
    // 出现账 / 分窗），用块把它们的作用域圈住。以前这儿是 `if (transcribeRow)` —— 那个 if 才是
    // 「配上 key 要重启」的真正来源，见上一行的注释与 `ensureTranscribeRow` 头注。
    {
      log(`[stream] transcribe provider members: ${transcribeRow.members.map((m) => ('source' in m ? m.source : 'matches' in m ? m.matches : 'provider' in m ? m.provider : 'category' in m ? m.category : m.provides)).join(' → ')}`)
      // Voiceprint identity kernel: engine (sherpa-onnx container, optional) + persistent registry.
      // identify is built unconditionally — under the host 档 the engine's address only exists once
      // its container is awake, so "configured at bootstrap time" is not a valid gate: evaluating
      // configured() once here and baking the result into whether `identify` exists would freeze
      // identity resolution off forever for any process that booted before the container woke.
      // makeIdentifyFn itself checks configured() on every call and degrades to the anonymous
      // segments when it's false, so constructing it unconditionally is safe. What the stt converter
      // needs from us instead is identifyReady, checked per job, which is what decides whether the
      // STT itself should diarize (see src/conversions/converters/stt.ts, sttDiarize).
      // registry/engine are still constructed unconditionally: the enroll HTTP routes need the
      // registry even with no engine.
      speakerRegistry = new SpeakerRegistryStore(join(dataDir, 'voiceprint.db'))
      // 句柄清欠：voiceprint.db 上的这条连接过去从没人关。
      const registryHandle = speakerRegistry
      ctx.effect(() => () => registryHandle.close())
      voiceprintEngine = new VoiceprintEngineClient(process.env.VOICEPRINT_URL)
      // readiness 问的是"管不管得着",不是"现在醒着吗":显式 URL/env/compose DNS 配置了 → true
      // (原语义);host 档下 standby 管着 voiceprint(哪怕此刻睡着)→ 也 true —— 真调用时
      // withAwake 会把容器唤醒(见 engine-client.ts diarize/embed),睡着不该成为早退的理由。
      const identifyReady = () => voiceprintEngine!.configured() || standbyManaged('voiceprint')
      const identify = makeIdentifyFn({
        engine: voiceprintEngine,
        registry: speakerRegistry,
        ready: identifyReady,
        onError: (e) => log(`[voiceprint] identify degraded: ${String((e as Error)?.message ?? e)}`),
        onDebug: config.onDebug,
      })
      // 自我介绍抽名的 LLM 通道：复用 llm.summarize 调用点（同是「读懂一段中文、给确定性小段
      // 输出」）。走梯子后连接/模型跟着 Provider 行热更，不必重启。
      // 未配置 / 全 decline / HTTP 失败 → 返回 null，抽名步据此把该簇留作匿名（低置信不硬认）。
      const invokeIntroLlm = (messages: import('../../llm/client.ts').ChatMessage[]): Promise<string | null> =>
        llmContentQuiet(ctx.llm.forTask, 'llm.summarize', { messages, temperature: 0 })
      // 本作品的演职员表（TMDb `metadata.people`）——抽名拿它纠 ASR 同音字：实测「林简七」被转写成
      // 「林剪七」，不纠就会 enroll 出一个错名的 Person 永久污染声纹库。videoDetails 自带缓存
      // （stream.db video_details 表），所以这里每集只是一次命中缓存的读。取不到就返回空数组
      // ——抽名侧遇空数组会「无从校验、原样采信」，不因为拿不到演职员表就整个不命名。
      // provider 域经 inject 保证已挂，`videoDetails` 恒在——搬家前那道 `if (!videoDetails)`
      // 防的是 bootstrap 里前向 `let` 还没赋值的那个窗口，inject 之后不存在这个窗口。
      const castNamesFor = async (handle: string): Promise<string[]> => {
        try {
          const ep = /^tmdb:(\d+):S\d+E\d+$/i.exec(handle)
          const identity = ep
            ? videoTmdbLookupIdentity({ id: ep[1], media: 'tv', title: ep[1] })
            : (() => {
                const item = itemStore.get(handle)
                return item ? videoWorkLookupIdentity(item) : null
              })()
          if (!identity) return []
          const detail = (await ctx.provider.videoDetails.get(identity)).detail
          return (detail.metadata?.people ?? []).map((p) => p.name).filter(Boolean)
        } catch {
          return []
        }
      }
      capabilityJobs = new CapabilityJobStore(join(dataDir, 'jobs.db'))
      // 句柄清欠：jobs.db 上的这条连接过去从没人关。
      const jobsHandle = capabilityJobs
      ctx.effect(() => () => jobsHandle.close())
      const introNamesFor = async (itemId: string, segs: TranscriptSegment[]) =>
        resolveIntroNames(itemId, segs, {
          invokeLlm: invokeIntroLlm,
          registry: speakerRegistry!,
          cast: await castNamesFor(itemId),
        })
      // 出现账只有一个源：diarization 时间线（此刻声纹匹配与抽名的改名都已落进去）。
      // 时间线为空 → 重算成空账，与「没有说话人数据」自洽。
      const recordAppearances = (itemId: string) =>
        speakerRegistry?.recomputeItemAppearances(itemId, speakerRegistry.getItemTimeline(itemId))
      // 分窗断点续跑的上下文：窗文件挂在 runner 给的 ctx.jobDir 下（账本行的目录），
      // 转换成功收尾时随账本行一起回收。
      const makeWindowing = (jobCtx: ConversionContext, onDegrade: (e: unknown) => void) => {
        if (!jobCtx.jobDir || !capabilityJobs) return undefined
        return identifyWindowingIn(jobCtx.jobDir, capabilityJobs, jobCtx, onDegrade, config.onDebug)
      }
      // stt 不再是一个对外的 kind——它成了 extract 的一条**分支**。构造照旧，只是接线换了地方。
      sttBranch = makeSttConverter({
          // **ffmpeg 在不在算进这句自述里。** 转写的第一步就是把源字节喂给 ffmpeg 重编码 / 切块
          // （`planSttChunks`）——它不在，这条分支必然失败，而且是在用户点下去、等了一分半钟
          // 之后才失败（活体：`stt:media` 88.6s → `stt:asr` 12ms → `spawn ffmpeg ENOENT`）。
          // 同一份代码里 audio-fp 早就是这么做的（探不到 chromaprint 就把自己报成不可用），
          // 这里补上口径。判据源只有一个：`src/media/ffmpeg-bin.ts`。
          // 每次现问、不缓存否定答案：用户装完 ffmpeg 回来刷新一下就该看到它亮起来。
          available: () => sttConfigured() && mediaToolAvailable('ffmpeg'),
          invokeTranscribe: (input) => ctx.provider.providerExecutor.invoke('transcribe', input),
          resolveMedia: resolveTranscribeMedia,
          onDebug: config.onDebug,
          identify,
          identifyReady,
          resolveIntroNames: introNamesFor,
          recordAppearances,
          makeWindowing,
        })
      conversionConverters.push(
        makeIdentifyConverter({
          store: conversionStore,
          available: identifyReady,
          resolveMedia: resolveTranscribeMedia,
          identify,
          resolveIntroNames: introNamesFor,
          recordAppearances,
          // 没有转写时出现账的唯一依据（转写 segments 为空，人名只在时间线上）。
          readTimeline: (itemId) => speakerRegistry?.getItemTimeline(itemId) ?? [],
          onRecluster: (itemId) => speakerRegistry?.deleteItemClusters(itemId),
          makeWindowing,
        })
      )
      // 总结:走 llm.summarize 调用点(prompt 组装仍是 client 的纯函数)。这条调用点刻意**不设**
      // model 覆盖——梯子上第一个能用的成员用自己 params.model;迁移只给有任务绑定的连接写了
      // 默认,没写的成员在梯子里被 sources.ts 的 !model 判断当未配置自动跳过。
      // 行不存在/成员全 decline(未配置)→ llmForTask 返回 null,维持"未配置"文案。
      const summarizeText = (text: string, lang?: string) =>
        summarizeViaLlm(ctx.llm.forTask, {
          messages: buildSummaryMessages(text, config.summaryPrompt(), lang),
          temperature: 0.3,
        })
      conversionConverters.push(
        makeSummaryConverter({ store: conversionStore, summarize: summarizeText, available: () => true })
      )
    }
    // 逐图 OCR 的两条 dep（ocr 分支多图 gallery 与 article 分支正文配图共用）：取字节走 safe-fetch
    // （SSRF 白名单/体积上限在那一层，**不能用 safeFetchText**——它只收 text/html，图片会被直接拒），
    // 认字走 `parse` 能力行的梯子（两条分支同一条行、同一个成本阶梯）。外面再包一层按图缓存：
    // 同一张图只付一次模型。
    const articleImageOcrDeps = (signal?: AbortSignal): OcrImagesDeps =>
      withImageOcrCache(
        {
          fetchBytes: async (url) => {
            const resp = await safeFetchResponse(url, { signal })
            if (!resp) return null
            const mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
            return { bytes: new Uint8Array(await resp.arrayBuffer()), mime }
          },
          // `parse` 行 sequential value:null 时的两种真相（全员 decline vs 有成员真的失败）由
          // makeParseOcrDep 分开，见其头注——判据是 InvokeMiss.stack 有没有值。
          ocr: makeParseOcrDep(ctx.provider.providerExecutor, signal),
        },
        contentCache,
      )

    // 图片/PDF → Markdown。**不再直连 MinerU**：走 `parse` 能力行的梯子，成员顺序即成本阶梯
    // （用户加的视觉模型排前面吃白嫖额度，MinerU 兜底）。converter 只管"跑一次"，挑谁归梯子。
    // mineruInstalled 问的是「管不管得着 MinerU」，与 identifyReady 同一个形状：MinerU 是可选包
    // （`stream add @streamapp/mineru`），装在用户层——用户层的包**不进** `ctx.packages.plugins`
    // （那份只扫内置层），它的容器描述符住 BackendDirectory、由 standby 管。所以不能问
    // `plugins.some(id === 'mineru')`（内置层里永远没有它，恒 false → OCR 梯子永远不亮）。
    // 顺序即判据：先问 standby 管不管（管着就不去读地址），再窥视一次地址（显式 override /
    // MINERU_URL / compose DNS）；`peek` 掐掉 host 档睡着时的「取址落空」喊声——这是探测不是消费。
    // 必须是 thunk：host 档下装配那一刻容器多半没醒，冻结成 false 就是永远不亮，且没有一处会报错
    // （AGENTS.md「装配期取的值 = 冻住的答案」）。
    const mineruInstalled = () => standbyManaged('mineru') || resolveMineruUrl(config.mineruUrl, { peek: true }) !== ''
    // 判据只有一份：src/conversions/parse-availability.ts 的 parseLadderLit（两个消费方共用）。
    const parseLadderAvailable = () =>
      parseLadderLit((channels.getProvider('parse')?.members ?? []) as ReadonlyArray<Record<string, unknown>>, { mineruInstalled: mineruInstalled() })
    const ocrBranch = makeParseConverter({
        available: parseLadderAvailable,
        parse: async (bytes, mime) => {
          // sequential 行的结果在 `value`（第一个不 decline 的成员赢），不是 `items`。
          const res = await ctx.provider.providerExecutor.invoke('parse', { bytes, mime })
          const ladder = ladderTrace(res ?? null)
          const won = (res && 'value' in res ? res.value : null) as { markdown?: string } | null
          if (!won?.markdown) {
            // 逐个成员的退出原因**必须带出来**。executor 一直把它记在 `misses` 里，早先这里把它丢了，
            // 只报一句"成员都 decline 或未配置"——那句话分不清「没配」和「配了但调用失败」，
            // 而这两者的排查方向完全相反。一句话要能分开两个世界，否则它只是安慰。
            const why = (res?.misses ?? []).map((m) => `${m.member}: ${m.reason}`).join('；')
            // LadderError 而不是 Error：这样走法在失败那条路上也能进记录（runner 的 catch 会取它）。
            throw new LadderError(`parse: 没有成员产出结果${why ? `（${why}）` : '（梯子上一个成员都没有）'}`, ladder)
          }
          return { markdown: won.markdown, ladder }
        },
        resolveSource: (media) => resolveSourceBytes(media, { fetchUrl: (u) => safeFetchResponse(u) }),
        // 多图 gallery：收齐全部图 URL（第一张在前），逐图管线复用 article 分支那套
        // （safe-fetch + parse 行 + 按图缓存，见下 articleImageOcrDeps）。
        resolveImages: (media) => imageUrls(media),
        ocrImages: articleImageOcrDeps,
      })

    // 「把一个网页读成正文」这一份能力**只有这一处实现**，两个消费方：extract 的 article 分支
    // （用户点「转成文字」时的链接类内容）和 MCP/对话的 `read_url` 工具（跟进一条搜索结果）。
    const articleFetch = makeArticleFetchDep(ctx.provider.providerExecutor)

    // 「把这条 item 的正文给我」——唯一的问法。三条分支（转写 / OCR / 网页正文）+ 一档 inline
    // 直取，判分支归 shared/extract/plan.ts（前端同一份）。
    conversionConverters.push(
      makeExtractConverter({
        stt: sttBranch ?? { stages: [], available: () => false, run: async () => ({ ok: false, error: { code: 'unavailable', message: '未配置任何转写源' } }) },
        ocr: ocrBranch,
        article: {
          // 打 `article-extract` 行——成员即成本阶梯（裸 HTTP 的 Defuddle 在前，跑 JS 的降级档在后）。
          // **不打 fetch-url**：那条行是媒体导向的，`text` 一处都没赋值过，接上去就是一条恒空的分支。
          available: () => (channels.getProvider('article-extract')?.members.length ?? 0) > 0,
          fetch: articleFetch,
          ocrImages: async (markdown, signal) => (await ocrArticleImages(markdown, articleImageOcrDeps(signal))).markdown,
        },
      })
    )

    // 「屏幕上写着什么」——抽帧 + 逐帧 OCR，只留转写拿不到的那部分（幻灯片要点、代码、图表数字）。
    // 转写落定且是视频时由 derive.ts 自动派生；也可以单独 POST 一条。
    conversionConverters.push(
      makeFramesConverter({
        // 只读上游那条 extract（时间轴 + media），不写 store。
        store: conversionStore,
        // 认字和 extract 的 ocr 分支同一条 `parse` 行、同一个成本阶梯（同一份判据，见上）。
        // **ffmpeg 也进这个判据**：抽帧的第一步就是它。它曾被当成「本进程的硬前提、不是一档
        // 可配置能力」而排除在外——那个前提在发行安装上是假的（活体：干净装机的 Windows 上
        // 根本没有 ffmpeg），于是这句自述会在一台永远抽不出帧的机器上一直说「可以」。
        available: () => parseLadderAvailable() && mediaToolAvailable('ffmpeg'),
        ocr: makeParseOcrDep(ctx.provider.providerExecutor),
        // 抽帧要的正是取音频那条腿扔掉的另一半：完整画面。两条腿在这里绑好，形状一致（直链 +
        // 那个 CDN 要的 headers）：网盘 AList 直链 / 带 `(provider, vid)` 的平台经 resolveVideo 的渐进式流。
        // **itemId 这层用不上**——视频源全部从上游转写记下的 media 推出来；收着这个参数是为了
        // 将来能按 item 兜底（如网盘绑定改走 item 而非 media）。
        resolveVideoSource: (_itemId, media) =>
          resolveVideoSource(media, {
            netdisk: ctx.netdisk.netdisk,
            // 与播放路由同一条派发：id 形状认不认得出，由答 `video.resolve` 的那个包说了算；
            // 要唤醒容器的成员自己在包里 withAwake，宿主这层不认识任何平台。
            resolveVideo,
          }),
        // 三条 ffmpeg 命令：真函数在这里接上（converter 收注入是为了让测试钉得住调用次数——
        // 「全扫必须在闸门之后」这条不变量只能靠 planVideoFrames 有没有被调过来钉）。
        sampleFrames,
        planVideoFrames,
        frameAt,
      })
    )

    // 两个条件块都登记完 converter 之后，runner 统一构造一次——队列/去重/取消/计时/账本只有这一份。
    const conversions = new ConversionRunner({
      store: conversionStore,
      converters: conversionConverters,
      ledger: capabilityJobs,
      // 失败重排的定时器走记账版（见 trackedSchedule）——runner 自己没有 stop 面，
      // 关停时留在飞的那些回调会打到已经关掉的库上。
      schedule: trackedSchedule,
      // 转成文字是一条会自己往上长的梯子：转写落定后自动去补说话人、是视频再自动去抽帧取画面
      // 文字。规则表见 conversions/derive.ts。
      derivations: CONVERSION_DERIVATIONS,
      costarts: CONVERSION_COSTARTS,
      onSettled: (rec) => {
        // 播报「转成文字」的成败。**inline 那一档不播**：它不打任何后端、瞬时完成，播报纯是噪音
        // ——通知的意义是「你等的那件慢活儿有结果了」。
        if (rec.kind !== 'extract') return
        if ((rec.result as { branch?: string } | undefined)?.branch === 'inline') return
        const done = rec.status === 'done'
        events.emit({
          type: done ? 'transcribe.done' : 'transcribe.error',
          severity: done ? 'info' : 'error',
          title: done ? `转成文字完成：${rec.snapshot?.title ?? rec.itemId}` : `转成文字失败：${rec.snapshot?.title ?? rec.itemId}`,
          body: rec.error?.message,
          ref: { kind: 'item', id: rec.itemId },
          dedupeKey: `extract:${rec.itemId}:${rec.status}`,
        })
      },
    })
    // 存量迁移：老 item（声纹解耦前）的说话人只活在转写抄件里，反推成时间线（幂等，见 meta 标记）。
    // 必须在 runner 之后——扫描口 allTranscripts 是它的方法。
    if (speakerRegistry) {
      try {
        migrateSegmentsToTimeline({ registry: speakerRegistry, allTranscripts: () => conversions.allTranscripts(), log })
      } catch (e) {
        // 迁移失败不拦启动：老 item 只是暂时读不到说话人，下次启动会重试（标记只在成功后落）。
        log(`[speaker-migrate] failed: ${String((e as Error)?.message ?? e)}`)
      }
    }
    // 归堆的判据在这里落地：内容身份 = 正文/转写的文本，而取文本走的就是上面这条 extract 链路
    // （它自己判分支、自己缓存、转过一次不重复计费）。**只给有候选的条目取文本**——
    // 转写实测平均 16s，全量转是不可接受的成本。
    const storyFoldWorker = new StoryFoldWorker({
      store: storyFoldStore,
      // 兜底巡检是一条自己给自己续命的定时器链，同样没有 stop 面（见 trackedSchedule）。
      schedule: trackedSchedule,
      texts: makeFoldTextSource({
        conversions: conversionStore,
        itemOf: (id) => itemStore.get(id) ?? undefined,
        requestExtract: (item) => {
          try {
            conversions.start('extract', item.id, {
              options: { media: item.content?.media, content: item.content, url: item.url },
              snapshot: { title: item.title, source: item.stream_id, url: item.url },
            })
          } catch {
            // 后端没配 / kind 不可用 —— 这条这次取不到文本，worker 自己会记一次尝试。
          }
        },
      }),
      fps: makeFoldFpSource({
        conversions: conversionStore,
        itemOf: (id) => itemStore.get(id) ?? undefined,
        available: () => fpEngine.current !== null,
        requestFp: (item) => {
          try {
            conversions.start('audio-fp', item.id, {
              options: {
                media: item.content?.media,
                // durationS：给指纹结果一个真时长（偏移窗换算用）；没有就由 converter 按项数估
                durationS: item.content?.media?.find(
                  (m): m is Extract<Media, { kind: 'video' | 'audio' }> =>
                    (m.kind === 'video' || m.kind === 'audio') && typeof m.duration_s === 'number',
                )?.duration_s,
              },
              snapshot: { title: item.title, source: item.stream_id, url: item.url },
            })
          } catch {
            // kind 不可用（引擎没探出来）—— worker 自己会记一次尝试
          }
        },
      }),
    })
    storyFoldWorker.startSweeping()

    // Agent 的上下文补全要读转写正文（chat 时把已转写内容喂进去）。
    const agentGetTranscript = (itemId: string): unknown => {
      const rec = conversions.transcriptOf(itemId)
      if (!rec || rec.status !== 'done') return { status: rec?.status ?? 'none' }
      return { status: 'done', ...(rec.result as object) }
    }

    ctx.provide('conversions', {
      conversions,
      speakerRegistry,
      voiceprintEngine,
      capabilityJobs,
      readUrl: articleFetch,
      storyFoldWorker,
      agentGetTranscript,
    } satisfies ConversionsDomain)
  },
}
