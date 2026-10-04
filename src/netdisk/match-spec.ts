import type { MatchSpec, MatchStage, CoverageReport } from './types.ts'
import { EXT, PUNCT, type IdentityRules } from './identity.ts'

/**
 * **匹配谱（`MatchSpec`）这门语言本身**：闭集校验、stage 的默认与补全，加上匹配两侧共用的
 * 清洗与比较工具（相似度、清晰度择优、规范名）与两向覆盖率。运行时零 LLM——谱由离线 AI 产出，
 * 或用默认。
 *
 * **匹配本身不在这里**：把谱读成判决的是 `match-engine/`（证据层 `collect.ts` → 裁决层
 * `resolve.ts` + 规则表 `rules.ts` → 适配层 `adapt.ts`）。本文件是它的**词汇表与工具箱**，
 * 一条规则都不含。要改"谁配给谁"去 `match-engine/rules.ts`；要改"什么算同一个名字/谁的画质更好"
 * 才来这里，改完两处消费者（匹配引擎、归档器）一起受影响。
 *
 * 闭集的 stage：`duration`（时长锚，没声明就隐式补一档）、`season-episode`（季集结构键，
 * 左键×文件名）、`episode-part`（期号+分段复合键）、`epnum`（集号）、`title`（纯标题相似度）、
 * `solo`（电影：目录里唯一的视频文件）。
 */

// 真实 bug（脱口秀和Ta的朋友们 第三季，2026-07-19）：title stage 靠纯字符串相似度比较，视频扩展名
// 不在剥离范围内时 "第2期上.mp4" 相似度被 ".mp4" 这条尾巴拖累，配不上左标题剥完前后描述的 "第2期上"。
// 音频扩展名早覆盖了、视频的一直没补——canonName 的去重同样受益（同名不同容器不再被扩展名拆成两条）。
// EXT 已上移共享认集层 identity.ts（spec 2026-07-25-shared-episode-identity），本文件改从那里导入。
/**
 * 比较形要剥掉的**前导集号**。两种写法：裸数字（`020.再谈…`）和中文的「第N集/话/期」
 * （`第30集 阴暗的另一面.mp4`）——后者是国内剧集网盘最常见的命名之一，不剥则整条标题被
 * 前缀顶偏、相似度掉到阈值以下，表现为"名字明明一模一样却配不上"。
 *
 * 只作用于**比较形**（`tidy`/`canonName`），不作用于键提取（那条走 `stripper`，见
 * `match-engine/collect.ts`）、也不作用于归档器的分组 key（那条走 `identity.ts` 的
 * `titleStrip`）。这个边界是有意的：往 `DEFAULT_TITLE_STRIP` 里加同样一条会把 decisions
 * 表里的存量人工豁免整片漂掉（见 docs/MATCHING.md）。
 */
const LEAD_EPNUM = /^(?:第\s*0*\d{1,3}\s*[集话話期]|0*\d{1,3})[.\s、_-]*/
/**
 * 默认集号正则:开头 1–3 位数字后接分隔符或汉字;4 位数(年份)靠位数排除。
 * `第` 前缀可选——「第30集 …」与「30.…」是同一件事的两种写法，只认后者等于对前者整档无信号。
 */
export const DEFAULT_EPNUM_REGEX = '^(?:第\\s*)?0*(\\d{1,3})(?=[.\\s、\\-]|[\\u4e00-\\u9fff])'
/** 标题相似度 ≥此值判 auto,否则 pending(候选够像但没到十足把握)。 */
export const AUTO_SIM = 0.8

/**
 * 通用缺省规格 —— 不含任何频道特异性。两阶段管线:
 *   1. epnum:开头 1–3 位数字(后接分隔符/汉字)分桶,桶内标题相似度消歧;4 位年份不当集号。
 *   2. title:无号项(如 "2022壬寅流年运势解析")按归一化标题在剩余文件里找,高阈值 0.85 防误配。
 * 某频道若有自己的标题前缀(如网盘文件 "怡乐播客 - "),作为该绑定 stage 的 titleStrip 数据覆盖,不写进代码。
 */
/** 场景命名的季集标记：`S01E02` / `s1e2`（1–2 位季、1–3 位集）。右侧文件名按它取季集。 */
export const DEFAULT_SEASON_EPISODE_REGEX = '[Ss](\\d{1,2})[Ee](\\d{1,3})'
/**
 * 国综常见的「第N期…上/下集」结构键（如「第2期纯享下集」）。第 1 组=期号、第 2 组=上/下。
 * 收 `第` 开头 + `期`（`第N集` 的普通剧集不落这档，走 season-episode/epnum），且要求 `上集`/`下集`
 * 里的 `集` 兜底——`第10期上流社会` 这种含「上」却非「上集」的标题不会误命中（`.*?` 会一路找不到
 * `(上|下)集` 而放弃）。左标题以「第」开头拿不到集号（epnum 要数字打头），中英/含噪标题又够不到
 * title 阈值——这个复合结构键是唯一配得上的信号，故进默认管线。keyRegex 通用、不含某档节目专名。
 */
/**
 * 四种分段写法都认（第 2 组起任一组命中即为分段，`collect.ts` 取第一个非空组并归一化：中文数字→阿拉伯数字，
 * 上/中/下原样）：`第2期纯享下集`（上/下集）、`第10期（三）`（括号段号，喜剧之王单口季 TMDb 标题的写法）、
 * `第1期四` / `第5期上`（裸段号，必须贴在「期」后且后面是结尾或分隔符——`第10期上流社会` 仍不命中）、
 * 期号本身也可以是中文数字（`第一期上`）。文件名常带 `2025.09.13-` / `20250913` 这类日期前缀，
 * 在正则里可选吃掉——**不进 `DEFAULT_TITLE_STRIP`**：那张表同时是归档器分组键的一部分，动它会让
 * decisions 里的存量豁免整片漂掉。
 */
