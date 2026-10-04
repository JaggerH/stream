import type { TranscriptSegment } from '../transcribe/client.ts'
import type { ChatMessage } from '../llm/client.ts'
import type { SpeakerRegistryStore } from './store.ts'

const ANON = /^SPEAKER_\d+$/

/** 长得像自我介绍的台词——只是**廉价预筛**，真正判定「这是不是自报姓名」交给 LLM
 *  （「我是四川的」「我是一名富二代」都会命中这个正则，由 LLM 判 null 滤掉）。 */
const INTRO_HINT = /(我是|我叫|大家好)/

/** 一条自我介绍线索 + 它**该命名的那个簇**。
 *
 *  为什么不是「介绍句自己所在的簇」：diarization 常把同一个人拆成多个簇，介绍句和随后的表演
 *  经常落在不同簇里。实测 `tmdb:261391:S03E02`——「我是林剪七」在 SPEAKER_16（全集仅 56s），
 *  她那段 set 在 SPEAKER_11（639s，全集最大簇）。按簇内找开头的老模型在真综艺上 0 命中。
 *  所以改成看**介绍句之后那段窗口由谁主导**：主导簇才是这个人真正的声音样本，
 *  名字要打在它身上（enroll 的也是它的向量，后续靠声纹自动识别）。 */
export interface IntroCandidate {
  /** 介绍句出现的时刻（秒） */
  atSeconds: number
  /** 递给 LLM 的文本：介绍句起 `contextSeconds` 内的台词（介绍常被切成「大家好」/「我是X」两段） */
  text: string
  /** 该被命名的簇 = 介绍句之后窗口内的主导说话人 */
  cluster: string
  /** 主导簇在窗口内的发言秒数（判据强度） */
  dominantSeconds: number
}

/** 扫出「自我介绍 → 紧随其后的表演段主导簇」这样的线索。纯函数，只读已存转写文本，不碰音频。
 *  一个簇最多产出一条（最早的那条赢——开场白通常在 set 最前面）。 */
export function pickIntroCandidates(
  segs: TranscriptSegment[],
  opts: { windowSeconds?: number; minDominantSeconds?: number; contextSeconds?: number } = {}
): IntroCandidate[] {
  const windowSeconds = opts.windowSeconds ?? 240
  const minDominantSeconds = opts.minDominantSeconds ?? 60
  const contextSeconds = opts.contextSeconds ?? 20
  const ordered = segs.filter((s) => s.speaker).sort((a, b) => a.start - b.start)
  const out: IntroCandidate[] = []
  const claimed = new Set<string>()
  for (const s of ordered) {
    if (!INTRO_HINT.test(s.text ?? '')) continue
    const at = s.start
    // 谁主导介绍句之后这段窗口
    const spoken = new Map<string, number>()
    for (const x of ordered) {
      if (x.start < at || x.start >= at + windowSeconds) continue
      spoken.set(x.speaker!, (spoken.get(x.speaker!) ?? 0) + (x.end - x.start))
    }
    let cluster: string | undefined
    let dominantSeconds = 0
    for (const [sp, sec] of spoken) {
      if (sec > dominantSeconds) {
        cluster = sp
        dominantSeconds = sec
      }
    }
    // 主导得不够久 = 这句大概率不是「一段表演的开场」，别硬认
    if (!cluster || dominantSeconds < minDominantSeconds) continue
    // 已经被命名过的簇不重复取（最早那条赢），非匿名簇说明声纹已经认出来了、不用抽名
    if (!ANON.test(cluster) || claimed.has(cluster)) continue
    claimed.add(cluster)
    const text = ordered
      .filter((x) => x.start >= at && x.start < at + contextSeconds)
      .map((x) => x.text)
      .join(' ')
      .trim()
    if (text) out.push({ atSeconds: at, text, cluster, dominantSeconds })
  }
  return out
}

/** 拿本作品的演职员表纠 ASR 同音字（实测「林**简**七」被转写成「林**剪**七」）。
 *  完全匹配直接过；等长且只差一个字视为同音误听，纠回演职员表的写法。
 *  演职员表里查无此人 → 返回 null：**不硬认**（错名会永久污染回灌样本，见 spec-1「低置信不硬认」）。
 *  但 null 不再等于静默丢弃——调用方（resolveIntroNames）把它落成一条**待确认**挂到认人 UI，
 *  用户点一次「认」才 enroll（TMDb 对国综选手收录不全，校不上是常态，见 spec
 *  2026-07-24-uncast-name-pending-confirm）。
 *  没有演职员表可用（空数组）→ 无从校验，原样采信。 */
export function correctNameAgainstCast(name: string, cast: string[]): string | null {
  if (!cast.length) return name
  if (cast.includes(name)) return name
  for (const c of cast) {
    if (c.length !== name.length) continue
    let diff = 0
    for (let i = 0; i < c.length; i++) if (c[i] !== name[i]) diff++
    if (diff <= 1) return c
  }
  return null
}

