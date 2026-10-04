import type { LeftEntry } from './sync.ts'
import type { InvokeLlm, FolderContext } from './match-generate.ts'
import { resolveSeasonsByLlm } from './match-generate.ts'
import { DEFAULT_TITLE_STRIP, specStages, type SpecLeft, type SpecRight } from './match-spec.ts'
import { matchByEvidence } from './match-engine/resolve.ts'
import { emptyResolution, mergeResolutions, resultFrom, type EvidenceMatchResult } from './match-engine/adapt.ts'
import type { MatchSpec } from './types.ts'

/** 从 leftKey 的 SxxExx 尾巴取季号（同 match-spec.ts 内部的 LEFT_SE，这里独立一份——两个模块
 *  不必互相 import 对方的私有正则，语义简单到重复一行比加一处耦合划算）。 */
const LEFT_SE = /:S(\d{1,3})E(\d{1,4})$/i

/** 一季的指纹：集数 + 播出区间（`airFrom`/`airTo` 取该季有 airDate 的集的最早/最晚一天；一集都没有
 *  日期就两格都缺席——`airDateSeason` 对缺席的季不判，不拿 undefined 当"无穷"）。 */
export interface SeasonFingerprint { season: number; episodeCount: number; airFrom?: string; airTo?: string }

/** 从已投影的 LeftEntry[] 反推每季集数与播出区间——tmdbEpisodeIndex 已经把季集号铺平进 leftKey，
 *  分组计数即得，不必回头再问 TMDb 原始 payload。非剧集 leftKey（无 SxxExx）不计入任何季。 */
export function fingerprintsFromLeft(left: LeftEntry[]): SeasonFingerprint[] {
  const acc = new Map<number, { episodeCount: number; airFrom?: string; airTo?: string }>()
  for (const l of left) {
    const m = LEFT_SE.exec(l.leftKey)
    if (!m) continue
    const season = Number(m[1])
    const cur = acc.get(season) ?? { episodeCount: 0 }
    cur.episodeCount++
    if (l.airDate) {
      if (!cur.airFrom || l.airDate < cur.airFrom) cur.airFrom = l.airDate
      if (!cur.airTo || l.airDate > cur.airTo) cur.airTo = l.airDate
    }
    acc.set(season, cur)
  }
  return [...acc.entries()]
    .map(([season, { episodeCount, airFrom, airTo }]) => ({ season, episodeCount, ...(airFrom ? { airFrom, airTo } : {}) }))
    .sort((a, b) => a.season - b.season)
}

export interface FolderGroup { folder: string; files: SpecRight[] }

/** 按右侧文件相对路径的「直接父目录」（叶子目录）分组——不是顶层目录。一个绑定根目录下可能摞了
 *  多个独立分享来源的兄弟子文件夹（各自对应不同季）,按顶层分组会把它们强并成一组、逼着共享同一个
 *  季判定；按叶子目录分组则每个来源各自独立判季,不会互相传染。没有子目录的文件（直接躺在绑定根
 *  目录）单独成组,组名空串。 */
export function groupByLeafFolder(right: SpecRight[]): FolderGroup[] {
  const groups = new Map<string, SpecRight[]>()
  for (const r of right) {
    const slash = r.name.lastIndexOf('/')
    const folder = slash === -1 ? '' : r.name.slice(0, slash)
    const arr = groups.get(folder) ?? []; arr.push(r); groups.set(folder, arr)
  }
  return [...groups.entries()].map(([folder, files]) => ({ folder, files }))
}

/** 判断一个文件名是不是"像一集"——用来数文件夹里的集数做结构指纹。花絮/字幕/nfo 这类杂项
 *  文件不该被计进集数；极端目录里数错 1-2 个也不影响季判定,真撞车靠 LLM 兜底。 */
const EPISODE_LIKE = /\.(mkv|mp4|ts|avi|mov|m4v|wmv|flv|webm)$/i
function episodeLikeCount(files: SpecRight[]): number {
  return files.filter((f) => EPISODE_LIKE.test(f.name)).length
}

