import type { ExplainEdge, MatchFact, ReconcilePlanAction, RowExplain } from '../lib/types.ts'

/**
 * ④「凭什么」的判据链：把一段散文换成**一列带实测值的信号**。
 *
 * 起因（活体 2026-08-03，用户原话「说明原因比较冗长，其实是有级联关系」）：后端那句
 * `askReason` 一句话里塞了四样东西——命中了什么、卡在哪、可能是为什么、你能做什么。
 * 最后一样按钮上一字不差地又写了一遍；第二样里的数字文件行上本来就摆着。读的人得从
 * 六七十个字里捞出真正独有的那一个词（"时长"）。
 *
 * **数据一律取自后端已有的判决书**（`explain.edges[].facts`），前端不新造字段、不重算数
 * ——同 `types.ts` 那段"后端是唯一真相源"，也同 `explain.ts` 头注定下的规矩：
 * 「不另造数据源——卡片说的话必须是裁决真用过的证据」。现行那句散文反倒是二次转述，
 * 中途把两条最硬的证据丢了（见 `redundantChain`）。
 *
 * 拿不出链就**返回 `null`**，调用方退回原来那句 `reason`。宁可显示旧文案，不许渲染半条空链。
 */

export interface ChainSignal {
  /** `ok` 成立（✓ 绿）· `no` 否决（✗ 红）· `warn` 存疑（! 琥珀，不下结论只让它被看见）。 */
  tone: 'ok' | 'no' | 'warn'
  /** 左栏那个词：集号 / 名字 / 时长 / 同名集 / 码率。定宽一列，竖着扫得出。 */
  label: string
  /** 右栏那句话，**必须含实测值**——没有数的信号（"差出量级"）等于没说。 */
  value: string
}

export interface VerdictChain {
  signals: ChainSignal[]
  /** 判据链的落点（处置类才有）：所以这份是什么、要拿它怎么办。 */
  conclusion?: string
  /** 存疑的解释。**是猜测不是判据**，所以退成灰的一行，且不含任何行动句（那两句在按钮上）。 */
  hint?: string
}

