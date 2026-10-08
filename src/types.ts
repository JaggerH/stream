export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path?: string
  expirationDate?: number
  secure?: boolean
  httpOnly?: boolean
}

export interface StreamItem {
  id: string                    // deterministic hash, dedup key
  stream_id: string              // e.g. "rsshub:example:dynamic:2267573"
  /** source manifest id (e.g. "foo-user") — stable canonical key for the
   *  UI's translatable source label; distinct from stream_id (the dedup key).
   *  Optional: items persisted before this field existed won't carry it. */
  source_id?: string
  /** 本季在合并剧里的季号——从产出这条 item 的 Stream member 的 `season` 标签原样落盘
   *  （见 `StreamMember.season`）。缺省 = 这个 Stream 没有本地季分组。 */
  season?: number
  source_type: 'rsshub-bridge'
  source_route: string           // e.g. "/example/user/dynamic/2267573"
  fetched_at: string             // ISO timestamp (when we fetched)

  timestamp: string              // item.pubDate (when content was published)
  title: string
  url?: string
  author?: string
  author_avatar?: string
  comment_count?: number
  like_count?: number
  body_html?: string
  body_text?: string
  attachments?: string[]

  // set by the deterministic ad-filter when the item matches a keyword/domain
  // rule; the UI folds (does not drop) muted items. `rule` names the match.
  muted?: import('./content/ad-filter.ts').MutedFlag

  // normalized presentation model (archetype + typed media), filled by a normalizer
  content?: import('./content/types.ts').Content
  /** Discovery-source facts for video identity resolution; kept separate from presentation. */
  videoRef?: import('./video/types.ts').VideoReference
  // 留给上层 (wiki/topic 层) 填，stream 层不动
  facts?: unknown[]
  topics?: string[]
  density?: number

  raw: unknown                   // 完整 RSSHub DataItem (for replay)
}

export interface StreamConfig {
  id: string
  rsshub_path: string
  cadence_seconds: number
  vault_subdir: string
}

