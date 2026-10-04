/**
 * 归档器的判定（spec 2026-07-30-duplicate-episode-decision-design §3）：纯函数，现状进、动作清单
 * 和运行账本行出，不做任何 I/O。
 *
 * **只有一个匹配脑。** 用户拍板的四步模型（同 spec §0）里，"匹配到付费的进付费、不匹配的进下架"
 * 那个"匹配"就是绑定匹配器（证据图引擎 `match-engine/`：时长主锚 + `DURATION_MIN_SIM` 名字地板
 * + 阈值体系）。归档器**不许有自己的判定逻辑**，它只消费匹配器的结论，把文件搬到结论指定的
 * 货架（P7）。这一条不是洁癖：曾经四套判据各自局部合理、彼此说法不一致，是 2026-07-30 一天内
 * 反复翻案的结构性根源。要改判定，去 `match-engine/rules.ts`，别在这里加分支。
 *
 * **残差也是判决给的**（spec §3.3 / I2）：哪些文件"清单里真的没有它"由裁决层的 `residual` 说，
 * 归档器不许自己推。过去这里靠"没被认领、又不在歧义里"反推，那条推断把"匹配器见过又丢弃"
 * 误当"节目单上没有"——05 案就是被它静默搬去下架的。
 *
 * 一轮的形状：
 * ```
 * 豁免/墓碑 → 半截文件 → 字节全等重复 → 跑一次匹配器 → 四个筐 → 占位护栏(同名/同集) → 熔断
 * ```
 * **整理只有一个目标：把来源文件夹的内容归位进库。** 一个文件只有四条出路，每条都有结论——
 * 机器不摊手问"这是什么"，只在"删/换"这一步等人点头（每个进入本轮的文件恰好落进一个筐，
 * 账本据此自证守恒）：
 *  - `claimed`  对应到清单某集、**该集还没有认领音频** → 唯一候选，直接认领搬入（`sole-candidate:`）；
 *               匹配器以 auto 置信配下的同样在这个筐（`authority:`）。
 *               **例外一条（付费货架契约）**：认领到的那一集 `needsSupply === false`（源站自己
 *               放得出）→ 网盘这份是冗余，不搬、直接删（`redundant-free:`，见 `redundant`）
 *  - `copy`     对应到某集、**该集已有认领音频** → 唯一议题是"替换"：副本更差 → `delete-loser`；
 *               更优 → `replace`（删旧正主 + 新的搬进目标目录）。两者都是确认档动作。
 *               质量分不出高下（平手/比不出）时方向由**节目单**裁，不按谁先被认领（见 `settleCopy`
 *               里的 `settleUndecided` 判据阶梯）——先后只是遍历顺序
 *  - `offline`  没能落到任何一集头上 → 第二货架；搬进去前先对第二货架
 *               做同集择优（差/平 → 删这份、更优 → 替换架上那份、比不出 → pending）。
 *               **没有第二货架的绑定**（影视：没有"下架"这个概念）→ 判定照记，动作为空、原地不动。
 *               **这个筐里还有一种不搬的**：证据指向好几个集、没有规则敢裁（裁决层 I3）→
 *               `evidence-conflict` 出卡等人，本轮不搬不删（判定记 offline，处置为空）。
 *               **也有一种既不搬也不问的**：证据指着的那几集**全都不需要网盘供货**（源站自己放得出）
 *               → 直接删（`redundant-free-candidates:`，见 `redundantCandidates`）——是哪一集不必答，
 *               答案不改变动作。**零候选（清单里真的没有它）不走这条，照旧上第二货架**
 *  - `hold`     时长未知（没探到/预算外）→ 下轮续探。它是**状态不是问题**，不要求用户做什么。
 *               **还在长的那种也归这里**（`size-suspect`：不足 `MIN_MEDIA_BYTES`、或来源申报还在写）
 *               ——它**必须跑在字节全等签名之前**：两份都还在写的半截文件签名一模一样，进了那一档
 *               会被判成"同一份"删掉一份，而 `delete-dup` 是全流程唯一不经人眼的动作
 *
 * **对应到某集但证据自相矛盾**（两边时长都已知且差出容差）→ 不算对应，落回 `offline`：空槽位
 * 时机器要自己把文件搬进货架，矛盾的证据不足以支撑这一步。该集已有正主时不查这一条——名字指向
 * 清单里某一集的文件是那一集的副本/另一版（多几秒尾巴、重剪），扔第二货架会变成和 feed 撞名的
 * 独立集（违反 L3「默认不重复」），议题只能是替换。
 *
 * **时长命中要过名字地板**（`nameBacked`，与匹配器同一把尺）：撞进容差只是必要条件，名字还得沾
 * 一点边才算"对应到这一集"。命中全被地板挡下、名字这一侧又指不出别的集时，判定记 `offline`
 * （没落到任何一集头上），**但动作是 pending（`duration-collision`）不是搬去下架**：它可能是那
 * 一集的另一版（活体 37/756：时长 0 秒差、码率高一倍），也可能只是撞了车的另一期节目，机器分不出
 * 就把两份并排摆出来让人裁。**这个问句必须带出口**（`notEpisode`）：答"不是这一集"记进决定账本后，
 * 下一轮它按"清单里没有它"走第二货架——否则占着位的那份永远不腾，等位的那份永远落不了位（死锁）。
 *
 * **原地模式**：`sourceFiles` 为空（不配暂存区）就是影视那档退化配置——没有搬运，只有"同一集攒了
 * 多份、留最高质量那份"。同一条管线，不是第二套实现。
 *
 * **子节目路由只选目的地，不豁免匹配。** numPattern 只回答"认领成立时该放哪个文件夹"，不回答"这
 * 是不是那一集"——后者只有匹配器能答（同上 P7）。首版把它做成"命中即免检的 pre-pass"，活体当场
 * 打脸：玄关笔记目录里三份 104 分钟的错身文件（名字叫 `05/20/37`、时长与节目单差 2.6–3 倍）被按
 * 名字认领、原地不动，正确那三份 `swap-hold` 等一个永远不腾空的位置 = 死锁。现在错身那份走匹配
 * 脑：时长谁都不沾的判 `offline` 出库，位置同轮腾出、下轮落位；时长撞上别的集、名字又过不了地板
 * 的出 `duration-collision` 等人裁——那一份的位置要等人点头才腾，机器不替他猜。
 */
import type { EpisodeIdentity } from '../identity.ts'
import { compareQuality, DURATION_TOLERANCE_S, type SpecAmbiguity, type SpecLeft, type SpecRight } from '../match-spec.ts'
import { fileAsksOf, matchByEvidenceResult, type EvidenceMatchResult } from '../match-engine/adapt.ts'
import { candidateWeight } from '../match-engine/resolve.ts'
import { isNonLiveVeto } from '../match-engine/live-candidate.ts'
import { explainsOf, type RowExplain } from '../match-engine/explain.ts'
import type { Ask, Fact } from '../match-engine/types.ts'
import type { MatchSpec } from '../types.ts'
import type { ShelfTraits } from '../shelf.ts'
import type { DecisionOrigin, LedgerRow, LedgerVerdict, RunCounts } from './ledger.ts'
// 一张卡的文案里最多点名几个集——前端拼「冗余」那句用的是同一份，别在这儿另写一个数。
import { MAX_CARD_EPISODES } from '../../../shared/reconcile/card-limits.ts'

/**
 * 比它小的"媒体文件"当未知：转存中 / 上传中的半截文件 size 是 0 或一小截，进字节全等签名会把
 * 两份半截判成"同一份"删一份（spec 2026-09-03 §2.4）。`hold` 是状态不是问题，长全了下轮自然进池。
 */
export const MIN_MEDIA_BYTES = 1024 * 1024

/**
 * 「这份还在长，别拿它当一份完整文件」。**判据只有一份，两个地方吃**（别再内联写一次 `size <`）：
 *  · 主池入口 —— 半截文件判 `hold`/`size-suspect`，进不了字节全等签名；
 *  · 第二货架的签名表 —— 半截文件不许当"留下的那一份"。
 * 少了后面那一处，一份 0 字节的下架文件就能把来源里同名同 size 的那份判成重复删掉，而
 * `delete-dup` 是全流程唯一不经人眼的动作。
 */
export const isSizeSuspect = (f: RFile): boolean => !!f.inProgress || f.size < MIN_MEDIA_BYTES

export interface RFile {
  path: string
  name: string
  size: number
  /** 秒。undefined = 没探到（凭证/网络失败/预算外）——**必须当未知**，只能进 `hold`，永不进 `offline`。 */
  durationS?: number
  /** 来源申报"这份还在写"（`ShelfTraits.reportsInProgress` 的来源才会带）。带了就当未知，同 size 不足。 */
  inProgress?: true
}

/**
 * 权威（源站）清单的一条。`durationS` 是认集主锚，`leftKey` 让匹配器的结构化档（`season-episode`
 * 那类从 leftKey 取季集号的）拿到和绑定同步时一样的信号——缺省退化成用标题当键。
 *
 * `paid` **谁都不读**：判定层不读（读了就是第二个脑），处置层也不读。它活着只为解释原因——
 * 账本、证据卡、`authorityStats` 上那句「源站要钱」。语义真相源见 `sync.ts` 的 `LeftEntry.paid`。
 *
 * 处置层唯一读的那一位是 `needsSupply`（见下）。**别把它当 `paid` 的取反**：`paid` 答的是
 * 「要不要钱」，`needsSupply` 答的是「源站自己放不放得出」，两件事。
 */
export interface AuthorityEntry {
  leftKey?: string
  title: string
  durationS?: number
  paid?: boolean
  /**
   * **这一集要不要人往网盘供货**——处置层（认领结论已由匹配器给定之后）唯一读的那一位：
   *  · `true`  源站自己放不出 → 网盘那份可能是唯一可播来源，**不许自动删**。
   *  · `false` 源站自己就能放 → 这份文件是冗余，直接删（`delete-redundant`，付费货架契约）。
   *  · **缺席 → 按 `true` 办**（保守档）。删不可逆、留着只占空间，判据拿不准必须倒向留着。
   *    tmdb 影视那支（清单来自分集索引，网盘就是唯一来源）天然落在这里，不需要任何特判。
   *
   * 判据由清单那一侧算好（`left-from-stream.ts` 的 `hasPlayableMedia`：这一集自己带没带一个
   * 可播地址），归档器只消费结论——**这里绝不许再算一次**。
   */
  needsSupply?: boolean
  /** 人工订正钉死的那份文件（**绝对路径**——归档器这一侧的 `right[].name` 就是绝对路径，
   *  装配层负责把绑定里存的相对子路径拼上货架地址，见 `reconcile/service.ts`）。 */
  pinnedRight?: string
}

export interface PlanInput {
  authority: (string | AuthorityEntry)[]
  sourceFiles: RFile[]
  /** 认领货架（= 绑定的落地目录）现有文件——**整体进匹配池**：库内那份是不是这一集，也只能由
   *  那一个匹配脑说（L1）。 */
  libClaimedFiles: RFile[]
  /** 第二货架现有文件——**不进主匹配池**。它的契约就是"不配对、文件自己就是一集"（spec §2），
   *  拉进主池配对等于否掉那个契约。在主池里它只用来判字节全等重复 + 占位（别往它头上搬同名文件）。
   *  另外每轮由 `reviewSecondary` **单独跑一次**匹配做货架卫生（回流/清理），那一趟的结论
   *  只作用于货架自己、绝不写回主池的认领。 */
  libSecondaryFiles?: RFile[]
  /** 独立子节目（独立编号体系 + 独立文件夹）。**只选目的地，不豁免匹配**：`numPattern` 命中只是
   *  把 `claimed` 的落点从 `dirs.claimed` 换成 `dir`，认领本身照样由匹配器裁（L1/P7）。 */
  subShows: { name: string; dir: string; numPattern: RegExp }[]
  /** `claimed` = 绑定的落地目录（通用必有）。`secondary` = 播客的「下架」货架；影视没有这个概念，
   *  缺省时"认不出"的文件原地不动（永不删，spec §3 闸门三）。 */
  dirs: { claimed: string; secondary?: string }
  verdictFor: (key: string) => 'exempt' | 'tombstone' | null
  /**
   * 人已经裁过的「这**份**文件不是那一集」（`decisions` 表，按 集 + 文件路径 的组合存）。
   * 返回 true = 这条 `duration-collision` 已经有答案：不再问第二遍，按"清单里没有它"走第二货架
   * （**下一轮**才产出搬运动作——写决定不动文件，预览→确认→执行这条链不破）。
   * 缺省 = 谁都没裁过。
   */
  notEpisode?: (leftKey: string, path: string) => boolean
  /**
   * 人已经裁过的「这份文件**就是**那一集」→ 该集被钉死的那个绝对路径（问句的另一半答案）。
   * **按 leftKey 现问，不由调用方预先拼进 `authority`**：leftKey 是这里从 `authority` 推出来的
   * （缺省用标题、撞了加序号），调用方自己复刻一遍那套推导迟早会漂。
   */
  pinnedFor?: (leftKey: string) => string | undefined
  /**
   * 人已经裁过的「这两份留哪一份」（第二货架同集比不出高下那一档）→ 留下的那个绝对路径。
   * **只在机器比不出（`compareQuality` 判 unknown）时才问它**：人裁是补机器判不了的那一格，
   * 不是用来推翻实测证据的——比得出高下还去看人裁，等于给了一条静默改写择优结果的路。
   * 缺省 = 谁都没裁过，照旧出问句卡。
   */
  preferredOf?: (a: string, b: string) => string | undefined
  /** 目录前缀按优先级降序（上游原始命名 > 改造过的目录）——只用在"字节全等留哪份"上。 */
  sourcePriority?: string[]
  /** 共享认集函数（来自绑定 MatchSpec + show 级覆盖）。**只做分组键**：人工豁免按它存、字节全等
   *  重复按它判"是不是同一集"。认哪一集是匹配器的事，不是它的事。 */
  identity: (name: string) => EpisodeIdentity
  /** 绑定实际生效的那份谱（`sync.ts` `resolveSpec`）——归档器与绑定同步必须同一份，否则又是两个脑。 */
  matchSpec: MatchSpec
  /** 来源目录清单——suspect-dir 熔断按目录归组用。缺省 = 不熔断。 */
  sourceDirs?: string[]
  /**
   * 货架自述（spec 2026-09-03 §3.1）。**规划器只读这张表，不认来源类型**：换一种货架（本地目录）
   * 只需换表，这里一行不改。
   *
   * **必填，没有缺省。** 写成可选、缺席时落回 `OPENLIST_TRAITS` 看着更宽容，实际是把一条断掉的
   * 接线（装配层忘了传）伪装成"这是个 OpenList"——两种情形长得一模一样，没有任何测试会红。
   * 缺了它现在是编译期报错，响亮、当场。
   */
  shelf: ShelfTraits
  /**
   * 多季影视模式（spec 2026-09-03-tv-season-archive）：**只对 tmdb 剧集绑定为 true**。开着时
   * 三条规则换掉：认领落点 `<claimed>/S<nn>`、认领文件加 `SxxExx - ` 前缀、「同一集」按 leftKey
   * （不按名字身份）判。缺席 = 播客/电影那条路，一字不变。
   *
   * 为什么「同一集」必须换判据：一部剧里 S02E07 和 S03E07 的文件常常都叫「第7期.mkv」，名字身份
   * 一模一样。按名字判同集，两季各一份就会被判成"同一集的两份"——落点撞成 swap-hold、择优出
   * `delete-loser`，删掉的是另一季那一集**唯一**的文件。leftKey 是匹配器给的结论，它分得开。
   */
  seasonFolders?: true
  /**
   * 主匹配池的裁决器（Task 8）。**缺席 = `matchByEvidenceResult(matchSpec, …)`**，与过去一模一样。
   *
   * 为什么要有这个口：多季绑定的匹配必须**按季分区**跑（`season-resolve.ts`），而分区前那一步
   * 「这个文件夹属于哪一季」要问 LLM、是异步的，规划器却是同步的。所以由服务层先把季归属问好、
   * 把绑好的 `matchBySeasonResolved` 传进来。谱仍然只有一份（`matchSpec`），换的只是「怎么分批
   * 喂给同一个脑」——不是第二个脑。
   *
   * `reviewSecondary`（第二货架的货架卫生）那一趟**不吃它**：那是播客才有的第二货架，没有季这
   * 回事，而且它的结论只作用于货架自己、不写回主池。
   */
  match?: (left: SpecLeft[], right: SpecRight[]) => EvidenceMatchResult
  /**
   * 季归属判不出来的那些目录（**绝对路径**，由服务层从解析器答案里的 `null` 项填）。
   *
   * 这些目录里的文件**整段不参与匹配**（`matchBySeasonResolved` 里 `season == null` 那一 continue），
   * 所以它们不是"清单里没有它"，是**没被判过**——账本要给它们自己一行（`season-unresolved:<dir>`），
   * 而不是掉进 `unhandled:` 那条"某个终态漏接了"的兜底：那句话会把一次正常的保守处置读成缺陷，
   * 下一个人照着它去查一个根本不存在的漏接。
   *
   * 只在多季影视档有值（`seasonFolders` 同时为真）；缺席 = 没有这回事，一行代码都不生效。
   */
  unresolvedSeasonDirs?: Set<string>
  /**
   * 每个目录（**绝对路径**）属于哪一季——服务层问出来的那张表原样传下来
   * （`seasonPartitionedMatch` 里的 `seasonOfFolderAbs`，`null` = 判不出）。
   *
   * 唯一的消费者是**纯享货架的落点**（`<claimed>/纯享/S<nn>`）：那些文件按定义不属于任何一集，
   * 拿不到 leftKey，季号只能从它此刻待着的文件夹来。判不出（`null`/缺席）就不搬——猜一个季号
   * 把文件搬进错误的季里比留在原地坏得多，而且它已经有自己那一行（`season-unresolved`）。
   *
   * **别拿它去改任何认领判定**：认哪一集只有匹配器能答（P7），分区那一步早已在 `match` 里
   * 吃过同一张表了。
   */
  seasonOfDir?: Map<string, number | null>
}

