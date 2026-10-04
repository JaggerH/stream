/** 对齐层数据模型。一个绑定 = netdisk.db bindings 表一行 + binding_entries 若干行（见 db.ts）。 */

export type EntryStatus = 'auto' | 'pending' | 'confirmed' | 'rejected' | 'unmatched'

export interface Fingerprint {
  /** 字节数，AList fs/list 直接给，必有 */
  size: number
  /** 秒，左侧元数据已知时才有（右侧不探测） */
  duration?: number
}

export interface MappingEntry {
  /** `${platform}:${id}`，与 extractTrackRef 拼法一致 */
  leftKey: string
  leftTitle: string
  /** 相对文件名（不含目录），播放时拼 right.path + '/' + rightFile；unmatched 为 null */
  rightFile: string | null
  fingerprint?: Fingerprint
  confidence?: number
  status: EntryStatus
  /**
   * 人工订正标记（= 一条 ground-truth 样本）。用户在 UI 手动选/清了这条的网盘文件即写入：
   * 存在 ⟺ 「规则没配对，人来纠正过」。`autoFile` 是**首次**订正那一刻规则给的答案（错的文件名，
   * 或 null=规则压根没配上）——保留规则的原始错答，供 agent 之后重训该绑定的 matchSpec（正=rightFile、
   * 负=autoFile）。订正的条目在重同步时被钉住、不被规则重算（见 sync 的 pin 逻辑）。
   */
  corrected?: { at: string; autoFile: string | null }
  /** 最近一次网盘直链失败（静默回落留痕，详情页可见） */
  lastError?: { at: string; message: string }
  /** TMDb 该集播出日期（YYYY-MM-DD，随 sync 从分集索引带下来）。缺席 = 权威没给，**不等于未播出**。 */
  airDate?: string
}

/**
 * 一个匹配阶段（闭集,AI 只能从这些里挑、排序、调参）。执行器按 spec.stages 顺序跑,
 * 每个 stage 只处理上一阶段没配上的左项 + 没被占用的右文件。
 * - epnum:提集号分桶,桶内用标题相似度消歧(= 老的单策略行为)。
 * - title:纯归一化标题相似度,不依赖集号——救"按名字命名、没集号"的条目(如年度特辑)。
 * - episode-part:由 keyRegex 的第 1/2 捕获组提取期号和分段(如上/下集),按复合键分桶后标题消歧。
 * - season-episode:按「季+集」结构键分桶。**左侧从 leftKey 取**(tmdb 键 `tmdb:id:SxxExx` 权威带
 *   季集号)、右侧从文件名按 `fileRegex` 取(场景命名 `S01E02`)——这是剧集网盘文件最常见的配法,
 *   而 epnum(号不在开头)/title(中文标题 vs 英文文件名相似度 0)都够不着它。`fileRegex` 也可以只写
 *   **一个**捕获组(只取集号):适合网盘按季分文件夹、文件本身只剩集号的命名(如 `进击的巨人 S01/
 *   进击的巨人24.mp4`)——递归路径在 `stripper()` 里已被砍到只剩 basename,季号在 regex 阶段本就
 *   不可见,双捕获组无论怎么写都读不到季。单捕获组模式下季号被丢弃、纯按集号分桶,只在季已经被
 *   上游分区隔离干净时才安全——多季 tv 绑定的同步入口(`matchBySeason`,见 season-resolve.ts)已经
 *   保证这一点(左右两侧先按季拆分、每季独立跑一遍匹配管线);直接单季 `dirPath` 绑定同样天然安全。
 * - duration:按**时长**分桶(容差内)。时长是内容自带的,改名/水印/规避字/错编号都改不掉它,
 *   所以它排在全部文件名档之前当主锚,文件名降为二次确认(spec 2026-07-30-duration-primary-anchor)。
 *   没声明时 `specStages()` 会隐式补一档 —— 它是锚不是"某节目的命名规则",不该要求每个绑定
 *   各自记得配上。两侧任一没有时长就整档无信号,原样退回文件名链。
 */
export type MatchStage =
  | { by: 'epnum'; epNumRegex: string; titleStrip: string[]; threshold: number; margin: number }
  /** `toleranceS` 是**秒**(不是 [0,1] 的比例)。缺省 1s —— 同一集在不同转存里差的是编码零头。 */
  | { by: 'duration'; toleranceS: number; titleStrip: string[]; threshold: number; margin: number }
  | { by: 'title'; titleStrip: string[]; threshold: number; margin: number }
  | { by: 'episode-part'; keyRegex: string; titleStrip: string[]; threshold: number; margin: number }
  | { by: 'season-episode'; fileRegex: string; titleStrip: string[]; threshold: number; margin: number }
  /**
   * 电影：目录里**唯一**的视频文件就是它。没有阈值/边际——不做标题相似度，因为片名（中文）
   * 和文件名（英文发布组命名）注定不相似，而目录里根本没有第二个视频文件需要消歧。
   * 只在「左侧恰一行 且 视频文件恰一个」时认领；多于一个一律不猜（避免把正片配成花絮）。
   */
  | { by: 'solo' }