export const DEFAULT_EPISODE_PART_REGEX =
  '^(?:\\d{4}[.\\-]?\\d{2}[.\\-]?\\d{2}[\\s.\\-_]*)?第\\s*(0*\\d{1,3}|[一二三四五六七八九十]{1,3})\\s*期'
  + '(?:\\s*[（(]\\s*([上中下一二三四五六七八九十]|\\d{1,2})\\s*[）)]|.*?(上|中|下)集|\\s*([上中下一二三四五六七八九十]|\\d{1,2})(?=$|[\\s.\\-_\\[【（(：:、,，]))'
/**
 * 默认各 stage 共用的标题剥离：`【水印】` + 文件名常见的 `YYYY-MM-DD ` 日期前缀（网盘按发布日
 * 命名，如「2026-07-18 第3期纯享下集.mkv」——不剥则期号/结构键被日期顶开读不出）。剥日期对无日期
 * 前缀的命名是空操作，安全通用；某绑定的专属前缀仍作数据挂到该绑定 stage 的 titleStrip，不入代码。
 */
export const DEFAULT_TITLE_STRIP = ['【[^】]*】', '^\\d{4}-\\d{2}-\\d{2}\\s*', '(2160[Pp]|1080[Pp]|720[Pp]|540[Pp]|480[Pp]|4[Kk])']

/**
 * 时长命中的容差（秒）—— 绑定匹配与归档器共用这一个值（`reconcile/plan.ts` 从这里 import，
 * 别再各留一份）。同一集在不同转存/不同容器里差的是编码零头（帧对齐、ID3 尾巴），实测 1s 以内；
 * 超过 1s 基本就是另一集了。放宽只会把"整季等长"的撞车面积做大，收紧则被编码零头误伤。
 * 没有实测支撑就别调它；真需要（某节目转码普遍偏移）在该绑定显式声明一档 `duration` 覆盖
 * `toleranceS`，不要改这个全局默认。
 */
export const DURATION_TOLERANCE_S = 1
/**
 * 时长「唯一命中免检」的**名字地板**：容差内独一份也得名字沾一点边，才敢按锚级证据直接认。
 *
 * 为什么需要它：「唯一」不等于「对」。一两个小时的节目时长撞车比想象中常见（同一批 371 个文件里
 * 530 与 820 就分毫不差同为 7707s），而容差 ±1s 这个区间里恰好没有第三个文件，纯属运气——
 * 2026-07-30 活体：848 期（8162s）被判给了 209 期的文件（8163s），名字一个字都不沾，还是 `auto`。
 * 209 不在订阅流给的清单里，没有"正主"来把文件领回去，错配就一直挂着。
 *
 * 为什么是 0.3：实测这条断层两边是空的——真配的下限是 `455.现代版木仓下留人`（改字避审，0.615），
 * 误配全是 0.000（848/209、530/820、29/104）。0.3 在中间，两边各留一倍余量。
 * **地板不过一律不配**（不是降级 pending）：配不上本身就是要报出来的信号，给它一个"有点像"
 * 的分数只是把问题翻译成另一种说法。这一集退回文件名链，链也配不上就老实记缺档、文件留 orphan。
 *
 * **这个常量就是地板的唯一真相源**——引擎拿本规则那把清洗尺量出来的 `name` 事实分数直接比它
 * （`match-engine/rules.ts:soleTouching`、`resolve.ts` 的零竞争/冲突判定、`explain.ts` 的相争者
 * 判据），没有第二份判据。别在别处另写一个"差不多的地板"：判据一分家就是第二个判定脑
 * （spec 2026-07-30-duplicate-episode-decision-design P7），而**更松的那个脑照样会自动执行动作**
 * ——归档器一度就有过自己那份没地板的时长命中：2026-07-31 活体 `玄关笔记/37.申与酉.mp3`（6044s）
 * 与 756 期（6043s）分毫不差、名字一个字不沾，匹配器按地板正确地没认它，归档器却把它判成 756 的
 * 副本，再比码率得出"换正主"：建议删掉名字与时长都对的那份、换上一个不知道是什么的文件。
 */
export const DURATION_MIN_SIM = 0.3
/**
 * 内容矛盾闸的量级线：两侧都有时长、相对差超过它 = 另一期节目穿着这一集的名字（错身文件），
 * **任何一档都不算配上**。
 *
 * 为什么是横向闸门、而不是 `duration` 档的内部逻辑：`epnum`/`title`/`season-episode` 三档完全不看
 * 时长，时长档在最前面没撞上就返回"无信号"（那是对的——时长是增强不是替换），后面的档就再也不问
 * 时长了。于是 96 分钟的 `玄关笔记/05.太极两仪生四象.mp3` 被 epnum 按名字配给节目单上 36 分钟的
 * 第 05 集、还给了 `auto`（2026-07-31 活体，05/20/37 三条），用户点开第 05 集播出来的是灵异事。
 * 「时长是认集主锚」这句话必须横着管住所有档才成立。
 *
 * 0.1 两边各留百倍余量：观测到的同集变体差 ≤0.1%（活体 780：8279s vs 节目单 8274s = 0.06%），
 * 错身文件差 160%+。**两侧任一没有时长 → 闸门不生效**（TMDb 不给时长，影视线零影响）。
 */
export const CONTENT_MISMATCH_RATIO = 0.1
/**
 * 内容矛盾闸的**唯一判据**（见 `CONTENT_MISMATCH_RATIO`）。两侧任一没有时长 → 不生效。
 * 导出是为了让 `match-engine/` 的证据器产 `duration: contradict` 事实时用同一把尺——
 * 判据一分家就是第二个判定脑（P7），而"更松的那个脑照样会自动执行动作"。
 */
