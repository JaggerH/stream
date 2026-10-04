export interface SourceBinding {
  plugin: string
  source: string
  params: Record<string, unknown>
  /** 本季在这部合并剧里的季号——纯展示/分组标签，不参与 TMDb leftKey、不进网盘匹配。
   *  缺省 = 这个 member 不属于任何"本地季分组"。 */
  season?: number
}

export interface StreamRecord {
  id: string
  label: string
  strategy: 'fanout' | 'exclusive'
  cadence_seconds: number
  members: SourceBinding[]
  contract?: Record<string, unknown>
  /** vault_subdir / mode / ad_filter / autoDownload — Stream 附属字段的家。
   *  另含 T1 收割策略（opt-in，ARCHITECTURE.md Data Scheduling → Harvest policy）：
   *  `harvest?: { backfillLimit?: number, incrementalLimit?: number }` — 首收（流从未入库）
   *  注入 backfillLimit，之后注入 incrementalLimit；成员显式绑定的 limit 压过注入值。
   *  options 是自由 JSON，无 schema 迁移。 */
  options: Record<string, unknown>
}

/** Provider 能力分类：决定输入/输出签名与默认 strategy（timeline 不在此——那是 Stream）。 */
export type ProviderCategory = 'search' | 'resolve' | 'download' | 'transform' | 'transcribe' | 'llm' | 'metadata' | 'images' | 'data'

/** Provider 成员引用二型：manifest 源（进程内能力也是源——builtin adapter）/
 *  从 provides 声明实时派生的 auto 段。成员一律是 Source（方案 A，2026-07-03）。 */
export type ProviderMemberRef =
  /** source: 一个具体源。可选 `name` = **实例名**——同一个 source 可以带不同 params 多次进同一行
   *  （如一个 llm-openai 源开 deepseek / kimi 两个实例）。全链路寻址键（去重 / exclude / reorder /
   *  调用账本 byMember / via / misses）= `name ?? source`；`source` 始终是真源 id（fetch、manifest、
   *  health 按它查）。不写 name 时寻址键退化为 source，与实例名引入前逐字节一致。 */
  | { source: string; name?: string; params?: Record<string, unknown> }
  /** provides: expands to every source declaring this provides tag (registry.providersOf,
   *  failover order); params (with $input holes) ride onto each expanded member — symmetric
   *  with the matches segment (content-search threads {mode:'search', keyword:'$input'} this way). */
  | { mode: 'auto'; provides: string; params?: Record<string, unknown> }
  /** matches: expands to every source whose manifest.matchers contains this exact RSSHub-Radar
   *  pattern (registry.matching); params (with $input holes) ride onto each expanded member. */
  | { mode: 'auto'; matches: string; params?: Record<string, unknown> }
  /** category: expands to every source whose manifest.categories contains it AND declares key_param
   *  (registry.inCategory); each member gets `{ [key_param]: '$input' }` plus the segment params.
   *  播客源解析用它——成员名单归目录，不归源码。 */
  | { mode: 'auto'; category: string; params?: Record<string, unknown> }
  /** provider: composition — this member IS another Provider, resolved by recursively invoking it
   *  (black box: the child's own strategy/gate/dedup stay internal). Guarded against self-reference,
   *  cycles, and over-depth in the executor. See provider-composition delta spec. */
  | { provider: string; params?: Record<string, unknown> }

/** `expand` 组合子配置（依赖式 A→B fan-out）。map 把 A-item 的字段映射成 B 的 params；
 *  assemble 把每个 B-item 装配成一条 link。取值一律是 `$item.<field>` 字段抽取(无任意求值,守红线);
 *  assemble.type 额外允许裸分类器名 `pathClassify`(= classifyLink(url) 按链接路径判 magnet/quark/…)。
 *  **PROVISIONAL:契约按第一个消费者(btbtla)够用而定,待第二个"搜索出壳、详情出货"源出现再收敛。** */