export interface AppConfig {
  /**
   * 采集用的浏览器怎么唤起（ext-cdp 档）。全省略 = 按默认路径拉起 Chrome 的默认 profile。
   * 字段与 host-agent 的 `ensureApp` 同形；`profile_directory` 是 Chrome 的
   * `--profile-directory`（`Default` / `Profile 1`），**不是 `--user-data-dir`**——后者会另开
   * 一份空 user data，没有登录态也没有扩展，等于把采集又搬出用户的浏览器。
   */
  harvest_browser?: {
    exe?: string
    profileDirectory?: string
    args?: string[]
    process?: string
  }
  vault_root: string
  /** write markdown files to vault_root (default true); app still uses item_db */
  vault_enabled: boolean
  dedup_db: string
  /** item read-model db (default ./data/items.db) */
  item_db: string
  /**
   * 内置 Stream 包目录（default `./packages`）。插件包与 recipe 包住在同一层——
   * 一个包填哪些槽位（`backend` / `code` / `manifests.yaml` / `*.recipe.json`）决定它
   * 被哪个投影消费，而不是它住在哪个目录。
   * 用户装的第三方包**不在这里**，在 `<dataDir>/recipes/`（名字是历史布局，装载器一视同仁）。
   */
  packages_dir: string
  /** RSSHub built route catalog json (default derived from RSSHUB_PKG) */
  rsshub_catalog: string
  /**
   * 启动时由**后端自己**把声明了 backend 的插件容器备齐（没有就建、停着就起）。
   * **默认关闭**：今天容器由 `docker compose up -d` 起，打开这个开关等于把那些容器的
   * 生命周期交给后端，是一个要用户自己点头的事。发行版用户没有仓库、也没有 compose CLI，
   * 那条路才需要它。
   * 关着 = 与接这条线之前一字不差（零 docker 写操作）。
   * env 覆盖：`STREAM_MANAGE_CONTAINERS=1`。打开后，镜像与声明对不上的容器会被**删了重建**
   * ——要保的状态必须声明成卷（见 src/plugins/provision-wire.ts 与 docs/PACKAGE.md §4.1）。
   */
  manage_containers?: boolean
  /**
   * 能力包（`stream.capability` 槽位）的配置，**按能力名索引**（不是包名——一个包申报自己叫
   * 什么，见 `Capability.name`）。宿主原样透传给 `mount(ctx, config)`，自己不解释里面一个字：
   * 那是包与它的用户之间的约定，宿主插一脚就得跟着包的版本走。缺席 → 每个能力拿到 `{}`。
   */
  capabilities?: Record<string, unknown>
  /** base url of the MinerU document-parsing backend; unset → MINERU_URL env or the
   *  bootstrap-injected plugin target (compose mode: container DNS). A remote relay
   *  url here = the cloud (paid) tier. */
  mineru_url?: string
  /** 覆盖自动生成的访问令牌（`data/api-token`）。局域网/远程访问要出示它；本机免密。 */
  api_token?: string
  /**
   * 允许出现在 `Host` 头里的**域名**（自托管挂了域名/反代时填，如 `stream.example.com`）。
   * 默认只认 IP 字面量和 localhost —— 这条是防 DNS rebinding：攻击者把自己的域名解析到
   * 127.0.0.1，用户浏览器一访问，Origin 和 Host 就都是他的域名、"同源"判据照样成立。
   * 域名必须显式登记，才拆得掉这条路。
   */
  trusted_hosts?: string[]
  /** deterministic item-level ad filter; matched items are folded, not dropped */
  ad_filter?: import('./content/ad-filter.ts').AdRules
  /** path to the audio archive SQLite db (default: sibling of item_db) */
  audio_archive_db: string
  /** root directory for archived audio files（缺省 `<Stream 根目录>/music`；config.yaml / AUDIO_ARCHIVE_ROOT 覆盖） */
  audio_archive_root: string
  /**
   * 采集标签（lane）的并发预算。缺省 = 每 facility 4、全局 8（`RecipeSessionManager` 的默认）。
   *
   * **`per_facility` 不是性能旋钮，是「像不像一个人」的闸门**——同一个站点上同时开着几个标签，
   * 是这条链路上最容易被站方看出来的特征。调它之前先想清楚你愿不愿意在那个站上冒这个险；
   * 而 `global` 才是资源那一侧的东西（用户浏览器里的标签总数）。
   *
   * 两个上限都是 best-effort：只有**空闲**的 lane 会被淘汰出来腾位子，真的并发压上来时管理器
   * 宁可超售也不阻塞正在跑的采集（见 `SessionBudget` 的头注）。
   *
   * 什么时候需要动它：一次性的搜索 recipe（Google/Brave/baidu）是开一个标签、读完就关，
   * 并发几发只是几个短命标签——实测 6 发并发总墙钟 9s。要让 `search_agent` 那种一轮 12–18 条
   * 查询跑得动，就是调这里。
   */
  browser_lanes?: { per_facility?: number; global?: number }
  /**
   * host-desktop Engine（`/api/host` 的 `WsHostRelay`）的会话租约排队上界。
   *
   * 默认 180s（一趟桌面 recipe 十几个 op，排在后面的要给足够宽的窗口）——但这个天花板正是
   * "整趟 recipe 串行化"这个机制本身带来的：桌面 source 数量 × 单趟耗时一旦逼近它，排在
   * 后面的源每轮都拿不到租约，表现和"这个源本来就没有新内容"完全一样（查不到也不会告警——
   * debug bus 的 `host-agent` 频道会记一条 `sessionQueueTimeout`，但没人盯着就还是漏）。
   * source 数量多、单趟耗时长时调小它——**代价是**排队更容易因为撞上一趟正常的长 recipe
   * 而超时（本来会等到、现在提前放弃），需要配合调度侧的重试频率一起看。
   *
   * **改名时核过前提**：曾以「用户 config.yaml 里已经写下了它、改名会静默丢掉这一格」为由
   * 保留旧名 `host_agent`，2026-09-07 逐台核实——开发机的 `config.yaml`、`config.example.yaml`、
   * 文档、mac 那台（连 config.yaml 都没有）**全都没有这个键**，前提不成立，于是跟着产品名改。
   * 真有人写过旧名时的表现仍然是静默回落到默认值，所以将来再改这一格，先去核，别再照抄这句。
   */
  desktop?: { session_wait_ms?: number }
  /**
   * 登录态导出（`src/credentials/session-export.ts`）：把宿主手里某个域的登录态，按一个
   * 进程外消费者的约定写成磁盘文件，由内置任务 `session-export` 周期刷新。
   *
   * **只在 config.yaml 里声明**——它把凭证写到磁盘上一个任意路径，声明面留在配置文件里就
   * 意味着必须有人在这台机器上编辑过它。缺省（不写）= 整条能力不装配，零行为变化。
   * 声明的每个 `domain` 会自动并进 requiredCookieDomains（否则扩展根本不取那个域）。
   */
  session_exports?: import('./credentials/session-export.ts').SessionExportSpec[]
}
