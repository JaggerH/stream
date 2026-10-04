/**
 * sourceId 的文法：**全名 = `<npm 包名>/<局部名>`**。
 *
 * 局部名是包作者在 recipe / `manifests.yaml` 里写的那个 id，前缀是**宿主在装载期合成的**
 * （包作者不该在自己的文件里写自己的 npm 包名——改包名就得改每一个 recipe 文件）。
 * 全局唯一性因此由 npm registry 保证，宿主不维护任何表。
 *
 * 权威设计：`docs/superpowers/specs/2026-08-29-sourceid-package-namespace-design.md`；
 * cookbook（现状）在 `docs/PACKAGE.md` §2.1。
 */

/**
 * 一个局部名合不合法。不合法返回给人看的原因，合法返回 null。
 *
 * 两条禁令各自承重，不是洁癖：
 * - **不得含 `/`**：全名靠"最长包名前缀"定位包，局部名带 `/` 就多出一族二义
 *   （包 `<p>` 的局部名 `a/b` 与包 `<p>/a` 的局部名 `b` 长得一模一样）。
 * - **不得含 `:`**：`Registry.get` 的第 2 级会剥掉首个 `:` 之前的段（存量 stream 行重组出来的
 *   `xhs:xhs-home` 靠它剥回全名），局部名带 `:` 会让这条规则在全名上误触发。
 */
export function localSourceIdProblem(id: string): string | null {
  if (!id) return '空 id'
  if (id.includes('/')) return `'${id}' 含 '/'——它是包名与局部名的分隔符，局部名里不能出现`
  if (id.includes(':')) return `'${id}' 含 ':'——它被存量 stream 行的 plugin 前缀占着，局部名里不能出现`
  return null
}

/** 合成全名。包名来自 `package.json#name`；没有 npm 名的本地包用 `local/<目录名>`（见 localNamespace）。 */
export function namespacedSourceId(packageName: string, localId: string): string {
  return `${packageName}/${localId}`
}

/** 手放进 `<dataDir>/recipes/` 的本地开发包（`package.json` 没有 `name`）的命名空间前缀。
 *  必须显式回答这一格：不回答，手放包就成了"任何名字都行"的后门，正好绕开这道边界。
 *  这类包**不参与覆盖**——它的前缀与任何 npm 名都不相等，全名逐条独立。 */
export function localNamespace(dirName: string): string {
  return `local/${dirName}`
}

/** 全名 → 局部名。局部名不含 `/`（见 localSourceIdProblem），所以最后一段就是它，精确、不是猜。
 *  没有 `/` 的 id（裸名、手写旧 manifest）原样返回。 */
export function localNameOf(fullId: string): string {
  const i = fullId.lastIndexOf('/')
  return i < 0 ? fullId : fullId.slice(i + 1)
}

/**
 * 在一张「全名 → 东西」的表里按 id 取，**裸名也认**。
 *
 * 存在的理由是一处真实的不对称：`Registry.get` 有四级解析（全名 → 剥 `plugin:` → 局部名 →
 * 内置优先消歧），而按全名建的那几张 Map（`liveRecipes` 是一张）如果直接 `Map.get`，同一个
 * id 在两条路上答案就不一样。代价活体见过（2026-09-03）：`run_action_recipe` 传
 * `eastmoney-login` 恒 `not-found`，而正确的全名是 `@streamapp/eastmoney/eastmoney-login`
 * —— 那条 recipe 声明了 `discoverable: false`，**正确的名字在任何搜索面上都查不出来**，
 * 于是"名字打错了"和"这东西不存在"长得一模一样。
 *
 * 裸名命中多条时**抛 `AmbiguousSourceIdError`**，不静默挑一个：挑错了会去跑另一个包的动作。
 */
export function resolveBySourceId<T>(table: ReadonlyMap<string, T>, id: string): T | undefined {
  const exact = table.get(id)
  if (exact !== undefined) return exact
  // 已经是全名却没命中 = 真的没有；只有裸名才值得再找一轮。
  if (id.includes('/')) return undefined
  const hits = [...table.keys()].filter((k) => localNameOf(k) === id)
  if (hits.length === 0) return undefined
  if (hits.length > 1) throw new AmbiguousSourceIdError(id, hits)
  return table.get(hits[0]!)
}

/** 裸名（局部名）解析时命中多条，且分不出「内置那条」当胜者。
 *  **抛而不是返回 undefined**：「这个源不存在」和「它存在两份」的处置完全不同——前者是配置错，
 *  后者要用户改写全名。压成同一个 undefined 就是把一个能说清楚的错变成一个说不清的错。 */
export class AmbiguousSourceIdError extends Error {
  constructor(readonly localName: string, readonly candidates: string[]) {
    super(
      `source id "${localName}" 有 ${candidates.length} 个同名候选：${candidates.join('、')}。` +
      `请改用全名（<包名>/<局部名>）指明是哪一个。`,
    )
    this.name = 'AmbiguousSourceIdError'
  }
}