/**
 * 匹配规格（AI 离线产出、挂绑定、可读、确定性执行）。运行时零 LLM。
 * v2:`stages` 为有序多策略管线。v1(legacy):扁平 `epNumRegex/titleStrip/threshold/margin`,
 * `stages` 缺席时由 specStages() lift 成标准 [epnum, title] 管线(旧数据只存过通用默认,lift 安全)。
 */
export interface MatchSpec {
  version: number
  /** v2:有序匹配阶段。 */
  stages?: MatchStage[]
  /** v1 legacy:集号提取正则（第一个捕获组为号）;4 位年份靠前瞻/位数排除。 */
  epNumRegex?: string
  /** v1 legacy:标题归一化剥离片段（前缀/水印）。 */
  titleStrip?: string[]
  /** v1 legacy:标题相似度阈值。 */
  threshold?: number
  /** v1 legacy:撞号时最佳需领先次佳的边际。 */
  margin?: number
  /**
   * **人工覆盖「这条绑定的集要不要人往网盘供货」**——缺席 = 自动算（`AuthorityEntry.needsSupply`，
   * 判据是"这一集自己带没带可播地址"）；填了以填的为准，压过算出来的那一位。
   *
   * 存在的理由是算出来的那一位有够不着的情形：源站给了地址、但那地址早失效；或者音质差到
   * 不能听。人知道、机器不知道。
   *
   * **粒度是整条绑定，不是 leftKey 列表**，这一条是刻意的：订阅流的 leftKey 是 `item:<id>`，
   * item id 会随重新采集变（同 id 重建、renormalize、换 recipe 都动它）。按 id 写死的名单会
   * **悄悄失效**——一个保护用的开关最坏的失败方式就是"看起来还在、其实已经不保护了"。
   * 整绑定一刀切没有键可烂。放在 `matchSpec` 而不是 stream 配置，也是因为供货与否恰恰按绑定
   * 变（同一条 stream 绑到不同目录，策略可以不同）；stream 配置答的是"这个源怎么采"。
   */
  needsSupply?: boolean
  generatedBy?: string
  generatedAt?: string
}

/** 覆盖率报告（两个方向分开：源缺档 vs 文件孤儿）。sync 后算出、存绑定、UI 展示。 */
export interface CoverageReport {
  /** 左（清单）侧：total 全部条目；matched 已配；ambiguous 号命中但标题不敢配；missing 号在但右侧无文件。 */
  left: { total: number; matched: number; ambiguous: number; missing: number }
  /** 右（网盘）侧：total 去水印后文件数；matched 被用上；orphan 没配上任何清单条目。 */
  right: { total: number; matched: number; orphan: number }
  /** 左有右无的集号（升序）——判断“这个网盘源全不全”。 */
  missingEpisodes: number[]
  /** 右有左无的文件名——判断“规则要不要重训 / 内容是否多余”。 */
  orphanFiles: string[]
}

/**
 * 规则编辑的 I/O 契约(surface 无关,HTTP/MCP/前端共用)。改规则的三原语:
 *  - residue:改规则前要看的一切(残差 + 当前覆盖 + 人工订正标签)。生成器输入也取自它。
 *  - preview:一份候选 spec 全量 dry-run 的结果(只算不落)。
 */

/** 一个绑定的残差视图 —— 喂给"谁改规则"都够用(App 内置 LLM 或外部 agent)。 */
export interface SpecResidue {
  /** 当前生效的匹配规格(改规则的起点)。 */
  baseSpec: MatchSpec
  /** 当前规格全量重算出的覆盖率。 */
  coverage: CoverageReport
  /** 没配上的左项(标题 + 可选时长)——规则要救的目标。 */
  unmatchedLeft: { leftKey: string; title: string; durationS?: number }[]
  /** 没被任何左项用上的右文件(去水印规范名代表 + 字节数)——规则可利用的料。 */
  orphanRight: { name: string; size: number }[]
  /** 人工订正样本(带标签评测集):正=该配这个 / 负=该留空。 */
  corrected: { leftKey: string; title: string; rightFile: string | null }[]
}

/** 候选规则会让某条左项从 from 变到 to(null=未配对)。 */
export interface SpecChange { leftKey: string; title: string; from: string | null; to: string | null }
/** 候选规则判定与人工订正对不上 —— 应用时钉住人工的,只提示。 */
export interface SpecConflict { leftKey: string; title: string; ruleSays: string | null; human: string | null }

/** previewSpec 的返回:候选 + 前后覆盖 + 会动的行 + 与人工订正的冲突。只算不落。 */
export interface SpecPreview {
  candidateSpec: MatchSpec
  before: CoverageReport
  after: CoverageReport
  /** 非 corrected 左项里,候选判定 ≠ 当前 rightFile 的条目(面板/agent 眼里"会动的行")。 */
  changed: SpecChange[]
  /** corrected 左项里,候选判定 ≠ 人工所选的条目(应用时人工优先)。 */
  correctedConflicts: SpecConflict[]
}