export function contentContradicts(leftS: number | undefined, rightS: number | undefined): boolean {
  if (leftS == null || rightS == null) return false
  return Math.abs(leftS - rightS) / Math.max(leftS, rightS) > CONTENT_MISMATCH_RATIO
}

/** `toleranceS` 的上界（秒）。它是秒不是比例——套 [0,1] 那个校验器会把任何有意义的容差全拒掉。 */
const MAX_TOLERANCE_S = 3600

export const DEFAULT_MATCH_SPEC: MatchSpec = {
  version: 2,
  stages: [
    // 剧集网盘文件最常见的配法：左键 `tmdb:id:SxxExx` × 文件名 `SxxExx`。放最前——它是结构键，
    // 比 epnum(号不在开头，够不着)和 title(中文标题 vs 英文文件名，相似度 0)都可靠。非剧集
    // leftKey(播客/订阅流的 平台:id)不含 SxxExx → 本 stage 无信号跳过，老行为不变。
    { by: 'season-episode', fileRegex: DEFAULT_SEASON_EPISODE_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0, margin: 0.15 },
    // 国综「第N期上/下集」复合键：左标题以「第」开头无集号、中英含噪标题够不到 title 阈值，只有
    // 期号+上/下这个结构键配得上。放在 epnum 前——它比单集号更具体。命名不含「第N期…上/下集」时
    // keyRegex 两侧都 produce null → 无信号跳过，老行为不变（tmdb/播客左键均不落此档）。
    { by: 'episode-part', keyRegex: DEFAULT_EPISODE_PART_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.25, margin: 0.1 },
    { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 },
    { by: 'title', titleStrip: DEFAULT_TITLE_STRIP, threshold: 0.85, margin: 0.15 },
  ],
}

/**
 * 电影绑定的默认谱：左侧就一行，目录里的视频文件即认领（`solo`）。epnum/title 对电影
 * 无意义——片名是中文、文件名是英文发布组命名，相似度必然 0。目录里多个视频文件时
 * （同一部电影的多个画质版本，或正片+花絮），solo 取体量最大的那个当正片。title 仍留兜底。
 */
export const MOVIE_MATCH_SPEC: MatchSpec = {
  version: 2,
  stages: [{ by: 'solo' }, { by: 'title', titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 }],
}

/**
 * 节目单的一条。`durationS` 是**认集主锚**（`duration` stage 用），来自左侧来源自带的元数据
 * （订阅流 media 的 `duration_s`；TMDb 分集索引不给，那类绑定天然走文件名链）。
 *
 * `paid` = 源站这一集要不要钱。语义的唯一真相源是 `sync.ts` 的 `LeftEntry.paid`，别在这里另写
 * 一份。**谁都不读它做判断**：匹配层不读（带不带它配对结果一模一样），归档器的判定层不读
 * （读了就是第二个判定脑，spec 2026-07-30-duplicate-episode-decision-design P7），处置层也不读。
 * 它在这里只为让「节目单 → 匹配层」这一步不丢信息（`LeftEntry`/`SpecLeft`/归档器的
 * `AuthorityEntry` 讲的是同一件事），并进运行账本给人看那句"源站要钱"。
 *
 * 去留那件事走 `needsSupply`（见下）——**它不是 `paid` 的取反**，问的是另一件事。
 */
export interface SpecLeft {
  leftKey: string
  title: string
  durationS?: number
  paid?: boolean
  /**
   * **这一集要不要人往网盘供货**——`true` 源站自己放不出（网盘可能是唯一来源）/ `false` 源站
   * 自己就能放（网盘副本纯冗余）。判据是「这一集自己带没带一个可播地址」，在清单那一侧算
   * （`left-from-stream.ts` 的 `hasPlayableMedia`），匹配层只消费结论。
   *
   * **它不是 `paid` 的取反，这一点是它存在的全部理由**：`paid` 答的是"要不要钱"，这里问的是
   * "源站自己放不放得出"。两者在「没给地址、也不要钱」的 app 独占集上分道扬镳——那种集
   * `paid` 读不出任何东西，而网盘那份是它唯一的来源。判定层也因此不必知道什么叫"付费"，
   * 接任何新源只要能回答"自己带播放地址吗"就填得上，不绑播客。
   *
   * 匹配层拿它只做一件事：**该集不需要供货 → 不记集侧问句**（问了也白问，答案不改变处置）。
   *
   * **缺席 = 要供货**（保守档：删不可逆、留着只占空间）。填它的是消费方：归档器
   * `reconcile/plan.ts` 从 `AuthorityEntry.needsSupply` 取；绑定同步 `sync.ts` 目前不填
   * （那一侧的问句照旧全发）。
   */
  needsSupply?: boolean
  /**
   * 人工订正钉死的右文件（`MappingEntry.corrected`）。**与本次调用的 `right[].name` 同一命名
   * 空间**——绑定同步传相对子路径、归档器必须拼成绝对路径，不然 pin 静默失效（配不上又不报错）。
   *
   * 放在这里而不是各消费者自己特判：`sync.ts` 那侧的"corrected 不重算"只管**写回**，匹配本身
   * 照跑、被钉死的文件照样参与别的左项竞争；归档器那侧连这个特判都没有，会按自己重算的结果
   * 把用户钉死的那份当"清单里没有它"搬走。人裁过的机器不许翻案，这条只能长在判定层。
   */
  pinnedRight?: string
}
/** `size` (bytes) is optional and only consumed by the `solo` stage to break multi-file ties
 *  (最大 = 正片，花絮/sample 必然小一截)。其余 stage 纯按文件名匹配，缺 size 无影响。
 *  `durationS`（秒）由调用方探好再喂进来（`NetdiskService` 经 `durationsFor`）——本模块是纯函数，
 *  自己绝不做 I/O；缺席 = 时长档对该文件无信号。 */
