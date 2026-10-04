import type { UserStore } from '../store/user-store.ts'
import type { SharedChannel, StreamRecord, ProviderRecord, SourceBinding } from '../store/types.ts'
import type {
  CredentialRequirement, RuntimeConfigRequirement, EmbeddedRecipePackage,
} from './bundle-format.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import type { RecipePackage } from '../replay/recipe-package.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { pluginIdForDescriptor } from '../registry/seal.ts'
import { canonicalSourceId } from '../streams/store.ts'
import { allIdentities } from '../providers/identities.ts'
import {
  STREAM_BUNDLE_FORMAT, BUNDLE_SIZE_WARN_BYTES, serializeBundle,
  type StreamBundleV1, type BundleMeta, type PluginRequirement, type RecipeRequirement, type UnclassifiedDep,
} from './bundle-format.ts'

export type ExportRoot =
  | { kind: 'channel'; id: string }
  | { kind: 'stream'; id: string }
  | { kind: 'provider'; id: string }

export interface Closure {
  channels: SharedChannel[]
  streams: StreamRecord[]
  providers: ProviderRecord[]
  bindings: SourceBinding[]
  /** 闭包内各频道 options.slots 引用到的 provider id（去重）。只作导出 UI 的勾选候选——
   *  跟 capability-share 既有语义一致，不自动进包，只有经 opts.providerIds 显式选中才随包。 */
  slotProviderCandidates: string[]
}

/** 从任一根往下展开配置行。原样保留 id（stream_ids / provider 组合成员靠 id 互指）。 */
export function collectClosure(root: ExportRoot, store: UserStore): Closure {
  const channels: SharedChannel[] = []
  const streams = new Map<string, StreamRecord>()
  const providers = new Map<string, ProviderRecord>()
  const bindings: SourceBinding[] = []
  const slotProviderCandidates = new Set<string>()

  const addStream = (id: string) => {
    if (streams.has(id)) return
    const st = store.getStream(id)
    if (!st) return
    streams.set(id, st)
    for (const m of st.members) bindings.push(m)
  }
  const addProvider = (id: string, seen: Set<string>) => {
    if (providers.has(id) || seen.has(id)) return
    seen.add(id)
    const p = store.getProvider(id)
    if (!p) return
    providers.set(id, p)
    for (const m of p.members) if ('provider' in m && typeof m.provider === 'string') addProvider(m.provider, seen)
  }

  if (root.kind === 'channel') {
    const ch = store.getChannel(root.id)
    if (ch) {
      // `space_id` 不随包走：空间是**本机侧栏**的组织方式，对面机器上没有这一行。带过去
      // 只会指向一个不存在的空间；导入方一律落进它自己的默认空间（见 SharedChannel）。
      const { space_id: _space, ...portable } = ch
      channels.push(portable)
      for (const sid of ch.stream_ids) addStream(sid)
    }
  } else if (root.kind === 'stream') {
    addStream(root.id)
  } else {
    addProvider(root.id, new Set())
  }

  for (const ch of channels) {
    const slots = ch.options?.slots as Record<string, unknown> | undefined
    if (slots) for (const ids of Object.values(slots)) if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') slotProviderCandidates.add(id)
  }

  return {
    channels, streams: [...streams.values()], providers: [...providers.values()], bindings,
    slotProviderCandidates: [...slotProviderCandidates],
  }
}

// —— 依赖分栏所需的 catalog（下方 buildDependencyCatalog 实现，路由装配）——
export type ClassifyResult =
  | { kind: 'plugin'; id: string; version?: string; homepage?: string }
  | { kind: 'recipe'; id: string; version?: string; pkg: EmbeddedRecipePackage }
  | { kind: 'unknown' }

export interface DependencyCatalog {
  /** binding 的 `source` → **全名**（`<npm 包名>/<局部名>`）。解析不到就原样返回。
   *
   *  导出端写全名，bundle 从此自带命名空间：对面机器上零歧义，也不依赖它装了什么。裸名解析
   *  退化成对**旧 bundle** 的兜底。（`rsshub:…` 是 catalog id，不属于任何包命名空间，原样。） */
  canonicalSource(binding: SourceBinding): string
  /** 判定一个 member.plugin 归代码插件还是 recipe 包（或无法归类）。 */
  classify(binding: SourceBinding): ClassifyResult
  /** 该 binding 的源声明了哪些凭证/私有配置需求（仅 schema，绝不带值）。 */
  requirementsOf(binding: SourceBinding): { credentials: CredentialRequirement[]; runtimeConfig: RuntimeConfigRequirement[] }
}

