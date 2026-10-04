import type { VoiceprintEngineClient } from './engine-client.ts'
import type { SpeakerRegistryStore } from './store.ts'
import { alignTextToClusters, type DiarizedSegment } from './resolve.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'
import { planAudioWindows } from '../media/audio-windows.ts'
import { mergeWindowsDetailed, type WindowResult } from './windowed.ts'
import { shardSuspects } from './shards.ts'
import { cleanRepsOf, representativeOf } from './representative.ts'

/**
 * 自动认名的最短音频门槛（秒，按簇的累计发言时长算）。低于它的簇仍会被存下来
 * （手动 enroll 不受限），但**不参与**与声纹库的自动比对。
 *
 * 为什么要有它：容器会把一个人连续讲满一窗判成「主说话人 + 三五秒碎片」
 * （`windowed.ts` 的 `MIN_ANCHOR_S` 同一现象）。碎片的代表由极短音频算出、噪声极大，
 * 而自动认名会直接改写转写里那一段的归属——这条路径不受面板 30s 门槛保护，
 * 错了是错在文字上。取 3 与 `MIN_ANCHOR_S` 同值同因：连"有没有资格决定簇结构"
 * 都不够格的代表，更没资格决定"这是谁"。
 */
const MIN_IDENTIFY_S = 3

/**
 * 自动认名的相似度门槛（cosine，越大越像）。
 *
 * ⚠ **它绑定簇代表的口径**——口径一变，相似度的尺度就变，这个常数必须重新量。曾是 0.65，
 * 那是配「簇代表 = 第一段的原始 embedding」定的；口径换成时长加权均值后实测：喜剧之王 E02 上
 * **不同人**的簇代表之间相似度最高到 **0.787**（林简七的簇与领笑员的簇），0.65 会让认名直接跨人。
 *
 * 0.85 = 实测异人上界 0.787 之上留一点余量。
 *
 * **2026-07-27 口径又换了一次（簇代表优先吃容器门控后的干净代表），按规矩重量了两个锚点**
 * ——E02 同一份门控后 dump（`data/voiceprint-spike/tmdb_261391_S03E02-gated/`），
 * 只在同一口径内部比距离（跨口径比量到的是两种口径的差，不是"是不是同一个人"）：
 *
 * | | 旧口径（段级均值） | 新口径（干净代表） |
 * |---|---|---|
 * | 异人上界（人锚定：多多/林简七/庞博/黄渤 的主导簇两两） | 0.790 | **0.735** |
 * | 已认名者 × 自己库内声纹（多多 / 林简七） | 1.000 / 0.999 | **0.991 / 0.989** |
 *
 * 旧口径量出的 0.790 与当年记下的 0.787 对得上（量法可比），新口径把异人推得更开
 * （余量 0.060 → 0.115），同人几乎不动 → **0.85 不动，存量声纹也不失效**（同一嵌入模型、
 * 只是喂进去的音频更干净，`MODEL_VERSION` 因此也不动）。
 *
 * **两条已知限制，别把它当保证**：
 * 1. **下界没量过**。「同一个人在另一集里」的相似度需要跨集同人真值才能量，现有三份 dump
 *    给不出（唯一能凑的同人对是被容器切污染的碎片，中位只有 0.386，不能当同人真值）。
 *    所以这个门只保证「不太容易认错」，不保证「该认的都能认出来」——**症状是自动认名基本不触发**，
 *    那时要做的是去量下界，不是拧松这个数。上面 2026-07-27 那两个「同人」数字也**不是**下界：
 *    它们量的是同一集里同一个人的簇代表 vs 由它自己登记出去的那条声纹（换口径会不会把存量
 *    登记打废），跨集同人仍然没量过。
 * 2. **声学相近的人任何阈值都分不开**：同一演播厅的两位男领笑员，窗级代表相似度实测 0.913
 *    （spec 2026-07-25 §1.2 的 0.087 距离）。这是声纹模型的分辨极限，不是阈值问题。
 *
 * 可靠的路径始终是手动 enroll（不受本门槛限制）。
 */
