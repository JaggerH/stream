import type { UserStore } from '../store/user-store.ts'
import type { ProviderRecord } from '../store/types.ts'
import { allIdentities, identityOf } from './identities.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'
import { identityServes } from './system/types.ts'

/** System-reserved provider ids — boot guarantees these rows exist and blocks their deletion.
 *
 *  派生自身份表，不另立一份名单：两份名单迟早分家，而分家的症状是「某条系统行不再被当成系统行」
 *  ——没有任何一处会喊。
 *
 *  **函数而不是 const**：表里现在含包声明的行（`src/providers/identities.ts`），而包在装配期
 *  才挂上；模块加载那一刻求值会得到一张只有宿主行的表，而且不会有任何一处报错。 */
export function systemProviderIds(): string[] { return [...allIdentities().keys()] }

/** 页面"调用位置"注记（live 行）——HTTP 视图层拼进 ProviderView.callSites。
 *
 *  **手写这张表只为宿主自己那些行**；包声明的行由 `callSitesOf` 按调用点 label 反查生成，
 *  不在这里手写（手写 = 每装一个包都要改一次源码，正是本次搬迁要消灭的东西）。
 *  spec 2026-09-18-facility-knowledge-stage2-design §2.3 */
export const PROVIDER_CALL_SITES: Record<string, string[]> = {
  'music-search': ['GET /api/search?scope=music'],
  'content-search': ['GET /api/search?scope=content'],
  'resource-search': ['GET /api/search?scope=resources'],
  'subtitle-search': ['GET /api/media/netdisk-subtitle-list（搜）', 'GET /api/media/netdisk-subtitle?track=scrape:…（取）'],
  'video-search': ['GET /api/search?scope=video'],
  'lyrics-search': ['GET /api/resolutions?type=lyrics'],
  'download-resolve': ['GET /api/download-options', 'MCP video_resolve'],
  'video-canonical': ['GET /api/video/works/:key'],
  'video-metadata': ['GET /api/video/works/:key'],
  'video-images': ['GET /api/video/works/:key'],
  // 两个调用方都直接 import fetchUrl 函数，不经这条行：MCP 工具 stream_fetch_url，
  // 和 HTTP 门 `GET /api/media/from-url`（旧名 `?source=url`，与 source=link 同义却产媒体，
  // 误导性命名已改）。
  'fetch-url': ['MCP stream_fetch_url + GET /api/media/from-url（媒体导向的 URL 抓取）'],
  'article-extract': ['POST /api/conversions kind:extract（article 分支）'],
  'podcast-feed': ['makeStreamFromProviderLadder（订阅建流）/ Scheduler 收割'],
  llm: ['POST /api/conversions kind:summary（总结）', '网盘匹配建议/身份裁决', '搜索 agent 的对话关节', '意图跟踪的消化/招募'],
  parse: ['POST /api/conversions kind:extract（ocr 分支：图片/PDF → Markdown）'],
}

/**
 * 这一行出现在哪些调用位置。手写表里有就用手写的（那是宿主行的人话，比调用点 label 更具体）；
 * 没有就按「哪些调用点把它当默认行」反查它们的 `label`。包行走的是后一条。
 */
export function callSitesOf(providerId: string): string[] {
  const written = PROVIDER_CALL_SITES[providerId]
  if (written) return written
  return PROVIDER_CALLSITES.filter((cs) => cs.defaultProviderIds.includes(providerId)).map((cs) => cs.label)
}

/** 这一行的**默认来源**——"给这行加个成员"时该开哪个 source 的配置面。
 *
 *  只有 Stream 自己的代码知道"llm 这行 = 一个 OpenAI 兼容端点"：source manifest 的 `categories`
 *  是**内容分类法**（video / music / social-media…），和 ProviderCategory 只是偶然撞了几个词，
 *  拿它推候选就是建在沙上。所以这里显式声明，和 PROVIDER_CALL_SITES 同性质：关于系统行的代码知识，
 *  在 HTTP 视图层 join 进去，不进 store（不进 store = 不用给存量装机写迁移，也不会被用户改坏）。
 *
 *  两条现役的都是 **perInstance 的 BYOK 端点源**：一个成员 = 一份端点+模型+key，用户要加的永远是
 *  同一个 source 的又一个实例，让他去几百个源的目录里翻出唯一那个纯属折磨。用户自建的行没有默认，
 *  也不该有——没有哪个 source 是它的"正解"。 */
export const PROVIDER_DEFAULT_SOURCE: Record<string, string> = {
  llm: 'llm-openai',
  parse: 'ocr-vlm',
}