export interface ExpandSpec {
  /** A-item 字段 → B 的 params。例 `{ detailUrl: '$item.detailUrl' }` */
  map: Record<string, string>
  /** B-item → 一条 link。例 `{ url: '$item.link', type: 'pathClassify', desc: '$item.title' }` */
  assemble: { url: string; type: string; desc: string }
  /** A 的 handle 展开上限(默认 20)。 */
  handleCap?: number
  /** B 钻取的有界并发(默认 5)。 */
  concurrency?: number
}

/** 一行 Provider 定义（与 StreamRecord 同构的用户配置行）。
 *  serves = 路由键声明（'*' 兜底）；调用点只带 category + 键提取函数，分发靠声明匹配。 */
export interface ProviderRecord {
  id: string
  label: string
  description: string
  category: ProviderCategory
  serves: string[]
  strategy: 'sequential' | 'concurrent' | 'expand'
  members: ProviderMemberRef[]
  /** 仅 strategy:'expand' 用:依赖式 A→B 组合子配置(见 ExpandSpec)。 */
  expand?: ExpandSpec
  /** 结果合同（命名策略引用，如 {accept:'lossless'}）；null = 接受任何结果 */
  contract?: Record<string, unknown> | null
  /** exclude: string[] 等运行调节 */
  options: Record<string, unknown>
  /** System-reserved provider rows are stored in stream.db but cannot be deleted by user CRUD.
   *  boot ensures they exist (seed-backfilled if missing); members/options stay user-editable. */
  system?: boolean
}

/** A user-owned edge from a code-declared Provider callsite to its selectable implementations. */
export interface ProviderBinding {
  callsiteId: string
  /** fixed: exactly one; dispatch: ordered matching candidates. */
  providerIds: string[]
  /** 调用点覆盖参数（如 llm 调用点的 model 覆盖）——per-任务 model 覆盖的落点（Task 9 消费）。
   *  put 是整体替换：不带 params 会清掉已有值，不做合并。 */
  params?: Record<string, unknown>
  /**
   * 开机时**已经提过**给这条绑定的默认行 id（我们自己的记账，不是用户数据）。
   *
   * `ensureDefaults` 只并进**没提过**的默认行。没有这一格的话，用户从一个 dispatch 绑定里
   * 删掉某条默认行，每次重启它都会长回来——而"补齐新装包的默认行"和"把用户删掉的塞回去"
   * 在代码里是同一个动作，区别只在于这一行提没提过。
   *
   * 缺席（升级前的存量行）当作"一条都没提过"：当下的默认行会被提一次，此后才记账。
   * `putProviderBinding` 对这一格用保留语义而不是整体替换，理由见那里。
   */
  offeredDefaults?: string[]
  updatedAt?: string
}

export type ChannelPresent = 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'

export interface ChannelRecord {
  id: string
  label: string
  /** 消费模式 = Present 注册表 id(原 variant;'mixed' 已在开库迁移中收敛为 'timeline')。 */
  present: ChannelPresent
  stream_ids: string[]
  /** System-reserved channels are stored in stream.db but cannot be deleted by user CRUD. */
  system?: boolean
  options: Record<string, unknown>
  /** 归属的空间（侧栏里频道分组的那一层）。缺省 = `DEFAULT_SPACE_ID`。
   *  **不要把这一层叫"组"**：Stream 里"组"已经有主了——频道本身就是「一组 stream」，
   *  代码里的 `groupedIds` / ungrouped 指的是"这个 stream 有没有被某个频道收编"。 */
  space_id: string
}

/** 分享包里的频道：与 `ChannelRecord` 只差一个 `space_id`。空间是**本机侧栏**的组织方式，
 *  对面机器上没有这一行——带过去只会指向一个不存在的空间，所以它不随包走，导入方一律
 *  落进自己的默认空间。 */