export interface SpecRight { name: string; size?: number; durationS?: number }
/** 一集只认一个正主。同集的其余画质/副本**不进这里**——它们是整理的删除候选（同集只留最高
 *  质量那份，见 `compareQuality` 与 `reconcile/plan.ts`），不是可切换的播放候选。 */
export interface SpecAssignment {
  rightFile: string
  confidence: number
  status: 'auto' | 'pending'
  /** 同集的其余份（另一画质 / 水印副本 / 另一码率）。**交出来是为了让归档器不必自己反推
   *  "这份是哪一集的另一份"——那就是第二个判定脑（P7）。** 它们不是可切换的播放候选，
   *  归宿是整理按质量判删（`compareQuality`）。只有一份时整个字段缺席。 */
  losers?: string[]
}
/**
 * 一条**歧义**：有像样候选、但没敢配。
 *
 * 它过去只活到 `coverage.left.ambiguous` 那个计数为止——哪几集、在场的是哪些候选、差在哪道门槛，
 * 全丢了。下游拿不到证据就只能自己重算一遍，`reconcile/plan.ts` 那两个自建认领入口正是这么长出来
 * 的（活体怡乐 3 条：`怡乐播客 - 005/020/037`，名字完全正确，卡在分享者前缀把相似度稀释到 0.571、
 * 阈值 0.6）。交出去之后，"判不出"从**拒绝理由**变成**路由信号**：送人裁、送模型裁都行，
 * 但证据必须跟着走，且结论要回到同一份 `assignments`——不许下游各自长第二个脑（P7）。
 */
export interface SpecAmbiguity {
  leftKey: string
  stage: MatchStage['by']
  /** 机器可读，路由按它分派——**绝不解析文案**。 */
  reason: 'below-threshold' | 'no-margin' | 'duration-contradiction' | 'name-floor'
  /** 当时在场的候选，按分数降序。`duration-contradiction` 那档是被时长闸否掉的那些，
   *  `name-floor` 那档是时长容差内独一份、但名字连地板都没沾上的那个。 */
  candidates: { name: string; sim: number }[]
  threshold: number
  margin: number
}

export interface SpecMatchResult {
  /** leftKey → 配对结果（只含配上的）。 */
  assignments: Map<string, SpecAssignment>
  /** 判不出的那些（见 `SpecAmbiguity`）。**与 `coverage.left.ambiguous` 同一批**，只是带上了证据。 */
  ambiguous: SpecAmbiguity[]
  coverage: CoverageReport
}

/**
 * 取规格的有序 stage:v2 直接用 `stages`;v1(扁平字段)lift 成标准 [epnum, title] 管线
 * ——旧数据里 matchSpec 只存过通用默认(从没生成过自定义),补上 title 兜底既安全又让老绑定同步即修好无号项。
 */
export function specStages(spec: MatchSpec): MatchStage[] {
  return withDurationAnchor(declaredStages(spec))
}

function declaredStages(spec: MatchSpec): MatchStage[] {
  if (spec.stages && spec.stages.length) return spec.stages
  const titleStrip = spec.titleStrip ?? ['【[^】]*】']
  const margin = spec.margin ?? 0.15
  return [
    { by: 'epnum', epNumRegex: spec.epNumRegex ?? DEFAULT_EPNUM_REGEX, titleStrip, threshold: spec.threshold ?? 0.6, margin },
    { by: 'title', titleStrip, threshold: 0.85, margin },
  ]
}

/**
 * 时长档是**锚**，不是"某个节目的命名规则"——所以它不该要求每个绑定各自记得配上：任何没有
 * 显式声明 `duration` 的谱，这里在最前面补一档默认的。
 *
 * 为什么不能只加进 `DEFAULT_MATCH_SPEC`：LLM 生成/用户应用过的自定义谱（`generatedBy` 有值 →
 * `resolveSpec` 冻结尊重）永远不会含这一档，而那些绑定恰恰是被命名问题折磨过、最需要锚的。
 *
 * 为什么排在**最前**（连 `season-episode` 都在它后面）：编号会骗人（真实事故两次），时长不会。
 * 放在编号档之后，错编号的文件会先被"号对得上的那一集"抢走，真正的那一集永远配不上——
 * 编号错位的代价是"两集全错"；时长在前时降为"一集缺档"。
 *
 * 补进来那档的 `titleStrip` 借本谱已声明各档的并集（二次确认要和本绑定同一套清洗口径，
 * 否则相似度虚低）；threshold/margin 与 `epnum` 同——撞车时两者干的是同一件事：桶内标题消歧。
 */
function withDurationAnchor(stages: MatchStage[]): MatchStage[] {
  if (stages.some((s) => s.by === 'duration')) return stages
  const titleStrip: string[] = []
  for (const st of stages) {
    if (st.by === 'solo') continue
    for (const re of st.titleStrip) if (!titleStrip.includes(re)) titleStrip.push(re)
  }
  return [
    { by: 'duration', toleranceS: DURATION_TOLERANCE_S, titleStrip: titleStrip.length ? titleStrip : DEFAULT_TITLE_STRIP, threshold: 0.6, margin: 0.15 },
    ...stages,
  ]
}

/**
 * 闭集校验:把一份来路不明的对象(App 生成器的 LLM 产出 / 外部 agent 经 MCP 递的 JSON)
 * 收成一个可执行的 v2 MatchSpec,或抛错。两端 applySpec 与生成器共用这一个门——畸形 spec
 * 谁写的都落不进 binding。只认闭集里的 stage 类型(epnum/title/episode-part/season-episode/solo);未知 by(含未来的 fingerprint)
 * 一律拒,与执行器实现的那几种诚实对齐。
 */