/** 结构指纹:文件夹里"像一集"的文件数唯一命中某季的集数 → 判定为那一季。数不上任何季、或撞了
 *  多个季(数量并列)→ 不判(null),留给嵌套干净名/LLM 兜底,不瞎猜。 */
export function structuralSeasonMatch(files: SpecRight[], fingerprints: SeasonFingerprint[]): number | null {
  const n = episodeLikeCount(files)
  if (n === 0) return null
  const hits = fingerprints.filter((f) => f.episodeCount === n)
  return hits.length === 1 ? hits[0].season : null
}

/** 文件名里的一个日历日期：`2026.08.14` / `20260814` / `2026-08-14` / `2026_08_14`，年份限 20xx，
 *  月日要合法——`20261399`、`1080p60` 这类数字串不算日期。只取每个文件名（不含目录）里的第一个。 */
const FILE_DATE = /(20\d{2})[.\-_]?(0[1-9]|1[0-2])[.\-_]?(0[1-9]|[12]\d|3[01])(?!\d)/
function fileDate(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const m = FILE_DATE.exec(base)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** 网盘上传常晚于播出几天（收官那两集尤其）：区间尾部放宽这么多天。头部不放——首播之前不可能有正片。 */
const AIR_TRAIL_DAYS = 14
function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 播出日期指纹：文件名里的日期落进哪一季的播出区间。判定要**唯一且占多数**——带日期的文件至少占
 * "像一集"文件的一半，且其中超过一半落进同一季、没有第二季分到任何一份；否则不判（null），交给
 * 后面的层。它排在嵌套干净名与结构指纹之后、缓存与 LLM 之前：比"目录名"硬（目录名可以是任何
 * 乱码，日期不会撒谎），也比 LLM 便宜且确定。
 *
 * 活体（喜剧之王单口季，2026-09-03）：追更转存的目录「X喜剧之DKJ」没季号、13 个文件对不上任何一季
 * 的集数、无子目录无杂项，LLM 拿到的上下文是空的 → null → 永久缓存，第 7–9 期整批
 * season-unresolved。每个文件名都写着 2026.08.xx。
 */
export function airDateSeason(files: SpecRight[], fingerprints: SeasonFingerprint[]): number | null {
  const spans = fingerprints.filter((f): f is SeasonFingerprint & { airFrom: string; airTo: string } => !!f.airFrom && !!f.airTo)
  if (spans.length === 0) return null
  const episodes = files.filter((f) => EPISODE_LIKE.test(f.name))
  const dates = episodes.map((f) => fileDate(f.name)).filter((d): d is string => !!d)
  if (dates.length === 0 || dates.length * 2 < episodes.length) return null
  const hits = new Map<number, number>()
  for (const d of dates) {
    for (const s of spans) {
      if (d >= s.airFrom && d <= shiftDays(s.airTo, AIR_TRAIL_DAYS)) hits.set(s.season, (hits.get(s.season) ?? 0) + 1)
    }
  }
  if (hits.size !== 1) return null
  const [[season, n]] = [...hits.entries()]
  return n * 2 > dates.length ? season : null
}

/** 干净的「第N季」/「Sxx(Exx)」文本——真名字可能就躺在顶层文件夹名里,也可能躺在子目录/压缩包名里
 *  (如 `S1+S2/脱口秀和Ta的朋友们 第二季.zip` 的真名字在压缩包文件名里、`王.中.王/S03 纯享/`
 *  的真季号在子目录名的裸 Sxx 里,不一定带 Exx)。从文件名到顶层文件夹**由近及远**扫每一段——
 *  越靠近文件的目录名标注得越具体:真实回归(喜剧之王单口季,2026-07-21)见过顶层文件夹写着
 *  "第二季"、底下却嵌套一个来源特意"反向收录"进来的"S1"子目录(装的是第一季内容),这不是顶层
 *  被混淆,是内层在明确标注一个例外子集——按由近及远扫,内层这个更具体的标注会先命中,正确覆盖
 *  掉外层"第二季"这个泛指整个文件夹主体内容的标签。
 *
 *  同一段里出现"S1+S2"这种撞了两次的裸 Sxx——那正是"反向收录了多季"的信号,不是干净的单一
 *  指向,不能抢答成其中一个季号:一段内必须**恰好一次**命中才算数,撞了 ≥2 次直接跳过这段继续
 *  扫别处(别的段/别的文件),不当真;命中的季号不在候选指纹里 → 也当没找到(防止误扫到无关数字)。 */
const CLEAN_SEASON_CN = /第\s*([一二三四五六七八九十0-9]{1,3})\s*季/
const CLEAN_SEASON_SE = /[Ss](\d{1,2})(?!\d)(?:[Ee]\d{1,4})?/
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function parseSeasonNum(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  return CN_NUM[raw] ?? null
}
/** seg 里恰好命中一次 re 才算干净信号；0 次或 ≥2 次(同段撞了多个季度提法)都不算数,返回 null。 */
function singleHit(re: RegExp, seg: string): RegExpMatchArray | null {
  const hits = [...seg.matchAll(new RegExp(re.source, 'g'))]
  return hits.length === 1 ? hits[0] : null
}
export function nestedCleanNameSeason(files: SpecRight[], fingerprints: SeasonFingerprint[]): number | null {
  const known = new Set(fingerprints.map((f) => f.season))
  for (const f of files) {
    const segments = f.name.split('/').reverse() // 文件名到顶层文件夹由近及远扫,见上方注释
    for (const seg of segments) {
      const cn = singleHit(CLEAN_SEASON_CN, seg)
      if (cn) { const n = parseSeasonNum(cn[1]); if (n != null && known.has(n)) return n }
      const se = singleHit(CLEAN_SEASON_SE, seg)
      if (se) { const n = Number(se[1]); if (known.has(n)) return n }
    }
  }
  return null
}

export interface ResolveSeasonsDeps {
  invokeLlm: InvokeLlm
  /** 文件夹名 → 上次 LLM 兜底判出的季号(或 null=判不出)的持久缓存;命中即直接用,不重新问模型。
   *  只缓存 LLM 这一层——结构指纹/嵌套干净名廉价、且随文件增减而变,每次都重新算,不进缓存。
   *  调用方(NetdiskService.matchWithSeasonAwareness)负责把这份缓存存回 binding、下次同步再传
   *  进来;这里只读写调用方给的 Map,不管持久化。缺省(undefined)等价于每次都当缓存全未命中。 */
  llmSeasonCache?: Map<string, number | null>
}

/** LLM 兜底那层的输入体量上限——目录数/杂项文件数正常场景个位数,这两个数只是防极端目录树
 *  把 prompt 撑爆的安全网,不是期望常态触发的裁剪。 */
const MAX_TREE_ENTRIES = 30
const MAX_EXTRA_FILES = 20

/** 给 LLM 兜底层的文件夹上下文:目录结构(跳过顶层,与 nestedCleanNameSeason 同一口径) + 非
 *  "一集视频"的文件名(压缩包/说明文件等杂项——真实季度线索常年藏在这类文件名里,例如一个叫
 *  "XX 第二季.zip" 的压缩包,嵌套干净名的正则扫描过这些路径但没命中时不该把这份信息也一起
 *  扔掉)。每一集视频的文件名不给——季度判断用不上,且数量随集数线性增长,白占 token。 */
function folderContext(files: SpecRight[]): FolderContext {
  const dirs = new Set<string>()
  const extraFiles: string[] = []
  for (const f of files) {
    const segments = f.name.split('/').slice(1) // 跳过顶层文件夹
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
    if (!EPISODE_LIKE.test(f.name)) extraFiles.push(segments.join('/'))
  }
  return { tree: [...dirs].slice(0, MAX_TREE_ENTRIES), extraFiles: extraFiles.slice(0, MAX_EXTRA_FILES) }
}

/**
 * 一个绑定的季归属:嵌套干净名 → 播出日期 → 结构指纹 → 缓存 → LLM 语义兜底,命中即停。各层都判不出
 * 的文件夹归 null——调用方把它的文件整体排除在匹配之外,留作 orphan 残留(人工在
 * netdisk_preview_spec 兜底)。根目录散文件(folder === '')不送 LLM——没有文件夹名可读,问了也是
 * 白问。真落到 LLM 兜底的文件夹**批量问一次**(见 resolveSeasonsByLlm),不是一个文件夹问一次——
 * 省调用次数,还能把结构指纹/嵌套干净名/缓存已经确定的季号当 takenSeasons 喂给模型做排除法。
 *
 * 嵌套干净名放在结构指纹**之前**——真实回归(进击的巨人,2026-07-25):同一季被拆成
 * `S03 part1`(12 个文件)+ `part2`(10 个文件)两个子目录,part1 的文件数(12)与另一季(S02)
 * 的真实集数撞脸,结构指纹按老顺序会把 part1 误判成 S02、12 个文件整段并错季,S03E01-E12
 * 因此在最终 coverage 里全数 missing(而非"配错"——两边桶里同名文件让 reduceByQuality 消歧
 * 不出,先到的季 2 自己文件赢先手)。folder 名里字面写着的 `S03` 是比"文件数量凑巧相等"更硬的
 * 证据,该赢;结构指纹退居"没有字面标注时"的兜底档。
 */
export async function resolveFolderSeasons(
  groups: FolderGroup[],
  fingerprints: SeasonFingerprint[],
  deps: ResolveSeasonsDeps,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const needLlm: FolderGroup[] = []
  for (const g of groups) {
    const nested = nestedCleanNameSeason(g.files, fingerprints)
    if (nested != null) { out.set(g.folder, nested); continue }
    // 日期排在结构指纹之前：文件数 == 某季集数是巧合级的证据（活体 2026-09-03：追更往一个 2025 年
    // 的分享目录里转存两份后，目录恰好 20 个视频 = 第 1 季集数，整目录被判成第 1 季，新到的两集
    // 一条边都没有）；文件名里的日期不会撒谎。也排在缓存之前：缓存里躺着的可能正是上一轮 LLM
    // 空手而归的 null。
    const byDate = airDateSeason(g.files, fingerprints)
    if (byDate != null) { out.set(g.folder, byDate); continue }
    const structural = structuralSeasonMatch(g.files, fingerprints)
    if (structural != null) { out.set(g.folder, structural); continue }
    if (g.folder === '') { out.set(g.folder, null); continue }
    if (deps.llmSeasonCache?.has(g.folder)) { out.set(g.folder, deps.llmSeasonCache.get(g.folder) ?? null); continue }
    needLlm.push(g)
  }
  if (needLlm.length > 0) {
    const takenSeasons = [...new Set([...out.values()].filter((v): v is number => v != null))]
    const folders = needLlm.map((g) => ({ folderName: g.folder, context: folderContext(g.files) }))
    const resolved = await resolveSeasonsByLlm(folders, takenSeasons, fingerprints, deps.invokeLlm)
    for (const g of needLlm) {
      const season = resolved.get(g.folder) ?? null
      out.set(g.folder, season)
      deps.llmSeasonCache?.set(g.folder, season)
    }
  }
  return out
}

/**
 * 多季 tv 绑定的季归属 + 分季匹配总控。左侧按季拆分、右侧按解出的季号分区，每个季各自跑一遍
 * 匹配器(消掉"第1期上"跨季撞桶),最后把各季判决合并、对完整左右两侧重算一次全局 coverage
 * (未季归属的文件夹天然落不进任何分区 → 全局覆盖率里正确报成孤儿)。
 *
 * **分区语义与合并语义都没变**，变的只是每一季跑的是哪个引擎：证据图引擎一次调用 = 一份
 * `Resolution`，`mergeResolutions` 走的是"左键互不相交、后写覆盖前写"。
 */
/**
 * 季分区**专用**的收尾档：文件名开头只剩一个集号（`23 4K.mkv`、`第30集 ….mp4`）时，拿它当
 * 完整的结构键。单捕获组 ⇒ 引擎整档退化成"纯按集号分桶"（见 `types.ts` 的 `MatchStage`
 * 头注），而那份头注写明这**只在季已被上游分区隔离干净时才安全**——这里正是那个上游。
 *
 * 为什么不写进 `DEFAULT_MATCH_SPEC`：没分季的池子里（单季绑定、订阅流）裸集号跨季撞车，
 * 而 `season-episode` 是 `trustUnique + autoOnMatch`，撞上就是无声配错。这一档只能活在
 * 这一层。为什么不改 `epnum` 的 `trustUnique`：那一档在**所有**绑定上生效，放开它等于
 * 让"号对上、名字一个字都不沾"在全库变成 auto。
 *
 * 排在**最后**：它只捡前面各档没认领的剩饭。`threshold: 0` 是有意的——季分区里集号就是
 * 硬键，标题在这一档只用来在同号多份时消歧（那时候候选不唯一，`trustUnique` 短路不了，
 * 门槛与 margin 照常起作用）。
 *
 * **「期≠集」的季不能吃这一档的默认口径**：活体（脱口秀 tmdb:261471 S02，2026-09-03）里
 * TMDb 把这档综艺按"每期两集"编号（E01=第1期上、E02=第1期下……），网盘按"期"命名
 * （`第3期上：….mkv`、`第4期纯享版：….mkv`）。默认正则只要求数字后不紧跟另一个数字，
 * "第3期上"里"期"前面的数字照样被读成裸集号 3，唯一命中直接 `auto`——整季从 E02 起错位，
 * 而本该赢的 `episode-part`（第N期上/下）反倒因为集号已经被抢注、产出证据冲突卡。判据从
 * 该季自己的权威标题里找：只要有一条 `SpecLeft.title` 形如"第N期上/中/下"，就说明这一季
 * 是"一期多集"，裸数字后面不能再跟"期"——用负向前瞻把"期"也堵上（`23 4K.mkv`、`第30集`
 * 这类真裸集号不受影响，"期"不出现在那类文件名的紧邻位置）。期==集的季（标题只有"第N期"、
 * 没有上/中/下）维持原样，裸期号本来就等于集号。
 */
const SEASON_BARE_EPISODE_REGEX = '^(?:第\\s*)?0*(\\d{1,3})(?![0-9])'
const SEASON_BARE_EPISODE_REGEX_NO_QI = '^(?:第\\s*)?0*(\\d{1,3})(?![0-9期])'
/** 权威标题里"一期拆成多集"的写法：`第N期上/中/下`、`第N期（一）`/`第N期(2)`。任一形状出现过，这一季
 *  的期号就不是集号——喜剧之王单口季 S02/S03（2026-09-03）用的是括号段号，只认上/中/下那版守卫
 *  没拦住，`第4期二` 被裸期号档读成 E04、前缀刻进文件名，13 条。 */
const MULTI_EPISODE_PER_QI_TITLE = /第\s*\d+\s*期\s*(?:[上中下]|[（(]\s*[一二三四五六七八九十\d]+\s*[）)])/
function withBareEpisodeTail(spec: MatchSpec, seasonLeft: SpecLeft[]): MatchSpec {
  const stages = specStages(spec)
  const multiEpisodePerQi = seasonLeft.some((l) => MULTI_EPISODE_PER_QI_TITLE.test(l.title))
  return {
    ...spec,
    stages: [...stages, {
      by: 'season-episode',
      fileRegex: multiEpisodePerQi ? SEASON_BARE_EPISODE_REGEX_NO_QI : SEASON_BARE_EPISODE_REGEX,
      titleStrip: DEFAULT_TITLE_STRIP,
      threshold: 0,
      margin: 0.15,
    }],
  }
}

export async function matchBySeason(
  spec: MatchSpec,
  left: SpecLeft[],
  right: SpecRight[],
  fingerprints: SeasonFingerprint[],
  deps: ResolveSeasonsDeps,
): Promise<EvidenceMatchResult> {
  const groups = groupByLeafFolder(right)
  const seasonOfFolder = await resolveFolderSeasons(groups, fingerprints, deps)
  return matchBySeasonResolved(spec, left, right, seasonOfFolder)
}

/**
 * 分区匹配那一段——**同步**，季归属已经有答案了。
 *
 * 为什么和 `matchBySeason` 拆开：归档器（`reconcile/plan.ts` 的 `buildPlan`）是同步的，可它必须
 * 和同步走**同一条分区路**，否则跨季同期号的文件会被判成同一集（活体 2026-09-03 脱口秀
 * 52/128 行错判）。它的季归属由服务层提前去要（与同步共用同一份 `llmSeasonCache`），拿到
 * 答案后调的就是这一段。`matchBySeason` 只是「先要答案、再调这一段」的那个异步壳。
 *
 * `seasonOfFolder` 的键是 `groupByLeafFolder` 给的**叶子目录名**，与 `right[].name` 的目录部分
 * 同一口径——同步那侧是相对路径，归档器那侧是绝对路径，调用方各自保证自洽即可。
 */
export function matchBySeasonResolved(
  spec: MatchSpec,
  left: SpecLeft[],
  right: SpecRight[],
  seasonOfFolder: Map<string, number | null>,
): EvidenceMatchResult {
  const groups = groupByLeafFolder(right)

  const leftBySeason = new Map<number, SpecLeft[]>()
  for (const l of left) {
    const m = LEFT_SE.exec(l.leftKey)
    if (!m) continue
    const season = Number(m[1])
    const arr = leftBySeason.get(season) ?? []; arr.push(l); leftBySeason.set(season, arr)
  }

  // 先按解出的季号把（可能来自多个文件夹的）文件合并成一份,每季只跑一次匹配——
  // 不按文件夹跑。两个文件夹撞同一季号时（如按清晰度拆成独立顶层目录、或同季分两次转存）,
  // 必须在同一次调用里看见彼此的候选,否则各自独立跑出的判决合并时,后处理的
  // 文件夹会用 mergeResolutions 的后写覆盖前写语义,无条件盖掉先处理文件夹里更可靠的命中——
  // 那个合并语义是按「每季只跑一次」为前提写的,这里必须真的兑现这个前提。
  const filesBySeason = new Map<number, SpecRight[]>()
  for (const g of groups) {
    const season = seasonOfFolder.get(g.folder)
    if (season == null) continue // 归不了属的文件夹整段留作残留,不参与任何分区匹配
    const arr = filesBySeason.get(season) ?? []
    arr.push(...g.files)
    filesBySeason.set(season, arr)
  }

  // 分区跑的谱多一档收尾（见 withBareEpisodeTail）——季号已由文件夹定死，剩下的裸集号
  // 就是完整的键。只在这里加：出了季分区它是不安全的。每季各自算一份 partitionSpec
  // （不能在循环外算一次）：这一档要不要把"期"也堵进负向前瞻，取决于**这一季自己**
  // 的权威标题是不是"一期多集"——不同季的口径可能不同，公用一份会把别的季的判据带偏。
  let resolution = emptyResolution()
  for (const [season, files] of filesBySeason) {
    const seasonLeft = leftBySeason.get(season) ?? []
    if (seasonLeft.length === 0) continue
    const partitionSpec = withBareEpisodeTail(spec, seasonLeft)
    resolution = mergeResolutions(resolution, matchByEvidence(partitionSpec, seasonLeft, files))
  }
  // 各季的问句合并后一起交出去——季分区不改问句的语义，只是分了几批算。coverage 对**完整**
  // 两侧重算：归不了季的文件夹一份判决都没进过，正是靠这一次全局重算才报成孤儿。
  return resultFrom(resolution, left, right)
}
