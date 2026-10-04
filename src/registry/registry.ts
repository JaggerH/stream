import type { SourceManifest } from '../manifest/types.ts'
import { LexicalSearch, type RankedSource, type SearchBackend } from './search.ts'
import { AmbiguousSourceIdError, localNameOf } from './source-id.ts'
import { affectedSources, type AffectedSourcesResult } from './affected-sources.ts'

const DEFAULT_SEARCH_K = 8

/** 一条歧义解析的记录：裸名命中多条，按「内置优先」挑了一个。**不是错误，是要说出来的降级**
 *  ——第三方装了个同名包之后，一条旧记录的含义并没有变（仍指内置那条），但用户有权知道
 *  这件事发生过；不说出来，日后"我装的那个源好像没生效"就无从查起。 */
export interface AmbiguityNotice {
  localName: string
  chosen: string
  candidates: string[]
}

/**
 * The single source of truth for what sources exist and how to call them.
 * Built from a directory of manifests; answers exact lookup and intent search.
 *
 * **id 是全名**（`<npm 包名>/<局部名>`，见 `source-id.ts`）。裸名（局部名）仍解析得到——
 * 库里的 stream 行、别人分享来的旧 bundle、用户手打的 id 都是裸名，而且**永远**会是
 * （它不是"旧路"，是"短名"，与 shell 在 PATH 里按裸名找可执行文件同构）。四级规则见 `get`。
 */
export class Registry {
  private readonly byId = new Map<string, SourceManifest>()
  private readonly curatedIds = new Set<string>()
  /** 我们**真的以 catalog 身份插进 byId 的**那些 id。被 curated 遮蔽掉的不在里面——
   *  所以换一份 catalog 时绝不会顺手删掉别人的条目。 */
  private readonly catalogIds = new Set<string>()
  private readonly groups = new Map<string, Set<string>>()
  /** 局部名 → 全名[]。只收 curated（含 recipe 组）的条目，RSSHub catalog 不进——catalog id
   *  是 `rsshub:…`，不属于任何包命名空间，撞名本来就是静默遮蔽而非解析歧义。 */
  private readonly byLocalName = new Map<string, string[]>()
  /** 随应用发布的那一层（`packages/`）出的全名。裸名歧义时它胜出（见 `get`）。 */
  private readonly builtinIds = new Set<string>()
  /** 歧义解析的旁路记录（接线方读它往 debug bus / 日志发一条）。 */
  private onAmbiguity_?: (n: AmbiguityNotice) => void

  constructor(
    manifests: SourceManifest[],
    private readonly backend: SearchBackend = new LexicalSearch(),
    catalog: SourceManifest[] = []
  ) {
    for (const m of manifests) {
      if (this.byId.has(m.id)) {
        throw new Error(`Duplicate manifest id: ${m.id}`)
      }
      this.byId.set(m.id, m)
      this.curatedIds.add(m.id)
      // 构造函数收的是插件包的 curated 清单 —— 随应用发布的那一层，整批算内置。
      this.builtinIds.add(m.id)
      this.indexLocalName(m.id)
    }
    this.applyCatalog(catalog)
  }

  // catalog (e.g. RSSHub's full route list) — long tail; curated wins on id clash
  private applyCatalog(catalog: SourceManifest[]): void {
    for (const m of catalog) {
      if (this.byId.has(m.id)) continue
      this.byId.set(m.id, m)
      this.catalogIds.add(m.id)
    }
  }

  /**
   * 整份换掉长尾 catalog（RSSHub 的全量路由表）。
   *
   * 为什么不能拿 `swapGroup` 凑合：catalog 的条目**不进** `curatedIds`、不进 `byLocalName`
   * （它们的 id 是 `rsshub:…`，不属于任何包命名空间），撞名的语义也不同——curated 赢、catalog
   * 被静默遮蔽，而不是抛 `Duplicate manifest id`。混用会把长尾变成一堆能拿裸名解析到的条目。
   *
   * catalog 需要能换，是因为它不再只来自开机时读的那个文件：发行安装上它由 RSSHub worker
   * 现取（`request('/api/namespace')`），而那一刻后端早就起来了。
   */
  swapCatalog(catalog: SourceManifest[]): void {
    for (const id of this.catalogIds) this.byId.delete(id)
    this.catalogIds.clear()
    this.applyCatalog(catalog)
  }

  /** 接上歧义旁路。装配期调一次；不接 = 沉默，而沉默正是这条缺陷的形状。 */
  onAmbiguity(fn: (n: AmbiguityNotice) => void): void {
    this.onAmbiguity_ = fn
  }

