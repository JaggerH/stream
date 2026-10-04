/**
 * 「这一段是模型编的，不是真有人在说话」——whisper 家族最著名的失败模式。
 *
 * 静音、纯音乐、环境噪声喂进去，模型不会说"没听见"，它会**编一句出来**。产出看着完全
 * 正常（一句通顺的话、带时间戳），没有任何一处会喊——这正是这个项目反复吃亏的那种形状。
 *
 * **本地跑 whisper 的人靠 VAD 在模型前面拦**（Silero VAD 之类）；我们的转写全在云端
 * （Groq → Cloudflare → OpenAI），拦不到前面。但也不需要——**模型自己每段都在报，
 * 我们以前把那份报告扔了**：`verbose_json` 的每段带 `no_speech_prob`、`avg_logprob`、
 * `compression_ratio`，我们只读了 `start/end/text`。
 *
 * ## 阈值是量出来的
 *
 * 2026-08-15 拿真 Groq（`whisper-large-v3`）现打的三组，各 20 秒：
 *
 * ```
 *                no_speech  avg_logprob  compression   产出
 * 静音              0.70       -0.71        0.33       " you"     ← 编的
 * 纯音调            0.70       -0.62        0.20       " ."       ← 编的
 * 真人声            0.23       -0.08        1.20       正常转写
 * ```
 *
 * 三个字段方向一致、分得很开，所以门槛落在中间：`no_speech_prob ≥ 0.6` 且
 * `avg_logprob ≤ -0.5`。**样本只有这三组**，别当成标定完了——每段的原始值都留在
 * `probe.dropped` 的账里，攒够真实分布再回来定。
 *
 * ## 为什么必须两个字段同时成立
 *
 * 单看 `no_speech_prob` 会误杀：正常语句之间的短停顿段、句尾拖长音，这个值也能上到 0.6+，
 * 但它们的 `avg_logprob` 依然很高（模型对自己转出的字有把握）。**误杀一段真话是永久丢失
 * 且没人会喊**，而漏掉一段编造只是轨里多一句怪话——两种错的代价差着量级，所以取交集。
 *
 * ## 复读循环是相反的一种编造
 *
 * whisper 卡进循环时会把同一句重复几十遍，这时 `compression_ratio` 会飙高（文本压得极狠）。
 * 它和"静音编造"是两个方向的失败：一个是**没料硬凑**，一个是**有料出不来**。2.4 是 whisper
 * 官方实现里用了多年的那个数，这里沿用；**我们自己没量过**，标注在此。
 *
 * ## 拿不到字段 = 不判，不是"没有语音"
 *
 * Cloudflare / OpenAI 那两条腿的返回未必带这些字段。**缺信息绝不能当成"判定为无语音"**
 * ——那会把一整条正常转写静静抹掉。缺字段一律返回 `undefined`（不判），让它照常通过。
 */

/** 云端 STT 回来的一段原始形状（`verbose_json`）。三个判据字段都可能缺席。 */
export interface RawSttSegment {
  start?: number
  end?: number
  text?: string
  no_speech_prob?: number
  avg_logprob?: number
  compression_ratio?: number
}

/** 判为无语音的 `no_speech_prob` 下限。实测静音/音乐 0.70，真人声 0.23。 */
export const NO_SPEECH_PROB = 0.6

/** 判为无语音的 `avg_logprob` 上限。实测静音 -0.71、音调 -0.62，真人声 -0.08。 */
export const LOW_LOGPROB = -0.5

/** 判为复读循环的 `compression_ratio` 下限。沿用 whisper 官方实现的数，**我们没量过**。 */
export const REPEAT_COMPRESSION = 2.4

/** 丢弃理由。两种编造方向相反，账上必须分得开——混成一个数就查不出是哪种。 */
export type FabricationReason = 'no_speech' | 'repetition'

/**
 * 这一段是不是模型编的。返回理由，或 `undefined` 表示「留着」（含判不了的情况）。
 */
export function fabricationReason(s: RawSttSegment): FabricationReason | undefined {
  const { no_speech_prob: noSpeech, avg_logprob: logprob, compression_ratio: compression } = s
  if (typeof compression === 'number' && compression >= REPEAT_COMPRESSION) return 'repetition'
  // 交集，不是并集——理由见头注「为什么必须两个字段同时成立」。
  if (typeof noSpeech === 'number' && typeof logprob === 'number') {
    if (noSpeech >= NO_SPEECH_PROB && logprob <= LOW_LOGPROB) return 'no_speech'
  }
  return undefined
}

/** 被丢掉的一段，连同它的原始读数——留着是为了将来能拿真实分布重新标定阈值。 */
export interface DroppedSegment {
  start: number
  end: number
  text: string
  reason: FabricationReason
  noSpeechProb?: number
  avgLogprob?: number
  compressionRatio?: number
}

export interface SieveResult {
  kept: RawSttSegment[]
  dropped: DroppedSegment[]
}

/**
 * 把编造的段筛出去。**只丢段，不丢整条**——一条正常视频里插一段音乐，该丢的是那一段。
 *
 * 调用方要自己回答「全丢光了怎么办」：那是「这条没有语音」这个**正常结论**，不是失败，
 * 两者必须在账上分得开（都表现为"没有文字"，但一个该安静收工、一个该报错）。
 */
export function sieveFabricated(segments: readonly RawSttSegment[]): SieveResult {
  const kept: RawSttSegment[] = []
  const dropped: DroppedSegment[] = []
  for (const s of segments) {
    const reason = fabricationReason(s)
    if (!reason) {
      kept.push(s)
      continue
    }
    dropped.push({
      start: s.start ?? 0,
      end: s.end ?? 0,
      text: (s.text ?? '').trim(),
      reason,
      noSpeechProb: s.no_speech_prob,
      avgLogprob: s.avg_logprob,
      compressionRatio: s.compression_ratio,
    })
  }
  return { kept, dropped }
}