export function validateSpec(obj: unknown): MatchSpec {
  const bad = (msg: string): never => { throw new Error(`invalid matchSpec: ${msg}`) }
  if (!obj || typeof obj !== 'object') return bad('not an object')
  const o = obj as Record<string, unknown>
  if (o.version !== 2) return bad('version must be 2')
  if (!Array.isArray(o.stages) || o.stages.length === 0) return bad('stages must be a non-empty array')

  const num01 = (v: unknown, name: string): number =>
    typeof v === 'number' && v >= 0 && v <= 1 ? v : bad(`${name} must be a number in [0,1]`)
  const reArray = (v: unknown, name: string): string[] => {
    if (!Array.isArray(v)) return bad(`${name} must be an array of regex strings`)
    return v.map((s) => {
      if (typeof s !== 'string') return bad(`${name} entries must be strings`)
      try { new RegExp(s) } catch { return bad(`${name} has an uncompilable regex: ${s}`) }
      return s
    })
  }

  const stages: MatchStage[] = (o.stages as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== 'object') return bad(`stages[${i}] not an object`)
    const s = raw as Record<string, unknown>
    // 先认闭集(未知 by —— 含未来的 fingerprint —— 是首要拒因),再验共有字段。
    // solo 无参数（唯一视频文件即认领），先分流——它不吃 titleStrip/threshold/margin。
    if (s.by === 'solo') return { by: 'solo' }
    if (s.by !== 'epnum' && s.by !== 'title' && s.by !== 'episode-part' && s.by !== 'season-episode' && s.by !== 'duration') return bad(`stages[${i}].by must be 'epnum', 'title', 'episode-part', 'season-episode', 'duration', or 'solo' (got ${JSON.stringify(s.by)})`)
    const titleStrip = reArray(s.titleStrip, `stages[${i}].titleStrip`)
    const threshold = num01(s.threshold, `stages[${i}].threshold`)
    const margin = num01(s.margin, `stages[${i}].margin`)
    if (s.by === 'epnum') {
      if (typeof s.epNumRegex !== 'string') return bad(`stages[${i}].epNumRegex must be a string`)
      try { new RegExp(s.epNumRegex) } catch { return bad(`stages[${i}].epNumRegex uncompilable`) }
      return { by: 'epnum', epNumRegex: s.epNumRegex, titleStrip, threshold, margin }
    }
    if (s.by === 'episode-part') {
      if (typeof s.keyRegex !== 'string') return bad(`stages[${i}].keyRegex must be a string`)
      try { new RegExp(s.keyRegex) } catch { return bad(`stages[${i}].keyRegex uncompilable`) }
      return { by: 'episode-part', keyRegex: s.keyRegex, titleStrip, threshold, margin }
    }
    if (s.by === 'duration') {
      // 秒，不是比例——num01 那个校验器套上来会把 1s/3s 这类唯一有意义的取值全拒掉。
      if (typeof s.toleranceS !== 'number' || !Number.isFinite(s.toleranceS) || s.toleranceS < 0 || s.toleranceS > MAX_TOLERANCE_S) {
        return bad(`stages[${i}].toleranceS must be a number of seconds in [0,${MAX_TOLERANCE_S}]`)
      }
      return { by: 'duration', toleranceS: s.toleranceS, titleStrip, threshold, margin }
    }
    if (s.by === 'season-episode') {
      if (typeof s.fileRegex !== 'string') return bad(`stages[${i}].fileRegex must be a string`)
      try { new RegExp(s.fileRegex) } catch { return bad(`stages[${i}].fileRegex uncompilable`) }
      return { by: 'season-episode', fileRegex: s.fileRegex, titleStrip, threshold, margin }
    }
    return { by: 'title', titleStrip, threshold, margin }
  })

  const spec: MatchSpec = { version: 2, stages }
  // 人工覆盖那一位（见 `MatchSpec.needsSupply`）。**只收真布尔**：非布尔一律当没填，不猜真值——
  // 它是个删除开关，让 `'true'`/`1` 这类字符串真值把它意外打开是最不该发生的一种事。
  if (typeof o.needsSupply === 'boolean') spec.needsSupply = o.needsSupply
  if (typeof o.generatedBy === 'string') spec.generatedBy = o.generatedBy
  if (typeof o.generatedAt === 'string') spec.generatedAt = o.generatedAt
  return spec
}

/** 检测清晰度档位；未识别出算独立的 'unknown' 档，不影响没有清晰度标签的老场景。 */
const QUALITY_REGEX = /(2160p|1080p|720p|540p|480p|4k)/i
function qualityOf(name: string): string {
  const m = QUALITY_REGEX.exec(name)
  return m ? m[1].toLowerCase() : 'unknown'
}

/** 档位从低到高；`4k` 与 `2160p` 是同一档的两种写法。不在表里 = 文件名没标清晰度。 */
const QUALITY_RANK = ['480p', '540p', '720p', '1080p', '2160p']
const rankOf = (name: string): number => {
  const q = qualityOf(name)
  return QUALITY_RANK.indexOf(q === '4k' ? '2160p' : q)
}

/** 同集两份文件谁的质量更高。`incomparable` = **比不出**，与"平手"是两件事：平手可以删一份，
 *  比不出必须留着让人看（整理的闸门二，见 spec 2026-07-31 §3）。 */
export type QualityVerdict = 'better' | 'worse' | 'tie' | 'incomparable'
export interface QualityCandidate { name: string; size: number; durationS?: number }

/** 码率相对差超过它才算分出高下——同一份内容两次转码的体量零头差不该被判成"谁更好"。 */
const BITRATE_MARGIN = 0.05

/**
 * `a` 相对 `b` 的质量。判据只用已有的两个数（文件名、体量+时长），不探新东西：
 *  1. 两侧时长都已知且差出 `DURATION_TOLERANCE_S` → **不是同一份内容**（加长版/切割版/合集），
 *     `incomparable`：比码率等于拿两段不同长度的东西比大小，删掉的可能是唯一完整的那份。
 *  2. 两侧文件名都标了清晰度档且档位不同 → 档位说了算（视频：4K > 1080p > 720p …）。
 *  3. 否则退到码率（`size×8÷durationS`，音频的主判据）：相对差 ≤5% 算平手。
 *  4. 再不行就是 `incomparable`——档位一样但没时长、或干脆两样都缺，未知 ≠ 该删。
 */