  private indexLocalName(id: string): void {
    const local = localNameOf(id)
    if (local === id) return // 没有命名空间前缀的 id：第 1 级就命中，索引它只会多一条自指
    const list = this.byLocalName.get(local)
    if (list) { if (!list.includes(id)) list.push(id) } else this.byLocalName.set(local, [id])
  }

  private dropLocalName(id: string): void {
    const local = localNameOf(id)
    const list = this.byLocalName.get(local)
    if (!list) return
    const i = list.indexOf(id)
    if (i >= 0) list.splice(i, 1)
    if (!list.length) this.byLocalName.delete(local)
  }

  /** Hot-swap a named group of manifests in place (recipe package reload — 改/加 recipe 免重启).
   *  Removes the group's previous ids, inserts the new set. Throws on id clash with a
   *  non-group entry (mirrors the constructor's duplicate fail-loud); catalog entries
   *  are shadowed by the group, same as boot ordering.
   *
   *  `builtinIds` 是这一批里**随应用发布那一层**出的全名（recipe 组两层混装：`packages/` +
   *  `<dataDir>/recipes/`）。裸名歧义要靠它判胜者，而只有装载方分得清哪条来自哪层。 */
  swapGroup(name: string, manifests: SourceManifest[], builtinIds: ReadonlySet<string> = new Set()): void {
    const prev = this.groups.get(name) ?? new Set<string>()
    // **先全验完再改**：抛出去之后这个 registry 还得能继续用。启动期整组装不进去会退化成
    // 逐包重试（`src/kernel/plugins/sources.ts`），而边插边抛会把半批 manifest 留在表里，
    // 下一次重试就全撞上自己刚才插进去的那些，一个坏包照样掀翻全部。
    // `prev.has(id)` 免检：那些 id 属于本组，提交阶段会先被摘掉，不算撞。
    const next = new Set<string>()
    for (const m of manifests) {
      if (next.has(m.id)) throw new Error(`Duplicate manifest id: ${m.id}`)
      if (!prev.has(m.id) && this.byId.has(m.id) && this.curatedIds.has(m.id)) {
        throw new Error(`Duplicate manifest id: ${m.id}`)
      }
      next.add(m.id)
    }
    for (const id of prev) {
      this.byId.delete(id)
      this.curatedIds.delete(id)
      this.builtinIds.delete(id)
      this.dropLocalName(id)
    }
    for (const m of manifests) {
      this.byId.set(m.id, m)
      this.curatedIds.add(m.id)
      if (builtinIds.has(m.id)) this.builtinIds.add(m.id)
      this.indexLocalName(m.id)
    }
    this.groups.set(name, next)
  }

  /**
   * 解析一个 source id。四级，顺序不能反：
   *
   * | 级 | 规则 | 存在理由 |
   * |---|---|---|
   * | 1 | `byId` 精确命中 | 全名、以及 catalog 的 `rsshub:…` 都走这里 |
   * | 2 | 含 `:` → 剥掉首个 `:` 之前的段，回到第 1 级 | 存量 stream 行经 `canonicalSourceId` 重组成 `foo:@scope/pkg/foo-home`（或旧形 `foo:foo-home`）就是靠它剥回来 |
   * | 3 | 裸名（局部名）→ `byLocalName` 唯一命中则解析 | 存量数据、分享包、用户手打的 id 都是裸名 |
   * | 4 | 裸名命中多条 → 内置那条胜出（记一条 AmbiguityNotice）；分不出胜者则抛 | 见下 |
   *
   * **第 3、4 级作用在第 2 级剥离之后的那个串上。** 存量行 `{plugin_id:'foo',
   * source_template_id:'foo-home'}` 重组出 `foo:foo-home`：第 1 级不中（`byId` 只有全名），
   * 第 2 级剥成 `foo-home`，第 3 级按局部名命中 `@scope/pkg/foo-home`。
   *
   * **歧义为什么内置优先**：一条写着裸名的存量记录，写下的那一刻只可能指内置那条——第三方包
   * 是后来装的。让后来者改变一条旧记录的含义，是这条线上最贵的那种静默失真。
   * **分不出胜者就抛**（内置层里 ≥2 条，或候选全在第三方层且 ≥2 条）：`undefined` 会被调用点
   * 写成「Unknown source」，把"它存在两份、请写全名"压成"它不存在"——两者的处置完全不同。
   */
  get(id: string): SourceManifest | undefined {
    const direct = this.resolve(id)
    if (direct) return direct
    const idx = id.indexOf(':')
    if (idx > 0) return this.resolve(id.slice(idx + 1))
    return undefined
  }