const INTRO_SYSTEM =
  '你在分析一段脱口秀/综艺的开场白。判断说话人是否在自我介绍（如「大家好，我是XXX」）。' +
  '只有说话人自报的**自己的**名字才算；报幕、介绍别人、玩梗自称、口播广告都不算。' +
  '严格只输出 JSON：{"name": "抽到的名字"} 或 {"name": null}。名字只给称呼本身，不要带任何多余文字。'

export function buildIntroMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: INTRO_SYSTEM },
    { role: 'user', content: text },
  ]
}

/** Parse the LLM's `{"name": ...}` output into a plausible name, or null. Guards against the model
 *  returning a whole sentence: a real self-intro name is short and punctuation-free. */
export function parseIntroName(content: string | null): string | null {
  if (!content) return null
  const m = content.match(/\{[^{}]*"name"\s*:\s*(null|"[^"]*")[^{}]*\}/)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[0]) as { name?: unknown }
  } catch {
    return null
  }
  const name = (raw as { name?: unknown }).name
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 12) return null
  if (/[，。,.！!？?；;：:\s]/.test(trimmed)) return null
  return trimmed
}

export interface IntroDeps {
  invokeLlm: (messages: ChatMessage[]) => Promise<string | null>
  registry: Pick<
    SpeakerRegistryStore,
    'listPersons' | 'createPerson' | 'enrollFromCluster' | 'enqueuePendingName' | 'clearPendingNames' | 'renameInTimeline'
  >
  /** 本作品的演职员表姓名（TMDb `metadata.people`），用于纠 ASR 同音字。缺省 = 不纠、原样采信。 */
  cast?: string[]
  opts?: { windowSeconds?: number; minDominantSeconds?: number; contextSeconds?: number }
}

/** identify 末尾的自我介绍抽名步：找到「介绍句 → 其后表演段的主导簇」，LLM 抽名、演职员表纠错，
 *  然后把名字打在**主导簇**上并 enroll 它的向量——那才是这个人真正的声音样本，
 *  之后任何内容里再遇到这个声音都会被声纹自动认出，不必再自我介绍。
 *  纯后处理，不碰音频。任一条失败只影响那一条，整体不 throw（调用方 runIdentify 另有兜底降级）。 */
export async function resolveIntroNames(
  itemId: string,
  segs: TranscriptSegment[],
  deps: IntroDeps
): Promise<TranscriptSegment[]> {
  const candidates = pickIntroCandidates(segs, deps.opts)
  if (!candidates.length) return segs
  const rename = new Map<string, string>()
  // 待确认要**整份替换**，不是先清空再指望填回来。原因是两条约束顶在一起：
  //  · 必须替换：待确认按 `(item_id, cluster)` 存，而簇号每次重跑都会变，旧行指向的已经
  //    不是同一批内容；按名字的去重还会把新簇那条挡在门外（见 store.clearPendingNames 头注）。
  //  · 不能盲清：抽名要过 LLM，而 LLM 会哑（2026-07-25 活体：端点返回「未配置」，整条链路
  //    一个名字都抽不出来）。先清后填在这种时候等于把用户排队等确认的名字凭空删掉。
  // 所以：先把这一轮抽到的攒起来，**攒到了才删旧的**；一个都没抽到就原样不动。
  const fresh: Parameters<SpeakerRegistryStore['enqueuePendingName']>[0][] = []
  for (const cand of candidates) {
    if (rename.has(cand.cluster)) continue
    try {
      const content = await deps.invokeLlm(buildIntroMessages(cand.text))
      const raw = parseIntroName(content)
      if (!raw) continue
      const name = correctNameAgainstCast(raw, deps.cast ?? [])
      if (!name) {
        // 校不上演职员表 → 不丢、不硬认:落一条待确认挂到认人 UI(问用户一次)。名字原样存(未纠错),
        // 主导簇的向量已在 registry(identify 阶段 putItemCluster),确认时直接 enrollFromCluster。
        fresh.push({ itemId, cluster: cand.cluster, name: raw, evidence: cand.text, atSeconds: cand.atSeconds })
        continue
      }
      const personId =
        deps.registry.listPersons().find((p) => p.name === name)?.id ?? deps.registry.createPerson(name).id
      deps.registry.enrollFromCluster(itemId, cand.cluster, personId, `${itemId}:${cand.cluster}:intro`)
      // 改名必须落到时间线上——那是唯一权威，投影（返回值里的段）只是读时形态。曾经只改投影：
      // 出现账里有他、/clusters 与 /blocks（走时间线）里他还叫「说话人 N」，三份数据各叫各的。
      deps.registry.renameInTimeline(itemId, cand.cluster, name)
      rename.set(cand.cluster, name)
    } catch {
      // this candidate stays anonymous; the others still get a chance
    }
  }
  // 这一轮确实抽出了东西（认掉的 or 待确认的）才动旧行——LLM 哑掉时 fresh 与 rename 都空，
  // 旧的待确认原样留着（宁可挂在过时的簇上，也好过整份消失）。
  if (fresh.length || rename.size) {
    deps.registry.clearPendingNames(itemId)
    for (const rec of fresh) deps.registry.enqueuePendingName(rec)
  }
  if (!rename.size) return segs
  return segs.map((s) => (s.speaker && rename.has(s.speaker) ? { ...s, speaker: rename.get(s.speaker)! } : s))
}