export interface DependencyCatalogDeps {
  plugins: PluginDescriptor[]
  recipePackages: RecipePackage[]
  /** 源 id → 其 sealed manifest（含 auth / runtime_config / pluginId）。 */
  readManifest(sourceId: string): SourceManifest | undefined
  /** facility → 内嵌的整份 recipe 包字节（落盘的逆操作，导出侧打包）。 */
  readEmbedded(facility: string): EmbeddedRecipePackage | undefined
}

export function buildDependencyCatalog(deps: DependencyCatalogDeps): DependencyCatalog {
  // recipe 身份索引：sourceId → facility（当前身份 = facility；T3 未来换 scoped id）。
  const recipeSourceToFacility = new Map<string, string>()
  for (const pkg of deps.recipePackages) {
    for (const src of pkg.sources) recipeSourceToFacility.set(src.id, pkg.facility)
  }
  // 代码插件索引：归一后的 pluginId → descriptor。
  const pluginById = new Map<string, PluginDescriptor>()
  for (const d of deps.plugins) pluginById.set(pluginIdForDescriptor(d), d)

  // 库里的 binding 存的是 `{plugin, source}` 两截（`source` 是 `source_template_id`）。先按
  // scheduler 那把尺重组回一个 registry 认的 id 再查——不这么做，命名空间化之后 `source` 是
  // 裸名而 registry 只按全名索引，`recipeSourceToFacility` 这类按 id 建的表会全部落空，
  // 而落空的表现是"归类不出来"，不是报错。
  const manifestOf = (b: SourceBinding) =>
    deps.readManifest(canonicalSourceId(b.plugin, b.source)) ?? deps.readManifest(b.source)

  return {
    canonicalSource(binding) {
      return manifestOf(binding)?.id ?? binding.source
    },
    classify(binding) {
      const facility = recipeSourceToFacility.get(this.canonicalSource(binding))
      if (facility) {
        const pkg = deps.readEmbedded(facility)
        if (pkg) return { kind: 'recipe', id: facility, version: pkg.version, pkg }
      }
      const plugin = pluginById.get(binding.plugin)
      if (plugin) return { kind: 'plugin', id: pluginIdForDescriptor(plugin), homepage: plugin.homepage }
      // manifest 自报的 pluginId 兜底（binding.plugin 可能是别名）
      const m = manifestOf(binding)
      if (m?.pluginId && pluginById.has(m.pluginId)) {
        const p = pluginById.get(m.pluginId)!
        return { kind: 'plugin', id: m.pluginId, homepage: p.homepage }
      }
      return { kind: 'unknown' }
    },
    requirementsOf(binding) {
      const m = manifestOf(binding)
      const credentials: CredentialRequirement[] = []
      const runtimeConfig: RuntimeConfigRequirement[] = []
      if (m?.auth && m.auth.type === 'cookie' && 'domain' in m.auth) {
        credentials.push({ domain: m.auth.domain, reason: `${m.title || m.id} 采集需要登录态` })
      }
      if (m?.runtime_config) {
        runtimeConfig.push({ ref: m.runtime_config.ref, fields: Object.keys(m.runtime_config.fields) })
      }
      return { credentials, runtimeConfig }
    },
  }
}

const SECRET_TERMS = ['token', 'secret', 'cookie', 'password', 'passwd', 'apikey', 'credential', 'session', 'bearer', 'auth']

/** camelCase / snake_case 归一后子串命中——`apiKey`/`accessToken`/`sessionToken`/`session_id`
 *  一律命中（旧的下划线正则漏掉 camelCase，是红线漏洞）。宁可过匹配（拒导出、可读提示）
 *  也不可漏匹配（泄密）。 */
function isSecretKey(k: string): boolean {
  const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SECRET_TERMS.some((t) => norm.includes(t))
}

/** 深度扫描任意配置行（stream/provider/channel，含 options/contract/members/params）里的
 *  疑似密钥值。红线的唯一执行点——必须覆盖整行，不能只看 binding.params（provider 成员与
 *  options 曾整个绕过，是评审抓到的 C2/I2）。 */
export function scanSecrets(rows: unknown[]): { field: string; source: string }[] {
  const hits: { field: string; source: string }[] = []
  const seen = new Set<unknown>()
  const walk = (v: unknown, label: string): void => {
    if (v === null || typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const el of v) walk(el, label)
      return
    }
    const rec = v as Record<string, unknown>
    const here = typeof rec.source === 'string' ? rec.source : typeof rec.id === 'string' ? rec.id : label
    for (const [k, val] of Object.entries(rec)) {
      if (isSecretKey(k) && typeof val === 'string' && val.trim().length > 0) hits.push({ field: k, source: String(here) })
      walk(val, here)
    }
  }
  for (const row of rows) walk(row, 'root')
  return hits
}