const DEFAULT_IDENTIFY_THRESHOLD = 0.85

/** identify 内部用的一次 diarization 结果：引擎的 `DiarizeResult` 加上**按全局簇算好的库用
 *  代表**。为什么在这里加而不是塞进 `DiarizeResult`：`clusterReps` 的 key 是**全局**簇 label，
 *  只有跨窗合并之后才存在（单发路径下容器的 speaker label 恰好就是全局 label，是特例不是通例），
 *  而 `DiarizeResult` 是 HTTP 契约的直译，不该混进合并层的产物。 */
type Diarization = {
  modelVersion: string
  segments: DiarizedSegment[]
  /** 全局簇 → 门控后的干净代表；缺省的簇由调用方退回段级均值（见 `MergeResult.clusterReps`）。 */
  clusterReps: Map<string, number[]>
}

/** 一个已持久化的分窗结果：WindowResult + 当时的 modelVersion（全窗都从 resume 里来时，
 *  assembler 仍需要 modelVersion 才能把 cluster 存进 registry / 做 match）。 */
export type SavedWindow = WindowResult & { modelVersion?: string }

/** 分窗链的注入通道。deps 侧给默认（windowS 等静态配置），调用侧（service 的 runIdentify）
 *  按 job 递入 resume/onProgress/onDegrade——两层浅合并，调用侧优先。任一层出现即启用分窗；
 *  两层都缺 = 现单发路径一字不变。 */
export interface IdentifyWindowing {
  windowS?: number
  overlapS?: number
  /** 断点续跑：load() 返回已算完的窗（垃圾/越界条目会被忽略并重算），save() 在每窗算完后
   *  立刻持久化（service 侧落 data/jobs/<jobId>/window-<n>.json 并 jobs.appendChunk）。 */
  resume?: { load(): SavedWindow[]; save(w: SavedWindow): void }
  /** 每窗完成回调（resume 预置的窗计入分子）；service 侧转发 DebugBox channel `capability-job`。 */
  onProgress?: (done: number, total: number) => void
  /** identify 的契约是不 throw（内部 catch 后降级返回原 textSegs）——这让 service 从返回值上
   *  分不出「补上了」和「没补上」。onDegrade 是给 service 记账用的旁路：catch 降级时带原错
   *  误调用一次，service 据此把账本记 fail（与「音频取不到 fail」同账），而 transcript 本身
   *  仍按「没补上而非弄坏」原样保留。abort 也会经由这里（fetch 被打断即异常）——service 侧
   *  以 signal.aborted 优先判定，取消仍记 complete。 */
  onDegrade?: (e: unknown) => void
}

/**
 * 识别一次 = **纯音频**：分人、认名、落库，产出一条带名字的说话人时间线。
 *
 * **它不认识文字。** 「把标签投影到转写段上」是另一件事，由调用方在拿到时间线之后自己做
 * （`alignTextToClusters`，`src/voiceprint/resolve.ts`）。分开是承重的：这一步是全链路最慢的
 * 那一段（分钟级），把文字塞进来就等于让它必须排在取白文后面；分开之后两者才能同时开工，
 * 投影推迟到时间线出来之后再做——那时候取白文早跑完了。
 *
 * 降级/未配置时返回空时间线，**失败与否只从 `onDegrade` 旁路认**（这个契约不 throw）。
 */
export type IdentifyFn = (
  itemId: string,
  bytes: Uint8Array,
  mime: string,
  signal?: AbortSignal,
  windowing?: IdentifyWindowing
) => Promise<DiarizedSegment[]>

/** Compose engine + registry + alignment into the identity step injected into TranscribeService.
 *  Degrades to the original (anonymous) text segments whenever the engine is unconfigured or
 *  anything throws — transcription itself must never fail because identity resolution did. */