  /** 第 1 + 3 + 4 级（第 2 级的剥离在 `get` 里，剥完再进这里一次）。 */
  private resolve(id: string): SourceManifest | undefined {
    const exact = this.byId.get(id)
    if (exact) return exact
    const candidates = this.byLocalName.get(id)
    if (!candidates?.length) return undefined
    if (candidates.length === 1) return this.byId.get(candidates[0])
    const builtin = candidates.filter((c) => this.builtinIds.has(c))
    if (builtin.length !== 1) throw new AmbiguousSourceIdError(id, [...candidates])
    this.onAmbiguity_?.({ localName: id, chosen: builtin[0], candidates: [...candidates] })
    return this.byId.get(builtin[0])
  }

  /** 内置层（随应用发布的 `packages/`）里局部名为 `localName` 的全部全名。只数内置层：
   *  `pruneDeadMembers` 拿它判"搬了包的源搬去了哪"，第三方层的同名源不许借这条路接管系统行。 */
  builtinIdsByLocalName(localName: string): string[] {
    return (this.byLocalName.get(localName) ?? []).filter((id) => this.builtinIds.has(id))
  }

  all(): SourceManifest[] {
    return [...this.byId.values()]
  }

  /** Sources that declare they `provides` the given target-type, ordered by failover
   *  priority (lower first; absent = 100), id-tiebroken. The derived failover ladder. */
  providersOf(targetType: string): SourceManifest[] {
    const declared = this.all()
      .filter((m) => m.provides?.includes(targetType))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id))
    if (declared.length) return declared
    // implicit self-provision: any source is addressable as a single-provider ladder by its own id.
    // 走 get 而不是 byId：target-type 名是裸的，命名空间化之后 byId 里只有全名，直查一律不中。
    const self = this.get(targetType)
    return self ? [self] : []
  }

  /** Sources whose `matchers` (RSSHub Radar `source` patterns) contain the exact string.
   *  Dumb exact equality — no globbing. Backs a Provider row's {mode:'auto',matches} expansion,
   *  id-ordered for a stable ladder. */
  matching(pattern: string): SourceManifest[] {
    return this.all()
      .filter((m) => m.matchers?.includes(pattern))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id))
  }

  /** `categories` 含该类、且声明了 `key_param`（订阅键往哪个参数灌）的源，failover 序。
   *  Backs a Provider row's {mode:'auto',category} expansion——播客源解析那一行用它按目录现取成员，
   *  装了第三方播客 recipe 包就自动认，源码里不写任何站名。 */
  inCategory(category: string): SourceManifest[] {
    return this.all()
      .filter((m) => m.categories?.includes(category) && !!m.key_param)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id))
  }

  /**
   * 「这个 Source 坏了会连累谁」——沿 `uses` 的反向边求闭包（含它自己）。语义与为什么现算见
   * `src/registry/affected-sources.ts`。
   *
   * **入参吃任何存量形状**：全名、库里 stream 行重组出来的 `xhs:xhs-home`、裸名，都先经 `get`
   * 归一成全名再比对——`uses` 里写下的那些也一样。少了这一步，一条按裸名记的存量记录和一条按
   * 全名记的声明就永远对不上，而且不报错、只是查出一个空答案。
   *
   * `get` 在裸名歧义时会**抛**（AmbiguousSourceIdError）。这里逐条吞掉它并把那条边计进
   * `unresolved`：一次诊断查询没有资格因为某个第三方包和别人重名就整个失败。
   */
  affectedSources(id: string): AffectedSourcesResult {
    const resolve = (x: string): string | undefined => {
      try {
        return this.get(x)?.id
      } catch {
        return undefined
      }
    }
    return affectedSources(this.all(), resolve, id)
  }

  /** Hand-written manifests only (featured) — excludes the bulk catalog. */
  curated(): SourceManifest[] {
    return [...this.curatedIds].map((id) => this.byId.get(id)!).filter(Boolean)
  }

  search(intent: string, k: number = DEFAULT_SEARCH_K): RankedSource[] {
    return this.backend.rank(intent, this.all(), k)
  }

  /** Deduplicated union of topics across all manifests — for facet browsing. */
  topics(): string[] {
    const set = new Set<string>()
    for (const m of this.byId.values()) for (const t of m.topics) set.add(t)
    return [...set].sort()
  }
}