export type SharedChannel = Omit<ChannelRecord, 'space_id'>

/** 空间 = 频道之上的一层，只有名字和次序。**允许是空的**（建完还没往里放频道），
 *  所以它是自己一张表而不是频道上的一个字符串——字符串档的空间在最后一个成员被移走时
 *  会自己消失，那不是用户建它时预期的东西。 */
export interface SpaceRecord {
  id: string
  label: string
  /** 侧栏里的显示次序，小的在前。同值按 id 兜底排，保证顺序稳定。 */
  position: number
  /** 系统空间（默认空间）不可删——删了之后无主频道就没有落点了。 */
  system?: boolean
}

/** 所有频道的默认落点。系统行，随开库自建，不可删。 */
export const DEFAULT_SPACE_ID = 'default-space'

export const DEFAULT_VIDEO_CHANNEL_ID = 'default-video'

// `space_id` 一律给默认空间：这只是**第一次建**这几行时的落点，之后用户把它们挪去别的空间
// 会被 `ensureSystemChannels` 保留（那里显式读当前值回填，见 user-store.ts）。
export const SYSTEM_CHANNEL_RECORDS: ChannelRecord[] = [
  {
    id: 'default-timeline',
    label: '时间线',
    present: 'timeline',
    stream_ids: [],
    system: true,
    options: {},
    space_id: DEFAULT_SPACE_ID,
  },
  {
    id: 'default-audio',
    label: '音乐/播客',
    present: 'audio',
    stream_ids: [],
    system: true,
    options: {},
    space_id: DEFAULT_SPACE_ID,
  },
  {
    id: DEFAULT_VIDEO_CHANNEL_ID,
    label: '影视',
    present: 'video',
    stream_ids: [],
    system: true,
    options: {},
    space_id: DEFAULT_SPACE_ID,
  },
  {
    id: 'default-tasks',
    label: '定时任务',
    present: 'tasks',
    stream_ids: [],
    system: true,
    options: {},
    space_id: DEFAULT_SPACE_ID,
  },
]

/** One ranking stream to seed under the 影视 channel: a single-source fanout Stream
 *  bound to a curated rsshub movie source (packages/rsshub/manifests.yaml). */
export interface VideoRankingSeed {
  id: string
  label: string
  /** 源的**包全名**（宿主代码不吃裸名，见 docs/PACKAGE.md §1.1）。落库成 `{plugin:'rsshub', source}`，
   *  调度时拼成 `rsshub:<全名>`，Registry 第 2 级剥掉前缀后精确命中（`video-ranking-seeds.real.test.ts`）。 */
  source: string
}

/**
 * 影视频道**开箱带哪几条榜单**——这是宿主的产品默认值（频道长什么样），不是某家站的知识：
 * 选哪几条、排什么顺序、给什么标签是宿主替新用户做的判断，站点包没有「把我塞进某个系统频道的
 * 默认种子」这种声明位。源本身（路由、解析规则）住 `packages/rsshub`。只在首次启动种一次
 * （`UserStore.ensureVideoStreams`），已种过的用户库不动。
 */
export const VIDEO_RANKING_STREAMS: VideoRankingSeed[] = [
  { id: 'video-douban-playing', label: '豆瓣 · 正在热映', source: '@streamapp/rsshub/movie-douban-playing' },
  { id: 'video-douban-weekly', label: '豆瓣 · 一周口碑榜', source: '@streamapp/rsshub/movie-douban-weekly' },
  { id: 'video-tmdb-movie', label: 'TMDB · 电影趋势', source: '@streamapp/rsshub/movie-tmdb-trend-movie' },
  { id: 'video-tmdb-tv', label: 'TMDB · 剧集趋势', source: '@streamapp/rsshub/movie-tmdb-trend-tv' },
  { id: 'video-imdb-popular', label: 'IMDb · 热门电影', source: '@streamapp/rsshub/movie-imdb-popular' },
]