export function translateRequirements(bindings: SourceBinding[], catalog: DependencyCatalog): { credentials: CredentialRequirement[]; runtimeConfig: RuntimeConfigRequirement[] } {
  const credByDomain = new Map<string, CredentialRequirement>()
  const rcByRef = new Map<string, RuntimeConfigRequirement>()
  for (const b of bindings) {
    const r = catalog.requirementsOf(b)
    for (const c of r.credentials) if (!credByDomain.has(c.domain)) credByDomain.set(c.domain, c)
    for (const rc of r.runtimeConfig) {
      const prev = rcByRef.get(rc.ref)
      if (prev) prev.fields = [...new Set([...prev.fields, ...rc.fields])]
      else rcByRef.set(rc.ref, { ref: rc.ref, fields: [...rc.fields] })
    }
  }
  return { credentials: [...credByDomain.values()], runtimeConfig: [...rcByRef.values()] }
}

/** 勾选导出用：从给定 provider ids 往下收（跟 {provider} 组合成员），去重。不做 system 过滤——
 *  过滤留给 exportBundle（一处一职）。 */
export function collectProviders(ids: string[], store: UserStore): ProviderRecord[] {
  const out = new Map<string, ProviderRecord>()
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const p = store.getProvider(id)
    if (!p) return
    out.set(id, p)
    for (const m of p.members) if ('provider' in m && typeof m.provider === 'string') add(m.provider)
  }
  for (const id of ids) add(id)
  return [...out.values()]
}

/** 从选中的 MappingSet 投影出可移植子集（config-sharing v2 · B / T1·D2）：**剥掉整个 right**、
 *  只留有 corrected 的 entries、保 left+matchSpec。绝不带 right.path / fileId。 */
export function collectNetdiskBindings(
  ids: string[],
  mappingStore: { get(id: string): import('../netdisk/types.ts').MappingSet | undefined },
): import('./bundle-format.ts').NetdiskBindingShare[] {
  const out: import('./bundle-format.ts').NetdiskBindingShare[] = []
  for (const id of ids) {
    const set = mappingStore.get(id)
    if (!set) continue
    // **白名单投影 entry**——绝不整份 spread：`lastError` 会含作者本机 AList 路径（播放失败留痕），
    // spread 会把它连同泄漏出去，且 scanSecrets 抓不到（非密钥命名）。只留重建映射必需的字段。
    const corrected = set.entries
      .filter((e) => !!e.corrected)
      .map((e) => ({ leftKey: e.leftKey, leftTitle: e.leftTitle, rightFile: e.rightFile, status: e.status, corrected: e.corrected, ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}) }))
    out.push({
      left: set.left,
      ...(set.matchSpec ? { matchSpec: set.matchSpec } : {}),
      ...(corrected.length ? { entries: corrected as never } : {}),
      // right 绝不带；shareUrl MappingSet 当前无此字段，格式槽位为将来预留，不臆造来源。
    })
  }
  return out
}

/** provider 成员里的 {source} → 伪 SourceBinding，供 translateRequirements 读 manifest 抽需求
 *  （只需 binding.source；plugin 无关紧要，requirementsOf 不用它）。 */
function providerMemberBindings(providers: ProviderRecord[]): SourceBinding[] {
  const out: SourceBinding[] = []
  for (const p of providers) {
    for (const m of p.members) {
      if ('source' in m && typeof m.source === 'string') out.push({ plugin: m.source, source: m.source, params: {} })
    }
  }
  return out
}