export function makeIdentifyFn(deps: {
  engine: VoiceprintEngineClient
  registry: SpeakerRegistryStore
  threshold?: number
  hint?: 'accuracy' | 'fast'
  onError?: (e: unknown) => void
  /** 早退门问的问题:"engine 配置了吗"在 host 档下问错了对象 —— 睡着的容器 configured()
   *  恒假,永远早退、永远不会触发 withAwake 唤醒。默认沿用旧语义(`configured()`);
   *  调用方(bootstrap)可传入"配置了或可唤醒"的判断,让早退门和唤醒门问同一个问题。 */
  ready?: () => boolean
  /** 分窗链默认配置；per-call 第 6 参可补/可覆盖（见 IdentifyWindowing 头注）。 */
  windowing?: IdentifyWindowing
  /** debug bus（bootstrap 的 onDebug）。摘掉非人声碎片时往这里记一条——那一步删的是
   *  时间线，删了什么必须查得到，而 dev 档下后端 stdout 进不了 docker logs。 */
  onDebug?: (entry: import('../debug.ts').DebugEntry) => void
}): IdentifyFn {
  const threshold = deps.threshold ?? DEFAULT_IDENTIFY_THRESHOLD
  const ready = deps.ready ?? (() => deps.engine.configured())

  /** 单发（未分窗）路径：容器的 `speakers[]` 标签就**是**全局簇标签（它看的是整份音频），
   *  所以干净代表可以直接当库用簇代表用，不需要任何聚合。 */
  async function diarizeSingle(
    bytes: Uint8Array,
    mime: string,
    signal?: AbortSignal
  ): Promise<Diarization> {
    const r = await deps.engine.diarize(bytes, mime, { hint: deps.hint, signal })
    return { modelVersion: r.modelVersion, segments: r.segments, clusterReps: cleanRepsOf(r.speakers) }
  }

  /** planner → 逐窗短调用 → assembler。总时长 ≤ windowS（planner 只切出 1 窗）→ 退回单发
   *  路径：原 bytes/mime 直送 engine，与不启用分窗时一字不变（切出来的那一窗是抽轨后的
   *  wav，不是原容器，喂它反而改变现行为）。 */
  async function diarizeWindowed(
    itemId: string,
    bytes: Uint8Array,
    mime: string,
    w: IdentifyWindowing,
    signal?: AbortSignal
  ): Promise<Diarization> {
    const { windows } = await planAudioWindows(bytes, mime, { windowS: w.windowS, overlapS: w.overlapS, signal })
    if (windows.length <= 1) return diarizeSingle(bytes, mime, signal)
    // 断点续跑：已持久化的窗直接采信，只算缺的。垃圾/越界条目（损坏文件、旧参数残留）忽略。
    // 几何守卫：resume 里的 startS/durS 必须和这次 planAudioWindows 重算出的同 index 窗一致
    // 才采信——窗参数（windowS/overlapS）变了会导致同 index 对应不同时间范围，错位采信会把
    // 一段不相干的旧窗结果拼进当前 timeline。不一致就当没存过，走下面的补算。
    const done = new Map<number, SavedWindow>()
    for (const saved of w.resume?.load() ?? []) {
      if (!saved || typeof saved.index !== 'number' || !Array.isArray(saved.segments)) continue
      if (saved.index < 0 || saved.index >= windows.length) continue
      const target = windows[saved.index]
      if (saved.startS !== target.startS || saved.durS !== target.durS) continue
      done.set(saved.index, saved)
    }

    // modelVersion 守卫：error 行几天后带着旧模型的预置窗和这次的新模型混算会把跨版本向量
    // 揉进同一次 merge。全部窗都来自 resume 时没有"新鲜"调用可当权威，只在预置窗彼此一致时
    // 采信，否则保守地全部重算（下面补算循环会把 done 清空后逐窗跑满）。
    let modelVersion: string | undefined
    if (done.size === windows.length) {
      const versions = new Set([...done.values()].map((s) => s.modelVersion))
      if (versions.size === 1 && !versions.has(undefined)) modelVersion = [...versions][0]
      else done.clear()
    }

    // 首个新鲜 diarize 调用一旦落地，它的 modelVersion 就是这次跑的权威版本——丢弃与它不一致
    // 的预置窗（留给下面第二轮补算循环重算），而不是任其混进 merge。
    const adoptFreshVersion = (v: string): void => {
      if (modelVersion !== undefined) return
      modelVersion = v
      for (const [idx, saved] of [...done]) {
        if (saved.modelVersion !== undefined && saved.modelVersion !== modelVersion) done.delete(idx)
      }
    }
    // 逐窗短调用：每窗一次 /diarize（withAwake 已在 engine-client 内），窗 bytes 是 16k 单声道 wav
    const computeWindow = async (win: (typeof windows)[number]): Promise<void> => {
      const r = await deps.engine.diarize(win.bytes, 'audio/wav', { hint: deps.hint, signal })
      adoptFreshVersion(r.modelVersion)
      const saved: SavedWindow = {
        index: win.index,
        startS: win.startS,
        durS: win.durS,
        segments: r.segments,
        // 容器给的每人一份干净代表（拼接音频重算）——跨窗合并优先用它，比拿一堆短段求平均稳得多。
        // 一并落进 resume 文件：断点续跑捡回来的窗才不会退化成段级均值。老窗没有这个字段，
        // mergeWindows 会自动退回段级均值。
        ...(r.speakers?.length ? { speakers: r.speakers } : {}),
        modelVersion: r.modelVersion,
      }
      done.set(win.index, saved)
      w.resume?.save(saved)
      w.onProgress?.(done.size, windows.length)
    }
    for (const win of windows) if (!done.has(win.index)) await computeWindow(win)
    // 二轮补算：第一轮里 adoptFreshVersion 可能逐出了排在"权威版本确立点"之前、已被跳过的
    // 预置窗（for...of 只前进不回头）——这一轮把它们连同任何仍缺的窗补齐。常态下（无版本
    // 冲突）done 已满，这里不会触发任何新的 engine 调用。
    for (const win of windows) if (!done.has(win.index)) await computeWindow(win)
    // assembler：跨窗说话人合并（窗内相对时间 → 全局时间、局部 label → 全局 label），
    // 顺带把各窗的干净代表按全局簇聚成库用代表（见 mergeWindowsDetailed）。
    const { segments, clusterReps } = mergeWindowsDetailed([...done.values()], { itemId })
    return { modelVersion: modelVersion ?? 'unknown', segments, clusterReps }
  }

  /** 摘掉「掌声变成的说话人」：结构判据（本地）+ 帧证据（容器）两个信号都命中才动。
   *
   *  为什么在这里、而不是在容器逐窗做：结构判据里最要紧的一条是「这个簇在整条录音的别处
   *  从不露面」，而容器一次只看 120s。实测同一份 E02，判据放窗内只摘到 41s、放这里能看见
   *  19 个碎片簇。⚠ 同类改动 2026-07-27 被证伪撤回过（详见 shards.ts 头注），所以只减不加、
   *  且摘掉什么都打日志——静默改数字是那次最坑的地方。任何一步出错就整个跳过，宁可不摘。 */
  async function dropNonspeechShards(
    itemId: string,
    segments: DiarizedSegment[],
    bytes: Uint8Array,
    mime: string,
    signal?: AbortSignal
  ): Promise<DiarizedSegment[]> {
    const suspects = shardSuspects(segments)
    if (!suspects.size) return segments
    const idx = segments.map((s, i) => [s, i] as const).filter(([s]) => suspects.has(s.speaker))
    const intervals = idx.map(([s]) => [s.start, s.end] as [number, number])
    let verdict: Awaited<ReturnType<typeof deps.engine.speechFrac>>
    try {
      verdict = await deps.engine.speechFrac(bytes, mime, intervals, signal)
    } catch (e) {
      console.warn(`[voiceprint/shard] 帧证据取不到，本次不摘任何段: ${(e as Error).message}`)
      return segments
    }
    if (verdict.length !== intervals.length) {
      console.warn(`[voiceprint/shard] 帧证据条数对不上（${verdict.length}≠${intervals.length}），本次不摘`)
      return segments
    }
    const drop = new Set<number>()
    for (let k = 0; k < verdict.length; k++) if (verdict[k].nonspeech) drop.add(idx[k][1])
    if (!drop.size) return segments
    const byCluster = new Map<string, number>()
    let secs = 0
    for (const i of drop) {
      const s = segments[i]
      secs += s.end - s.start
      byCluster.set(s.speaker, (byCluster.get(s.speaker) ?? 0) + (s.end - s.start))
    }
    const ranked = [...byCluster.entries()].sort((a, b) => b[1] - a[1])
    const detail = ranked.map(([c, d]) => `${c}(宿主${suspects.get(c)})${d.toFixed(0)}s`).join(' ')
    const line =
      `[voiceprint/shard] 摘掉非人声碎片 ${drop.size}/${intervals.length} 段 · ${secs.toFixed(0)}s` +
      ` · 嫌疑簇 ${suspects.size} 个 · ${detail}`
    console.log(line)
    // 同时进 debug bus：**这条改动删的是时间线，删了什么必须查得到**，而 dev 档下后端 stdout
    // 进不了 docker logs（实测：容器启动后 7 小时一行没有，连 tsx watch 的重启行都没有），
    // console.log 等于写进黑洞。debug bus 是这个项目里真正查得到的通道
    // （`GET /api/debug/log?channel=voiceprint`），不依赖 stdout。
    deps.onDebug?.({
      id: `voiceprint-shard:${itemId}@${Date.now()}`,
      at: Date.now(),
      channel: 'voiceprint',
      key: itemId,
      title: `${itemId} 摘掉非人声碎片`,
      summary: `${drop.size}/${intervals.length} 段 · ${secs.toFixed(0)}s · 嫌疑簇 ${suspects.size} 个`,
      ok: true,
      fields: [
        { label: '嫌疑簇', value: [...suspects].map(([c, h]) => `${c}→宿主${h}`).join(', ') || '(无)' },
        { label: '摘掉', value: detail || '(无)' },
        {
          label: '留下的嫌疑段',
          value:
            verdict
              .filter((v) => !v.nonspeech)
              .map((v) => `${v.start.toFixed(1)}-${v.end.toFixed(1)}s(帧${v.frac === null ? 'n/a' : `${Math.round(v.frac * 100)}%`})`)
              .join(' ') || '(无)',
        },
      ],
    })
    return segments.filter((_, i) => !drop.has(i))
  }

  return async (itemId, bytes, mime, signal, callWindowing) => {
    if (!ready()) return []
    const windowing: IdentifyWindowing | undefined =
      deps.windowing || callWindowing ? { ...deps.windowing, ...callWindowing } : undefined
    try {
      const diarized = windowing
        ? await diarizeWindowed(itemId, bytes, mime, windowing, signal)
        : await diarizeSingle(bytes, mime, signal)
      const { modelVersion, clusterReps } = diarized
      // 掌声/笑声被判成说话人的，在这里摘掉——必须在下面建 item_clusters 之前，
      // 否则它们各自入库一份噪声代表、还可能被自动认名成某个人。
      const segments = await dropNonspeechShards(itemId, diarized.segments, bytes, mime, signal)
      // 簇代表：**优先**用容器帧级门控后的干净代表（`clusterReps`），缺省才退回该簇全部段的
      // 时长加权单位均值（口径与跨窗合并同源，见 representative.ts）。
      // - 为什么优先干净代表：段级 embedding 是门控**之前**算的，掌声笑声照样烧在里面。
      //   门控只接进跨窗合并的话，声纹库存的 / 自动认名比的 / 手动 enroll 登记的仍是脏向量
      //   ——前门装了闸、后门还敞着（frame-gate spec §8 记的那条尾巴）。
      // - 为什么还要退回段级均值（而不是干脆不入库）：缺省与弃权都会落到这里，而**手动 enroll
      //   的兜底权利不能没收**——用户耳朵认过的簇，不该因为容器判它弃权就再也登记不进库。
      //   自动认名那一侧不靠这条兜底把关：MIN_IDENTIFY_S 与 0.85 门槛照常拦着它。
      // 曾用「第一段的原始 embedding」：真实数据上翻过车——过合并簇的第一段是别人的七秒
      // 插话，登记进声纹库的就是那个人的声音（spec 2026-07-25 §8.1）。
      const segsByCluster = new Map<string, DiarizedSegment[]>()
      for (const s of segments) {
        const list = segsByCluster.get(s.speaker)
        if (list) list.push(s)
        else segsByCluster.set(s.speaker, [s])
      }
      // store each cluster for later enroll + build the cluster→identity rename map
      const rename = new Map<string, string>()
      for (const [cluster, segs] of segsByCluster) {
        const rep = representativeOf(segs)
        const emb = clusterReps.get(cluster) ?? rep.emb
        if (!emb) continue // 该簇全是零向量/零时长段，取不出代表
        // 碎片仍要存：手动 enroll 拿的就是这份代表
        deps.registry.putItemCluster(itemId, cluster, emb, modelVersion)
        // 但不许拿几秒音频去自动断定"这是谁"——见 MIN_IDENTIFY_S。门槛量的始终是**实际发言
        // 秒数**（`rep.durationS`），与代表本身是干净的还是段级均值无关：干净代表由容器封顶
        // 20s 的拼接音频算出，拿它的秒数当门槛会误伤长发言。
        if (rep.durationS < MIN_IDENTIFY_S) continue
        const best = deps.registry.match(emb, modelVersion)[0]
        if (best && best.score >= threshold) rename.set(cluster, best.name)
      }
      // apply rename to the diarization spans, then align text to the (renamed) clusters
      const named: DiarizedSegment[] = segments.map((s) => ({ ...s, speaker: rename.get(s.speaker) ?? s.speaker }))
      // diarization 时间线是一等数据：落库，然后交出去。**投影到文字段上不在这里**——
      // 那一步要文字，放进来就把「有没有说话人」重新绑回了「有没有转写」，也就再也不能
      // 和取白文同时开工（见 IdentifyFn 的头注）。
      deps.registry.putItemTimeline(
        itemId,
        named.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
      )
      return named
    } catch (e) {
      deps.onError?.(e)
      windowing?.onDegrade?.(e)
      // 降级的**原始错误**也要进 debug bus。原来它只走 onError→console.log（dev 档下进不了
      // docker logs）和 onDegrade→转换记录里那句通用文案「声纹归名降级（未补上说话人）」，
      // 于是"为什么降级"根本查不到——实测因此卡过一次诊断，只能靠反推。
      const at = Date.now()
      deps.onDebug?.({
        id: `voiceprint-degrade:${itemId}@${at}`,
        at,
        channel: 'voiceprint',
        key: itemId,
        title: `${itemId} 归名降级`,
        summary: String((e as Error)?.message ?? e).slice(0, 200),
        ok: false,
        fields: [
          { label: '错误', value: String((e as Error)?.message ?? e), tone: 'bad' },
          { label: '堆栈', value: String((e as Error)?.stack ?? '(无)').slice(0, 1200) },
        ],
      })
      return []
    }
  }
}
