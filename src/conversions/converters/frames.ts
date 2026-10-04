// src/conversions/converters/frames.ts
//
// 「屏幕上写着什么」——对一个 item 的视频抽帧、逐帧 OCR，只留转写拿不到的那部分文字
// （幻灯片要点、代码、图表数字）。设计见
// docs/superpowers/specs/2026-08-14-extract-progressive-ladder-design.md §5、§6。
//
// **这一层的全部形状是一道逐级止损的梯子，而每一级「判为不抽」都是成功。**
// 闸门判纯口播、没有视频源、画面不动、探过没料——四种结局都落 `ok: true` + 一份说得出
// 理由的读数（`probe.stop`）。判成 `ok: false` 会让通知中心报错、让用户以为坏了，
// 而它恰恰是在正常工作。真正的失败是三种 I/O 自己炸了：取视频地址（`source_failed`）、
// 稀疏取样（`sample_failed`）、全扫（`plan_failed`）——都是「后端答不上来」，跟上面那些
// 「判得出来的空」不是一回事。
//
// **「没跑」和「跑了没料」在账上必须分得开**：`track: []` 不是证据（四级止损都产出空
// 数组），要看 `probe.stop` 和 `probe.ocrTried`。
//
// **全扫（planVideoFrames）必须在三道闸之后。** 它是唯一读完整个文件的一步（两小时的
// 片子几个 GB），而且这一层要**重新取一遍视频源**——转写那份字节只有音轨，复用不了
// （spec §5.4）。顺序写反了不会有任何报错，只会每条视频都白烧几个 GB 流量，所以这条
// 不变量由 frames.test.ts 里的「calls.plan === 0」断言钉着，不靠人记性。
import type { Media } from '../../content/types.ts'
import type { ConversionStore } from '../store.ts'
import type { Converter, ConversionContext, ConversionOutcome } from '../runner.ts'
import type { ConversionKind } from '../store.ts'
import type { VideoSource } from '../../media/video-source.ts'
import type { KeyframeCandidate } from '../../media/video-frames.ts'
import { DEFAULT_MIN_DISTANCE, DEFAULT_SAMPLE_COUNT } from '../../media/video-frames.ts'
import { dedupeFrames, hammingDistance } from '../../media/frame-hash.ts'
import { framesGate, type GateVerdict } from '../frames/gate.ts'
import { newTextAt, type Segment } from '../frames/new-text.ts'
import { dedupeTrack } from '../frames/dedupe-track.ts'

/** 这个 kind 的名字（枚举在 `ConversionKind`，`src/conversions/store.ts`）。 */
const FRAMES_KIND: ConversionKind = 'frames'

/** 探 OCR 送几张。spec §5.2 第 3 步写的「2–3 帧」——**没量过，是拍的**。
 *  量法：拿库里真实视频跑一遍，看「探 1 张就够判」和「探 3 张才判得出」各占多少。 */
export const DEFAULT_PROBE_OCR_COUNT = 3

/**
 * 正式抽帧的帧数上限。**没量过，是拍的。**
 *
 * 为什么必须有：一个两小时的讲座可能有几百个变化点，逐帧 OCR 是这层唯一真正花钱的地方，
 * 不设上限就会失控。超限时保留哈希差异最大的那些，并把截掉了多少记进 `probe.truncated`
 * ——**静默截断在这里是最坏的形状**：产出看着正常，只是后半程的幻灯片永远不进正文，
 * 没有任何一处会喊。
 *
 * 量法：跑一批真实视频，看 `probe.planned` 的分布（去重之后到底有多少变化点），
 * 以及 `truncated > 0` 的那些里被丢掉的帧是不是真的还有新字。
 */
export const DEFAULT_MAX_FRAMES = 40

/**
 * 「画面动没动」的门槛：稀疏取样的 8 帧里，两两汉明距离的**最大值**低于它就判画面不动
 * （固定机位访谈、播客视频版）。
 *
 * 复用 `DEFAULT_MIN_DISTANCE`（10，已在真编码视频上实测钉死：噪声底 0–2、换页那一跳 28）。
 * **但那组数字量的是「相邻关键帧」，这里比的是「隔了几分钟的两帧」**——后者只会差得更多，
 * 所以用同一个数在这条判据上是偏保守的（宁可判成「动了」多付一次探 OCR，不轻易判出局）。
 * 这个方向正是要的：判成「不动」就直接出局，那页文字永远不会被抽到。
 */