/** 待迁移标注（status: planned）——尚未收口为 Provider 的能力，页面单列一区。 */
export const PLANNED_PROVIDERS: Array<{ id: string; label: string; description: string; callSites: string[] }> = [
  { id: 'enrich', label: '内容富化', description: '文章/评论等富化聚合', callSites: ['GET /api/enrich'] },
  { id: 'summarize', label: 'LLM 摘要', description: '字幕/文本摘要生成', callSites: ['POST /api/conversions kind:summary'] },
  { id: 'anchor', label: '锚定查询', description: '单对象 URL/id → 结构化数据（7 源已声明能力，未接线）', callSites: ['无代码分发（声明 capabilities: [anchor]）'] },
]

/** 建行时写进 DB 的整行形状：身份取代码，编排取身份声明的初值。
 *
 *  身份字段照写进 DB 只是因为那几列 NOT NULL——**读侧一律以代码身份为准**
 *  （`ProviderDirectory.merged`），所以行上那份从此是死数据，不是第二个真相源。 */
function rowFor(id: string): ProviderRecord {
  const identity = identityOf(id)!
  return {
    id,
    label: identity.defaultLabel,
    description: identity.defaultDescription,
    category: identity.category,
    serves: identityServes(identity),
    strategy: identity.strategy,
    members: identity.defaultMembers,
    contract: identity.contract ?? null,
    ...(identity.expand ? { expand: identity.expand } : {}),
    // 包出的行盖上「谁声明的」。宿主静态表的行没有这一格——它们归代码，代码删了就是真删了。
    // 清退分支靠它分清「代码删了这条行」与「这一轮这个包没装上」（见 `ensureSystemRows`）。
    options: identity.declaredBy ? { declaredBy: identity.declaredBy } : {},
    system: true,
  }
}

/** 一条行上盖的「谁声明的」，读不出来就是没盖（宿主行、或存量里建于本次改动之前的包行）。 */
function declaredByOf(row: ProviderRecord): string | null {
  const v = (row.options as { declaredBy?: unknown }).declaredBy
  return typeof v === 'string' && v ? v : null
}

/** 一条被清退的系统行：id + 连带清掉的频道槽位引用（供调用方出声）。 */
export type RetiredSystemRow = { id: string; clearedSlots: Array<{ channelId: string; callsiteId: string }> }

/** 一条**保住**的包行：它的包这一轮不在场，所以不清退（调用方出声，否则这份沉默和"没事发生"一样）。 */
export type AbsentPackageRow = { id: string; packageName: string }

/** `ensureSystemRows` 的回执：建了几条、清退了哪几条、因为包不在场保住了哪几条。 */
export type EnsureSystemRowsResult = { inserted: number; retired: RetiredSystemRow[]; keptAbsent: AbsentPackageRow[] }

/**
 * 启动期对系统行的唯一保证，两个方向对称：
 * - **正向**：身份表里有、库里缺的行补上；已有的行只重申 `system` 标志。
 * - **反向（清退）**：`system = 1` 但 id **不在**身份表里的行删掉，并把它从所有频道槽位里摘掉。
 *
 * 用户改过的 members/options/label 永不覆盖；用户自建行是 `system = 0`，清退**永不碰它们**
 * ——哪怕它们的 id 不在身份表里（那本来就是常态）。
 *
 * 清退的判据自证：`system = 1` 说明这一行当初是我们种的，而 id 查不到身份说明那个身份已经被
 * 代码删了，于是这一行的成员指向一个不存在的 source，点下去只会静默失败。它不是用户的数据。
 *
 * **一个例外：包出的行，而那个包这一轮不在场。** 它和"被代码删了"长得一模一样，但成因是暂时的
 * （包 `package.json` 读不动、manifest 撞 id 被逐包摘掉），而清退是永久的。这类行保住并报出去，
 * 判据与 `pruneDeadMembers` 同源（`options.declaredBy` + 调用方给的 `packageLoaded`）。
 *
 * **清退不是「迁移」**：它不读版本号、不改字段语义、不按库里的旧值推新值，只做「代码不再声明的
 * 系统行就不该继续存在」这一条恒真判断，每次启动都成立。选它而不是写一次性迁移脚本，是因为
 * 迁移工作量相同却只治当下这几行——下一次退役还得再来一遍，而下一次没人会记得。
 *
 * 系统行的身份住在代码里（`src/providers/system/`），代码一改就是新身份，库里那几列是死数据。
 * 从 2026-08-16 之前的版本升级要先跑一次带迁移链的旧版，见 README 升级须知。
 *
 * `transcribe` 不在此列——它由 `ensureTranscribeRow` 无条件重写（整份成本阶梯，不按 key 筛，
 * 理由见那儿）。它落库时刻意不写 `system` 列（`system = 0`），而它的 id **在**身份表里，
 * 所以清退判据的两个条件它一个都不满足，永远不会被误清。
 */