export function compareQuality(a: QualityCandidate, b: QualityCandidate): QualityVerdict {
  if (a.durationS != null && b.durationS != null && Math.abs(a.durationS - b.durationS) > DURATION_TOLERANCE_S) {
    return 'incomparable'
  }
  const ra = rankOf(a.name)
  const rb = rankOf(b.name)
  if (ra >= 0 && rb >= 0 && ra !== rb) return ra > rb ? 'better' : 'worse'
  if (a.durationS != null && b.durationS != null && a.durationS > 0 && b.durationS > 0) {
    const ba = (a.size * 8) / a.durationS
    const bb = (b.size * 8) / b.durationS
    const top = Math.max(ba, bb)
    if (top <= 0) return 'incomparable'
    const rel = (ba - bb) / top
    if (Math.abs(rel) <= BITRATE_MARGIN) return 'tie'
    return rel > 0 ? 'better' : 'worse'
  }
  return 'incomparable'
}

/** `dups`：被这个候选**吸收**掉的同名重复（清洗后标题一模一样的转存/水印副本）。跟着候选走而
 *  不是挂在桶上——时长档的桶键不保证同一集，挂桶上就会算到别的集头上（见 `reduceByQuality`）。 */
export type RTn = { r: SpecRight; tn: string; dups?: string[] }

/**
 * 桶内多候选清晰度分层去重。顺序很关键——先分层、层内再去重，不能反过来:
 *  1. 按检测到的清晰度分层（用原始文件名探测,qualityOf 不吃 titleStrip 处理过的 tn）。
 *     必须放最前：DEFAULT_TITLE_STRIP 现在会剥清晰度标签，若先按 tn 逐字去重，两个只差
 *     清晰度标签的文件 tn 会撞成同一串，被误判成同一份重复而吞掉一整个清晰度层。
 *  2. 层内逐字去重——tn 相同(标题完全相同,水印/转存重复)消歧不出任何信息，体量能分就取
 *     最大，分不出就该层原样留作候选（绝不跨层去重）。
 *  3. 跨层挑正片——层内去重后若每层都已收敛到唯一赢家，体量最大的当 primary，其余各档
 *     赢家是**落选副本**（`losers`：同一集的另一份，整理按质量判删）。任一步分不出正片时，
 *     原样留作候选，交给调用方的标题相似度兜底——不比老 season-episode 判据更激进。
 *
 * `sameEpisodeBucket`——**桶的键是否已经保证"这些文件是同一集"**。`epnum`/`season-episode`
 * 的桶键是集号，保证；`duration` 的桶键只是"时长相同"，**不保证**（两集正好一样长太常见）。
 * 不保证时，体量只许用来消同名重复（步骤 2），**绝不许在不同标题之间选**——2026-07-30 首次
 * 活体 sync 的教训：530/820 两集同为 7707s、体量差 3.7KB，"体量大者胜"把撞车压成了"唯一候选"，
 * 唯一性又被 `trustUniqueKey` 当成锚级证据，标题相似度根本没机会查，两集交叉配错且都是 auto。
 */
export function reduceByQuality(bucket: RTn[], sameEpisodeBucket = true): { cands: RTn[]; losers: string[] } {
  if (bucket.length <= 1) return { cands: bucket, losers: [] }

  // 按清晰度分层放在最前——用原始文件名探测（qualityOf 不吃 titleStrip 处理过的 tn），不会
  // 被"清晰度标签被 titleStrip 剥掉后 tn 撞车"污染（DEFAULT_TITLE_STRIP 现在会剥清晰度标签，
  // 若先按 tn 去重,两个只差清晰度标签的文件会被误判成同一份重复,吞掉整个清晰度层）。
  const byQuality = new Map<string, RTn[]>()
  for (const b of bucket) { const q = qualityOf(b.r.name); const arr = byQuality.get(q) ?? []; arr.push(b); byQuality.set(q, arr) }

  const winners: RTn[] = []
  for (const group of byQuality.values()) {
    // 层内先按 tn 逐字去重（同档位同内容的转存/水印重复,消歧不出信息,体量大者留）。
    // 落选的那几份**记在赢家的 `dups` 上**——它们和赢家清洗后同名，可证是同一份内容的副本，
    // 这是本函数在"桶键不保证同一集"时唯一敢下的同集断言。
    const byTn = new Map<string, RTn[]>()
    for (const g of group) { const arr = byTn.get(g.tn) ?? []; arr.push(g); byTn.set(g.tn, arr) }
    const deduped: RTn[] = [...byTn.values()].map((tnGroup) => {
      if (tnGroup.length === 1) return tnGroup[0]
      const [win, ...rest] = [...tnGroup].sort((a, b) => (b.r.size ?? 0) - (a.r.size ?? 0))
      const dups = rest.filter((x) => MEDIA_EXT.test(x.r.name)).map((x) => x.r.name)
      return dups.length ? { ...win, dups: [...(win.dups ?? []), ...dups] } : win
    })
    if (deduped.length === 1) { winners.push(deduped[0]); continue }
    // 桶键不保证同一集(时长档)——留下的这几个标题各不相同,就是几集不同的内容,体量在这里
    // 没有任何消歧含义。整层留作候选,交给标题相似度/后续 stage。
    if (!sameEpisodeBucket) { winners.push(...deduped); continue }
    // 层内去重复后仍有多个(真的是同档位的不同发布)——体量能分就分,分不出就整层留作候选。
    const ranked = [...deduped].sort((a, b) => (b.r.size ?? 0) - (a.r.size ?? 0))
    const topSize = ranked[0].r.size ?? 0
    winners.push(...(topSize > 0 && (ranked[1].r.size ?? 0) < topSize ? [ranked[0]] : deduped))
  }

  // 跨档位:每档都已确定唯一赢家时,体量最大的当 primary,其余各档赢家是同一集的落选副本。
  // 桶键不保证同一集时,只有各档赢家标题一致(真的是同一集的不同清晰度)才敢这么收。
  const crossTierOk = sameEpisodeBucket || new Set(winners.map((w) => w.tn)).size === 1
  let cands = winners
  if (crossTierOk && winners.length > 1 && winners.length === byQuality.size) {
    const ranked = [...winners].sort((a, b) => (b.r.size ?? 0) - (a.r.size ?? 0))
    const topSize = ranked[0].r.size ?? 0
    if (topSize > 0 && (ranked[1].r.size ?? 0) < topSize) cands = [ranked[0]]
  }

  // **落选份只收「清洗后同名」这一类**，两种桶键一视同仁。别按"桶键保证同一集就整桶收编"来推——
  // 那条推理看着顺，活体一量就塌（2026-08-01，全量 15 条绑定）：epnum 的桶键**实际上不保证同一集**，
  // 喜剧之王的 `第7期（一）(二)(三)(四)`、脱口秀的 `第5期上/中/下纯享` 全落进同一个号桶，
  // 整桶收编会把 53+25 份**不同内容**标成"这一集的其余份"，而落选份的归宿是按质量判删。
  // 层内体量择优丢掉的那些（标题各不相同）同理——`sameEpisodeBucket=false` 那条分支早就写着
  // 「标题各不相同,就是几集不同的内容,体量在这里没有任何消歧含义」，这条约束对号桶同样成立。
  const losers = cands.length === 1
    ? winners.filter((w) => w.r.name !== cands[0].r.name).flatMap((w) => [w.r.name, ...(w.dups ?? [])])
    : []
  return { cands, losers }
}