export function exportBundle(
  root: ExportRoot,
  store: UserStore,
  catalog: DependencyCatalog,
  meta: BundleMeta,
  opts: { sizeWarnBytes?: number; providerIds?: string[]; bindingCallsiteIds?: string[]; netdiskBindings?: import('./bundle-format.ts').NetdiskBindingShare[] } = {},
): { bundle: StreamBundleV1; warnings: string[] } {
  const closure = collectClosure(root, store)
  const warnings: string[] = []

  // 能力搭车：闭包 providers（provider 根导出的既有行为）+ 显式勾选，去重，仅非系统（D2）。
  const picked = collectProviders(opts.providerIds ?? [], store)
  const providersById = new Map<string, ProviderRecord>()
  for (const p of [...closure.providers, ...picked]) providersById.set(p.id, p)
  // 「是不是系统行」按代码身份表判，不看行上的 `system` 位：身份住代码之后，那一位是行上的
  // 陈旧数据，而系统行本来就不该出包（导入方自己的代码会建它）。
  const providers = [...providersById.values()].filter((p) => !allIdentities().has(p.id))

  // 净化频道 options.slots：引用的 provider 未随包（不在最终 providers 块）的槽键剔除——
  // 槽位不回落，悬空引用会让导入方那条能力静默哑掉。敏感体检仍扫净化前的整行（见下）。
  const shippedProviderIds = new Set(providers.map((p) => p.id))
  const sanitizedChannels = closure.channels.map((ch) => {
    const slots = ch.options?.slots as Record<string, string[]> | undefined
    if (!slots) return ch
    const kept = Object.fromEntries(Object.entries(slots).filter(([, ids]) => Array.isArray(ids) && ids.every((id) => shippedProviderIds.has(id))))
    return { ...ch, options: { ...ch.options, slots: kept } }
  })

  const providerBindings = (opts.bindingCallsiteIds ?? [])
    .map((id) => store.getProviderBinding(id))
    .filter((b): b is NonNullable<typeof b> => !!b)

  // 网盘 binding 搭车（B）：已投影好的块由路由传入（collectNetdiskBindings）。
  const netdiskBindings = opts.netdiskBindings ?? []
  // stream-left 的 stream 未随包 → 告缺（不静默产出不可重建项）。
  const bundledStreamIds = new Set(closure.streams.map((s) => s.id))
  for (const nb of netdiskBindings) {
    if (nb.left.kind === 'stream' && !bundledStreamIds.has(nb.left.streamId)) {
      warnings.push(`netdisk binding 的 stream \`${nb.left.streamId}\` 未随包，导入端无法重建其左侧清单`)
    }
  }

  // 1) 敏感体检——命中即拒（明文密钥不许进包）。扫**整份配置行**（含 provider 成员、options、
  //    contract、搭车 providers/providerBindings/netdiskBindings 块）——否则密钥全绕过。
  const secrets = scanSecrets([...closure.channels, ...closure.streams, ...providers, ...providerBindings, ...netdiskBindings])
  if (secrets.length) {
    throw new Error(`拒绝导出：检测到疑似密钥字段 ${secrets.map((h) => `${h.source}.${h.field}`).join(', ')}；请从配置中移除后再分享`)
  }

  // 2) 依赖分栏
  const plugins = new Map<string, PluginRequirement>()
  const recipes = new Map<string, RecipeRequirement>()
  const embedded: Record<string, EmbeddedRecipePackage> = {}
  const missing: UnclassifiedDep[] = []
  for (const b of closure.bindings) {
    const c = catalog.classify(b)
    if (c.kind === 'plugin') {
      if (!plugins.has(c.id)) plugins.set(c.id, { id: c.id, version: c.version, homepage: c.homepage })
    } else if (c.kind === 'recipe') {
      if (!recipes.has(c.id)) recipes.set(c.id, { id: c.id, version: c.version })
      embedded[c.id] = c.pkg
    } else {
      missing.push({ plugin: b.plugin, source: b.source })
    }
  }
  if (missing.length) warnings.push(`有 ${missing.length} 个源无法归类（既非代码插件也非 recipe），已记入 requires.missing`)

  // 3) 凭证/私有配置 → 需求声明（仅 schema）：stream 成员 + 搭车 provider 的成员一并翻。
  const { credentials, runtimeConfig } = translateRequirements(
    [...closure.bindings, ...providerMemberBindings(providers)], catalog,
  )

  // 4) 成员 id 写**全名**。导出端手里有 registry，解析一次，bundle 从此自带命名空间——
  //    对面机器上零歧义，也不依赖它装了什么。裸名解析在那边退化成只对旧 bundle 的兜底。
  //    只改 `source` 那一格：`plugin` 是另一个字段（plugin_id），两者不是一回事。
  const namespacedStreams = closure.streams.map((s) => ({
    ...s,
    members: s.members.map((m) => ({ ...m, source: catalog.canonicalSource(m) })),
  }))
  const namespacedProviders = providers.map((p) => ({
    ...p,
    members: p.members.map((m) => ('source' in m && typeof m.source === 'string'
      ? { ...m, source: catalog.canonicalSource({ plugin: '', source: m.source, params: {} }) }
      : m)),
  }))

  const bundle: StreamBundleV1 = {
    format: STREAM_BUNDLE_FORMAT,
    meta,
    channels: sanitizedChannels,
    streams: namespacedStreams,
    providers: namespacedProviders,
    ...(providerBindings.length ? { providerBindings } : {}),
    ...(netdiskBindings.length ? { netdiskBindings } : {}),
    requires: {
      plugins: [...plugins.values()],
      recipes: [...recipes.values()],
      credentials,
      runtimeConfig,
      ...(missing.length ? { missing } : {}),
    },
    embedded: { recipes: embedded },
  }

  // 4) 体积警告（T2：仍产单 JSON）
  const bytes = Buffer.byteLength(serializeBundle(bundle), 'utf8')
  const limit = opts.sizeWarnBytes ?? BUNDLE_SIZE_WARN_BYTES
  if (bytes > limit) warnings.push(`分享包体积 ${Math.round(bytes / 1024)}KB 超过 ${Math.round(limit / 1024)}KB 阈值；仍以单 JSON 导出（v1 不产 zip）`)

  return { bundle, warnings }
}