export function ensureSystemRows(
  store: UserStore,
  /** 「这个包这一轮装上了吗」——与 `pruneDeadMembers` 同一个谓词，由调用方从 registry 现推。
   *  缺省当作"全都在场"，保持旧行为（清退一切不在身份表里的系统行）。 */
  packageLoaded: (pkgName: string) => boolean = () => true,
): EnsureSystemRowsResult {
  // 合并表取一次给两个循环用：`allIdentities()` 每次都新建一张 Map（宿主表 + 包行），
  // 放在清退循环里就是每条存量行重建一遍。这一趟之内表不会变（装配期单线程，包行在此之前
  // 已经挂好），所以取一次和逐次现取是同一个答案。
  const identities = allIdentities()
  let inserted = 0
  for (const [id, identity] of identities) {
    if (id === 'transcribe') continue
    const current = store.getProvider(id)
    if (!current) {
      store.putProvider(rowFor(id))
      inserted++
      continue
    }
    // 存量行补盖「谁声明的」：这一格在本次改动之前建的包行上没有，而清退判据要读它。
    // 不补的代价是那些行第一次撞上「包没装上」时照旧被永久清掉。
    const needsStamp = !!identity.declaredBy && declaredByOf(current) !== identity.declaredBy
    if (!current.system || needsStamp) {
      store.putProvider({
        ...current,
        system: true,
        ...(needsStamp ? { options: { ...current.options, declaredBy: identity.declaredBy } } : {}),
      })
    }
  }
  const retired: RetiredSystemRow[] = []
  const keptAbsent: AbsentPackageRow[] = []
  for (const row of store.listProviders()) {
    if (!row.system || identities.has(row.id)) continue
    // 「不在身份表里」有两种成因，长得一模一样：**代码删了它**（永久，清掉才对）和
    // **这一轮这个包没装上**（暂时——包 package.json 读不动、manifest 撞 id 被摘）。
    // 后者清掉是不可逆的：行没了、频道槽位被摘、指着它的绑定从此静默不出结果，而
    // `ensureDefaults` 只补「一条绑定都没有」的调用点，永远不会把它补回来。
    // 判据与 `pruneDeadMembers` 同源：那个包这一轮在不在场。
    const declaredBy = declaredByOf(row)
    if (declaredBy && !packageLoaded(declaredBy)) {
      keptAbsent.push({ id: row.id, packageName: declaredBy })
      continue
    }
    const clearedSlots = store.clearProviderFromSlots(row.id)
    store.removeProvider(row.id)
    retired.push({ id: row.id, clearedSlots })
  }
  return { inserted, retired, keptAbsent }
}

/** 一条被清掉的死成员：哪一行、哪个 sourceId、清完是不是回了默认成员。
 *  `movedTo` 在场 = 没清，改指到了内置层唯一同局部名的新全名（源搬了包，见 `pruneDeadMembers`）。
 *  调用方必须把它说出来：静默改指和静默删除一样，是没有痕迹的退路。 */
export type PrunedMember = { providerId: string; sourceId: string; restoredDefaults: boolean; movedTo?: string }

/** `pruneDeadMembers` 要问 registry 的两件事。
 *  - `get`：这个 sourceId 在不在。用 registry 的**解析**（全名/裸名三级），不是字面比较——
 *    裸名成员是合法写法，按字面比就会把一批活着的成员判成死的。
 *  - `builtinIdsByLocalName`：判死的成员搬去了哪。**只数内置层**，第三方层的同局部名源不算。 */
export interface SourceLookup {
  get(id: string): unknown
  builtinIdsByLocalName(localName: string): string[]
}

/**
 * 死成员的新地址：内置层里局部名相同、全名不同的源，**恰好一个**才算。
 *
 * - 0 个：没搬，是真删了 → 照旧删除。
 * - ≥2 个：猜一个就是替用户做了选择 → 照旧删除。
 * - 第三方层的不数：装一个同局部名的包就能接管用户的梯子，把 URL / 音频改发给一个没人审过的包。
 */