/**
 * 能当"同一集的另一份"的只有媒体文件。字幕/海报/nfo/压缩包和正片**清洗后常常同名**
 * （`X.S01E01.ass` 与 `X.S01E01.mkv` 剥掉扩展名后一模一样），照 tn 收编就会把字幕标成
 * 落选副本 → 按质量判删时连字幕一起删。活体撞到过（西区帮派两条 `.ass`，2026-08-01）。
 */
export const MEDIA_EXT = /\.(mkv|mp4|avi|mov|ts|m2ts|flv|wmv|m4v|webm|rmvb|mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i

/**
 * 剥前缀/水印,得比较用的干净标题。**只跑 `titleStrip` 那几条规则**——砍路径、去扩展名是
 * 文件名那一侧独有的事,搬进 `normFile`（见其头注）。
 */
export function stripper(titleStrip: string[]) {
  // `g`：一条规则要剥掉**所有**命中，不是只剥第一处。分享者的文件名常常挂两块水印
  // （节目自己的 `【…】` + 分享者的 `【耗时整理…】`），只剥第一块就等于把第二块当成标题的一部分，
  // 名字完全相同的文件相似度被压到门槛以下、整条配不上（活体：春典 JARGON）。
  // 覆盖率那条路的 `canonName` 一直是 `/g`——两条清洗口径本来就该一致。
  const strips = titleStrip.map((s) => new RegExp(s, 'g'))
  return (raw: string) => {
    let s = raw
    for (const re of strips) s = s.replace(re, '')
    return s
  }
}
/**
 * 比较形：剥前导集号 → 去标点空白 → 小写。标点用的是归档器那把同款尺（`identity.ts` 的
 * `PUNCT`，它本身已含 `\s`）——「标点不算内容差异」这个判据两处必须是同一个，各写一份的
 * 表现是归档器认得出、匹配器认不出，而两边单看都正常。
 */
const tidy = (s: string) => s.replace(LEAD_EPNUM, '').replace(PUNCT, '').toLowerCase()

/**
 * **左侧**（节目单里的集标题）的比较形。标题不是路径：不砍 `/`、不剥扩展名。
 *
 * 这两刀曾经对两侧一起下，于是标题里一个普通的 `/`（`你有多讨厌男朋友/女朋友（6）`）会把它
 * 拦腰截断成 `女朋友（6）`，一个像扩展名的结尾（`…2026.3.21`）会被剥成 `…2026.3`。
 * **不报错、只是相似度掉下来**：活体春典那条 sim 0.244（真值 0.959）掉到名字地板以下，
 * 表现为"时长对得上、名字一个字都不沾"的假歧义，而那份文件同时还会作为噪音候选出现在
 * 别的集的问句卡上。全库 294 条标题含 `/`、16 条结尾像扩展名。
 */
export const normTitle = (pre: (r: string) => string, raw: string) => tidy(pre(raw))

/**
 * 文件名侧独有的第一刀：砍掉目录（`plan.ts` 传的是绝对路径，递归列目录时也带相对子路径）、
 * 去扩展名。**必须在 `titleStrip` 之前跑**——各档的键正则大多带锚：`^0*(\d{1,3})` 遇到
 * `/quark/…` 前缀读不到集号，`(\d{1,3})$` 遇到 `.mp4` 结尾读不到集号。
 */
export const fileBase = (name: string) => name.replace(/^.*\//, '').replace(EXT, '')

/** **右侧**（网盘文件）的比较形：先 `fileBase`，再走与左侧同一套清洗。 */
export const normFile = (pre: (r: string) => string, raw: string) => tidy(pre(fileBase(raw)))

/**
 * 覆盖率/去重用的规格无关规范名（剥子路径/扩展名/【水印】/标点空白，小写）。
 *
 * 前导集号**归一化而不是删掉**：折成数值放回键首（`01.X` 与 `1.X` 仍是一份，`第30集 X` 与
 * `30.X` 也是一份），但两个不同集号不会再撞成同一个键。
 *
 * 删掉它曾经把**只剩集号**的文件名整片折成一份：活体（星卡梦少女 S04，2026-09-02）
 * `01 4K.mp4` … `30 4K.mkv` 三十个文件的 canonName 全是 `4k`。覆盖率因此把 122 个用上的
 * 文件报成 93；更坏的是 `orphanFiles` 每组只留一个代表，**残差视图里那三十个孤儿只露出
 * 一个**，读它的人据此断定"网盘上只有一个文件"。改规则的整个循环都读那份残差，它少报一
 * 整个文件夹，循环就是瞎的，而且没有任何一处会喊。
 */
export function canonName(name: string): string {
  const base = name.replace(/^.*\//, '').replace(EXT, '').replace(/【[^】]*】/g, '')
  const lead = LEAD_EPNUM.exec(base)
  const num = lead ? String(Number(lead[0].replace(/\D/g, ''))) : ''
  const rest = base.slice(lead?.[0].length ?? 0).replace(PUNCT, '').toLowerCase()
  return num ? `${num}|${rest}` : rest
}

/**
 * 覆盖率的取数形。**它是 `computeCoverage` 的入参，不是引擎的内部态**——引擎交出来的是
 * `Resolution`（`match-engine/types.ts`），由 `match-engine/adapt.ts:ctxFromResolution` 投影成
 * 这四个字段。字段名长在前端与账本上，所以形状不动。
 */
export interface StageCtx {
  assignments: Map<string, SpecAssignment>
  usedRight: Set<string>
  /** 有像样候选但没敢配(撞号/相似度不足/被时长闸否掉) → 记为 ambiguous 而非 missing。
   *  存整条证据而不只是 leftKey：下游要路由它，就得知道当时在场的是谁、差在哪道门槛。 */
  ambiguous: Map<string, SpecAmbiguity>
  missingByKey: Map<string, number> // 集号在但右侧无此号文件 → 该左项的缺档号
}

/** 什么算"正片能是的那种文件"。`solo` 档（`match-engine/rules.ts` R10）拿它圈候选。 */
export const VIDEO_EXT = /\.(mkv|mp4|ts|avi|mov|m4v|wmv|flv|webm|iso)$/i

/** 左侧覆盖:未配的分 ambiguous(有像样候选没敢配)/ missing(压根没信号);缺档号只取仍未配的。
 *  右侧覆盖:规范名去水印重复;某规范名下任一文件被用上即算 matched,否则 orphan。 */
export function computeCoverage(left: SpecLeft[], right: SpecRight[], ctx: StageCtx): CoverageReport {
  let ambiguous = 0, missing = 0
  const missingEpisodes: number[] = []
  for (const l of left) {
    if (ctx.assignments.has(l.leftKey)) continue
    if (ctx.ambiguous.has(l.leftKey)) ambiguous++
    else missing++
    const n = ctx.missingByKey.get(l.leftKey); if (n != null) missingEpisodes.push(n)
  }

  const canonRep = new Map<string, string>()
  for (const r of right) { const c = canonName(r.name); if (!canonRep.has(c)) canonRep.set(c, r.name) }
  const usedCanon = new Set([...ctx.usedRight].map(canonName))
  const orphanFiles = [...canonRep].filter(([c]) => !usedCanon.has(c)).map(([, name]) => name)

  return {
    left: { total: left.length, matched: ctx.assignments.size, ambiguous, missing },
    right: { total: canonRep.size, matched: usedCanon.size, orphan: orphanFiles.length },
    missingEpisodes: missingEpisodes.sort((a, b) => a - b),
    orphanFiles,
  }
}

/**
 * 从绑定的 MatchSpec 抽认集规则（共享认集层的取数口）：titleStrip = 各 stage 去重保序的并集，
 * epNumRegex = epnum stage 的（缺省用 DEFAULT）。归档器经 bindingId 借它当分组键的规则。
 * 放这里不放 identity.ts：后者保持零依赖，不回环 import。
 *
 * **别理解成"绑定上改一条剥离规则两个消费者同时受益"**——`ReconcileService.identityFor` 是
 * **逐字段替换**（`show.identity?.titleStrip ?? 这里抽出来的`），某 show 配了覆盖，本函数抽出的
 * 那一档就整条不生效。怡乐两个字段都覆盖了，绑定侧改 titleStrip 到不了它。替换而非并集是有意的：
 * 并集会把绑定的 `_\d{10}`/`^瓜瓜乐` 卷进分组键，漂掉 decisions 表存的豁免。详见 docs/MATCHING.md。
 */
export function identityRulesFromSpec(spec: MatchSpec | undefined): IdentityRules {
  // 用 declaredStages 而不是 specStages：隐式补进来的时长档带着 titleStrip，并进这份规则会改变
  // 归档器的分组 key，而 decisions 表的人工豁免正是按那个 key 存的——key 一漂
  // 豁免就失联（见 docs/MATCHING.md「decisions key 会跟着认集规则漂」）。显式声明的时长档同样
  // 跳过：它的 titleStrip 只服务二次确认的相似度，不是"认文件名"的规则。
  const stages = declaredStages(spec ?? DEFAULT_MATCH_SPEC)
  const titleStrip: string[] = []
  for (const st of stages) {
    if (st.by === 'solo' || st.by === 'duration') continue
    for (const re of st.titleStrip) if (!titleStrip.includes(re)) titleStrip.push(re)
  }
  const ep = stages.find((s): s is Extract<MatchStage, { by: 'epnum' }> => s.by === 'epnum')
  return { titleStrip, epNumRegex: ep?.epNumRegex ?? DEFAULT_EPNUM_REGEX }
}