export const DEFAULT_STILL_DISTANCE = DEFAULT_MIN_DISTANCE

/** 未识别的帧**必须在轨里看得见**——静静跳过正好是「缺省信息」，而这层的目的就是不缺省。
 *  同 `src/content/images/ocr-images.ts` 的先例。 */
const unrecognizedNote = (reason: string) => `[未识别：${reason}]`

export interface FramesConverterDeps {
  /** 只读上游那条 extract——这层不写 store。 */
  store: Pick<ConversionStore, 'get' | 'latestFor'>
  resolveVideoSource: (itemId: string, media: Media[] | undefined) => Promise<VideoSource | null>
  /** 逐张图 OCR。合同同 `OcrImagesDeps['ocr']`：没识别出东西返回 `null`，真失败抛。 */
  ocr: (bytes: Uint8Array, mime: string) => Promise<string | null>
  available: () => boolean
  // —— 三条 ffmpeg 命令一律注入，不直接 import 调用 ——
  // 不是为了「可配置」，是为了测试**管得住调用次数**：这层最贵的不变量（全扫必须在闸门
  // 之后）只能靠「planVideoFrames 有没有被调用」来钉，直接 import 就钉不住。
  sampleFrames: (
    src: string,
    opts: { count?: number; signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<KeyframeCandidate[]>
  planVideoFrames: (
    src: string,
    opts: { minDistance?: number; signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<KeyframeCandidate[]>
  frameAt: (
    src: string,
    atSeconds: number,
    signal?: AbortSignal,
    opts?: { headers?: Record<string, string> },
  ) => Promise<Uint8Array>
}

export interface FramesOptions {
  sampleCount?: number
  stillDistance?: number
  probeOcrCount?: number
  maxFrames?: number
}

/** 走到哪一级停的，以及每一级的读数。**这份账是后面定阈值的依据**（spec §8）——
 *  没量过的阈值只是一个装作有判据的猜测，所以每一级（包括判停的那一级）都要留数。 */
export interface FramesProbe {
  stop: 'gate' | 'no_source' | 'still_picture' | 'no_new_text' | 'done'
  gate: GateVerdict
  /** 稀疏探帧取了几张。 */
  sampled?: number
  /** 稀疏帧两两哈希距离的最大值——「画面动没动」的读数本身。 */
  maxDistance?: number
  /** 一共送出去几次 OCR（探 + 正式合计）。**`track` 空时它才是「探过没料」的证据**。 */
  ocrTried?: number
  /** 其中抛错的几次（换成了 `[未识别：…]` 标记，别的帧照跑）。 */
  ocrFailed?: number
  /** 其中「跑成功但图上没字」的几次——和上一项是两个方向的排查线索，别合并。 */
  ocrEmpty?: number
  /** 送去正式 OCR 的候选帧数（I 帧 ∪ 稀疏样本，去重之后）——见 `mergeCandidates`。 */
  planned?: number
  /** 其中 I 帧那一腿单独贡献了几张（`planVideoFrames` 去重后的数）。**和 `planned` 分开记**：
   *  两个数一比就看得出「这条视频的 I 帧够不够密」——I 帧极少而 planned 明显更大，正是
   *  「只认 I 帧会漏字」那一类的读数，将来调策略要靠这批数，不能只留合并后的总数。 */
  plannedKeyframes?: number
  /** 超上限被截掉几张。`> 0` 必须看得见，不许静默截断。 */
  truncated?: number
  /** 最终抽到新字的帧数（不含未识别标记）。**这是文本级去重之后的数**，
   *  跟 `planned` 之间的落差由下面三个计数解释。 */
  framesKept?: number
  /** 文本级去重丢掉的行数：前面某一帧已经出现过（`dedupe-track.ts` 规则 3）。 */
  repeatedLines?: number
  /** 判为水印/角标、整条剔除的不同文字行数（规则 2）。**这条最该盯**——
   *  它是唯一会丢掉真内容的一条，读数异常大就是阈值定错了。 */
  watermarkLines?: number
  /** 归一化后没有内容而丢掉的行数：纯标点、markdown 围栏（规则 1）。 */
  emptyLines?: number
  /** 判为烧录字幕、整帧丢掉的帧数（规则 4）。它通常是 `planned` 与 `framesKept` 之间
   *  最大的那一项落差——实测抖音那类满屏字幕的短视频，40 帧里近半是它。 */
  thinFrames?: number
}

export interface FramesResult {
  /** 帧文字轨。判为不抽 / 探过没料时是空数组——**不是缺席**，读它之前先看 `probe.stop`。
   *  它**不混进正文**：转写是「谁说了什么」，帧文字是「屏幕上写着什么」（spec §6）。 */
  track: Array<{ at: number; text: string }>
  probe: FramesProbe
}

/** 上游那条 extract 的产物。时间轴与媒体是**转写分支特有**的，在 detail 下。 */
interface ExtractResult {
  text?: string
  detail?: { segments?: Segment[]; media?: Media[] }
}

/**
 * 闸门要的时长（秒）。优先取 media 上报的时长；没有就退到「转写最后一段的结束时刻」。
 *
 * 退档是个**下界**（片尾静音、片尾曲拿不到），会把语速密度算得偏高、从而更容易判成
 * 纯口播——偏保守的方向。完整转写下这个误差在 1% 量级，可以接受；但如果将来发现大量
 * 视频因为转写被截断而误判成 dense_speech，答案是去把真实时长接进来，不是调闸门阈值。
 * 两个都拿不到就交 0——`framesGate` 会据此判 `unknown_duration` 并放行（没量到不等于不该抽）。
 */
export function durationOf(media: Media[] | undefined, segments: readonly Segment[]): number {
  const v = (media ?? []).find((m) => m.kind === 'video')
  if (v && 'duration_s' in v && typeof v.duration_s === 'number' && v.duration_s > 0) return v.duration_s
  let end = 0
  for (const s of segments) if (s.end > end) end = s.end
  return end
}

/** 一串帧里两两汉明距离的最大值。不足两帧 → 0（「只有一帧」在这条判据上等同于「画面不动」）。 */
export function maxPairwiseDistance(frames: readonly KeyframeCandidate[]): number {
  let max = 0
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const d = hammingDistance(frames[i]!.hash, frames[j]!.hash)
      if (d > max) max = d
    }
  }
  return max
}

/** 挑「最不像其它帧」的那几张去探 OCR：按「到其它帧的最大距离」降序，同分按时间先后。 */
export function mostDistinct(frames: readonly KeyframeCandidate[], n: number): KeyframeCandidate[] {
  return frames
    .map((f) => ({
      f,
      score: Math.max(0, ...frames.filter((o) => o !== f).map((o) => hammingDistance(f.hash, o.hash))),
    }))
    .sort((a, b) => b.score - a.score || a.f.at - b.f.at)
    .slice(0, n)
    .map((x) => x.f)
}

/**
 * 超上限时保留哈希差异最大的那些，**并按时间序交回**——下游要拿 `at` 跟转写对齐，
 * 排完序不还原就等于把时间轴打乱。
 *
 * 「差异」按「与序列里前一张的距离」算：`planVideoFrames` 已经去过重，相邻两张之间的
 * 距离正是「这一次画面变了多少」。第一张没有前一张，恒定保留（它是整段的基线）。
 */
export function capFrames(
  frames: readonly KeyframeCandidate[],
  max: number,
): { kept: KeyframeCandidate[]; truncated: number } {
  if (frames.length <= max) return { kept: [...frames], truncated: 0 }
  const scored = frames.map((f, i) => ({
    f,
    i,
    score: i === 0 ? Number.POSITIVE_INFINITY : hammingDistance(frames[i - 1]!.hash, f.hash),
  }))
  const kept = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.f)
  return { kept, truncated: frames.length - max }
}

/**
 * 正式抽帧的候选集 = **I 帧 ∪ 稀疏样本**，按时刻排序后走同一套哈希去重。
 *
 * ## 为什么不能只要 I 帧
 *
 * `planVideoFrames` 问的是 `ffprobe -skip_frame nokey`——**I 帧集合**。它和「画面什么时候
 * 变了」是两件事：I 帧由编码器按 GOP 排布，跟内容换屏根本不同步。短视频尤其致命。
 *
 * 硬证据（2026-08-30，item `54302ede4b47213a`，7.33s / 220 帧的抖音新闻）：**全片只有 2 个
 * I 帧**（0.000 与 6.967）。第 3.5–4.5 秒整整一屏新闻通稿正文（这条视频信息量最大的一屏）
 * 从头到尾没有进过候选，`probe.planned` 如实记着 2。而稀疏取样那 8 张里的 4.13s 恰好就是
 * 它——已经取到了、可能已经探 OCR 过了，然后被丢掉。
 *
 * ## 为什么补的是稀疏样本，而不是调密取样
 *
 * 这两条腿的疏密方向刚好互补，不需要再加一个要调的数：
 *   - I 帧：长视频多（GOP 固定，半小时有几百个），**短视频少到只有两三个**。
 *   - 稀疏样本：固定张数（`DEFAULT_SAMPLE_COUNT`），所以**短视频里密**（7s / 8 张 ≈ 0.9s
 *     一张），长视频里疏——而长视频恰恰不缺 I 帧。
 * 合起来正好把对方的空档填上。取样那 8 张的字节和哈希**在第 4 步已经付过钱了**，并进来
 * 不多花一分。
 *
 * 增量成本被去重挡着：画面真不动的视频，这 8 张会被 `dedupeFrames` 全并掉（增量 0）；
 * 真在换屏的才多抽几张——那本来就是该抽的。上限仍由 `capFrames` 的 `maxFrames` 兜着。
 *
 * @param planned - `planVideoFrames` 的产物（I 帧，已按 `DEFAULT_MIN_DISTANCE` 去过重）。
 * @param sampled - 第 4 步的稀疏样本（均匀取样，已带哈希）。
 * @returns 按时刻升序、去过重的候选集。
 */
export function mergeCandidates(
  planned: readonly KeyframeCandidate[],
  sampled: readonly KeyframeCandidate[],
): KeyframeCandidate[] {
  // 顺序去重（`dedupeFrames` 拿每一张跟**上一张留下的**比），所以必须先按时刻排好——
  // 乱序进去会把「相邻两屏差多少」算成「隔了半分钟的两屏差多少」，去重结果完全没有意义。
  const all = [...planned, ...sampled].sort((a, b) => a.at - b.at)
  return dedupeFrames(all, DEFAULT_MIN_DISTANCE)
}

interface OcrTally {
  tried: number
  failed: number
  empty: number
  /** 有新字的帧（含未识别标记那几条——它们也要进轨，见 `unrecognizedNote`）。 */
  entries: Array<{ at: number; text: string; kept: boolean }>
}

/** 这一轮里某个时刻的 OCR 原文（`null` = 跑成功但图上没字）。**探帧和正式那一轮共用一份**，
 *  见 `ocrFrames` 的 `seen` 参数。 */
type OcrMemo = Map<number, string | null>

/**
 * 逐帧：取整帧 JPEG → OCR → 跟同一时刻的转写比、只留新字。
 *
 * **任何单帧的失败都在这里被吃掉换成一条标记**——一帧塌了不能让整条转换塌（那样这条
 * item 连已经抽到的几十帧一起没了），也不能静静跳过（那样「这帧没字」和「这帧没跑成」
 * 就分不出来了）。同 `ocr-images.ts` 的 `one()`。
 *
 * @param seen - 同一次运行里已经 OCR 过的时刻。**候选集含稀疏样本之后这是必需的**
 *   （`mergeCandidates`）：探帧挑走的那 2–3 张，正式那一轮多半会再遇到同一个 `at`，
 *   不记着就等于对同一张图付两次 OCR——而 OCR 是这层唯一真正花钱的地方（活体上探那 3 张
 *   就烧了 22.5s）。命中不计进 `tried`：那个数是「送出去几次」，不是「处理了几帧」。
 */
async function ocrFrames(
  frames: readonly KeyframeCandidate[],
  src: VideoSource,
  segments: readonly Segment[],
  deps: FramesConverterDeps,
  signal: AbortSignal,
  seen: OcrMemo = new Map(),
): Promise<OcrTally> {
  const tally: OcrTally = { tried: 0, failed: 0, empty: 0, entries: [] }
  for (const f of frames) {
    if (signal.aborted) break
    try {
      const cached = seen.has(f.at)
      let text: string | null
      if (cached) {
        text = seen.get(f.at)!
      } else {
        tally.tried += 1
        const bytes = await deps.frameAt(src.url, f.at, signal, { headers: src.headers })
        text = await deps.ocr(bytes, 'image/jpeg')
        seen.set(f.at, text)
      }
      const trimmed = text?.trim()
      if (!trimmed) {
        // 同一张图只在账上出现一次：命中缓存那次已经计过了。
        if (!cached) tally.empty += 1
        continue
      }
      const { newText } = newTextAt(trimmed, f.at, segments)
      if (newText) tally.entries.push({ at: f.at, text: newText, kept: true })
    } catch (e) {
      // e 不保证是 Error（裸字符串/普通对象都能被 throw）——`.message` 那时是 undefined，
      // 产出的 `[未识别：undefined]` 对排查零信息量。
      tally.failed += 1
      tally.entries.push({ at: f.at, text: unrecognizedNote(e instanceof Error ? e.message : String(e)), kept: false })
    }
  }
  return tally
}

export function makeFramesConverter(deps: FramesConverterDeps, opts: FramesOptions = {}): Converter {
  const sampleCount = opts.sampleCount ?? DEFAULT_SAMPLE_COUNT
  const stillDistance = opts.stillDistance ?? DEFAULT_STILL_DISTANCE
  const probeOcrCount = opts.probeOcrCount ?? DEFAULT_PROBE_OCR_COUNT
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES

  const stop = (probe: FramesProbe): ConversionOutcome => ({ ok: true, result: { track: [], probe } satisfies FramesResult })

  return {
    kind: FRAMES_KIND,
    label: '抽帧取画面文字',
    stages: ['source', 'sample', 'probe-ocr', 'plan', 'ocr'],
    available: deps.available,
    async run(ctx: ConversionContext): Promise<ConversionOutcome> {
      // —— 1. 上游转写（**不是前提**）——
      // 没有 / 没跑完 → text 空、segments 空。那不代表不该抽，恰恰相反：闸门会因此判
      // no_transcript 放行（信息可能全在画面上）。
      const upstream = ctx.inputId ? deps.store.get(ctx.inputId) : deps.store.latestFor(ctx.itemId, 'extract')
      const r = upstream?.status === 'done' ? (upstream.result as ExtractResult | undefined) : undefined
      const segments = r?.detail?.segments ?? []
      // 优先用上游转写记下的 media（那份字节是转写当时真正用过的源，与时间轴同源）；
      // 没有上游（闸门刚判完「没转写最该抽」——见文件头注）就退到 HTTP 路由早就递进来的
      // ctx.options.media（`src/http/conversions-routes.ts` 的 `body.media ?? resolved.media`）。
      // 少了这条兜底，闸门放行的下一步会立刻因为「没有 media」拿不到地址、停在
      // `no_source`——两步互相打脸，活体已经撞过（B 站视频 1ms 停在 no_source）。
      const media = r?.detail?.media ?? (ctx.options.media as Media[] | undefined)

      // —— 2. 闸门（零成本，唯一不用付字节钱就能出局的一档，spec §5.4）——
      const gate = framesGate({ text: r?.text ?? '', durationS: durationOf(media, segments) })
      if (!gate.go) return stop({ stop: 'gate', gate })

      // —— 3. 取视频地址 ——
      let source: VideoSource | null
      try {
        source = await ctx.stage('source', () => deps.resolveVideoSource(ctx.itemId, media))
      } catch (e) {
        if (ctx.signal.aborted) return cancelled()
        // 取地址这一步会打网盘 / 抖音容器 / B 站签名这类真 I/O，抛出的是「后端答不上来」，
        // 跟下面的 `!source`（「这条 item 就是没有可抽帧的东西」，判得出来的空）是两回事，
        // 不能都落成同一种「没有源」——那会把一次真的取址失败悄悄记成了成功的止损。
        return { ok: false, error: { code: 'source_failed', message: msg(e) } }
      }
      if (ctx.signal.aborted) return cancelled()
      // 「这条 item 没有可抽帧的东西」和「后端坏了」是两回事——前者是成功的一种结局。
      if (!source) return stop({ stop: 'no_source', gate })

      // —— 4. 稀疏探帧（每帧一次 range 请求，代价与片长无关）——
      let sampled: KeyframeCandidate[]
      try {
        sampled = await ctx.stage('sample', () =>
          deps.sampleFrames(source.url, { count: sampleCount, signal: ctx.signal, headers: source.headers }),
        )
      } catch (e) {
        if (ctx.signal.aborted) return cancelled()
        // ffmpeg/ffprobe 自己炸了才是真失败。**绝不能混进「探过没料」**——那会让一个
        // 取不到字节的视频在账上长得跟一个真的没画面文字的视频一模一样。
        return { ok: false, error: { code: 'sample_failed', message: msg(e) } }
      }
      if (ctx.signal.aborted) return cancelled()
      const maxDistance = maxPairwiseDistance(sampled)
      if (maxDistance < stillDistance) {
        return stop({ stop: 'still_picture', gate, sampled: sampled.length, maxDistance })
      }

      // —— 5. 探 OCR：只送 2–3 张，用 §5.1 的判据量增量 ——
      // 探帧挑走的那几张也在正式候选里（`mergeCandidates`），所以两轮共用一份记账，
      // 同一个时刻只 OCR 一次。**别把它做成跨运行的缓存**——这份只活在这一次转换里。
      const ocrMemo: OcrMemo = new Map()
      const probeTally = await ctx.stage('probe-ocr', () =>
        ocrFrames(mostDistinct(sampled, probeOcrCount), source, segments, deps, ctx.signal, ocrMemo),
      )
      if (ctx.signal.aborted) return cancelled()
      const base = {
        gate,
        sampled: sampled.length,
        maxDistance,
        ocrTried: probeTally.tried,
        ocrFailed: probeTally.failed,
        ocrEmpty: probeTally.empty,
      }
      // 探帧的 OCR 产物**不进 track**：这几张的时刻会跟着下面第 6 步一起进正式那一轮
      // （候选集含它们，见 `mergeCandidates`），在那里重新 OCR 一次、和别的帧同口径去重。
      // 留在这里只会制造两个来源不同、去重口径不同的重复条目。它在这里只回答一个问题：
      // 值不值得往下付。
      //
      // **别把这句读成「探帧的时刻会被正式那一轮覆盖到」**——那正是 2026-08-30 那个 bug 的
      // 前提：正式候选集曾经只有 I 帧，比稀疏取样还稀，探到的那一屏从此再没被看过第二眼。
      if (!probeTally.entries.some((e) => e.kept)) {
        // 「探过，没料」——不是「没跑」。两者的区别全在 ocrTried 上。
        return stop({ stop: 'no_new_text', ...base })
      }

      // —— 6. 正式抽：唯一读完整个文件的一步，前面三道闸的全部意义就是把它挡在判断之后 ——
      let planned: KeyframeCandidate[]
      try {
        planned = await ctx.stage('plan', () =>
          deps.planVideoFrames(source.url, { signal: ctx.signal, headers: source.headers }),
        )
      } catch (e) {
        if (ctx.signal.aborted) return cancelled()
        return { ok: false, error: { code: 'plan_failed', message: msg(e) } }
      }
      if (ctx.signal.aborted) return cancelled()
      // 候选集 = I 帧 ∪ 稀疏样本。**只认 I 帧会漏整屏的字**，理由见 `mergeCandidates`。
      const candidates = mergeCandidates(planned, sampled)
      const { kept, truncated } = capFrames(candidates, maxFrames)
      const tally = await ctx.stage('ocr', () => ocrFrames(kept, source, segments, deps, ctx.signal, ocrMemo))
      if (ctx.signal.aborted) return cancelled()

      // —— 7. 文本级去重：哈希层刻意多留下来的重复，在这里才收得掉 ——
      // 顺序不能反：去重要看 OCR 出来的字，而哈希层根本不知道画面上写的是什么。
      const deduped = dedupeTrack(tally.entries)

      const result: FramesResult = {
        track: deduped.track,
        probe: {
          stop: 'done',
          ...base,
          ocrTried: probeTally.tried + tally.tried,
          ocrFailed: probeTally.failed + tally.failed,
          ocrEmpty: probeTally.empty + tally.empty,
          planned: candidates.length,
          plannedKeyframes: planned.length,
          truncated,
          // 未识别标记原样穿过去重，所以减掉它们就是「真出了新字」的帧数。
          framesKept: deduped.track.length - tally.failed,
          repeatedLines: deduped.repeatedLines,
          watermarkLines: deduped.watermarkLines,
          emptyLines: deduped.emptyLines,
          thinFrames: deduped.thinFrames,
        },
      }
      return { ok: true, result }
    },
  }
}

const cancelled = (): ConversionOutcome => ({ ok: false, error: { code: 'cancelled', message: 'cancelled' } })
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