function movedTarget(sourceId: string, sources: SourceLookup): string | undefined {
  const hits = sources.builtinIdsByLocalName(sourceId.slice(sourceId.lastIndexOf('/') + 1)).filter((id) => id !== sourceId)
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * 这条成员是**被代码删掉了**，还是只是这一轮没装上？只有前者才准清（判据见 `pruneDeadMembers`
 * 头注）。具名是因为它是这条清理唯一会误伤用户配置的地方，值得单独钉测试。
 */
function removedByCode(
  sourceId: string, sources: SourceLookup, packageLoaded: (pkgName: string) => boolean,
  retiredRoutes: ReadonlyMap<string, string>,
): boolean {
  // RSSHub 目录路由不归任何包（它来自 catalog，随目录刷新增减）——**除非**某个已加载的包
  // 明说它顶掉了这一条（`stream.retires`）。那种情况下留着它就是同一条路由进两次：
  // 包那条源采一遍、目录这条再采一遍，内容搜索出两份重复结果，而没有一处会喊。
  if (sourceId.startsWith('rsshub:')) return retiredRoutes.has(sourceId)
  const cut = sourceId.lastIndexOf('/')
  // 裸名：`Registry.get` 的三级解析照样能找到它，但它不带包名，证不了"哪个包该出它"。
  if (cut <= 0) return false
  if (!packageLoaded(sourceId.slice(0, cut))) return false
  return sources.get(sourceId) == null
}

/**
 * 启动期第二条对称保证：**系统行里指向不存在的源的具名成员清掉。**
 *
 * 与「孤儿系统行清退」（`ensureSystemRows` 的反向分支）同性质——那条管"这一行的身份没了"，
 * 这条管"这一行还在，但它的某个成员指向的源没了"。两者都只做一条恒真判断，每次启动都成立，
 * 所以都不是迁移：不读版本号、不按旧值推新值。
 *
 * **为什么必须有**：`ensureSystemRows` 永不覆盖 members（那是用户可编辑的字段），所以一个源
 * 换了 id、或从一个包搬进另一个包之后，存量库里那条成员就永远指着一个不存在的 id。表现是
 * **静默死**：行还在、界面上看着配好了、没有任何一处报错，只是那个能力再也不出结果。
 * 实例：某个歌词源从 `@streamapp/builtin/` 搬进它自己的包之后，`lyrics-search` 行的存量
 * members 仍写着旧全名 → 歌词静默不出（spec 2026-09-18-facility-knowledge-stage2-design §2.2）。
 *
 * ### 判据是「**代码删掉了它**」，不是「此刻查不到」——这两者差着用户的配置
 *
 * "查不到"有两种截然不同的成因，而它们**长得一模一样**：
 *
 *  - **代码删了它**：源被改名 / 搬进别的包 / 从包里摘掉。这是永久的，清掉才对。
 *  - **这一轮没装上**：用户那个包 `package.json` 读不动（`kernel/plugins/packages.ts` 记一条
 *    failure 就跳过它）、或者它的 manifest 和别人撞 id 被逐包重试摘掉了
 *    （`kernel/plugins/sources.ts` 的 `skipPackage`）。这是**暂时的**——而清掉是永久的：
 *    用户把包修好重启，那条成员也回不来了，因为它已经不在库里。
 *
 * 所以只在**能证明是前者**时才动手，判据三条全中才算：
 *  1. 成员 id 是个全名（`<包名>/<局部名>`）。裸名、`rsshub:` 目录路由都不是包出的，一律留着
 *     （目录路由的唯一例外见下方「其余边界」：被某个已加载包 `retires` 顶掉的那条）。
 *  2. 它的 `<包名>` **这一轮确实装上了**（调用方给的 `packageLoaded`）。没装上 = 缺席是暂时的，留着。
 *  3. 那个包现在**不出**这个 id。
 *
 * 判据 2 的代价是一个刻意的假阴性：一个包的源被删光时它整个从 registry 里消失，于是它名下的
 * 死成员留着不清。宁可留一条清不掉的死成员，也不要删一条用户改不回来的配置。
 *
 * 其余边界：
 *  - 只碰 **system** 行。用户自建行（`system = 0`）里的成员是用户自己写的，我们不替他删。
 *  - 只碰 `{source}` 型成员。`{mode:'auto', …}` 是**现取**的扩展式（provides/matches/category），
 *    它本来就按"此刻有哪些源"展开，没有可指坏的目标。`{provider}` 型指的是另一条行，不是源。
 *  - `rsshub:` 目录路由**默认不清**，例外只有一条：某个已加载的包在 `stream.retires` 里
 *    明说顶掉了它。退役表由调用方现取（包热装之后下一次启动就该按新表来）。
 *  - **搬了包的不清，改指**：判死的成员若在**内置层**里有局部名相同的源、且**恰好一个**（源从
 *    `@streamapp/builtin` 搬进了它自己的包），就把它改指过去，成员上的 params 原样留着；命中 0 或
 *    ≥2 维持删除。只清不改的话，行没空就不会回默认——梯子上那一档永久消失、界面照样"配好了"。
 *    第三方层不数：那会让同局部名的第三方源接管用户的梯子。结果里带 `movedTo`，调用方必须打日志。
 *  - 清完 members 空了 → 回该行身份的 `defaultMembers`。空 members 和"被清干净了"在界面上
 *    长得一样，而回默认至少让这一行还是可用的；用户改回去仍然随时可以。
 */
export function pruneDeadMembers(
  store: UserStore, sources: SourceLookup, packageLoaded: (pkgName: string) => boolean,
  /** 已加载的包退役的目录路由（id → 理由）。**必填、不给默认值**：给了默认值就等于
   *  "忘了传 = 这条规则不生效"，而那是静默的。 */
  retiredRoutes: () => ReadonlyMap<string, string>,
): PrunedMember[] {
  const retired = retiredRoutes()
  const pruned: PrunedMember[] = []
  for (const row of store.listProviders()) {
    if (!row.system) continue
    const identity = identityOf(row.id)
    const dead: string[] = []
    const moved: Array<{ from: string; to: string }> = []
    const kept: typeof row.members = []
    for (const m of row.members) {
      const sourceId = (m as { source?: string }).source
      if (typeof sourceId !== 'string' || !removedByCode(sourceId, sources, packageLoaded, retired)) {
        kept.push(m)
        continue
      }
      const to = movedTarget(sourceId, sources)
      if (to) {
        kept.push({ ...m, source: to } as typeof m)
        moved.push({ from: sourceId, to })
        continue
      }
      dead.push(sourceId)
    }
    if (!dead.length && !moved.length) continue
    const restoredDefaults = kept.length === 0 && !!identity?.defaultMembers.length
    store.patchProvider(row.id, { members: restoredDefaults ? [...identity!.defaultMembers] : kept })
    for (const { from, to } of moved) pruned.push({ providerId: row.id, sourceId: from, restoredDefaults: false, movedTo: to })
    for (const sourceId of dead) pruned.push({ providerId: row.id, sourceId, restoredDefaults })
  }
  return pruned
}

/**
 * `transcribe` 行：**无条件建，整份成本阶梯都写进去**（Groq → Cloudflare → OpenAI）。
 *
 * **为什么不按「此刻有哪些 key」筛**（2026-09-05 改掉的旧写法）：因为筛了也没用，还坏事。
 *
 *  - **没用**：每一档成员在**被调用的那一刻**自己现读 token（`src/transcribe/sources.ts`：
 *    `const token = deps.tokenProvider.token(tokenName); if (!token) return []`），没钥匙就让给
 *    梯子的下一档。运行时压根不需要开机就知道有没有 key。
 *  - **坏事**：一把 key 都没有时旧写法返回 null、这一行**根本不建**，而 `conversions` 域里
 *    整整一批能力（转写 / 说话人识别 / 摘要）挂在「这一行建没建出来」下面。于是用户申请到 key
 *    之后功能仍然不存在，要重启后端才冒出来——活体撞到过（2026-09-04，win-test 干净装机：
 *    一键申请 16.7s 拿到 key、`configured:true`，`branches.stt` 仍然 false，重启才 true）。
 *
 * 旧写法的理由是「怕页面骗人」：三档都写进去，界面上看着像三条腿都配好了，其实两条没钥匙。
 * 那是**显示该解决的事**——每个成员的 keyState 后端本来就逐个算得出来（`/api/providers` 的
 * `members[].keyState`），页面按它标「缺 key」即可。用「不建行」去解决一个显示问题，代价是
 * 把一整批能力的存在与否绑在了启动那一刻。
 *
 * 这一行的 label/members 每次启动都被重写（用户对它的编辑不留存）——这条没变，是旧有行为。
 */
export function ensureTranscribeRow(store: UserStore): ProviderRecord {
  const identity = identityOf('transcribe')!
  // `system` 刻意不写（`rowFor` 给的那个 true 在这里摘掉）：今天 bootstrap 建这一行也不带它，
  // 而它是不是系统行由身份表回答（`ProviderDirectory.isSystem`），不由这一列回答。
  const { system: _system, ...row } = rowFor('transcribe')
  return store.putProvider({ ...row, members: [...identity.defaultMembers] })
}