/** 「这个文件夹判不出属于哪一季」那一行的 basis 前缀。**具名、只此一份**：规划器写它、
 *  suspect-dir 熔断按它排除、账本读它，三处对不上就是各说各的。 */
export const SEASON_UNRESOLVED_BASIS = 'season-unresolved:'

/**
 * 待定的种类——给 UI 分组和措辞用，**机器可读**，前端绝不解析中文理由字符串。
 *  - `replace`       第二货架上已有同集身份的一份，两份比不出高下 → 并排给人看（带 `compare`）。
 *                    认领货架那一侧比不出高下不会到这里：它有正主，直接出 `replace` 动作
 *  - `no-duration`   时长没探到 → 下轮续探（状态，不是问句）
 *  - `swap-hold`     目标目录已有同名文件 → 本轮不搬，等它腾空，下轮自然落位
 *  - `suspect-dir`   目录级熔断——该目录大多数文件认不出属于本节目，疑似认领错了目录
 *  - `duration-collision` 时长撞上某一集、名字过不了地板 → 并排给人看（带 `compare`）。
 *                    与 `replace` 分开是因为问句不同：那个问的是"这两份留哪个"（已经确定同一集），
 *                    这个问的是"这到底是不是那一集"——措辞、证据、可选的答案都不一样。
 *                    答"不是"有出口：`notEpisode` 记一笔，下一轮它按"清单里没有它"走第二货架
 *  - `evidence-conflict` **证据指向好几集，没有一条规则敢裁**（裁决层的 I3，spec §3.2）。
 *                    与 `duration-collision` 的区别是**争的是几集，不是一集**：那个问"它是不是
 *                    这一集"，这个连"该问哪一集"都还没定——名字指 A、时长指 B 时挑一个就是抓阄。
 *                    它取代的是过去那条**静默通道**：证据摆在那儿、没人认领，就当"清单里没有它"
 *                    搬去下架（05 案）。默认值是问人，不是挑一个，更不是当没看见。
 *  - `season-unresolved` 这份文件所在的文件夹判不出属于哪一季 → 它**整段没进过匹配器**。
 *                    状态，不是问句（同 `no-duration`），但**出路只有人**：给文件夹起个带季号的
 *                    名字，或者把文件挪进 `S<nn>/`。为什么必须是一条 `pending` 而不是 `action: null`：
 *                    没有动作的行进不了任何一条 `plan`、也不进任何一格计数——用户面前它就是
 *                    凭空消失的一批文件，而"整理完了、什么都没剩下"和"这一批我压根没看"长得一样。
 */
export type PendingKind = 'replace' | 'no-duration' | 'swap-hold' | 'suspect-dir' | 'duration-collision' | 'evidence-conflict' | 'season-unresolved'

/**
 * 「这几份留哪个」的并排对照数据。**机器可读**：前端据此渲染并排对比，绝不解析中文 `reason`。
 *
 * 为什么必须有它：过去 pending 只带来源那个文件，冲突的另一份连路径都没进返回值（只有字节数被塞
 * 在 reason 文本里），用户只能去网盘一个个文件夹翻——那个问句实际上无法回答。三个数各管一件事：
 * 时长判"是不是这一集"、码率（`size×8÷时长`，前端纯算）判"音质谁好"、路径判"这是哪一份"。
 */
export interface CompareInfo {
  /** 节目单说这一集多长。缺席 = 裁判不在场，UI 只并排列数据、不标对错。 */
  authorityDurationS?: number
  candidates: { path: string; size: number; durationS?: number; inLib: boolean }[]
}

/**
 * 一条动作。**每一条都带 `origin`**（见 `DecisionOrigin`）——它由产出这条判定的那个分支标上，
 * 由 `decide()` 统一盖到动作上，所以账本行与动作的来路永远是同一个值，不会两侧各说各的。
 *
 * 类型上写成"union 交一个 `origin`"而不是逐个变体各加一行：来路与 `kind` 正交，
 * 每一种动作都可能来自两侧中的任意一侧（同一个 `move` 可能是某一集认领了它，也可能是没人要它、
 * 搬去下架），摊到七个变体里只会让人误以为它和某种 kind 绑定。
 */
export type PlanAction = (
  /** `episode`：认领了哪一集（claimed 的 move 才有）。给 UI 自解释用——"移入付费"不带"凭什么"，
   *  用户无从核对；带上集名，一眼能对"这文件是不是那一集"。 */
  /**
   * `evicts`：**这条搬运要落的位置，本轮才被另一条动作腾出来**（换槽位）——那份文件的完整路径。
   *
   * 有它就意味着这条 move 有前置条件，执行器据此保证两件事：删排在搬前面（`executePlan` 的
   * 阶段顺序），以及**前置那一步没真做成时这条搬运不许跑**（删失败、或确认档在定时轮被跳过）。
   * 少了后半条，搬进去必然撞名 403——那正是过去把它压成 `swap-hold` 等下一轮的原因。
   */
  | { kind: 'move'; src: RFile; dstDir: string; basis: string; episode?: string; evicts?: string
      /** 搬进去时顺手改成这个名字（**只加 `SxxExx - ` 编号前缀**，spec 2026-09-03-tv-season-archive §3.2）。
       *  执行器先在源目录改名再搬——改名失败就按旧名照搬，错误行记下，下一轮以 `rename` 动作再试。 */
      newName?: string }
  /** 原地加编号前缀（已经在季文件夹里、但名字还没带 `SxxExx - `）。`newName` 是完整新文件名。
   *  与 `move` 分开是因为它**不挪窝**：混进 move 的计数里，"搬了几份"就把原地改名的也算了进去。 */
  | { kind: 'rename'; src: RFile; newName: string; basis: string; episode?: string }
  /** `compare` 带的是**这两份**（删的 + 留的）的并排数据。删除行要说清"删这份（多长、什么码率）、
   *  留那份（多长、什么码率）"，而留下那份只有路径时前端算不出码率、也说不出时长——机器可读字段
   *  不够表达，就把字段补齐在这里，别让前端去猜。
   *  `episode`：这两份说的是哪一集。删除行的抬头靠它——"删一个叫 X 的文件"答不了"这是哪一集的
   *  第几份"，用户对着确认按钮点不下去。取不到（清单里没有这个名字）就不带，前端退化成动作标签。 */
  | { kind: 'delete-dup'; src: RFile; dupOf: string; basis: string; episode?: string; compare?: CompareInfo }
  /** 同一集的落选副本（质量比得出、这份不更优）→ 删（P6）。`keptPath` = 留下的那份，UI 的
   *  "将删清单"据此说清"删这份、留那份"，账本据此可复盘。`episode` 同上（同集副本这一路一定有，
   *  第二货架择优那一路没有——那份文件按定义就不在清单里）。 */
  | { kind: 'delete-loser'; src: RFile; keptPath: string; basis: string; episode?: string; compare?: CompareInfo }
  /**
   * 源站自己放得出的那一集，它的网盘副本 → 删（付费货架契约，2026-08-01 拍板）。**没有
   * `keptPath`**：留下的那份不是另一个文件，是**源站自己**——网盘这份没有存在价值。
   *
   * 与另外两种删的区别只在"凭什么"：`delete-dup` 凭字节全等、`delete-loser` 凭同集比质量，
   * 这一条凭的是**那一集源站自己能播**（`AuthorityEntry.needsSupply === false`）。
   * **不进确认档**（`execute.ts` 的 `losers:false` 也照删）：转存成本极低、夸克回收站兜底，
   * 攒成一屏要人逐条点头反而没人看。这一位缺席（影视，以及任何答不上来的清单）一律不走这条路。
   */
  /**
   * `candidateEpisodes`：**没人认领那一半专属**（`redundant-free-candidates:`）——`basis` 里那串
   * leftKey 各自对应的**集名**，逐位对齐。`basis` 是机器可读的键，摆在卡片上没人读得懂，而这一条
   * 恰恰是"凭什么删"的全部依据：删它是因为**那几集源站自己都放得出**，卡片不说出那几集是谁，
   * 用户手里就只剩一个文件名（活体 2026-08-02：卡上只有 `37.申与酉`，用户据此以为付费判断错了）。
   *
   * **它是候选，不是结论**——一份文件同时撞上三集时机器并不知道是哪一集，只知道"不论哪一集都该删"。
   * 前端据此措辞（多个就得列全、不许暗示已经定了是哪一集），所以这里**必须原样带全**、不截断。
   * 认领成立那一条（`redundant-free:<leftKey>`）不带它：那条有确定的 `episode`。
   */
  /**
   * `noTrash`：这份货架**删不可撤**（`ShelfTraits.hasTrash === false`）。这一条平时不进确认档
   * （见上），而"不进确认档"的底气正是回收站兜底——底气没了就得跟着降：执行面看见这一位就把它
   * 按落选副本对待（`losers:false` 的定时轮跳过、计入 pending）。**缺席表示有回收站**，
   * 别写 `false`：这一位是"额外的约束"，不是三态。
   */
  | { kind: 'delete-redundant'; src: RFile; basis: string; episode?: string; candidateEpisodes?: string[]; noTrash?: true }
  /**
   * 换正主：删掉 `oldPath` 那份、把 `src` 搬进 `dstDir`（`src` 已经在 `dstDir` 里就只删旧的）。
   * 同集副本**更优或比不出**时出的建议——机器给到这一步为止，**和 `delete-loser` 同属确认档**：
   * 定时轮（`losers:false`）跳过它、计入 pending，只有用户在预览里确认后的显式 execute 才真动手。
   * `compare` 必带：并排两份的时长/体量/路径（外加节目单时长），那个确认按钮才按得下去。
   */
  /** `newName`：与 `move` 同义（只加编号前缀）——新正主搬进季文件夹时也得带上前缀，
   *  否则换完版名字反而退回没前缀那一档，下一轮又要再改一次名。 */
  | { kind: 'replace'; src: RFile; oldPath: string; dstDir: string; basis: string; episode?: string; compare?: CompareInfo; newName?: string }
  /** `collidesWith`：`duration-collision` 专属——撞上的是哪一集（`leftKey`，机器可读）。人裁的
   *  结论按「这一集 + 这份文件」存，前端把它连同 `src.path` 原样回传给 decisions 端点即可，
   *  **不许自己拼那个组合键**（同 `key` 那条：键的构造只有后端一处）。
   *  `episode`：这张卡问的是**哪一集**——`duration-collision` 填撞上的那一集（**不是这份文件自称的
   *  那一集**：它的名字恰恰是不可信的那一侧），第二货架比不出高下的那类填这几份共同的那一集。
   *  `swap-hold` 填**认领了这份文件的那一集**（走到等位的前提就是认领已经成立）——那张卡的主角
   *  仍是等着的这份文件，集名退成定语，说清"腾的是哪一集的位置"。没有任何一集认领的那些
   *  （残差下架撞上占位）照旧缺席：绝不拿文件名冒充集名。
   *  要人回答的待定卡片拿它当标题；缺席时前端退化成作品名，绝不拿文件名冒充集名。
   *  `conflictsWith`：`evidence-conflict` 专属——**全部**相争的那几集（`leftKey`，按证据分量降序）。
   *  它是那张卡的出口参数：「都不是这一集」把每一对（集 + 这份文件）各记一笔 not-episode，
   *  下一轮这份文件按"清单里没有它"走下架、位置腾出。**必须是全量**，少一个下一轮卡片就还在。
   *  与 `collidesWith` 并存而不是替换它：单集问句只有一个答案对象，两者的问法本就不同。 */
  /** `blockedBy`：`swap-hold` 专属——**占着那个位置的那份文件的完整路径**。
   *
   *  为什么是路径而不是 `reason` 里那个文件名：UI 要拿它去和**本轮其他动作**对上号，
   *  把「删掉这份 → 等位那份随即搬入」这句因果说出来（以前这层关系只存在于代码里，
   *  界面上三块各摆各的，用户读不出第一块和第三块之间有关系）。同名文件可以躺在不同目录里，
   *  名字对名字必然错配——只有完整路径是文件的唯一身份。 */
  /** `suspect`：`suspect-dir` 专属——**熔断这一整个目录的那条目录级判断**，逐字段摆开。
   *
   *  为什么不让消费方去 `reason` 里正则抠：这条判断是**目录级的**（"这个目录里 349/491 认不出"），
   *  熔断却把它复制到该目录下每一条动作上。491 条 pending 里 490 条的 `reason` 前半句一字不差，
   *  agent 面的回执因此有 60% 是同一句话的副本（实测 137KB/491 条）。有了这三个字段，回执可以
   *  按 `dir` 归成一组、公共那半句只出现一次，逐条只留 `priorVerdict`。前端仍读 `reason`，不变。 */
  | { kind: 'pending'; src: RFile; reason: string; pendingKind: PendingKind; compare?: CompareInfo; collidesWith?: string; conflictsWith?: string[]; episode?: string; blockedBy?: string; suspect?: { dir: string; bad: number; total: number; priorVerdict: string } }
) & {
  /** 这条建议**是从哪一侧推出来的**。构造时不必填——`decide()` 从判定那一侧盖过来（唯一来源）。 */
  origin?: DecisionOrigin
}

export interface PlanOutcome {
  actions: PlanAction[]
  /**
   * 匹配器判不出的那些（`SpecAmbiguity`，含在场候选与差在哪道门槛）。**本轮不消费它，只记账**——
   * 归档器现在还在用自己那两个入口把其中一部分认下来（`sole-candidate:`/`identity-hit:`），
   * 拆掉它们之前先把这批数据摆出来量一轮：有多少条、什么形态、拆了会牵动谁。
   * 量法与去向见 `docs/TODO.md`「匹配收敛」第二段。
   */
  ambiguities: SpecAmbiguity[]
  /** 每个进入本轮的文件恰好一行（含无动作的）——账本的原料，见 ledger.ts。 */
  rows: LedgerRow[]
  counts: RunCounts
  /** `input === 各筐之和`。代码里算，不等就原样返回 false（账本自己报账不平）。 */
  conservation: boolean
  authority: AuthorityStats
  /** 下架货架复核的结果（见 `reviewSecondary`）。**独立小节，不并进 `rows`/`counts`**——
   *  那两样的守恒律说的是"进本轮主池的文件"，下架文件不在池里，塞进去就把恒等式弄破了。 */
  secondaryReview: SecondaryReview
}

/** 节目单这一侧的四个数：清单多长、其中几集要钱、几集带得出时长、几集要网盘供货。 */
export interface AuthorityStats {
  entries: number
  paid: number
  withDuration: number
  /**
   * 「源站列着、但自己放不出来」的集数（`LeftEntry.needsSupply`，判据见 `left-from-stream.ts`
   * 的 `hasPlayableMedia`）。它是**整理这件事成不成立**的唯一判据：>0 才有东西要从网盘配上去，
   * =0 说明源站每一集都能放，网盘目录该当新节目源挂上来而不是拿去配对。
   * `paid` 回答不了这个问题——没人说要钱 ≠ 源站放得出（app 独占集就是免费且放不出）。
   */
  needsSupply: number
}

/**
 * 账本里"权威清单长什么样"那一小节的**唯一算法**。账本（`PlanOutcome.authority`）与只读的
 * 权威查询端点（`ReconcileService.authority`）共用它——两份口径就是两个真相源，会各自漂。
 * 只读 `paid`/`durationS`/`needsSupply`，所以 `AuthorityEntry` 与 `LeftEntry` 都喂得进来。
 */
export function authorityStats(
  entries: readonly { paid?: boolean; durationS?: number; needsSupply?: boolean }[],
): AuthorityStats {
  return {
    entries: entries.length,
    paid: entries.filter((e) => e.paid).length,
    withDuration: entries.filter((e) => e.durationS != null).length,
    needsSupply: entries.filter((e) => e.needsSupply).length,
  }
}