/** 时长按 mm:ss 说。与 `reconcile-action-row` 那份是同一个实现（那边从这里 re-export）。 */
export function fmtDur(s?: number): string {
  if (!s) return ''
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

/**
 * 差额的措辞。精度**按这个差额是拿来干什么的**分，不按它有多大：
 *
 *  · `precise`（问句里的时长）——**永远报到秒**。用户要判的是"这还算不算同一集"，
 *    那 44 秒可能正是片头广告或结尾彩蛋，是有信息的。按数值大小粗化会让同一列里
 *    一部分报到秒、一部分报整分（活体：116 报 5 分 57 秒、268 报 10 分钟），读起来像两把尺。
 *  · 默认（判删卡上那条"同名集根本不是这个长度"）——**报整分**。那是差着量级的对照，
 *    60 分 45 秒里的 45 秒纯属噪音。
 */
function fmtGap(deltaS: number, precise = false): string {
  const d = Math.round(Math.abs(deltaS))
  if (!precise && d >= 600) return `${Math.floor(d / 60)} 分钟`
  const m = Math.floor(d / 60)
  const s = d % 60
  if (!m) return `${s} 秒`
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}

const factsOf = <K extends MatchFact['kind']>(e: ExplainEdge, kind: K) =>
  e.facts.filter((f): f is Extract<MatchFact, { kind: K }> => f.kind === kind)

const durationFact = (e: ExplainEdge, state: 'hit' | 'contradict') =>
  factsOf(e, 'duration').find((f) => f.state === state)

const exactName = (e: ExplainEdge) => factsOf(e, 'name').find((f) => f.method === 'identity-exact')

/**
 * 码率基线 = **本轮全部文件的中位数**。
 *
 * 中位数而不是平均数：活体那 157 个文件里 150 个是 128k、另有 4 个 320k，平均数被拉到 133 上下
 * 还算温和，但视频那种 128k 混 4000k 的批次会被拉高好几倍，把正常文件全打成"异常"。
 * 中位数对少数极端值免疫，正是这里要的。
 *
 * **样本太少就没有基线**（返回 `undefined`）：三五个文件谈不上"同批别的是多少"，
 * 那时宁可不标，也不换成一个拍脑袋的绝对阈值——播客 128k 正常，有声书 32k 也正常。
 */
export const KBPS_MIN_SAMPLES = 8
export function kbpsBaselineOf(all: (number | undefined)[]): number | undefined {
  const xs = all.filter((x): x is number => typeof x === 'number' && x > 0).sort((a, b) => a - b)
  if (xs.length < KBPS_MIN_SAMPLES) return undefined
  return xs[Math.floor(xs.length / 2)]
}

/** 低于基线这个比例才算反常。活体：0.4 × 128 = 51.2，157 个文件里只命中 29k 与 33k 两个。 */
export const KBPS_ANOMALY_RATIO = 0.4

function kbpsSignal(explain: RowExplain, baseline?: number): ChainSignal | null {
  const kbps = explain.file.kbps
  if (!baseline || !kbps || kbps >= baseline * KBPS_ANOMALY_RATIO) return null
  // 只陈述两个数的对照，**不下"这份坏了"的结论**——码率低也可能是这一集本来就是单声道口播。
  return { tone: 'warn', label: '码率', value: `${kbps}k，同批别的文件是 ${baseline}k` }
}

/**
 * `duration-collision`（"是不是这一集"）的链：把那条被否决的主边**逐个事实**摊开。
 *
 * 顺序是**集号 → 名字 → 时长**，不按事实数组的原序：前两条是成立的证据、最后一条是卡住的那条，
 * 读到最后一行正好是"所以才问你"。原序由裁决层的记录顺序决定，对读者没有意义。
 */
function collisionChain(
  a: ReconcilePlanAction,
  explain: RowExplain,
  baseline?: number,
): VerdictChain | null {
  // 主边只认 `collidesWith`（leftKey，机器可读）——不按集名匹配：集名是展示值，
  // 同名的两集在别的节目单里真会出现，而认错主边意味着整条链讲的是另一集的事。
  const main = explain.edges.find((e) => e.episode.leftKey === a.collidesWith)
  if (!main) return null

  const signals: ChainSignal[] = []
  for (const k of factsOf(main, 'struct-key')) {
    signals.push({ tone: 'ok', label: STRUCT_KEY_LABEL[k.key], value: k.value })
  }
  const name = factsOf(main, 'name').sort((x, y) => y.score - x.score)[0]
  if (name) {
    signals.push(name.method === 'identity-exact'
      ? { tone: 'ok', label: '名字', value: `${name.cleanedLeft} · 完全一致` }
      : { tone: name.score >= 0.6 ? 'ok' : 'no', label: '名字', value: `${name.cleanedRight} ↔ ${name.cleanedLeft} · 相似度 ${name.score.toFixed(2)}` })
  }
  const contradict = durationFact(main, 'contradict')
  const authority = main.episode.durationS ?? a.compare?.authorityDurationS
  if (contradict && a.src.durationS != null && authority != null) {
    const dir = a.src.durationS < authority ? '短' : '长'
    signals.push({
      tone: 'no',
      label: '时长',
      value: `${fmtDur(a.src.durationS)}，比节目单 ${fmtDur(authority)} ${dir} ${fmtGap(contradict.deltaS, true)}`,
    })
  } else if (durationFact(main, 'hit') && a.src.durationS != null) {
    signals.push({ tone: 'ok', label: '时长', value: `${fmtDur(a.src.durationS)}，与节目单一致` })
  }

  const warn = kbpsSignal(explain, baseline)
  if (warn) signals.push(warn)
  if (!signals.length) return null
  return { signals, hint: askHint(a.basis) }
}

const STRUCT_KEY_LABEL: Record<Extract<MatchFact, { kind: 'struct-key' }>['key'], string> = {
  epnum: '集号',
  'season-episode': '季集号',
  'episode-part': '分段号',
}

/**
 * 存疑的解释，按 `basis` 里那个**机器可读**的 ask 理由分档（`ambiguous:<reason>:<leftKey>`）。
 * 与后端 `plan.ts` 的 `askReason` 同一套分档，但**只留解释、砍掉行动句**：
 * 「是这一集就换正主，不是就挪去下架」在按钮上一字不差地写着，在这里重复一遍是纯噪音。
 */
function askHint(basis?: string): string | undefined {
  const reason = /^ambiguous:([a-z-]+):/.exec(basis ?? '')?.[1]
  if (reason === 'duration-contradiction') return '可能是分享者贴错了名字，也可能是节目单时长不准或这份被截断了。'
  if (reason === 'name-floor') return '长音频撞时长很常见，光凭这一条不足以判定是同一集。'
  if (reason === 'low-confidence') return '名字像，但够不着"直接认下来"那条线。'
  if (reason === 'no-margin') return '几个候选拉不开差距，机器挑不出哪个更像。'
  if (reason) return '名字的相似度没到门槛。'
  return undefined
}

/**
 * `delete-redundant`（判删免费集副本）的链。**现行文案把两条最硬的证据都丢了**：
 *
 *  · 这份的时长与命中那一集**一秒不差**（活体 05 案：5808 = 5808）——这才是"它其实是那一集"的依据；
 *  · 而它文件名指的那一集**只有 36:03**，差了一个钟头——这才是"它不是它自称的那一集"的依据。
 *
 * 两条后端都量到了、都记在判决书里，卡片上却只有一句"实际对应《X》"。用户读到它时最想问的
 * 就是"凭什么"，答案原本一直在数据里。
 */
function redundantChain(a: ReconcilePlanAction, explain: RowExplain, baseline?: number): VerdictChain | null {
  // 候选名单**只认后端**：`candidateEpisodes` 与 `basis` 里那串 leftKey 逐位对齐，
  // 而 explain 的边有 8 条上限、会被 `truncatedCount` 截掉。拿 explain 自己凑一个名单，
  // 迟早少列一集——而少列的那一集恰恰可能是"它其实不该删"的理由。
  const keys = keysOfRedundant(a.basis)
  const titles = a.candidateEpisodes ?? (a.episode ? [a.episode] : [])
  if (!titles.length) return null

  const signals: ChainSignal[] = []
  // 时长命中的那几集（= 判它"其实是哪一集"的全部依据）。按 leftKey 对上判决书里的边取 deltaS。
  const hits = keys.length
    ? keys.map((k) => explain.edges.find((e) => e.episode.leftKey === k)).filter((e): e is ExplainEdge => !!e && !!durationFact(e, 'hit'))
    : explain.edges.filter((e) => durationFact(e, 'hit') && titles.includes(e.episode.title))
  if (hits.length && a.src.durationS != null) {
    const worst = Math.max(...hits.map((e) => Math.abs(durationFact(e, 'hit')!.deltaS)))
    const named = listEpisodes(titles)
    signals.push({
      tone: 'ok',
      label: '时长',
      value: `${fmtDur(a.src.durationS)}，与${named}${hits.length > 1 ? '都' : ''}${worst === 0 ? '一秒不差' : `只差 ${worst} 秒`}`,
    })
  }
  // 同名却被时长否决的那一集：文件名自称是它，而它根本不是这个长度。
  const namesake = explain.edges.find((e) => exactName(e) && durationFact(e, 'contradict'))
  const nsDur = namesake?.episode.durationS
  if (namesake && nsDur != null && a.src.durationS != null) {
    const shorter = nsDur < a.src.durationS
    signals.push({
      tone: 'no',
      label: '同名集',
      value: `《${namesake.episode.title}》${shorter ? '只有' : '有'} ${fmtDur(nsDur)}，`
        + `差了 ${fmtGap(durationFact(namesake, 'contradict')!.deltaS)}——不可能是它`,
    })
  }
  const warn = kbpsSignal(explain, baseline)
  if (warn) signals.push(warn)
  if (!signals.length) return null

  return { signals, conclusion: redundantConclusion(titles) }
}

/** `redundant-free-candidates:<k1>,<k2>` / `redundant-free:<k>` → leftKey 数组（与集名逐位对齐）。 */
function keysOfRedundant(basis?: string): string[] {
  const m = /^redundant-free(?:-candidates)?:(.+)$/.exec(basis ?? '')
  return m ? m[1].split(',').filter(Boolean) : []
}

/** 一张卡的文案里最多点名几个集（与后端 `plan.ts` 的 `MAX_CARD_EPISODES` 同一个数）。 */
const MAX_CARD_EPISODES = 3
function listEpisodes(titles: string[]): string {
  const shown = titles.slice(0, MAX_CARD_EPISODES)
  const more = titles.length > shown.length ? `等 ${titles.length} 个集` : ''
  return shown.map((t) => `《${t}》`).join('') + more
}

/**
 * 结论。**一个候选和多个候选是两句话，不是一句话套模板**：多个时机器并不知道是哪一集，
 * 它的逻辑是"这几集都不需要网盘供货，所以不论哪一集都该删"。措辞必须如实反映——
 * 挑第一个说成"装的是《X》"是把推测伪装成结论，而这张卡后面接的是删除。
 */
function redundantConclusion(titles: string[]): string {
  const tail = '删掉（夸克回收站里还能捞回来）'
  if (titles.length === 1) return `所以这份装的是《${titles[0]}》，那一集源站自己放得出 —— 是冗余，${tail}`
  return `所以这份是${listEpisodes(titles)}之一——机器分不出是哪一集，但这几集源站都放得出，`
    + `不论哪一集都是冗余，${tail}`
}

/** `evidence-conflict` 卡上的一个候选集：**它自己**命中了什么。 */
export interface ConflictCandidate {
  /** 认领时原样回传（`setIsEpisode`）。绝不许按集名反查——集名是展示值。 */
  leftKey: string
  /** 集名只能来自判决书；查不到就空着（调用方显示 leftKey），**不编一个出来**。 */
  title: string
  /** 这一条命中了什么，压成一行。 */
  evidence: string
}

/**
 * 「到底是哪一集」那张卡的候选清单。
 *
 * **为什么这个函数存在**：那张卡以前只给"都不是"这一半，理由是「让用户在一串集名里点一个
 * 同样是抓阄」——只要卡上真的只有一串集名，这话就成立。把每条边**各自的证据**摆到各自那一行
 * （谁时长命中、谁只是名字沾边、谁多一个集号），选择才有依据，"就是它"这个按钮才给得下去。
 *
 * **名单以 `conflictsWith` 为准，一个不漏**：判决书的边有 8 条上限、会被 `truncatedCount` 截掉，
 * 查不到的那条照列、证据栏如实说查不到——少列一集等于让人在一个不完整的名单里选，
 * 而漏掉的那个可能正是答案。
 *
 * **但整份判决书都没有时（老账本行）→ 空数组**：那时每一行都是一个光秃秃的 leftKey，
 * 摆出来让人点"就是它"就是回到抓阄。宁可退回只有"都不是"的老样子，也不给一个没有依据的选择。
 */
export function conflictCandidatesOf(leftKeys: string[], explain?: RowExplain): ConflictCandidate[] {
  if (!explain) return []
  return leftKeys.map((leftKey) => {
    const e = explain?.edges.find((x) => x.episode.leftKey === leftKey)
    if (!e) return { leftKey, title: '', evidence: '判决书里没有这条边（本轮证据被截断）' }
    return { leftKey, title: e.episode.title, evidence: evidenceTagOf(e) }
  })
}

/**
 * 一条边命中了什么，压成一行。**由事实渲染、不写结论**（同后端 `plan.ts` 的 `evidenceTag`）：
 * 说"时长只差 1 秒"是因为图里真有一条 `duration.hit`，说"名字全等"是因为清洗后逐字相同。
 * 一条都不沾时露出"无可裁决证据"这句实话——别编一个像模像样的理由，上一次事故就是文案与判据两张皮。
 */
function evidenceTagOf(e: ExplainEdge): string {
  const tags: string[] = []
  const hit = durationFact(e, 'hit')
  if (hit) tags.push(Math.abs(hit.deltaS) === 0 ? '时长一秒不差' : `时长只差 ${Math.round(Math.abs(hit.deltaS))} 秒`)
  for (const k of factsOf(e, 'struct-key')) tags.push(`${STRUCT_KEY_LABEL[k.key]} ${k.value}`)
  const name = factsOf(e, 'name').sort((a, b) => b.score - a.score)[0]
  if (name) tags.push(name.method === 'identity-exact' ? '名字全等' : `名字 sim ${name.score.toFixed(2)}`)
  const bad = durationFact(e, 'contradict')
  if (bad) tags.push(`时长差 ${fmtGap(bad.deltaS)}`)
  return tags.join(' · ') || '无可裁决证据'
}

export interface ChainOptions {
  /** 本轮码率基线（`kbpsBaselineOf` 算出来的）。缺席 = 不标反常码率。 */
  kbpsBaseline?: number
}

/**
 * 一条动作 → 它的判据链。**没有就返回 `null`**（调用方退回后端那句 `reason`）：
 * 老账本行没有 `explain`、豁免行压根没进过证据图，那都是合法状态，不许补算一个出来。
 */
export function verdictChainOf(
  a: ReconcilePlanAction,
  explain: RowExplain | undefined,
  opts?: ChainOptions,
): VerdictChain | null {
  if (!explain) return null
  if (a.kind === 'pending' && a.pendingKind === 'duration-collision') return collisionChain(a, explain, opts?.kbpsBaseline)
  if (a.kind === 'delete-redundant') return redundantChain(a, explain, opts?.kbpsBaseline)
  return null
}