/**
 * 绑定的左侧 = **集清单从哪来**，不是「一个实体」。判别式描述来源，所以加一种来源只是加一支，
 * 不必给「一部电影/剧集」造一等概念（ARCHITECTURE 是 Five concepts，它不在其中）。
 *
 * 对齐引擎（epnum 分桶 / title 消歧 / episode-part / 指纹 / 人工订正 / coverage）**没有一处
 * 认识这里的任何一支** —— 它只吃 `LeftEntry[]`。这是加左侧来源代价极低的原因。
 */
export type MappingLeft =
  /** 清单来自订阅流（ItemStore 按 streamId 拉）。旧名 'playlist'（词来自音频歌单），读时归一。 */
  | { kind: 'stream'; streamId: string; title: string }
  /**
   * 清单来自 TMDb 权威分集索引——作品不必是 Stream 也能绑网盘。剧集多行，电影一行。
   * `media` 必须存下来：TMDb 的 id 按媒体类型分命名空间（电影 1399 ≠ 剧集 1399），
   * 只有 id 无从判断该打 `/movie/{id}` 还是 `/tv/{id}`，靠探测则是拿歧义当运气。
   */
  /** `year` 随 TmdbWorkRef 一路带下来（Jellyfin 目录名用），存量行里已经存在——类型如实声明。 */
  | { kind: 'tmdb'; id: string; media: 'movie' | 'tv'; title: string; year?: number }

export interface MappingSet {
  id: string
  left: MappingLeft
  right: {
    kind: 'alist-dir'
    /** AList 绝对路径，如 /夸克网盘/我的转存/三体广播剧S2 */
    path: string
    boundAt: string
    /** 「跳转网盘」网页文件夹 URL 缓存（backend 无关）。首次经 netdisk.folder 解析后落盘，避免每次
     *  开详情页都问一次网盘 API。目录改名/移动后失效 → 解析不到会重求。（旧字段 browseFid 已废，
     *  存量绑定 URL 缓存缺失时按未解析处理、重求一次即可。） */
    browseUrl?: string
  }
  rightHistory: Array<{ path: string; unboundAt: string }>
  autoSync: boolean
  lastSyncAt?: string
  entries: MappingEntry[]
  /** 该绑定的匹配规格（缺省用 DEFAULT_MATCH_SPEC）。 */
  matchSpec?: MatchSpec
  /** 最近一次同步的覆盖率（缺席图缺 / 文件孤儿）。 */
  coverage?: CoverageReport
  /**
   * 绑定级健康态：目录在网盘侧已不在（AList `object not found` / `failed get dir`）。resolve 撞该错时
   * 置、下次 resolve 或 sync 成功时清（见 sync.ts noteResolveError/noteResolveOk）。区别于 entry 级
   * `MappingEntry.lastError`（单文件失败留痕、含超时/CDN 抖等临时故障）——`broken` 是整条绑定的终局
   * 信号，只由 object-not-found 触发，`GET /api/netdisk/mappings` 带出、前端 WorkBinding 面板亮出来。
   * 分享导出走白名单投影（collectNetdiskBindings），此字段不进导出（含作者本机 AList 路径）。
   */
  broken?: { at: string; message: string }
  /** 多季 tv 绑定的 LLM 季归属兜底缓存：文件夹名 → 上次判出的季号（或 null=判不出）。只缓存
   *  LLM 那层——结构指纹/嵌套干净名廉价、每次都重新算。文件夹改名会自然产生新 key（不用显式
   *  失效）；文件夹内容增减不影响这份缓存（季归属只认文件夹名，不认文件夹内部有几个文件）。
   *  见 season-resolve.ts 的 ResolveSeasonsDeps.llmSeasonCache。 */
  llmSeasonCache?: Record<string, number | null>
  /** 追更（spec 2026-09-03-work-follow-loop）。缺席 = 不追（存量绑定 / 电影）。tv 绑定新建时默认开。 */
  follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
  /**
   * 轮末裁决器的节流状态（spec 2026-09-03-netdisk-llm-adjudicator §3）。`lastCardsHash` 是上次
   * 问过模型的那批卡片集合的指纹（`adjudicate/cards.ts` 的 `cardsHash`）——指纹相同且 `lastAt`
   * 距今不足 7 天就不再调模型，防止每小时的追更轮重复烧钱问同一批卡。缺席 = 从没裁过。
   */
  adjudication?: { lastCardsHash: string; lastAt: string; lastRunId: string }
}

/** 播放侧反查命中：leftKey → 该文件在哪个绑定的哪个目录 */
export interface PlayableHit {
  setId: string
  dirPath: string
  rightFile: string
  lastSyncAt?: string
}
