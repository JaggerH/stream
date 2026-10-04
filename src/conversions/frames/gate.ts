/**
 * 抽帧闸门 —— 在付任何取样字节钱之前，用转写已经产出的东西（零成本）判掉大多数
 * 不需要抽帧的视频。spec §5.2 第 2 步。
 *
 * 三条判据，任一条成立就 go（去抽）：
 *   1. 没有转写 —— 恰恰说明信息可能全在画面上，是最该抽的一类，不是最不该的。
 *   2. 语速密度低（charsPerMinute < sparseCpm）—— 大段时间没人说话：教学演示/干讲/剪辑片。
 *   3. 指示语命中数高（deicticHits >= 阈值）—— 说话人在指屏幕，转写必然缺一半。
 * 三条都不成立 → 不抽（dense_speech，纯口播），账上记「探过，判为纯口播」。
 */

/** 转写里出现就说明说话人在指着画面讲、转写文字盖不住画面信息的词。
 *  加词的人从这里找到它——别把判据散落成内联字面量。 */
export const DEICTIC_WORDS = [
  '这里',
  '这边',
  '这个',
  '那个',
  '你看',
  '大家看',
  '如图',
  '图上',
  '左边',
  '右边',
  '上面',
  '下面',
  '我点',
  '点一下',
  '屏幕上',
  '代码里',
] as const

/**
 * 语速密度阈值（字/分钟）：低于它判「大段没人说话」→ 抽。
 *
 * **240 是量过的，别再往上抬。** 库里 129 条已转写视频跑一遍（2026-08-31）：真抽到画面
 * 文字的 37 条里，这条判据放行的 12 条 cpm 落在 9–233，而被判纯口播踢掉的那批 cpm
 * 中位数 361、最高 982——**两簇在 240 以上完全重叠，没有任何自然缺口**。也就是说这个数
 * 在高语速区没有分辨力：抬到 500 只会 admit 二十多条盲目多付 OCR，并不比现在更准。
 * 高语速那一侧的活是下面那条指示语判据在干（放行 25 条，一条没白付）。
 */
export const DEFAULT_SPARSE_CPM = 240

/**
 * 指示语命中阈值（次数）：达到它判「一直在指屏幕」→ 抽。
 *
 * **1 是量出来的，而且是拿真值验过的。** 两步（2026-08-31）：
 *
 * 1. 库里 129 条已转写视频对上 frames 的实际结局：这条判据在高语速区放行 25 条，**25 条
 *    全抽到了字，一条都没白付**——它精准，就是太紧。判纯口播出局的 37 条里，命中恰好
 *    1 次的有 9 条。
 * 2. 那 9 条**强制跑了一遍**（`force: true`，否则 POST 只把已有记录原样退回）：逐帧看完
 *    9 条，**8 条抽到了画面文字**，1 条空（一段对话/短剧）。抽到的那些不是零星几个字：
 *    财经解读 10 条轨、Skill 讲解 25 条、修图教程 5 条，整屏的标题正文都在里面。
 *
 * 所以阈值 2 的代价是实打实的：那 8 条视频此前一个字都拿不到。松到 1 之后这条判据的
 * 准确率 33/34（旧 25/25 + 新 8/9），基本没掉。
 *
 * 代价认得清：口语里「这个 / 那个」本来就常见，阈值 1 会让**每 4 条高语速视频多抽 1 条**
 * （9/37），其中约每 9 条有 1 条白付 OCR。这个量级可接受；真要再松就得先给词表分强弱
 * （「屏幕上 / 如图 / 代码里」比「这个」强得多），而那需要新的标注样本，不是再改一个数。
 */
export const DEFAULT_DEICTIC_HITS = 1

export interface GateInput {
  /** 转写全文（没有转写就是空串——那不代表「不该抽」，见上）。 */
  text: string
  /** 媒体时长（秒）。0 或缺省 = 不知道。 */
  durationS: number
}

export interface GateVerdict {
  /** 要不要往下走（去付那次稀疏取样）。 */
  go: boolean
  /** 为什么——要能直接写进账，不是一个光秃秃的布尔。 */
  reason: 'no_transcript' | 'unknown_duration' | 'sparse_speech' | 'deictic' | 'dense_speech'
  /** 量出来的语速密度，进 probe 账。`null` = 时长不知道、算不出这个数（没量到）；
   *  `0` = 时长知道、但转写里就是没字（真的没人说话）。这两者**绝不能混**——将来
   *  拿这批读数定阈值时，把「没量到」和「真的 0 字/分钟」混进同一簇会污染量法。 */
  charsPerMinute: number | null
  deicticHits: number
}

function countDeicticHits(text: string): number {
  let hits = 0
  for (const word of DEICTIC_WORDS) {
    let from = 0
    for (;;) {
      const idx = text.indexOf(word, from)
      if (idx === -1) break
      hits += 1
      from = idx + word.length
    }
  }
  return hits
}

export function framesGate(
  input: GateInput,
  opts?: { sparseCpm?: number; deicticHits?: number },
): GateVerdict {
  const sparseCpm = opts?.sparseCpm ?? DEFAULT_SPARSE_CPM
  const deicticThreshold = opts?.deicticHits ?? DEFAULT_DEICTIC_HITS

  const text = input.text ?? ''
  const deicticHits = countDeicticHits(text)

  if (text.length === 0) {
    // 没有转写时也算不出密度（分子分母都没有），charsPerMinute 记 null——理由是
    // 'no_transcript'，不是下面那条 'unknown_duration'。
    return { go: true, reason: 'no_transcript', charsPerMinute: null, deicticHits }
  }

  // 时长不知道（0/缺省）时算不出密度——charsPerMinute 记 null，不能因为算不出就
  // 当成「真的 0 字/分钟」记进账；判决方向不变，仍然要给个能抽的理由，但理由要
  // 说实话：这不是「量出来偏低」，是压根没量到。
  if (input.durationS <= 0) {
    return { go: true, reason: 'unknown_duration', charsPerMinute: null, deicticHits }
  }

  const minutes = input.durationS / 60
  const charsPerMinute = text.length / minutes

  if (charsPerMinute < sparseCpm) {
    return { go: true, reason: 'sparse_speech', charsPerMinute, deicticHits }
  }

  if (deicticHits >= deicticThreshold) {
    return { go: true, reason: 'deictic', charsPerMinute, deicticHits }
  }

  return { go: false, reason: 'dense_speech', charsPerMinute, deicticHits }
}