/**
 * 下架货架复核的账。**只记产生了动作的那些**（`rows`），没命中的不记——下架货架的默认状态就是
 * "待着"，一份一行会把账本淹掉，而"复核跑过、什么都没动"这条信息由 `checked` 说清。
 */
export interface SecondaryReview {
  /** 本轮回头看了几份下架文件（= 货架上的文件总数）。0 = 这条绑定没有第二货架。 */
  checked: number
  rows: LedgerRow[]
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** 这份文件所在的文件夹判不出季吗（= 它压根没进过匹配器）。**具名、只此一份**：主循环按它
 *  出账本行、suspect-dir 熔断按它把这些文件排除在分子分母之外，两处必须是同一句判据。 */
const isSeasonUnresolved = (input: PlanInput, path: string): boolean =>
  input.unresolvedSeasonDirs?.has(dirOf(path)) ?? false

/**
 * 文件名自带的季集号。**与 `DEFAULT_SEASON_EPISODE_REGEX`（`match-spec.ts`）逐字同形**——
 * 匹配器按它从名字抠出结构键、归档器按它判"名字已经带过前缀了吗"，两处问的是同一件事。
 * 这里不 import 那个常量是因为那边是**给用户改的谱字段**（一条绑定可以换成自己的正则），
 * 而"我们写进文件名的前缀长什么样"是本模块自己的格式约定，不随谱走。
 */
const SE_RE = /[Ss](\d{1,2})[Ee](\d{1,3})/

/** leftKey `tmdb:<id>:S03E14` → `{ season: 3, episode: 14 }`；不是这个形状 → null。 */
export function seasonEpisodeOfKey(leftKey: string): { season: number; episode: number } | null {
  const m = /:S(\d+)E(\d+)$/.exec(leftKey)
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null
}
/** 季文件夹名，两位补零（`S01`/`S12`）。 */
export const seasonDirName = (season: number) => `S${String(season).padStart(2, '0')}`
/** 文件名前缀里那串编号，逐字 `S03E14`（集号 ≥100 时自然是三位）。 */
export const episodePrefix = (se: { season: number; episode: number }) =>
  `S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')}`
/** 归档器自己刻的前缀形状（`episodePrefix` + ` - `），只认这一种；分享者写在名字里的 `S01E02.` 之类不算。 */
export const ARCHIVER_PREFIX_RE = /^S\d{2,3}E\d{2,4} - /
/** 文件名自带的季集号（第一个命中）。 */
export function seasonEpisodeOfName(name: string): { season: number; episode: number } | null {
  const m = SE_RE.exec(name)
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null
}

/**
 * 「纯享」剪辑的货架名（认领货架根下的一层，季模式专属）：`<claimed>/纯享/S<nn>/`。
 *
 * **具名、只此一份**：规划器按它定落点、`counts` 按它把这些搬运从 `moveClaimed` 里分出来、
 * 执行器的空目录清理按它把这两层当归档结构留着。三处对不上就是各说各的——最安静的那种错位是
 * 清理那一处：纯享目录本轮搬空了就被删掉，下一轮再建一次，撤销时无从还原它原本装着什么。
 */
export { PURE_CUT_DIR, isPureCut } from '../pure-cut.ts'
import { PURE_CUT_DIR, isPureCut, pureCutMismatch } from '../pure-cut.ts'
/**
 * 这份文件是「纯享」剪辑吗（用户拍板 2026-09-03）——**只看名字，且只是个筛子，不是判定**：
 * 引擎把它认成某一集的正主时这一问根本不会被问（有的节目就把纯享版当正片列进节目单，标题自己带
 * 「纯享」）。期-段体系里标题不带纯享的正片，引擎自己就不建这条边（`pureCutMismatch`，事实级否决）。
 * 认哪一集仍然只有匹配器能答（P7）。
 */

/** 「第N期」抽取正则。**导出**——裁决器的 `no-duration` 候选收窄（`adjudicate/cards.ts`）复用它
 *  抽期号,不许另写一份同形正则(两份一旦措辞漂移,收窄判据与这里的冲突判据就会各说各的)。 */
export const QI_OF = /第\s*0*(\d{1,3})\s*期/
/**
 * 刻前缀之前的最后一道闸：文件名的「第N期」与清单这一集标题的「第M期」**都在场却不相等**、或文件名说
 * 自己是纯享而清单那一集不是 → 返回一句人话（作为冲突卡的 reason），否则 null。
 *
 * 为什么放在归档器而不只靠引擎：引擎把「第4期二」判成 S03E04（清单「第1期（四）」）是裸期号档的
 * 误读（喜剧之王单口季，2026-09-03，13 条），那一档修了；但归档器是**唯一会把结论刻进盘上文件名**的
 * 地方，而 `SxxExx - ` 一旦刻上就是下一轮最强的证据——错号自证正确，撤都撤不干净。分享者写的期号
 * 和 TMDb 写的期号两个都在场，机器不替它们二选一。
 */
export function qiConflict(fileName: string, episodeTitle: string): string | null {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const fq = QI_OF.exec(base), tq = QI_OF.exec(episodeTitle)
  if (fq && tq && Number(fq[1]) !== Number(tq[1])) return `文件名写着第${Number(fq[1])}期，清单这一集是第${Number(tq[1])}期`
  // 纯享那半句只在清单是"期"体系时问：标题带期号说明节目单按期列了正片，纯享另有条目或根本不列；
  // 标题是「第 7 集」这类占位时清单自己都不知道这集是什么，机器没资格替它说"这不是"。
  if (pureCutMismatch(base, episodeTitle)) return '文件名写着纯享，清单这一集不是纯享'
  return null
}


/** 归档器摆出问句的理由。匹配器那几种（判不出）+ 归档器自己这一种：配上了但置信度不够
 *  （`SpecAssignment.status === 'pending'`）。**分派只看这个闭集，绝不解析文案**。 */
type AskReason = SpecAmbiguity['reason'] | 'low-confidence'

/** 池子里的一份文件。`inLib` = 它此刻躺在认领货架上（决定"原地不动"还是"搬进去"，也进 compare）。 */
interface Slot { f: RFile; inLib: boolean }

interface Decision {
  slot: Slot
  verdict: LedgerVerdict
  basis: string
  /**
   * 这条判定**从哪一侧推出来的**（`authority` = 某一集来认领 / `file` = 没人认领、从文件自己的
   * 证据边反推）。**必填**：每个产出点本来就知道自己走的是哪条分支，就地标上，让归类成为构造时的
   * 事实——事后拿 `basis` 前缀去猜是把展示字段当协议用，文案一改就静默错位。
   */
  origin: DecisionOrigin
  episode?: string
  /** null = 本轮对它没有动作（豁免、或已经在该在的位置）。 */
  action: PlanAction | null
}

/** `settleCopy` 的产出：动作 + **这一行账本的 basis**。basis 跟着动作一起从产出点带出来，
 *  不由调用方事后按 `action.kind` 反推——那就是"拿展示字段当协议用"（见 `Decision.origin` 头注）。 */
interface SettledCopy { action: PlanAction; basis: string }

export function buildPlan(input: PlanInput): PlanOutcome {
  const { identity } = input
  // 货架自述表：下面每一处降级都只读它，不问"这是网盘还是本地盘"（spec 2026-09-03 §3.1）。
  const shelf = input.shelf
  /** 名字比对前的折叠：不区分大小写的货架上 `A.mp3` 和 `a.mp3` 是同一个位置。 */
  const fold = (name: string) => (shelf.caseSensitive ? name : name.toLowerCase())
  /** 删不可撤的货架上给每条 `delete-redundant` 盖的那一位（执行面据此降级，见该变体头注）。 */
  const noTrashMark = shelf.hasTrash ? {} : { noTrash: true as const }
  const entries: AuthorityEntry[] = input.authority.map((a) => (typeof a === 'string' ? { title: a } : a))
  // leftKey 必须唯一（判决的 assignments 按它索引）。缺省用标题；真撞了加序号，别静默丢一条。
  const seenKeys = new Set<string>()
  const leftKeys = entries.map((e, i) => {
    let k = e.leftKey ?? e.title
    if (seenKeys.has(k)) k = `${k}#${i}`
    seenKeys.add(k)
    return k
  })
  const entryByKey = new Map<string, AuthorityEntry>()
  entries.forEach((e, i) => entryByKey.set(leftKeys[i], e))
  /** leftKey → 证据卡要展示的那几样。裁决层只认 key，标题/时长/paid 是展示层的事。 */
  const episodeOf = (leftKey: string) => {
    const e = entryByKey.get(leftKey)
    return e ? { title: e.title, durationS: e.durationS, paid: e.paid } : undefined
  }
  /** 认集身份 → leftKey，即「这个文件名自称是清单里的哪一集」。同 key 多条留第一条。
   *
   *  **它不是任何一道关卡**——认哪一集只有匹配器能答（P7）。三个消费者一个都不改配对结果：
   *   · `titleOfName`：给 UI 当抬头（字节全等那一档跑在匹配器之前，那里只有这一个集名可拿）；
   *   · `paidByName`：`paid` 的**删除闸**，只用来「不删」，绝不用来「删」或「认领」；
   *   · `titleIdentityKeys`：下面那次排序的快照，只决定先看谁，判据一条没变。 */
  const leftKeyByIdentity = new Map<string, string>()
  entries.forEach((e, i) => {
    const k = identity(e.title).key
    if (!leftKeyByIdentity.has(k)) leftKeyByIdentity.set(k, leftKeys[i])
  })
  /** 清单里每一集标题的认集身份键**快照**——「这个文件名自称是清单里的某一集」这个信号。
   *  必须在下面那次"从认领下来的文件补身份"之前取：那一步会把文件名这一侧的身份也塞进
   *  `leftKeyByIdentity`，混进来之后"名字对得上标题"就不再是名字这一侧的信号了。 */
  const titleIdentityKeys = new Set(leftKeyByIdentity.keys())
  /**
   * 文件名自称的集身份 === 这一集标题的集身份。**只在"两份内容一样、留哪份"这一步当裁判**
   * （见 `settleCopy` 的平手分支），不参与"这是哪一集"——后者只有匹配器能答（P7）。
   */
  const nameMatchesEpisode = (f: RFile, leftKey: string): boolean => {
    // 影视档：集标题是「第 14 集」这种通用串，一整季都长得差不多，拿它比对等于没比。名字这一侧
    // 真正带信息的是 `SxxExx`，所以这一档改问"名字自带的季集号 === 引擎判的那一集"。
    if (input.seasonFolders) {
      const n = seasonEpisodeOfName(f.name)
      const k = seasonEpisodeOfKey(leftKey)
      return !!n && !!k && n.season === k.season && n.episode === k.episode
    }
    return identity(f.name).key === identity(entryByKey.get(leftKey)!.title).key
  }

  /**
   * 这份文件自称是清单里的哪一集（只查名字的认集身份表）。**纯给 UI 当抬头，不参与任何判定**——
   * 认哪一集是匹配器的事（P7）。字节全等那一档跑在匹配器之前，那里唯一能拿到的集名就是它；
   * 查不到就不带，前端退化成动作标签，绝不瞎猜。
   */
  const titleOfName = (f: RFile): string | undefined => {
    const k = leftKeyByIdentity.get(identity(f.name).key)
    return k ? entryByKey.get(k)!.title : undefined
  }

  /**
   * **这一集要不要人往网盘供货**——处置层唯一读的那一位（判定层一个字都不读，读了就是第二个脑）。
   * 判据早在清单那一侧算完了（`left-from-stream.ts` 的 `hasPlayableMedia`：这一集自己带没带
   * 可播地址），这里只做两件事：**认人工覆盖**，以及**缺席补成"要供货"**。
   *
   * **人工覆盖压过算出来的那一位**（`matchSpec.needsSupply`，整条绑定一刀切，见那里的头注）：
   * 源站给了地址、但地址早失效或音质差到不能听——人知道、机器不知道。`??` 而不是 `||`：
   * 覆盖成 `false`（这条绑定的副本全可以删）和"没填"是两回事。
   *
   * **缺席 = 要供货**，这是本函数唯一的默认方向，也是它写成 `!== false` 而不是 `=== true` 的
   * 全部理由：删不可逆、留着只占空间，判据拿不准必须倒向留着。tmdb 影视（清单来自分集索引、
   * 压根没有这一位）天然落在这一侧，**不需要任何 `undefined` 特判**——旧模型里那条特判是影视
   * 全库的命（`!paid` 会把它们全判成冗余），新模型里它已经结构性不可能失败：默认方向本身就是
   * "要供货"，没有哪个写法能让缺席掉到"删"那一边。清单里查不到那一集时同样返回"要供货"。
   */
  const supplyOverride = input.matchSpec.needsSupply
  const needsSupply = (leftKey: string) => supplyOverride ?? entryByKey.get(leftKey)?.needsSupply !== false

  /**
   * 这份文件按名字自称的那一集，清单**明说**它要供货吗（要供货 = 源站自己放不出 = 网盘这份可能是
   * **唯一可播来源**）。查的是和 `titleOfName` 同一张名字表。
   *
   * **它只用来「不删」，绝不用来「删」或「认领」**——这条不对称是它不算第二个判定脑的原因
   * （P7 禁的是归档器自己判"这文件是哪一集"然后**据此动手**）：
   *  · 认成要供货而其实不是 → 代价是多一次人点头，不会删错、也不会认错集；
   *  · 认不出（名字表查不到）→ 退回原行为，是现状不是回归。
   *
   * **它读的是 `=== true`（清单明说），不是 `needsSupply()` 那条"缺席也算要供货"的保守默认**
   * ——两个默认方向不同，因为两个问题的代价结构不同：
   *  · `needsSupply()` 管**删不删**，删错就是这一集彻底没音频、不可逆 → 缺席必须倒向留着。
   *  · 这里管的只是**删之前要不要人点一下头**，而字节全等意味着留下的那份一字节不差，删掉
   *    落选份本来就不丢内容。缺席（清单答不上来，如 tmdb 影视）若跟着倒向"要点头"，换来的是
   *    整个影视库的字节全等重复都得逐条点，一点真实安全都没多。
   *
   * **人工覆盖照样压过这里**：一条绑定被人判成"要供货"，它的字节全等副本却照旧自动删，
   * 就是个半截状态。覆盖是整条判据的覆盖，不是只盖主循环那一处。
   */
  const needsSupplyByName = (f: RFile): boolean => {
    if (supplyOverride != null) return supplyOverride
    const k = leftKeyByIdentity.get(identity(f.name).key)
    return k ? entryByKey.get(k)!.needsSupply === true : false
  }

  /** 「删这份、留那份」的并排数据：**只有涉事的两份**（不掺别的候选），有裁判就带上节目单时长。
   *  删除行的叙述靠它才完整——留下那份光有路径，时长和码率都说不出来。 */
  const pairCompare = (gone: Slot, kept: Slot, leftKey?: string): CompareInfo => {
    const authorityDurationS = leftKey ? entryByKey.get(leftKey)!.durationS : undefined
    return {
      ...(authorityDurationS != null ? { authorityDurationS } : {}),
      candidates: [gone, kept].map((s) => ({ path: s.f.path, size: s.f.size, durationS: s.f.durationS, inLib: s.inLib })),
    }
  }

  // —— 池子：认领货架先进（字节全等时"留库内那份"靠这个顺序自然成立），来源后进；按 path 去重
  //    （sourceDirs 与库目录重叠的历史配置下，同一个文件会两侧各出现一次——它不是自己的重复）。
  const pool: Slot[] = []
  const seenPath = new Set<string>()
  for (const f of input.libClaimedFiles) if (!seenPath.has(f.path)) { seenPath.add(f.path); pool.push({ f, inLib: true }) }
  for (const f of input.sourceFiles) if (!seenPath.has(f.path)) { seenPath.add(f.path); pool.push({ f, inLib: false }) }

  // —— 占位表：磁盘上此刻每个目录有哪些文件名 + 哪些认集身份。两道占位判据都会降级 swap-hold：
  //    · 同名：`executePlan` 把 move 按 (srcDir → dstDir) 分组、组间顺序不保证，同轮"A 搬出去 +
  //      B 搬进来"会撞名（403）；同名那份不走也一样撞。
  //    · 同集（认集身份同 key）：货架上已有这一集的一份（哪怕它正在待裁）就不再往里搬第二份——
  //      步 4"默认不重复"/L3 的执行面。只查同名是靠文件名运气：活体里 796 因为来源/库内一字不差
  //      被拦住了，780/05/37 的来源名带【耗时整理】装饰就漏了过去，差点一集两份。
  const occupied = new Map<string, Set<string>>()
  /** 目录 → (认集身份 key → 占位者文件名)。嵌套 Map，不拼合成字符串键——目录名可含任意字符，
   *  拼串分隔符选什么都有歧义（这里真栽过一次：写进模板串的"空格"实际是个肉眼不可见的 NUL）。 */
  const epByDir = new Map<string, Map<string, string>>()
  const occupyName = (dir: string, name: string) => {
    const set = occupied.get(dir) ?? new Set<string>()
    // 存折叠后的名字：不区分大小写的货架上 `A.mp3` 占的就是 `a.mp3` 那个位置（查询侧同样折叠）。
    set.add(fold(name))
    occupied.set(dir, set)
  }
  /** 同集占位登记。**键是谁由模式决定**：播客档用名字身份（开局就知道），影视档用 leftKey
   *  （要等匹配器给结论，所以那一档的登记在匹配之后补，见下方）。 */
  const registerEpisode = (dir: string, key: string, name: string) => {
    const eps = epByDir.get(dir) ?? new Map<string, string>()
    if (!eps.has(key)) eps.set(key, name)
    epByDir.set(dir, eps)
  }
  /** 目录 → (折叠名 → 盘上那份文件)。与 `occupied` 分开：那张表也登记本轮**计划**落地的名字，
   *  而这张只有此刻真躺在盘上的文件——"同名的那份有多大"只有真文件答得出。 */
  const onDisk = new Map<string, Map<string, RFile>>()
  for (const f of [...input.libClaimedFiles, ...(input.libSecondaryFiles ?? []), ...input.sourceFiles]) {
    occupyName(dirOf(f.path), f.name)
    const byName = onDisk.get(dirOf(f.path)) ?? new Map<string, RFile>()
    if (!byName.has(fold(f.name))) byName.set(fold(f.name), f)
    onDisk.set(dirOf(f.path), byName)
    if (!input.seasonFolders) registerEpisode(dirOf(f.path), identity(f.name).key, f.name)
  }

  const decisions: Decision[] = []
  /** 判定入账的唯一入口，顺手把来路盖到动作上：动作与账本行同出一条判定，两侧必须是同一个值。
   *  由这里统一盖（而不是每个动作构造点各写一遍）是因为动作的构造函数（`place`/`placeSecondary`/
   *  `settleCopy`）两侧共用——同一个 `place` 既服务认领落位，也服务残差下架。 */
  const decide = (d: Decision) => {
    if (d.action) d.action = { ...d.action, origin: d.origin }
    decisions.push(d)
  }

  /**
   * 搬去 `dst`：已经在那儿 = 无动作；那儿已有同名或同集文件 = swap-hold；否则 move（并登记占位）。
   *
   * `leftKey`：影视档「同一集」的键（认领结论）。缺席就不查也不登记同集占位——没配上的文件本来
   * 就不该在同集表里占位置，名字那一道照旧拦得住它。播客档不传，走名字身份，与过去逐字一致。
   * `landingName`：这份文件**落地时叫什么**（影视档会顺手加 `SxxExx - ` 前缀）。同名占位的查询与
   *  登记都得用它——按旧名查等于查了一个不会出现在目标目录里的名字。
   */
  const place = (
    slot: Slot, dst: string, basis: string, episode?: string, leftKey?: string, landingName?: string,
  ): PlanAction | null => {
    if (dirOf(slot.f.path) === dst) return null
    const landing = landingName ?? slot.f.name
    if (occupied.get(dst)?.has(fold(landing))) {
      return {
        kind: 'pending', src: slot.f, pendingKind: 'swap-hold', blockedBy: `${dst}/${landing}`,
        ...(episode ? { episode } : {}),
        reason: `目标目录 ${dst} 已有同名文件——本轮不搬（同轮对搬会撞名），等它腾空后下一轮自然落位`,
      }
    }
    const epKey = input.seasonFolders ? leftKey : identity(slot.f.name).key
    const occupant = epKey === undefined ? undefined : epByDir.get(dst)?.get(epKey)
    if (occupant !== undefined) {
      return {
        kind: 'pending', src: slot.f, pendingKind: 'swap-hold', blockedBy: `${dst}/${occupant}`,
        ...(episode ? { episode } : {}),
        reason: `目标货架已有同集文件（${occupant}）——默认不重复（步 4），等那份裁决/腾空后下一轮自然落位`,
      }
    }
    occupyName(dst, landing)
    if (epKey !== undefined) registerEpisode(dst, epKey, landing)
    return { kind: 'move', src: slot.f, dstDir: dst, basis, ...(episode ? { episode } : {}) }
  }

  /** 第二货架上的一集：认集身份 → 架上那份。同 key 多条留第一条。 */
  const secondaryByIdentity = new Map<string, RFile>()
  for (const f of input.libSecondaryFiles ?? []) {
    const k = identity(f.name).key
    if (!secondaryByIdentity.has(k)) secondaryByIdentity.set(k, f)
  }

  /**
   * 搬去第二货架。**先做同集择优**，再走通用 `place`——顺序不能反：架上那份和这份同集时，同名/同集
   * 护栏会把它降级成 `swap-hold` 干等，而第二货架没有"下一轮腾空"这回事（没人会去搬走它），
   * 那就是个永不腾空的僵尸位。择优三分支：差/平 → 删这份；更优 → 换掉架上那份；比不出 → 人裁。
   *
   * 只对**本轮开始前就在架上**的那些择优（`libSecondaryFiles`）。同一轮里两份同集文件一起判下架时，
   * 第二份照常走 `place` 的同集护栏降级 `swap-hold`：那份还没落地，拿一个计划中的位置去规划删除
   * 是在赌执行顺序。下一轮它就是"架上那份"，自然进这里择优。
   */
  const placeSecondary = (slot: Slot, dst: string, basis: string): PlanAction | null => {
    const shelf = secondaryByIdentity.get(identity(slot.f.name).key)
    // 这次调用没传 leftKey/landingName——tmdb 绑定没有第二货架（`dirs.secondary` 恒缺席），今天
    // 这条路对影视档不可达；接第二货架时要补 leftKey/landingName，同主循环 `place` 那次调用一样。
    if (!shelf || shelf.path === slot.f.path) return place(slot, dst, basis)
    const verdict = compareQuality(slot.f, shelf)
    if (verdict === 'worse' || verdict === 'tie') {
      return {
        kind: 'delete-loser', src: slot.f, keptPath: shelf.path, basis: `quality-loser-of:${shelf.path}`,
        compare: pairCompare(slot, { f: shelf, inLib: false }),
      }
    }
    const compare: CompareInfo = {
      candidates: [slot.f, shelf].map((f) => ({ path: f.path, size: f.size, durationS: f.durationS, inLib: false })),
    }
    if (verdict === 'better') {
      return { kind: 'replace', src: slot.f, oldPath: shelf.path, dstDir: dst, basis: `quality-upgrade:${shelf.path}`, compare }
    }
    // 机器比不出来，但人可能已经裁过了。**动作与上面两条完全同构**（同样进「将删清单」等确认，
    // 定时轮一步都不动），变的只是依据：`basis` 记 `decision:prefer:` 而不是 `quality-*`，
    // 账本上一眼看得出这一笔是人说的还是实测出来的。
    const preferred = input.preferredOf?.(slot.f.path, shelf.path)
    if (preferred === shelf.path) {
      return {
        kind: 'delete-loser', src: slot.f, keptPath: shelf.path, basis: `decision:prefer:${shelf.path}`,
        compare: pairCompare(slot, { f: shelf, inLib: false }),
      }
    }
    if (preferred === slot.f.path) {
      return { kind: 'replace', src: slot.f, oldPath: shelf.path, dstDir: dst, basis: `decision:prefer:${slot.f.path}`, compare }
    }

    const episode = titleOfName(slot.f)
    return {
      kind: 'pending', src: slot.f, pendingKind: 'replace', compare,
      ...(episode ? { episode } : {}),
      reason: `第二货架已有同集的一份（${shelf.name}），两份比不出高下（清晰度档探不出、时长不全，`
        + `或长度差出容差根本不是同一份）——未知 ≠ 该删，人看一眼`,
    }
  }

  /**
   * 「没落到任何一集头上」的落地：搬去第二货架（搬进去前先与架上同集那份择优）。
   * **没有第二货架的绑定**（影视：没有"下架"这个概念）→ 判定照记，动作为空、原地不动、永不删
   * （spec §3 闸门三）。两个入口共用它：时长/名字都不指向任何一集的，和人裁过「不是这一集」的。
   */
  const shelve = (s: Slot, basis: string): Decision => {
    const secondary = input.dirs.secondary
    // 来路恒为 `file`：走到这里的前提就是"没有任何一集认领它"——不论是判决层说的残差，
    // 还是人对着问句答完「不是这一集」之后剩下的那种，推理的起点都是这份文件自己。
    const origin = 'file' as const
    return secondary
      ? { slot: s, verdict: 'offline', origin, basis, action: placeSecondary(s, secondary, basis) }
      : { slot: s, verdict: 'offline', origin, basis: `${basis} no-secondary-shelf`, action: null }
  }

  const seasonUnresolved = (p: string) => isSeasonUnresolved(input, p)

  // ① 豁免/墓碑先于一切（spec §3.3）：不动、不报，但**账本要有行**——否则守恒律对不上。
  let stage: Slot[] = []
  for (const s of pool) {
    const v = input.verdictFor(identity(s.f.name).key)
    // 来路 `file`：豁免/墓碑跑在匹配器之前，没有任何一集在问它——判据是人对**这份文件**
    // （的身份键）下过的裁定，起点在文件这一侧。
    if (v) { decide({ slot: s, verdict: 'exempt', origin: 'file', basis: `decision:${v}`, action: null }); continue }
    // 半截文件在**字节全等签名之前**就拦下：两份都还在写的 0 字节文件签名相同，进了那一档
    // 会被判成"同一份"删掉一份（`delete-dup` 是唯一不经人眼的动作）。来路 `file`：判据是这份
    // 文件自己的字节数/来源申报，没有任何一集在问它。
    if (isSizeSuspect(s.f)) {
      decide({
        slot: s, verdict: 'hold', origin: 'file', basis: 'size-suspect',
        action: {
          kind: 'pending', src: s.f, pendingKind: 'no-duration',
          reason: s.f.inProgress ? '这份还在写入——长全了下轮再看' : `只有 ${s.f.size} 字节，像半截文件——长全了下轮再看`,
        },
      })
      continue
    }
    // 判不出季的文件夹：**没被判过**，不是"没人要"。必须排在②字节全等之前——那一档会产出
    // `delete-dup`，全流程唯一不经人眼的动作，而这个文件夹里两份同名同体量的文件很可能正是
    // 两季各自那一份（跨季同期号是常态）。连"它们是不是同一季"都还没答上来，凭什么说是同一份。
    if (seasonUnresolved(s.f.path)) {
      const dir = dirOf(s.f.path)
      decide({
        // 来路 `file`：没有任何一集在问它——这一行讲的是它所在的文件夹归不了季。
        // 判定筐 `hold`：这是个**状态**（判不出来、等人给文件夹起个带季号的名字），
        // 不是"清单里没有它"那个结论。
        slot: s, verdict: 'hold', origin: 'file', basis: `${SEASON_UNRESOLVED_BASIS}${dir}`,
        action: {
          kind: 'pending', src: s.f, pendingKind: 'season-unresolved',
          reason: `这个文件夹判不出属于哪一季——本轮不搬不改名；给文件夹起个带季号的名字，或把文件挪进 S<nn>/`,
        },
      })
      continue
    }
    stage.push(s)
  }

  /** 认领成立时的落点：命中子节目编号模式 → 那个子节目的文件夹，否则认领货架根。**只管去向**——
   *  没配上的文件不因为名字像子节目编号就免检（那是第二个脑，P7）。 */
  const destinationFor = (name: string) =>
    input.subShows.find((x) => x.numPattern.test(name))?.dir ?? input.dirs.claimed

  /** 认领落点：影视档进 `<claimed>/S<nn>`（季号取自 leftKey），其余照旧走子节目路由。
   *  抽成一个函数是因为两处要用同一个答案——主循环的落位与 `settleCopy` 里换正主的那次上位。
   *  `subShows` 在影视档恒空（tmdb 绑定没有子节目），所以两条路不会打架。 */
  const claimedRoot = input.dirs.claimed.replace(/\/$/, '')
  const seasonOf = (leftKey: string) => (input.seasonFolders ? seasonEpisodeOfKey(leftKey) : null)
  const claimedDestination = (name: string, leftKey: string) => {
    const se = seasonOf(leftKey)
    return se ? `${claimedRoot}/${seasonDirName(se.season)}` : destinationFor(name)
  }
  /**
   * 名字自带的季集号与引擎判的那一集**打架**时的那张卡：不搬、不改名，等人裁。
   *
   * 为什么不是"信引擎、照改"：改名会把一个可能正确的证据（分享者写在文件名里的集号）抹掉，
   * 而且是不可逆地抹在盘上。两侧各说一集时机器分不出谁错，正是 `evidence-conflict` 的定义。
   * `conflictsWith` 两个键都给全（引擎那一集在前、名字那一集在后），出口才清得掉这张卡。
   */
  const prefixConflict = (
    s: Slot, leftKey: string, se: { season: number; episode: number },
    named: { season: number; episode: number }, title: string,
  ): PlanAction => ({
    kind: 'pending', src: s.f, pendingKind: 'evidence-conflict', episode: title,
    conflictsWith: [leftKey, leftKey.replace(/:S\d+E\d+$/, `:${episodePrefix(named)}`)],
    reason: `文件名写着 ${episodePrefix(named)}，引擎判它是 ${episodePrefix(se)}`
      + `——名字和证据打架，本轮不搬不改名，等人裁`,
  })

  // ② 字节数全等 = 就是同一份（最硬的判据，不需要比质量）。同一集内留一份：库内那份优先，
  //    其次按 sourcePriority，其余 delete-dup。第二货架上的同签名文件同样算重复。
  /**
   * 字节全等那一档的删除动作。**清单明说要供货的集降级成确认档**（`delete-loser`）而不是
   * `delete-dup`：`delete-dup` 是全流程里唯一不经人眼、`autoExecute` 下即删的动作
   * （`execute.ts` 的 `losers` 开关**管不到它**），而要供货的集其网盘副本可能是唯一可播来源——
   * 删错就是这一集彻底没音频，且不可逆。降级后定时轮永不执行它（`service.ts` 那条路永远传
   * `losers:false`），必须人点头。
   *
   * 最尖的那个形状：留下的那份在**第二货架**上。第二货架不进**主**匹配池，每轮只由 `reviewSecondary`
   * 单独复核一趟、且**只认 `auto` 命中**——改过名、没探到时长的那些认不回来。所以"字节还在"不等于
   * "这一集还有音频"：付费货架那份一删，这一集可能就哑了。
   *
   * 源站自己放得出的那些不降级：删掉网盘那份不会让任何一集失声，保持原行为。
   */
  const dedupAction = (gone: Slot, kept: RFile, basis: string, compare: CompareInfo): PlanAction => {
    const episode = titleOfName(gone.f)
    // 无回收站的货架上一律降级：`delete-dup` 的底气是"删错了还捞得回来"，捞不回来就得过人眼。
    if (needsSupplyByName(gone.f) || !shelf.hasTrash) {
      return {
        kind: 'delete-loser', src: gone.f, keptPath: kept.path,
        basis: shelf.hasTrash ? basis : `${basis} no-trash`,
        ...(episode ? { episode } : {}), compare,
      }
    }
    return { kind: 'delete-dup', src: gone.f, dupOf: kept.path, basis, ...(episode ? { episode } : {}), compare }
  }
  /**
   * 字节全等的签名。影视档**按目录分组**：一部剧里跨季同名（两季各一个「第7期.mkv」）是常态，
   * 体量也常常接近；不带目录的签名会把两季各自唯一的那份判成"同一份"，而 `delete-dup` 是全流程
   * 唯一不经人眼的动作。同目录里的同名同体量仍然是真重复（转存重复落地），照删。
   */
  const sig = (f: RFile) =>
    input.seasonFolders ? `${dirOf(f.path)}|${identity(f.name).key}|${f.size}` : `${identity(f.name).key} ${f.size}`
  const shelfBySig = new Map<string, RFile>()
  // 半截的下架文件不进签名表：它不该当"留下的那一份"（同 `isSizeSuspect` 的头注）。第二货架不进
  // 主池，所以这道闸够不到它自己的判定——这里只保证它不会替别人做掉一个不可逆的删除。
  for (const f of input.libSecondaryFiles ?? []) {
    if (isSizeSuspect(f)) continue
    if (!shelfBySig.has(sig(f))) shelfBySig.set(sig(f), f)
  }
  const groups = new Map<string, Slot[]>()
  for (const s of stage) {
    const shelf = shelfBySig.get(sig(s.f))
    if (shelf && shelf.path !== s.f.path) {
      const basis = `size-dup-of:${shelf.path}`
      // 来路 `file`：这一档跑在匹配器之前，判据是**这两份文件的字节数**，没有任何一集在问它。
      decide({
        slot: s, verdict: 'dup', origin: 'file', basis,
        action: dedupAction(s, shelf, basis, pairCompare(s, { f: shelf, inLib: false })),
      })
      continue
    }
    groups.set(sig(s.f), [...(groups.get(sig(s.f)) ?? []), s])
  }
  const priorityOf = (p: string) => {
    const i = input.sourcePriority?.findIndex((d) => p.startsWith(`${d}/`)) ?? -1
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER
  }
  const next: Slot[] = []
  for (const group of groups.values()) {
    if (group.length === 1) { next.push(group[0]); continue }
    const ranked = [...group].sort((a, b) =>
      (a.inLib === b.inLib ? 0 : a.inLib ? -1 : 1) || priorityOf(a.f.path) - priorityOf(b.f.path))
    const [keep, ...drop] = ranked
    next.push(keep)
    for (const d of drop) {
      const basis = `size-dup-of:${keep.f.path}`
      decide({ slot: d, verdict: 'dup', origin: 'file', basis, action: dedupAction(d, keep.f, basis, pairCompare(d, keep)) })
    }
  }
  stage = next

  // ③ 跑**一次**匹配器。右侧的 `name` 用**绝对路径**：来源和库内常有同名文件（正是本轮
  //    要裁的那种局面），用文件名当标识两份会互相顶掉。匹配器内部比较前会自己剥到 basename。
  /** 人裁钉死的那份文件：leftKey → 绝对路径。**具名、只此一份**——匹配器拿它当输入，
   *  处置层拿它答"这条归属是人给的还是引擎判的"（`prefixConflict` 那道闸按它放行）。 */
  const pinnedPathByKey = new Map<string, string>()
  const left: SpecLeft[] = entries.map((e, i) => {
    // 人对着问句答的「就是这一集」压过绑定侧的订正——它是对**这个货架上这一份文件**的直接回答。
    const pin = input.pinnedFor?.(leftKeys[i]) ?? e.pinnedRight
    if (pin) pinnedPathByKey.set(leftKeys[i], pin)
    return {
      leftKey: leftKeys[i],
      title: e.title,
      ...(e.durationS != null ? { durationS: e.durationS } : {}),
      ...(e.paid ? { paid: true } : {}),
      // 判定层能读的那一位（`SpecLeft.needsSupply`）：**不是 `paid` 的别名**，是处置语义本身。
      // 走的就是处置层那个 `needsSupply()`（同一个函数，不是同一个式子抄两遍）——两侧分家就会
      // 出现"没问句、却照旧出卡"这类只在活体现形的错位。
      needsSupply: needsSupply(leftKeys[i]),
      ...(pin ? { pinnedRight: pin } : {}),
    }
  })
  const right: SpecRight[] = stage.map((s) => ({
    name: s.f.path,
    size: s.f.size,
    ...(s.f.durationS != null ? { durationS: s.f.durationS } : {}),
  }))
  const { assignments, ambiguous, resolution } = (input.match ?? ((l, r) => matchByEvidenceResult(input.matchSpec, l, r)))(left, right)
  /**
   * **残差是判决给的，不是归档器推出来的**（spec §3.3 / I2）。过去这里靠"没被认领、又不在歧义
   * 里 → 那就是清单里没有它"反推，而那条推断正是 05 案静默搬下架的通道：匹配器见过这份文件、
   * 评估过、丢弃了，痕迹却一点没留，归档器只能把"见过又扔了"读成"节目单上没有"。
   * 现在残差有了定义——**零边，或每条可裁决的边都被显式否决**——由裁决层直接交出。
   */
  const residualPaths = new Set(resolution.residual)
  /**
   * 一份文件的**活候选**：证据现在还指着的那几集（按 leftKey 去重、排序，好让 `basis` 稳定）。
   *
   * 判据是裁决层那把尺（`candidateWeight`：时长命中 | 结构键 | 名字过 `DURATION_MIN_SIM` 地板），
   * **不许在这里另立阈值**——量得比它松会多删，比它紧会漏，而两边单看都正常（P7 那条老账）。
   *
   * 剔两种：
   *  · **事实级否决**（`duration-contradict`：两侧时长差出量级 = 这份文件永远不可能是这一集）。
   *    其余否决理由（`left-claimed`/`below-threshold`/`no-margin`…）是顺序性或门槛性的，证据本身
   *    仍指着那一集，照留——它们正是"没人认领、但也不是没人惦记"的那批。
   *  · **人裁过「不是这一集」**（`notEpisode`）：人说了不是，那条边的证据就作废，不许再拿它
   *    反过来给这份文件定性。**这一条只能落在这里**：闸一开，那一集的问句就没了、上游的
   *    `answeredNotEpisode`（它是遍历 `asks` 填出来的）也跟着空，指望上面那个分支拦是拦不住的。
   *    口径与 I3 冲突卡的出口逐字相同（那边是"每个相争的集都答过不 → 按清单里没有它办"）。
   */
  const liveCandidateKeys = (path: string): string[] => {
    const keys = new Set<string>()
    for (const e of resolution.trails.get(path)?.edges ?? []) {
      if (candidateWeight(e.facts) < 0) continue
      // 剔哪些否决理由**不由归档器自己定**：口径与判定层那道「不需供货就不问」的闸共用一张表
      // （`match-engine/live-candidate.ts`），两侧共读。写死在这里就会与闸分家，
      // 而分家的表现是文件被静默搬走、一张卡都没有（2026-08-02 怡楽 112/116）。
      if (isNonLiveVeto(e.vetoReason)) continue
      if (input.notEpisode?.(e.leftKey, path)) continue
      keys.add(e.leftKey)
    }
    return [...keys].sort()
  }
  /** I3 的文件侧问句：证据指向多个集、没有规则敢裁。一份文件一张卡（问的就是这份文件）。 */
  const conflictByPath = new Map<string, Ask>()
  for (const a of fileAsksOf(resolution)) conflictByPath.set(a.path!, a)
  /** 只认 auto 置信的认领。`pending` 状态的配对是"够像但没到把握"，不足以据此搬文件。 */
  const claimedByPath = new Map<string, string>() // path → leftKey
  const claimedKeys = new Set<string>()
  const claimedPathOfKey = new Map<string, string>()
  /** path → leftKey：**匹配器认出的"这一集的其余份"**（`SpecAssignment.losers`）。正主与落选份
   *  同出一次匹配，所以这里不需要（也不许）再判一次"它是哪一集"——只把结论接过来。 */
  const loserByPath = new Map<string, string>()
  /**
   * `pending` 配对：匹配器说"像这一集、但没到把握"。它**既不是认领也不是没人要**——
   * 把它当没人要是最坏的一种处理：文件在匹配器那边已经被占住（别的集抢不到），归档器这边却
   * 判成"清单里没有它"搬去下架。活体 2026-08-01 春典：3 份就躺在付费货架上、名字与节目单只差
   * 一截分享者尾巴（相似度 0.765，AUTO_SIM 是 0.8）的文件被规划搬走。**它是个问句**，与
   * `ambiguous` 同类：摆出并排数据问人，本轮不搬不删。
   */
  const lowConfidence: { leftKey: string; paths: string[] }[] = []
  for (const [leftKey, a] of assignments) {
    if (a.status === 'auto') {
      claimedByPath.set(a.rightFile, leftKey)
      claimedKeys.add(leftKey)
      claimedPathOfKey.set(leftKey, a.rightFile)
      for (const path of a.losers ?? []) loserByPath.set(path, leftKey)
      continue
    }
    lowConfidence.push({ leftKey, paths: [a.rightFile, ...(a.losers ?? [])] })
  }
  // 影视档的同集占位表**只能在这里填**：键是 leftKey，而 leftKey 是匹配器刚给出的结论。
  // 只登记匹配器认下的那些（正主 + 同集其余份）——没配上的文件不占任何一集的位置，
  // 它们由名字那一道占位护栏管着。
  if (input.seasonFolders) {
    for (const [path, key] of [...claimedByPath, ...loserByPath]) registerEpisode(dirOf(path), key, baseOf(path))
  }

  const slotByPath = new Map(stage.map((s) => [s.f.path, s]))
  /**
   * 匹配器判不出的那些（`SpecAmbiguity`）→ 候选文件 → 那一集。**归档器不许把"判不出"当成
   * "清单里没有它"**：前者是问句、后者是结论，把问句当结论办就是自作主张（见下方兜底路那段的活体）。
   * 人裁过「不是这一集」的组合直接排除——问句已经有答案了，不再问第二遍。
   */
  const ambiguityByPath = new Map<string, { leftKey: string; reason: AskReason; paths: string[] }>()
  /** 人裁过「不是这一集」而被摘掉的那些：问句已经有答案，按"清单里没有它"办，但账本上要说清
   *  是**人裁过**才走的这条路，别退化成一句没来由的 `no-duration-hit`。 */
  const answeredNotEpisode = new Map<string, string>()
  // 两种问句同一个筐：匹配器"判不出"（ambiguous）和"像但没把握"（pending 配对）。
  // 前者先登记——同一份文件两边都沾时，判不出比没把握更该被摆出来。
  const asks: { leftKey: string; reason: AskReason; candidates: string[] }[] = [
    ...ambiguous.map((a) => ({ leftKey: a.leftKey, reason: a.reason as AskReason, candidates: a.candidates.map((c) => c.name) })),
    ...lowConfidence.map((p) => ({ leftKey: p.leftKey, reason: 'low-confidence' as AskReason, candidates: p.paths })),
  ]
  for (const ask of asks) {
    const paths: string[] = []
    for (const name of ask.candidates) {
      if (!slotByPath.has(name)) continue
      if (input.notEpisode?.(ask.leftKey, name)) { answeredNotEpisode.set(name, ask.leftKey); continue }
      paths.push(name)
    }
    if (paths.length === 0) continue
    const entry = { leftKey: ask.leftKey, reason: ask.reason, paths }
    for (const path of paths) if (!ambiguityByPath.has(path)) ambiguityByPath.set(path, entry)
  }
  const ambiguityFor = (path: string) => ambiguityByPath.get(path)
  /** 某一集的并排对照：占着这一集的那份（若有）+ 所有时长命中它、却没被认领的那些。
   *  `selfPath`：问句的主角自己（唯一来路是 `settleCopy` 传的 `s.f.path`——匹配器判出的**同集
   *  其余份**，`assignments[].losers`）。它认这一集靠的是匹配器，时长不一定落进容差，靠下面
   *  那个循环收不进来,所以显式带上：主角不在对照里,那个问句就无法回答。 */
  const compareFor = (leftKey: string, selfPath?: string): CompareInfo => {
    const authorityDurationS = entryByKey.get(leftKey)!.durationS
    const paths = new Set<string>()
    if (selfPath) paths.add(selfPath)
    const claimed = claimedPathOfKey.get(leftKey)
    if (claimed) paths.add(claimed)
    for (const s of stage) {
      if (claimedByPath.has(s.f.path)) continue
      if (s.f.durationS != null && authorityDurationS != null && Math.abs(s.f.durationS - authorityDurationS) <= DURATION_TOLERANCE_S) paths.add(s.f.path)
    }
    return {
      ...(authorityDurationS != null ? { authorityDurationS } : {}),
      candidates: [...paths].map((p) => {
        const s = slotByPath.get(p)!
        return { path: p, size: s.f.size, durationS: s.f.durationS, inLib: s.inLib }
      }),
    }
  }

  /**
   * I3 的那张卡：**证据指向好几个集，没有一条规则敢裁**。本轮无动作——文件原地不动，等人。
   *
   * 三处刻意的缺席，每一处都是"不许挑一个"的落实：
   *  · **不带 `episode`**：卡片标题写哪一集都是抓阄（名字指 A、时长指 B 时尤其），
   *    前端缺席时退化成作品名，比顶着一个可能错的集名强。争的是哪几集写在 `reason` 里。
   *  · **不带 `collidesWith`**：那是单集问句的回传参数，只装得下一个 leftKey。
   *    带上其中一个，用户点「不是这一集」就把答案落到了一集他未必在想的集头上——
   *    正是本次要修的那类 bug。多集的回传走 `conflictsWith`（**全部**相争的集）。
   *  · **`compare` 不带 `authorityDurationS`**：裁判有好几个，摆一个出来就是暗示答案。
   *    UI 那侧的约定正是"缺席 = 裁判不在场，只并排列数据、不标对错"。
   *
   * **出口**（`conflictsWith` + 「都不是这一集」）不是可选项：这份文件占着货架上的一个名字，
   * 等位的那份靠它腾位。没有出口 = 卡片永远消不掉 = 等位的永远落不了位，正是
   * `duration-collision` 当初补出口要解决的那个死锁（见本文件头注）。
   */
  const conflictCard = (s: Slot, ask: Ask): Decision => {
    const factsOf = new Map((resolution.trails.get(s.f.path)?.edges ?? []).map((e) => [e.leftKey, e.facts]))
    const keys = ask.candidates.map((c) => c.name)
    // 文案只列证据最强的头几个（`ask.candidates` 已按分量降序）：活体见过一份文件沾上二十几集，
    // 全列出来那张卡就没法读了。**机器可读的 `conflictsWith` 仍是全量**——出口要真能清掉它。
    const shown = ask.candidates.slice(0, MAX_CARD_EPISODES).map((c) => {
      const title = entryByKey.get(c.name)?.title ?? c.name
      return `《${title}》(${evidenceTag(factsOf.get(c.name) ?? [])})`
    })
    const more = keys.length > shown.length ? `等 ${keys.length} 个集` : ''
    // 并排数据：这份文件 + 头几个相争的集此刻的正主（若有）——问句要答得出，得先看得见对手。
    const incumbents = ask.candidates.slice(0, MAX_CARD_EPISODES)
      .map((c) => claimedPathOfKey.get(c.name))
      .filter((p): p is string => p != null && p !== s.f.path)
    const paths = [...new Set([s.f.path, ...incumbents])]
    return {
      slot: s,
      verdict: 'offline',
      // 来路 `file`：没有一集认领它，这张卡整个是从这份文件自己那几条边反推出来的——
      // 卡片问的正是"我该怎么办"，而不是某一集在问"哪个文件是我"。
      origin: 'file',
      basis: `evidence-conflict:${keys.join(',')}`,
      action: {
        kind: 'pending', src: s.f, pendingKind: 'evidence-conflict', conflictsWith: keys,
        compare: {
          candidates: paths.map((p) => {
            const slot = slotByPath.get(p)!
            return { path: p, size: slot.f.size, durationS: slot.f.durationS, inLib: slot.inLib }
          }),
        },
        reason: `证据指向 ${keys.length} 个集：${shown.join('、')}${more}`
          + `——机器分不出它属于哪一集，本轮不搬不删，等人裁。`,
      },
    }
  }

  /**
   * 同集副本的处置（P6）。走到这里"这一集有正主在架"已经成立（`claimedPathOfKey` 有值），
   * 这份文件也确实指向那一集（名字或时长）。**唯一议题是替换**——机器最多给到"换/不换"这一步：
   *  · 副本更差（`quality-loser-of:`）→ `delete-loser`：同集只留一份，删这份。
   *  · 副本更优（`quality-upgrade:`）→ `replace`：删旧正主、这份上位。
   *  · **质量分不出高下**（`tie` / `incomparable`）→ 方向由节目单裁，判据阶梯见 `settleUndecided`。
   *    **影视档的 `incomparable` 例外**：两份时长都知道且差出容差 = 不是同一份内容，出对照卡
   *    （`pending:replace`），不删不换——季目录里人人都带 `SxxExx - ` 前缀，名字那一档在那里恒真。
   *
   * 比不出也给建议而不是问句——"哪份是这一集"没有第二个人能答，摊手只会把同一个问题攒到下一轮；
   * 并排数据（`compare`）全带上，确认档拦着，用户点头才动。
   *
   * **影视档：先过一遍「名字自带的季集号是否与引擎打架」这一关，整个函数共用**（不止上位那一条
   * 路径）——`compareQuality` 判它更差时一样会 `dropCopy` 直接删，删掉的是分享者写在文件名里的
   * 那个可能正确的证据，且不可逆。少一份 loser 不该比多一份 claimed 少一份保护：出同一张
   * `evidence-conflict` 卡，本轮不删不换不改名，等人裁。
   */
  const settleCopy = (s: Slot, leftKey: string, title: string, selfPath?: string): SettledCopy => {
    /** 账本 basis 的常态：这一条判定就是「它是这一集的另一份」。只有比不出那张卡换掉它
     *  （`incomparable-copy:`）——复盘时要一眼看出这一行为什么既没删也没换。 */
    const wrap = (action: PlanAction, basis = `same-episode-copy:${leftKey}`): SettledCopy => ({ action, basis })
    const se = seasonOf(leftKey)
    const named = se ? seasonEpisodeOfName(s.f.name) : null
    if (se && named && (named.season !== se.season || named.episode !== se.episode)) {
      return wrap(prefixConflict(s, leftKey, se, named, title))
    }
    const oldPath = claimedPathOfKey.get(leftKey)!
    const kept = slotByPath.get(oldPath)!
    /** 换正主：删 `oldPath`、这份上位搬进目标目录。目标目录被**第三份**同名文件占着 → 搬进去
     *  必撞名（403），本轮先不搬；旧正主自己占着不算（先删后搬）。 */
    const promote = (basis: string, compare: CompareInfo): PlanAction => {
      const dstDir = claimedDestination(s.f.name, leftKey)
      // 新正主搬进季文件夹时也得带上前缀，否则换完版名字反而退回没前缀那一档，下一轮再改一次名。
      const newName = se && !named ? `${episodePrefix(se)} - ${s.f.name}` : undefined
      const landing = newName ?? s.f.name
      const oldIsOccupant = dirOf(oldPath) === dstDir && fold(baseOf(oldPath)) === fold(landing)
      if (dirOf(s.f.path) !== dstDir && !oldIsOccupant && occupied.get(dstDir)?.has(fold(landing))) {
        return {
          kind: 'pending', src: s.f, pendingKind: 'swap-hold', blockedBy: `${dstDir}/${landing}`,
          // 判据与 `place` 那两处一致：走到这里"这一集要换正主"已经成立，集名是知道的。
          episode: title,
          reason: `目标目录 ${dstDir} 已有同名文件——本轮不搬（同轮对搬会撞名），等它腾空后下一轮自然落位`,
        }
      }
      return { kind: 'replace', src: s.f, oldPath, dstDir, basis, episode: title, compare, ...(newName ? { newName } : {}) }
    }
    /** 留正主、删这份副本。`basis` 指着**被删的那份**（= 这份），与 `quality-loser-of:` 那条
     *  "指着留下那份"的老约定不同——方向靠 `kind` 已经说死，basis 只回答"凭什么"。 */
    const dropCopy = (basis: string): PlanAction =>
      ({ kind: 'delete-loser', src: s.f, keptPath: oldPath, basis, episode: title, compare: pairCompare(s, kept, leftKey) })

    /**
     * 质量分不出高下（`tie` / `incomparable`）时留哪份。**不能按"谁被认领了"**：正主/副本的身份
     * 只取决于匹配器先认领了谁，与哪份更像这一集无关，照它定方向就是抓阄。判据阶梯先到先得：
     *
     *  1. **贴近节目单时长**（`authority-duration:`）：两份都有时长、这一集也有权威时长 →
     *     `|时长 − 节目单|` 更小的那份留下。差值一样大 → 下一档。
     *  2. **名字与集标题一致**（`name-authority:`）：只有一边的认集身份等于这一集标题的认集身份
     *     → 留那边。两边都对得上（或都对不上）→ 下一档。
     *  3. **都分不出** → 各自维持现状：平手删副本（`quality-loser-of:`），比不出换正主
     *     （`quality-unknown:`）——"哪份是这一集"没有第二个人能答，摊手只会把问题攒到下一轮。
     *
     * 为什么第 1 档必须在最前（活体 怡楽 780/796）：节目单说 8274s，来源那份 8274s 被认领当上
     * 正主、库内那份 8279s 判副本；差 5 秒 > 容差 → `incomparable`。固定"副本上位"就是在建议
     * 删掉与节目单严丝合缝的那份，留下多 5 秒尾巴的那份——方向纯属遍历运气。
     *
     * 为什么第 2 档还在（活体 怡楽播客）：`05.太极两仪生四象.mp3` 与
     * `怡乐播客 - 005.身边那些灵异事.mp3` 字节数与时长完全相同（同一份音频，都是第 005 期），
     * 第 1 档分不出；节目单里的 05 期只有 2164s——前者是错身文件。它先落位当了 005 的正主，
     * 名字正确那份随后平手落选被判删：判"同一集删一份"是对的，留错了份。
     */
    const settleUndecided = (verdict: 'tie' | 'incomparable'): SettledCopy => {
      // 影视档 + 比不出（两份时长都知道且差出容差 = **不是同一份内容**）→ 对照卡，不删不换。
      // 名字那一档在这里是危险的：季目录里每份文件都被顺手加了 `SxxExx - ` 前缀，
      // "名字与集标题一致"于是恒真，`name-authority` 就成了一个**只按名字下删除令**的判据，
      // 而时长早已说了两份不是同一集内容。活体（2026-09-03 脱口秀 map_c038e1）：加前缀之后
      // 「第1期纯享版」被引擎判成 S02E01 的落选副本，一轮预览里 10 条 delete-loser——
      // 而追更循环是 `losers:true` 无人值守跑的，当晚就会真删。
      if (verdict === 'incomparable' && input.seasonFolders) {
        return {
          action: {
            kind: 'pending', src: s.f, pendingKind: 'replace', episode: title,
            compare: pairCompare(s, kept, leftKey),
            reason: '与正主质量比不出（时长不同或探不到）——季模式下不自动删也不换，'
              + '人看一眼是不是同一集的另一版',
          },
          basis: `incomparable-copy:${oldPath}`,
        }
      }
      const authorityDurationS = entryByKey.get(leftKey)!.durationS
      if (authorityDurationS != null && s.f.durationS != null && kept.f.durationS != null) {
        const offCopy = Math.abs(s.f.durationS - authorityDurationS)
        const offKept = Math.abs(kept.f.durationS - authorityDurationS)
        if (offCopy < offKept) return wrap(promote(`authority-duration:${oldPath}`, pairCompare(s, kept, leftKey)))
        if (offKept < offCopy) return wrap(dropCopy(`authority-duration:${s.f.path}`))
      }
      const copyNamed = nameMatchesEpisode(s.f, leftKey)
      if (copyNamed !== nameMatchesEpisode(kept.f, leftKey)) {
        return wrap(copyNamed
          ? promote(`name-authority:${oldPath}`, pairCompare(s, kept, leftKey))
          : dropCopy(`name-authority:${s.f.path}`))
      }
      return wrap(verdict === 'tie'
        ? dropCopy(`quality-loser-of:${oldPath}`)
        : promote(`quality-unknown:${oldPath}`, compareFor(leftKey, selfPath)))
    }

    const verdict = compareQuality(s.f, kept.f)
    if (verdict === 'worse') return wrap(dropCopy(`quality-loser-of:${oldPath}`))
    if (verdict === 'better') return wrap(promote(`quality-upgrade:${oldPath}`, compareFor(leftKey, selfPath)))
    return settleUndecided(verdict)
  }

  /**
   * **付费货架契约**（2026-08-01 拍板）：那个货架只放「要供货 ∧ 匹配器认领」的文件。认领了、
   * 但那一集源站自己放得出（`needsSupply === false`）→ 网盘这份没有存在价值，删。
   *
   * 三件事要分清，否则这条会被误读成"归档器又长了一个脑"：
   *  1. **认领结论没变**，变的只是处置——是哪一集仍然只有匹配器答（P7），这里读的是**它给的
   *     那个 leftKey** 对应的清单条目，不是拿文件名去猜（`needsSupplyByName` 那张名字表只服务
   *     字节全等那一档，且只用来「不删」）。
   *  2. **只在清单明说"源站自己放得出"时生效**。这一位缺席（tmdb 影视，以及任何答不上来的清单）
   *     一律算要供货、走现状——见 `needsSupply()` 的默认方向。
   *  3. **不搬只删**：文件在来源目录还是已经躺在付费货架上都一样。"先搬进去再删"没有任何意义，
   *     而"留在来源目录不管"会让它下一轮再被规划一次。货架干净就是契约本身。
   *
   * 账本 verdict 仍记认领侧的那个筐（`claimed`/`copy`）：**筐说的是判定，不是处置**，
   * 这一条恰恰是"认领成立"才走到的。守恒律照旧（一个文件一行）。
   */
  const redundant = (s: Slot, leftKey: string, title: string, verdict: LedgerVerdict): Decision => {
    const basis = `redundant-free:${leftKey}`
    // 来路 `authority`：走到这里的前提是**某一集认领了它**（认领结论没变，变的只是处置），
    // 读的正是那一集的清单条目。
    return { slot: s, verdict, origin: 'authority', basis, episode: title, action: { kind: 'delete-redundant', src: s.f, basis, episode: title, ...noTrashMark } }
  }

  /**
   * 上一条的**没被认领**那一半：没人认领这份文件，但证据还指着的那几集**全都不需要供货** →
   * 它不论是其中哪一集，处置都一样（删）。于是"是哪一集"这个问题不值得问，卡也不必出。
   *
   * 活体（2026-08-02 怡楽）：`玄关笔记/37.申与酉.mp3` 的时长同时撞上三集，被 I3 判成文件侧冲突卡，
   * 卡上问"它是不是《037.三谈身边灵异事》"——而那三集源站自己全放得出。问句无论怎么答都通向同一个
   * 动作，白占一次注意力。
   *
   * **两条边界写死在调用点，不在这里**：零候选（清单里根本没它）必须走下架货架、绝不删；
   * `needsSupply` 缺席（影视）一律算"要供货"。见 `needsSupply()` 与 `liveCandidateKeys()`。
   *
   * `basis` 与上面那条**故意不同形**（`redundant-free-candidates:` vs `redundant-free:`）：
   * 前者冒号后是**一组**候选 leftKey，后者是**认领到的那一集**。共用一个前缀会让账本读者
   * （以及未来解析它的人）把"没人认领、但都免费"读成"认领到了 k1,k2 这一集"。
   * `episode` 留空——没有确定的那一集，前端据此退化成作品名，绝不拿其中一个候选冒充。
   */
  const redundantCandidates = (s: Slot, leftKeys: string[]): Decision => {
    const basis = `redundant-free-candidates:${leftKeys.join(',')}`
    // 候选集的**名字**跟着键一起下发，逐位对齐（见 `candidateEpisodes` 头注）：卡片上要说得出
    // "推测是这几集"，而 `basis` 那串键只有机器读得懂。**不去重、不截断、不排序**——
    // 顺序就是 `basis` 的顺序，卡上的名字才回得去对上那串键。
    const candidateEpisodes = leftKeys.map((k) => entryByKey.get(k)!.title)
    // 判定筐仍是 `offline`：**筐说的是判定**——匹配器确实没把它认到任何一集头上。
    // 来路同理是 `file`：没有集来认领，是从这份文件自己那几条证据边反推出来的。
    return { slot: s, verdict: 'offline', origin: 'file', basis, action: { kind: 'delete-redundant', src: s.f, basis, candidateEpisodes, ...noTrashMark } }
  }

  /**
   * 处理顺序：**名字自称是清单里某一集的文件排前面**。同一轮里几份文件都指向同一个还空着的集时，
   * 谁先被处理谁就当上正主（`sole-candidate`），而目录遍历顺序不是判据——那是抓阄。名字对得上
   * 节目单是个具体信号，先让它落位。
   *
   * 这**不是第二个判定脑**：排序只决定先看谁，不改任何一条判据——排在后面的照样各走各的筐，
   * 认哪一集仍是匹配器说了算。稳定排序，同类维持原有相对顺序（认领货架先于来源，见池子的构造）。
   * 放在匹配之后：匹配器的输入顺序不受影响，`auto` 认领在进循环前就已登记，与顺序无关。
   *
   * 顺序管不到的那半边（现任是匹配器给的、或名字都对不上）由 `settleCopy` 的平手分支兜底。
   */
  stage = [...stage].sort(
    (a, b) => Number(titleIdentityKeys.has(identity(b.f.name).key)) - Number(titleIdentityKeys.has(identity(a.f.name).key)),
  )

  for (const s of stage) {
    // 判不出季的那些在①就被摘走了（排在②字节全等之前，见那一处），走不到这里。
    const claimedKey = claimedByPath.get(s.f.path)
    if (claimedKey) {
      const entry = entryByKey.get(claimedKey)!
      const title = entry.title
      if (!needsSupply(claimedKey)) {
        decide(redundant(s, claimedKey, title, 'claimed'))
        continue
      }
      const basis = `authority:${claimedKey}`
      const se = seasonOf(claimedKey)
      if (se) {
        // —— 影视档：落点 `<claimed>/S<nn>`、名字前面补 `SxxExx - `。三种终态：
        //    名字自带的季集号与引擎打架 → 出卡；已在季目录 → 顶多原地改名；否则搬（顺手改名）。
        const named = seasonEpisodeOfName(s.f.name)
        // **人已经钉死这份文件属于这一集** → 不出冲突卡：那张卡问的正是人刚答过的那个问题，
        // 摆出来只会让同一份文件每一轮都回来一次，而它没有第二个出口。名字里那串编号照旧
        // 一个字不动（`named` 为真 → 下面 `newName` 恒 undefined），绝不再叠一层前缀。
        const pinned = pinnedPathByKey.get(claimedKey) === s.f.path
        if (!pinned && named && (named.season !== se.season || named.episode !== se.episode)) {
          decide({
            slot: s, verdict: 'claimed', origin: 'authority', basis: `prefix-conflict:${claimedKey}`,
            episode: title, action: prefixConflict(s, claimedKey, se, named, title),
          })
          continue
        }
        // 同一道闸的另一半：文件名里的「第N期」和清单这一集的「第M期」都在场却不相等，或文件说自己是
        // 纯享而清单那一集不是——刻前缀就是替分享者和 TMDb 二选一，错了还不可逆（活体 13 条，见
        // `qiConflict` 头注）。人钉死的照旧放行。
        const qi = pinned ? null : qiConflict(s.f.name, title)
        if (qi) {
          decide({
            slot: s, verdict: 'claimed', origin: 'authority', basis: `qi-conflict:${claimedKey}`, episode: title,
            action: {
              kind: 'pending', src: s.f, pendingKind: 'evidence-conflict', episode: title, conflictsWith: [claimedKey],
              reason: `${qi}，引擎判它是 ${episodePrefix(se)}（${title}）——名字和证据打架，本轮不搬不改名，等人裁`,
            },
          })
          continue
        }
        const dst = claimedDestination(s.f.name, claimedKey)
        // 名字已经带着**正确**的季集号就一个字都不动：反复改名会把 `SxxExx - SxxExx - ` 叠起来。
        const newName = named ? undefined : `${episodePrefix(se)} - ${s.f.name}`
        let action: PlanAction | null
        if (dirOf(s.f.path) === dst) {
          if (!newName) {
            action = null
          } else if (occupied.get(dst)?.has(fold(newName))) {
            // 原地改名也要过同名占位这道闸：这个位置本轮可能已经被另一条动作认领
            // （比如同轮另一份文件搬进来占了这个新名字），硬改就是同轮撞名（403）。
            action = {
              kind: 'pending', src: s.f, pendingKind: 'swap-hold', blockedBy: `${dst}/${newName}`,
              episode: title,
              reason: `目标目录 ${dst} 已有同名文件——本轮不改名（同轮改名会撞名），等它腾空后下一轮自然落位`,
            }
          } else {
            occupyName(dst, newName)
            action = { kind: 'rename', src: s.f, newName, basis, episode: title }
          }
        } else {
          action = place(s, dst, basis, title, claimedKey, newName ?? s.f.name)
          if (action?.kind === 'move' && newName) action = { ...action, newName }
        }
        decide({ slot: s, verdict: 'claimed', origin: 'authority', basis, episode: title, action })
        continue
      }
      // 落点才是子节目路由起作用的地方——认领已经由匹配器裁完了。
      decide({ slot: s, verdict: 'claimed', origin: 'authority', basis, episode: title, action: place(s, destinationFor(s.f.name), basis, title) })
      continue
    }
    // —— 「纯享」剪辑：**另一条播放线，不是那一集**（用户拍板 2026-09-03）。各自进
    //    `<claimed>/纯享/S<nn>/`，**不加编号前缀**——前缀是"这是第几集"的断言，而它恰恰不是。
    //
    //    **落点必须在认领那一格之后**：引擎认下它当某一集的正主（有的节目就把纯享版当正片列进
    //    节目单）就是那一集，照常走 `S<nn>/`。走到这里的只剩两种：残差，和引擎判成同集落选副本
    //    的那些——后者这一条**顶掉 `settleCopy`**（删/换/对照卡三条出路对它都答错了问题：
    //    纯享不是正片的副本，两份时长差着十几分钟本来就不该拿去比质量）。
    //
    //    季号两个来源，`leftKey` 优先（引擎的结论比文件夹强）；两个都答不出就不搬，
    //    落回下面各分支各走各的路（判不出季的那些在①已经有自己那一行了）。
    if (input.seasonFolders && isPureCut(s.f.name)) {
      const cutSeason = (loserByPath.has(s.f.path) ? seasonEpisodeOfKey(loserByPath.get(s.f.path)!)?.season : undefined)
        ?? input.seasonOfDir?.get(dirOf(s.f.path)) ?? null
      if (cutSeason != null) {
        const dst = `${claimedRoot}/${PURE_CUT_DIR}/${seasonDirName(cutSeason)}`
        const basis = `pure-cut:${seasonDirName(cutSeason)}`
        // 货架上已经有同名同体积的一份 = 同一份文件（纯享不经字节全等那一档——它没被认领，
        // 那一档只看同集）。不删就是一张永远等不到"腾空"的 swap-hold（活体 2026-09-03，3 张）。
        // 名字上还挂着 `SxxExx - ` 前缀（早先被引擎认成某一集时刻上的，后来人/模型裁了「不是」）：
        // 进纯享货架时把它摘掉——前缀是"这是第几集"的断言，留着就是一份自证错号的证据，下一轮
        // 又会被 SxxExx 那一档读回去。只摘归档器自己那种形状的前缀，别的一个字不动。
        const landing = s.f.name.replace(ARCHIVER_PREFIX_RE, '')
        const twin = dirOf(s.f.path) === dst ? undefined : onDisk.get(dst)?.get(fold(landing))
        if (twin && twin.size === s.f.size) {
          const dupBasis = `size-dup-of:${twin.path}`
          decide({ slot: s, verdict: 'dup', origin: 'file', basis: dupBasis, action: dedupAction(s, twin, dupBasis, pairCompare(s, { f: twin, inLib: true })) })
          continue
        }
        // 判定筐 `offline`：**它不是任何一集**，这正是那个筐的定义。来路 `file`：没有集认领它。
        // `place` 管同名占位（撞上就 swap-hold 等下一轮）与"已经在那儿了"（无动作）。
        let cutAction = place(s, dst, basis, undefined, undefined, landing)
        if (cutAction?.kind === 'move' && landing !== s.f.name) cutAction = { ...cutAction, newName: landing }
        decide({ slot: s, verdict: 'offline', origin: 'file', basis, action: cutAction })
        continue
      }
    }
    if (s.f.durationS == null) {
      decide({
        // 来路 `file`：没有集在问它——这一条讲的是这份文件自己的时长还没探到。
        slot: s, verdict: 'hold', origin: 'file', basis: 'no-duration',
        // 陈述,不是问句:时长探测是几轮收敛的过程（预算/凭证/网络），用户对它没有可做的动作。
        action: { kind: 'pending', src: s.f, pendingKind: 'no-duration', reason: '时长还没探到（本轮预算用尽或探测失败）——下轮续探' },
      })
      continue
    }
    // —— 它是不是**已被认领的某一集的其余份**？这一问由匹配器答完了（`assignments[k].losers`）：
    //    同集只留一个正主，其余份不进配对结果、但已经被认出是同一集。归档器不再自己重算一遍
    //    "时长命中 + 名字地板 + 锚定哪一集"（`hitsOf`/`clearFloor`/`anchorOf`）——那套判据与匹配器
    //    的口径长期各走各的，两个脑给出相反答案时播放走的是错的那个（P7：归档器不做认集判定）。
    const loserKey = loserByPath.get(s.f.path)
    if (loserKey !== undefined) {
      const title = entryByKey.get(loserKey)!.title
      // 整集冗余：源站放得出这一集，那么它的**每一份**网盘副本都没有存在价值——正主刚在上面被删，
      // 这里再为"留哪份"比一次质量纯属白比（比出来的赢家下一步也要删）。
      if (!needsSupply(loserKey)) {
        decide(redundant(s, loserKey, title, 'copy'))
        continue
      }
      // 该集已有正主 → 唯一议题是替换（删/换都是确认档，机器不自己动手）。
      const settled = settleCopy(s, loserKey, title, s.f.path)
      decide({ slot: s, verdict: 'copy', origin: 'authority', basis: settled.basis, episode: title, action: settled.action })
      continue
    }
    // 人裁过「不是这一集」→ 问句已经有答案，不再问第二遍：按"清单里没有它"办，走第二货架那条
    // **会自愈**的路（位置腾出，等位的那份下一轮落位）。写决定的那一步不动文件，动作还是这一轮
    // 预览里的一条 move，照样要人点执行。
    const answered = answeredNotEpisode.get(s.f.path)
    if (answered !== undefined && !ambiguityByPath.has(s.f.path)) {
      decide(shelve(s, `decision:not-episode:${answered}`))
      continue
    }
    // —— 没人认领它，但证据指着的那几集**全都不需要供货** → 删，不出卡（见 `redundantCandidates`）。
    //
    // **落点为什么在这里**，四条都得成立：
    //  · 在 `claimedByPath`/`loserByPath` **之后**：认领是更强的结论，那两条已各自按 `paid` 分过岔，
    //    抢在它们前面等于用一组候选去覆盖一个确定的答案。
    //  · 在 `no-duration` **之后**：时长还没探到时证据本身残缺，拿它当"证据指向哪几集"用就是拿未知当已知。
    //  · 在人裁过的 `decision:not-episode` **之后**：人说了"不是这一集"就该走他答的那条路。
    //    注意闸一开那个分支就拦不住了，真正生效的是 `liveCandidateKeys` 自己滤 `notEpisode`。
    //  · 在余下**每一条**之前：`ambiguous`、I3 冲突卡都是问句（正是要消灭的那一张），
    //    残差 `shelve` 是把不需要的文件搬进下架货架——搬完抽屉里还是那份没人要的文件。
    //
    // 零候选（`length === 0`）不进这条：清单里根本没有它 → 照旧走下架货架，**绝不删**。
    // `[].every()` 恒为 true，漏掉这一句就是"每一份没人要的文件都被判成免费冗余"——
    // 加这条闸之前本仓 31 条既有用例当场变红，护栏用例也当场变红。
    const liveKeys = liveCandidateKeys(s.f.path)
    if (liveKeys.length > 0 && liveKeys.every((k) => !needsSupply(k))) {
      decide(redundantCandidates(s, liveKeys))
      continue
    }
    // 匹配器判不出**这一集**配哪份（集侧问句）→ 摆出并排数据问人。
    // 清单里没有它 = 没配上 → 第二货架。那个目录本身是一个 alist source，
    // 匹配器**判不出**这一份属于谁（`ambiguous`）→ 不许当"清单里没有它"搬走。
    //
    // 活体 2026-08-01 怡乐：`112.河南洛阳案.mp3`／`116.安特卫普金库案.mp3`／`268.三十六年未破悬案.mp3`
    // 三份文件名与节目单那一集**一字不差**（sim 1.000），被横向时长闸否掉之后掉进这条兜底路，
    // 被规划成搬去下架货架。而机器分不出「分享者贴错了名字」和「节目单时长不准 / 文件被截断」——
    // `玄关笔记/05.太极两仪生四象.mp3`（确是错身文件）与它们结构完全相同。**分不出就别动**：
    // 摆出证据问人，本轮不搬不删。
    const ask = ambiguityFor(s.f.path)
    if (ask) {
      const title = entryByKey.get(ask.leftKey)!.title
      // 一集一张卡：并排数据里已含全部候选，每个候选各出一张只会把同一个问题问几遍。
      // 代表行之外的候选照记账（守恒），但**本轮无动作**。
      const lead = ask.paths[0] === s.f.path
      decide({
        // 来路 `authority`：这张卡是**某一集**在问"哪个文件是我"——它有候选、只是不敢认。
        // 判定筐是 offline（确实还没认到谁头上），但问句的发起方是清单那一侧。
        slot: s, verdict: 'offline', origin: 'authority', basis: `ambiguous:${ask.reason}:${ask.leftKey}`,
        action: lead
          ? {
              kind: 'pending', src: s.f, pendingKind: 'duration-collision', episode: title,
              collidesWith: ask.leftKey,
              compare: {
                ...(entryByKey.get(ask.leftKey)!.durationS != null ? { authorityDurationS: entryByKey.get(ask.leftKey)!.durationS } : {}),
                candidates: ask.paths.map((p) => {
                  const slot = slotByPath.get(p)!
                  return { path: p, size: slot.f.size, durationS: slot.f.durationS, inLib: slot.inLib }
                }),
              },
              reason: askReason(ask.reason, title),
            }
          : null,
      })
      continue
    }
    // I3：证据指向好几个集、没有规则敢裁 → 出卡等人。**这一格过去不存在**——那样的文件直接
    // 掉进下面那条兜底路被搬去下架，卡片理由还是句假话（"时长和名字都对不上任何一集"，
    // 而它的时长恰恰命中了其中一集）。
    const conflict = conflictByPath.get(s.f.path)
    if (conflict) {
      // 出口收敛：人对**每一个**相争的集都答过「不是」→ 问句有答案了，按"清单里没有它"办。
      // 必须是全部——还剩一个没答就说明它可能仍是那一集，这时候搬走就是替他做了决定。
      const keys = conflict.candidates.map((c) => c.name)
      if (keys.every((k) => input.notEpisode?.(k, s.f.path))) {
        decide(shelve(s, `decision:not-episode:${keys.join(',')}`))
        continue
      }
      decide(conflictCard(s, conflict))
      continue
    }
    // 残差：**判决说的**（零边，或每条可裁决的边都被显式否决），不是这里推的。
    // 文件进去立刻是一条独立可播的集，不是消失（spec §2/L2）。搬进去前先与架上的同集那份择优。
    if (residualPaths.has(s.f.path)) { decide(shelve(s, `no-duration-hit:${s.f.durationS}s`)); continue }
    // 判决层碰过它、上面每个分支却都没接住。**绝不当"清单里没有它"搬走**——那正是要拆掉的那条
    // 静默通道。判定照记（守恒不破）、动作为空、文件原地不动，`basis` 把判决那侧的说法带出来，
    // 活体真出现了就是这一层接漏了一种终态，账本上看得见。
    decide({
      // 来路 `file`：上面每个集侧分支都没接住它 —— 没有任何一集认领它，剩下的只有它自己那条轨迹。
      slot: s, verdict: 'offline', origin: 'file', action: null,
      basis: `unhandled:${resolution.trails.get(s.f.path)?.disposition ?? 'no-trail'}`,
    })
  }

  // 本轮就要被替换掉（= 删掉）的那份，不该再挂着任何"把它搬进来"的动作：
  //  · `move`：搬进去只会让执行面对着一个已经不在的文件报错。（活体形状：同一集来了两份、
  //    这一集还空着——先到的那份认领落位，后到的更优那份把它换下来。）
  //  · `pending:swap-hold`：那句话是"等货架腾空、下一轮自然落位"，可它本轮就会消失——账本会
  //    自相矛盾（同一份文件既"本轮删你"又"下轮搬你进来"），前端的"等下一轮"那一组里出现一批
  //    本轮就不在了的文件。活体 780/796 正是这个形状。
  // 账本行照旧保留（`action: 'none'`），守恒不变。别的 pendingKind 不动：`no-duration`/
  // `suspect-dir` 讲的是另一回事（探测与目录熔断），与"这份文件要被删了"无关。
  const replaced = new Set(decisions.flatMap((d) => (d.action?.kind === 'replace' ? [d.action.oldPath] : [])))
  for (const d of decisions) {
    if (!d.action || !replaced.has(d.slot.f.path)) continue
    if (d.action.kind === 'move' || (d.action.kind === 'pending' && d.action.pendingKind === 'swap-hold')) d.action = null
  }

  suspectDirPass(decisions, input)

  /**
   * **下架货架每轮回头看**（2026-08-01 拍板）。它过去只进不出：文件放进去就再没人复核，
   * 源站把某集重新上架（它回到节目单）、或免费集副本曾被错放进去，抽屉就这么悄悄变脏。
   *
   * **它不是第二个判定脑**（P7）：同一个匹配器、同一份谱、判据一行都没改，只是**多调
   * 一次**——权威清单为左、**只有下架货架的文件**为右。结论也只用于货架卫生，**绝不写回主池的
   * 认领**：下架货架不进主匹配池这条契约（P8）纹丝不动，两次调用各自独立、互不影响
   * （主池的认领结果与有没有跑这一趟完全一致，`plan.test.ts` 钉死了这一条）。
   *
   * **同图另跑一次，不复用主池那份判决**：两次的右侧根本不是同一批文件（主池没有货架文件），
   * 复用等于拿一张缺了半边的图去回答另一个问题。代价是多跑一次匹配，收益是这条契约不用靠自觉守。
   *
   * **只消费 `auto`**。复核跑出的 `pending`/`ambiguous` 一律无动作：下架文件的默认状态就是
   * "待着"，把抽屉里的陈年文件翻成一堆新问句只会把面板淹掉——不确定就不折腾。
   *
   * auto 命中后按 `needsSupply` 分岔（与主池同一套契约、同一个 `needsSupply()`）：
   *  · **不要供货** → `delete-redundant`（与主池同一条规则：源站放得出，副本无处存身）。
   *  · **要供货** + 这一集本轮没人认领 → 它重新上架了，而下架那份是唯一副本 →
   *    `move` 回付费货架（`relisted:`，普通搬运档，可自动执行）。
   *  · **要供货** + 这一集已有正主 → 它是同集的另一份 → `delete-loser` 形状的确认档
   *    （`shelf-copy-of:<正主路径>`，带并排数据），机器不自动删。
   *  · 没命中 → 那正是它该在的地方，不动（绝大多数）。
   *
   * **这里没有"这一位缺席就一律不碰"那条岔路了**（旧模型下是 `paid === undefined` → 不动）。
   * 缺席现在就是"要供货"，与 app 独占集（源站没给地址、也不要钱）走同一条路。少掉那条岔路
   * 补的是个真缺口：怡楽有真实的下架货架、167 条 app 独占集，旧判据下它们的文件一旦进了抽屉
   * 就永远出不来。方向也安全——多出来的两种处置，一个是搬回来、一个要人点头。
   *
   * 三条边界：
   *  · **本轮已被主池的 `replace` 点名要删的那份不碰**——一份文件不许挂两个动作，执行面会对着
   *    一个已经不在的文件报错。**这一条是防御，不是观察到的形状**：主池唯一可能删货架文件的路是
   *    `placeSecondary` 的 `replace`，而它要求那份来的文件与货架那份时长在容差内（否则只到
   *    `pending`），那样它自己就先被这一集认领了、压根走不到 `placeSecondary`——今天构造不出来。
   *    留着它是因为判据一变（容差、择优阶梯）这条路就可能通，而代价只是一次 `Set.has`。
   *  · 回流撞上占位（同名/同集）→ **本轮无动作**，不出 `swap-hold`。主池那边的等位是句承诺
   *    （"下轮自然落位"），而货架上这份留在原地本来就是个合法状态，不需要惊动用户。
   *  · 回流那一集在下架货架上还有别的份（`losers`）→ 本轮只搬正主那一份。下一轮它已在付费货架，
   *    剩下的份自然走上面第二条分岔（已有正主 → 确认档）。拿一个计划中的位置去规划删除是在赌
   *    执行顺序（同 `placeSecondary` 的那条注释）。
   */
  const reviewActions: PlanAction[] = []
  const reviewSecondary = (): SecondaryReview => {
    const shelf = input.libSecondaryFiles ?? []
    const rows: LedgerRow[] = []
    if (!shelf.length) return { checked: 0, rows }
    const byPath = new Map(shelf.map((f) => [f.path, f]))
    const right: SpecRight[] = shelf.map((f) => ({
      name: f.path,
      size: f.size,
      ...(f.durationS != null ? { durationS: f.durationS } : {}),
    }))
    const { assignments, resolution } = matchByEvidenceResult(input.matchSpec, left, right)
    // 复核这一趟自己的证据图——货架文件不在主池那张图里，卡片要说的话只能从这一份取。
    const explains = explainsOf(resolution, (p) => byPath.get(p), episodeOf)
    /** 复核这一趟**整趟都是集侧发问**：它只消费 `assignments` 里 `auto` 的那些，也就是
     *  「某一集认出货架上这份是自己的」。没被任何一集认下的货架文件在这里一律无动作、无行——
     *  所以这里的 `origin` 恒为 `authority`，不是省事写死的常量。 */
    const origin = 'authority' as const
    const note = (f: RFile, verdict: LedgerVerdict, basis: string, episode: string, action: PlanAction | null) => {
      rows.push({
        path: f.path, size: f.size, ...(f.durationS != null ? { durationS: f.durationS } : {}),
        verdict, origin, episode, basis, action: describe(action),
        ...(explains.has(f.path) ? { explain: explains.get(f.path)! } : {}),
      })
      if (action) reviewActions.push({ ...action, origin })
    }
    for (const [leftKey, a] of assignments) {
      if (a.status !== 'auto') continue
      const entry = entryByKey.get(leftKey)!
      const hit = byPath.get(a.rightFile)
      if (!hit || replaced.has(hit.path)) continue
      const losers = (a.losers ?? []).flatMap((p) => {
        const f = byPath.get(p)
        return f && !replaced.has(f.path) ? [f] : []
      })
      if (!needsSupply(leftKey)) {
        // 整集冗余：源站放得出，货架上这一集的每一份都没有存在价值（同主池的 loser 分支）。
        for (const f of [hit, ...losers]) {
          const basis = `redundant-free:${leftKey}`
          note(f, 'claimed', basis, entry.title, { kind: 'delete-redundant', src: f, basis, episode: entry.title, ...noTrashMark })
        }
        continue
      }
      const incumbent = claimedPathOfKey.get(leftKey)
      if (incumbent !== undefined) {
        const kept = slotByPath.get(incumbent)!
        const basis = `shelf-copy-of:${incumbent}`
        note(hit, 'copy', basis, entry.title, {
          kind: 'delete-loser', src: hit, keptPath: incumbent, basis, episode: entry.title,
          compare: pairCompare({ f: hit, inLib: false }, kept, leftKey),
        })
        continue
      }
      const basis = `relisted:${leftKey}`
      // 同上：没传 leftKey/landingName——tmdb 绑定没有第二货架，季模式的落点/前缀在这条回流路上
      // 今天不生效（不可达）；接第二货架时要补。
      const action = place({ f: hit, inLib: false }, destinationFor(hit.name), basis, entry.title)
      note(hit, 'claimed', basis, entry.title, action?.kind === 'move' ? action : null)
    }
    return { checked: shelf.length, rows }
  }
  const secondaryReview = reviewSecondary()

  /**
   * **换槽位一轮做完**：占位那份本轮就要被删，等位那份不必再等下一轮。
   *
   * 为什么过去要两轮：占位表（`occupied`）是**动手前的磁盘快照**，不含"这个位置本轮会腾出来"，
   * 于是 `place` 一律降级 `swap-hold`；而执行器把删排在搬后面，就算硬排也会先搬、撞名 403。
   * 两头各修一半——这里补计划、`executePlan` 把删提到搬前面并认 `evicts` 这个前置条件。
   *
   * 提升的条件卡得很死，每一条都是"宁可多等一轮"：
   *  · 占位者本轮被**无条件地删掉**——只认 `delete-dup`（字节全等）和 `delete-redundant`
   *    （源站自己放得出）。`delete-loser` 是确认档，定时轮会跳过它，把等它的搬运摆进
   *    「可以自动完成」就是说了句假话；何况那一档本来就要人点头，早一轮晚一轮无所谓。
   *    被 `move` 搬走的也不算：那两条都是搬运，AList 批量搬按 (源目录 → 目标目录) 分组、
   *    组间顺序不保证，排进同一轮就是在赌顺序。
   *  · 挡着它的等位**只有一条**。同一份占位者挡着好几条时（同集的几份都指着货架上那一份），
   *    挑哪一条进去是"哪份质量更好"的择优，不是这个 pass 该下的判断——全都留着，下一轮那个
   *    位置空了，它们照常走同集择优那条路。
   *  · 位置**真的空得出来**：本轮结束时目标目录里既没有同名的、也没有同集的（磁盘上留下的
   *    + 本轮规划搬进去的，两边都算）。**不能直接查 `occupied`**——占位者自己就在里面，一查
   *    必然命中、一条也提升不了（这里真栽过一次，pass 写完是死代码）。所以在这儿按"删完之后
   *    还剩什么"重算一遍。
   *
   * `evicts` 把前置条件带给执行器：确认档的删在定时轮被跳过、或者删失败时，这条搬运也必须
   * 跟着不跑。少了它，`losers:false` 那一轮就会对着一个还没删掉的同名文件搬进去。
   */
  const freeSlotPass = () => {
    const allActions = [...decisions.map((d) => d.action), ...reviewActions].filter((a): a is PlanAction => a != null)
    const removed = new Set<string>()
    for (const a of allActions) {
      if (a.kind === 'delete-dup' || a.kind === 'delete-redundant') removed.add(a.src.path)
    }
    if (!removed.size) return

    /** 本轮结束时某个目录里会有哪些文件名 / 哪些集：删掉的不算，搬进去的算。 */
    const after = new Map<string, { names: Set<string>; keys: Set<string> }>()
    const bucket = (dir: string) => {
      const b = after.get(dir) ?? { names: new Set<string>(), keys: new Set<string>() }
      after.set(dir, b)
      return b
    }
    /** 「这份文件算哪一集」——与占位表同一把尺：影视档用匹配器给的 leftKey，没配上的退回
     *  `目录|名字身份`（跨目录的同名文件因此各占各的，不会互相当成同一集）。 */
    const episodeKeyOf = (f: RFile) =>
      input.seasonFolders
        ? claimedByPath.get(f.path) ?? loserByPath.get(f.path) ?? `${dirOf(f.path)}|${identity(f.name).key}`
        : identity(f.name).key
    const settle = (dir: string, f: RFile, landingName?: string) => {
      const b = bucket(dir)
      b.names.add(landingName ?? f.name)
      b.keys.add(episodeKeyOf(f))
    }
    // 原地改名（不挪窝）本轮结束时的落地名——磁盘快照那个循环得知道这一件事，否则一份改完名的
    // 文件在 `after` 里仍按旧名占位，等位那条明明会撞新名却查不出来。
    const renamedTo = new Map<string, string>()
    for (const a of allActions) if (a.kind === 'rename') renamedTo.set(a.src.path, a.newName)
    for (const f of [...input.libClaimedFiles, ...(input.libSecondaryFiles ?? []), ...input.sourceFiles]) {
      if (!removed.has(f.path)) settle(dirOf(f.path), f, renamedTo.get(f.path))
    }
    for (const a of allActions) {
      if (a.kind === 'move' || a.kind === 'replace') settle(a.dstDir, a.src, a.newName)
    }

    const waiters = new Map<string, Decision[]>()
    for (const d of decisions) {
      const a = d.action
      if (a?.kind !== 'pending' || a.pendingKind !== 'swap-hold' || !a.blockedBy) continue
      waiters.set(a.blockedBy, [...(waiters.get(a.blockedBy) ?? []), d])
    }
    for (const [occupant, list] of waiters) {
      if (!removed.has(occupant) || list.length !== 1) continue
      const d = list[0]
      const held = d.action as Extract<PlanAction, { kind: 'pending' }>
      const dst = dirOf(occupant)
      const b = bucket(dst)
      // 影视档：这条搬运是主循环那条 `swap-hold` 的兑现，前缀得跟着一起兑现——否则位置腾出来了、
      // 名字却退回没编号那一档，下一轮还要再改一次名。
      const promotedKey = claimedByPath.get(d.slot.f.path)
      const se = promotedKey ? seasonOf(promotedKey) : null
      const newName = se && !seasonEpisodeOfName(d.slot.f.name) ? `${episodePrefix(se)} - ${d.slot.f.name}` : undefined
      const landing = newName ?? d.slot.f.name
      if (b.names.has(landing) || b.keys.has(episodeKeyOf(d.slot.f))) continue
      settle(dst, d.slot.f, newName)
      d.action = {
        kind: 'move', src: d.slot.f, dstDir: dst, evicts: occupant,
        basis: `freed-by:${occupant}`,
        ...(newName ? { newName } : {}),
        ...(held.episode ? { episode: held.episode } : {}),
        origin: d.origin,
      }
    }
  }
  freeSlotPass()

  const counts: RunCounts = { input: pool.length, claimed: 0, offline: 0, copy: 0, hold: 0, dup: 0, exempt: 0 }
  for (const d of decisions) counts[d.verdict]++
  /**
   * 主池的证据卡数据。**豁免/字节全等那两档的文件没有**——它们跑在匹配器之前，压根没进过证据图，
   * 强行给它们编一份 explain 就是无中生有。缺席是合法状态，读侧不许假设它存在（见 `LedgerRow`）。
   */
  const explains = explainsOf(resolution, (p) => slotByPath.get(p)?.f, episodeOf)
  const sum = counts.claimed + counts.offline + counts.copy + counts.hold + counts.dup + counts.exempt
  return {
    // 复核出来的动作与主池的混在同一份清单里——执行器不关心一条动作是谁判出来的（`move` 就是
    // `move`、`delete` 就是 `delete`），分两份只会让每个消费者都得记得合并一次。
    actions: [...decisions.map((d) => d.action).filter((a): a is PlanAction => a !== null), ...reviewActions],
    ambiguities: ambiguous,
    rows: decisions.map((d) => ({
      path: d.slot.f.path,
      size: d.slot.f.size,
      ...(d.slot.f.durationS != null ? { durationS: d.slot.f.durationS } : {}),
      verdict: d.verdict,
      origin: d.origin,
      ...(d.episode ? { episode: d.episode } : {}),
      basis: d.basis,
      action: describe(d.action),
      ...(explains.has(d.slot.f.path) ? { explain: explains.get(d.slot.f.path)! } : {}),
    })),
    counts,
    conservation: counts.input === sum,
    secondaryReview,
    authority: authorityStats(entries),
  }
}

/**
 * 问句的文案。四种理由问的是同一件事（"它是不是这一集"），差在**证据缺口在哪一侧**——
 * 文案必须把那个缺口说出来，否则用户面对的是四张长得一样、却来自不同证据的卡片。
 * 分派只看机器可读的 `reason`（`SpecAmbiguity['reason']`），**绝不解析文案**。
 */
function askReason(reason: AskReason, title: string): string {
  if (reason === 'low-confidence') {
    return `名字像「${title}」但没到把握——够不着"直接认下来"那条线。是这一集就认领，不是就挪去下架。`
  }
  if (reason === 'duration-contradiction') {
    return `名字与「${title}」对得上，时长却差出量级——可能是分享者贴错了名字，也可能是节目单时长不准`
      + `或这份被截断了。机器分不出，先不动它：是这一集就换正主，不是就挪去下架。`
  }
  if (reason === 'name-floor') {
    // **不写"完全不沾"**：`name-floor` 的判据是名字相似度没过 `DURATION_MIN_SIM` 这条地板线
    // （`match-engine/rules.ts` R3），不是"一个字都不重合"——两串都长的时候，共享好几个字也照样
    // 过不了地板。写成"完全不沾"是把门槛没过夸张成毫无关系，读的人（和模型）会据此排除掉一个
    // 其实沾边的候选。活体撞过：文件名与剧集同含「肯x基灵异」，这句话却说它完全不沾。
    return `时长与「${title}」对得上，名字的相似度却没过地板线（不是毫无关系，是没到能直接认下来的`
      + `程度）——长音频撞时长很常见，这点证据不足以判定是同一集。是这一集的另一版就换正主，不是就挪去下架。`
  }
  return `时长与「${title}」对得上，名字却不够把握（${reason === 'no-margin' ? '几个候选拉不开差距' : '相似度没到门槛'}）`
    + `——这点证据不足以判定是同一集。是这一集的另一版就换正主，不是就挪去下架。`
}

/**
 * 一条证据边**量到了什么**，压成一句短标签给 `evidence-conflict` 的问句用。
 *
 * 由事实渲染，**不写结论**（spec §5.3）：说"时长命中"是因为图里真有一条 `duration.hit`，
 * 说"名字全等"是因为清洗后两串逐字相同。一条都不沾时露出"无可裁决证据"这句实话，
 * 别编一个像模像样的理由——上一次事故就是文案与判据两张皮。
 */
function evidenceTag(facts: Fact[]): string {
  const tags: string[] = []
  if (facts.some((f) => f.kind === 'duration' && f.state === 'hit')) tags.push('时长命中')
  const key = facts.find((f): f is Extract<Fact, { kind: 'struct-key' }> => f.kind === 'struct-key')
  if (key) tags.push(`${key.key}=${key.value}`)
  const name = facts
    .filter((f): f is Extract<Fact, { kind: 'name' }> => f.kind === 'name')
    .sort((a, b) => b.score - a.score)[0]
  if (name) tags.push(name.method === 'identity-exact' ? '名字全等' : `名字 sim ${name.score.toFixed(2)}`)
  if (facts.some((f) => f.kind === 'duration' && f.state === 'contradict')) tags.push('时长矛盾')
  return tags.join('·') || '无可裁决证据'
}

function describe(a: PlanAction | null): string {
  if (!a) return 'none'
  // 带 newName 的搬运落地后是新名字——账本行只写目录就对不上盘上那份文件，复盘时查无此路径。
  if (a.kind === 'move') return a.newName ? `move:${a.dstDir}/${a.newName}` : `move:${a.dstDir}`
  if (a.kind === 'rename') return `rename:${a.newName}`
  if (a.kind === 'delete-dup') return `delete:${a.dupOf}`
  if (a.kind === 'delete-loser') return `delete:${a.keptPath}`
  // 留下的那份不是文件，是源站——这一档没有"留哪个路径"可写，别硬塞一个空串冒充路径。
  if (a.kind === 'delete-redundant') return 'delete-redundant'
  // 换正主时若顺手加了前缀，落地名不是 `src.name` 而是 `newName`——只写 oldPath 说不出新的那份
  // 落到了哪里，复盘时查无此路径（同 `move` 那一句道理）。
  if (a.kind === 'replace') return a.newName ? `replace:${a.oldPath}→${a.dstDir}/${a.newName}` : `replace:${a.oldPath}`
  return `pending:${a.pendingKind}`
}

/** 熔断阈值：单目录内可疑占比过半、且绝对数 ≥5，才够得上"这个目录不像本节目的"。绝对数下限挡
 *  小目录误伤（3 个文件里 2 个下架是正常尾巴，不是认错目录）。常量，不做配置项。 */
const SUSPECT_RATIO = 0.5
const SUSPECT_MIN = 5

/**
 * suspect-dir 熔断：认领把配置降成一次点击后，误指父目录（下辖十几个播客）的概率上升；别的节目的
 * 文件在本节目的账本里时长零命中 → 会被成批判成"本节目的下架集"搬走。单目录内可疑占比过阈值时，
 * 把该目录**已有的**动作全部降级为 pending，一条都不自动执行（无动作的行不凭空长出动作来）。
 *
 * 可疑 = **判进第二货架的那些**（搬过去、或与架上同集那份择优出的删/换/待裁，判定筐都是 `offline`）
 * 加上 `no-duration` 的 pending。认领、同集替换都不算——它们恰恰是"认出了本节目的集"的正信号。
 * 分母 = **该目录内来源文件总数**，不是"产出了动作的文件数"：被豁免、或
 * 已在该在位置而无动作的文件也是"认出它属于本节目"的正信号，必须留在分母里压低占比，否则一个
 * 大量豁免的目录会因为分母被抽空而误触发。
 *
 * 已知会在新模型下过敏（"进下架"成了常态结果，占比判据失真，见 spec §7.1）——过敏的代价只是多问，
 * 不是错搬，所以判据先维持不动。
 *
 * **判不出季的文件夹整段不进这道闸的分子，也不进分母**（`isSeasonUnresolved`）：这道闸问的是
 * "这个目录里的文件认不认得出是本节目的"，而那些文件一次都没被判过——对这个问题一个字都答不上。
 * 留在分母里会把占比稀释到熔断哑火（真有 5 份认不出、旁边摞着 6 份没判过 → 5/11 不触发）。
 */
function suspectDirPass(decisions: Decision[], input: PlanInput): void {
  const dirs = input.sourceDirs ?? []
  if (!dirs.length) return
  const dirFor = (p: string) => dirs.find((d) => p === d || p.startsWith(`${d}/`))
  const suspicious = (d: Decision) =>
    !!d.action && (d.verdict === 'offline' ||
      (d.action.kind === 'pending' && d.action.pendingKind === 'no-duration'))
  const notJudged = (p: string) => isSeasonUnresolved(input, p)

  const badByDir = new Map<string, number>()
  for (const d of decisions) {
    if (notJudged(d.slot.f.path)) continue
    const dir = dirFor(d.slot.f.path)
    if (dir && suspicious(d)) badByDir.set(dir, (badByDir.get(dir) ?? 0) + 1)
  }
  const totalByDir = new Map<string, number>()
  for (const f of input.sourceFiles) {
    if (notJudged(f.path)) continue
    const dir = dirFor(f.path)
    if (dir) totalByDir.set(dir, (totalByDir.get(dir) ?? 0) + 1)
  }
  const tripped = new Map<string, { bad: number; total: number }>()
  for (const [dir, bad] of badByDir) {
    const total = totalByDir.get(dir) ?? bad
    if (bad >= SUSPECT_MIN && bad / total > SUSPECT_RATIO) tripped.set(dir, { bad, total })
  }
  if (!tripped.size) return
  for (const d of decisions) {
    if (!d.action) continue
    if (notJudged(d.slot.f.path)) continue // 没判过的不该被"降级"成一句关于本节目的判断
    const dir = dirFor(d.slot.f.path)
    const hit = dir ? tripped.get(dir) : undefined
    if (!hit) continue
    const priorVerdict = describe(d.action)
    d.action = {
      kind: 'pending', src: d.slot.f, pendingKind: 'suspect-dir',
      // 熔断换的是**处置**，不是来路：这条建议本来是怎么来的照旧要说清，否则降级一次就丢了。
      origin: d.origin,
      // 同一句话的两个形态：`reason` 是给人读的整句（前端在用，不动），`suspect` 是同一份内容的
      // 结构化版本，好让 agent 面按目录归组、不必把公共那半句复制 N 遍。两者由这一处同时写出，
      // 不会各说各的。
      suspect: { dir: dir!, bad: hit.bad, total: hit.total, priorVerdict },
      reason: `目录疑似认领错误：${dir} 内 ${hit.bad}/${hit.total} 个文件认不出属于本节目——确认无误可逐条裁决。原判定：${priorVerdict}`,
    }
  }
}
