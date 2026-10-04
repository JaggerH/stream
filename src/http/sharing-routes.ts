import type { Hono } from 'hono'
import type { UserStore } from '../store/user-store.ts'
import type { Registry } from '../registry/registry.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import type { RecipePackage } from '../replay/recipe-package.ts'
import { pluginIdForDescriptor } from '../registry/seal.ts'
import { exportBundle, buildDependencyCatalog, collectNetdiskBindings, type ExportRoot } from '../sharing/export-closure.ts'
import { importBundle } from '../sharing/import-bundle.ts'
import { parseBundle, type BundleMeta } from '../sharing/bundle-format.ts'
import { readEmbeddedFromDir, writeEmbeddedToDir } from '../sharing/recipe-embed.ts'
import type { ImportRunStore, ImportRun, ImportItem } from '../sharing/import-run-store.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import { detectConflicts } from '../sharing/activate-provider.ts'
import { decideImportItem } from '../sharing/decide.ts'
import { isParked } from '../providers/parked.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'

export interface SharingDeps {
  store: UserStore
  registry: Registry
  plugins: PluginDescriptor[]
  /** getter 而非快照：install 热挂载后每次请求读到最新（导出内嵌 + 导入去重表都靠它，I-1/I-2）。 */
  recipePackages: () => RecipePackage[]
  recipesUserDir: string
  /** 导入台账：一次导入 = 一个 run，遗留事项 = items（spec 2026-07-24-import-decision-ledger）。 */
  runs: ImportRunStore
  bindings: ProviderBindings
  /** Provider 读模型：激活体检的 serves 具名键与兜底身份从它取（同一个实例转交 decide/activate）。 */
  directory: Pick<import('../providers/directory.ts').ProviderDirectory, 'serveKeysOf' | 'isFallback'>
  /** 网盘对齐 binding 分享（B）：读投影/暂存 pending。absent → 未接 AList，netdisk 分享不可用。 */
  mappingStore?: { get(id: string): import('../netdisk/types.ts').MappingSet | undefined; save(set: import('../netdisk/types.ts').MappingSet): void }
  /** 导入会建频道和流（present 由 bundle 决定，research 也在其中）——建完要让装配层重建
   *  research watcher 集合。见 HttpDeps.onChannelsChanged。 */
  onChannelsChanged?: () => void
}

/** 与 app.ts 的 errorBody 同形状（sharing 路由独立注册，helper 就地一份）。 */
function err(code: 'validation_error' | 'not_found' | 'conflict', message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

// —— 严格输入闸（docs/API.md §2）。每份名单 = 对应 handler **实际读的那几个顶层键**；
// 加字段就要加进来（漏加是响亮的 400，不是静默失效）。嵌套结构只查顶层——
// 里面的形状由各自的解析器说话（`meta` 由 BundleMeta、`bundle` 由 parseBundle）。

/** `POST /api/sharing/exports` 认识的字段。 */
const EXPORT_KEYS = ['root', 'meta', 'providerIds', 'bindingCallsiteIds', 'netdiskBindingIds'] as const
/** `POST /api/sharing/imports` 认识的字段（二选一：url 拉取 | 直接递 bundle）。 */
const IMPORT_KEYS = ['url', 'bundle'] as const
/** `POST /api/sharing/imports/:id/decisions` 认识的字段。 */
const DECISION_KEYS = ['itemId', 'choice'] as const

/**
 * body 是对象就查一遍键名，认不出的当场 400 并指出该写哪个。返回 `null` = 放行
 * （body 不是对象时交给各 handler 自己的形状校验说话）。
 */
function strictBody(
  c: import('hono').Context, body: unknown, allowed: readonly string[],
): Response | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const bad = unknownKey(Object.keys(body as Record<string, unknown>), allowed)
  return bad ? c.json(err('validation_error', unknownKeyMessage('字段', bad, allowed)), 400) : null
}

function labelOfRoot(deps: SharingDeps, root: ExportRoot): string {
  if (root.kind === 'channel') return deps.store.getChannel(root.id)?.label ?? root.id
  if (root.kind === 'stream') return deps.store.getStream(root.id)?.label ?? root.id
  return deps.store.getProvider(root.id)?.label ?? root.id
}

/** run 的实时投影：parked-provider 的 open item 以 store 现值为准——provider 已被别处删除/激活时
 *  不再显示为待拍板（幂等，不靠台账猜），并附激活前的冲突体检供 UI/AI 一次拿全上下文。 */
function projectRun(run: ImportRun, deps: SharingDeps): ImportRun & { items: (ImportItem & { conflicts?: unknown[] })[] } {
  const items = run.items.map((item) => {
    if (item.kind !== 'parked-provider' || item.status !== 'open') return item
    const providerId = (item.subject as { providerId?: string }).providerId ?? ''
    const provider = deps.store.getProvider(providerId)
    if (!provider) return { ...item, status: 'dismissed' as const, detail: `${item.detail}（Provider 已被删除）` }
    if (!isParked(provider)) return { ...item, status: 'decided' as const, detail: `${item.detail}（已在别处激活）` }
    return { ...item, conflicts: detectConflicts(provider, deps.store, deps.bindings, deps.directory) }
  })
  return { ...run, items }
}

export function registerSharingRoutes(app: Hono, deps: SharingDeps): void {
  // 每次调用现取 recipePackages()：install 热挂载后新装包立即可导出/可去重（I-1）。
  const buildCatalog = () => {
    const recipePackages = deps.recipePackages()
    return buildDependencyCatalog({
      plugins: deps.plugins,
      recipePackages,
      readManifest: (id) => deps.registry.get(id),
      readEmbedded: (facility) => {
        const pkg = recipePackages.find((p) => p.facility === facility)
        return pkg ? readEmbeddedFromDir(pkg.dir) : undefined
      },
    })
  }

  app.post('/api/sharing/exports', async (c) => {
    const catalog = buildCatalog()
    const body = await c.req.json().catch(() => null) as
      { root?: ExportRoot; meta?: Partial<BundleMeta>; providerIds?: string[]; bindingCallsiteIds?: string[]; netdiskBindingIds?: string[] } | null
    const gate = strictBody(c, body, EXPORT_KEYS)
    if (gate) return gate
    if (!body?.root?.kind || !body.root.id) return c.json(err('validation_error', '缺少 root {kind,id}'), 400)
    const meta: BundleMeta = {
      title: body.meta?.title ?? labelOfRoot(deps, body.root),
      description: body.meta?.description,
      author: body.meta?.author,
      created: body.meta?.created ?? new Date().toISOString().slice(0, 10),
      revision: body.meta?.revision ?? '1.0.0',
      report_to: body.meta?.report_to,
    }
    try {
      const netdiskBindings = (deps.mappingStore && Array.isArray(body.netdiskBindingIds))
        ? collectNetdiskBindings(body.netdiskBindingIds, deps.mappingStore)
        : undefined
      const { bundle, warnings } = exportBundle(body.root, deps.store, catalog, meta, {
        providerIds: Array.isArray(body.providerIds) ? body.providerIds : undefined,
        bindingCallsiteIds: Array.isArray(body.bindingCallsiteIds) ? body.bindingCallsiteIds : undefined,
        netdiskBindings,
      })
      return c.json({ bundle, warnings })
    } catch (e) {
      return c.json(err('validation_error', (e as Error).message), 400)
    }
  })

  // 一次导入 = 一个可寻址资源：执行导入、落台账、回 201。
  app.post('/api/sharing/imports', async (c) => {
    const body = await c.req.json().catch(() => null) as { url?: string; bundle?: unknown } | null
    const gate = strictBody(c, body, IMPORT_KEYS)
    if (gate) return gate
    if (!body) return c.json(err('validation_error', '缺少 body'), 400)

    let raw: unknown = body.bundle
    if (body.url) {
      const { loadBundleFromUrl } = await import('../sharing/transport.ts')
      const loaded = await loadBundleFromUrl(body.url)
      if (!loaded.ok) return c.json(err('validation_error', loaded.error), 400)
      raw = loaded.bundle
    }
    const parsed = parseBundle(raw)
    if (!parsed.ok) return c.json(err('validation_error', parsed.error), 400)

    const run = importBundle(parsed.bundle, {
      store: deps.store,
      installedPlugins: new Set(deps.plugins.map(pluginIdForDescriptor)),
      // 去重 identity = package.json#name（有则）否则 facility——与 writeEmbeddedToDir 落盘目录同一把尺（I-2）。
      installedRecipes: new Map(deps.recipePackages().map((p) => [p.name ?? p.facility, { version: undefined }])),
      installRecipePackage: (pkg) => writeEmbeddedToDir(pkg, deps.recipesUserDir),
      mappingStore: deps.mappingStore,
      // 旧 bundle 里的裸名 → 本机全名。歧义时 registry **抛**，importBundle 接住落一条待拍板
      // item（不静默挑一个）。解析不到就原样落库，运行时再解析。
      resolveSource: (id) => deps.registry.get(id)?.id,
    })
    deps.runs.create(run)
    // 导入可能建出 research 频道，watcher 集合要跟着重建（`applyCollectionPolicy` 那一半没接
    // 这条路，是因为导入建的流本来就走各自 present 的既有排班；watcher 这边没有这层兜底）。
    deps.onChannelsChanged?.()
    return c.json(projectRun(run, deps), 201)
  })

  app.get('/api/sharing/imports', (c) => {
    const items = deps.runs.list().map((run) => {
      const projected = projectRun(run, deps)
      return {
        id: run.id, at: run.at, meta: run.meta,
        openCount: projected.items.filter((i) => i.status === 'open').length,
        itemCount: run.items.length,
        netdiskBindings: run.netdiskBindings.length,
      }
    })
    return c.json({ items })
  })

  app.get('/api/sharing/imports/:id', (c) => {
    const run = deps.runs.get(c.req.param('id'))
    if (!run) return c.json(err('not_found', `未找到导入 ${c.req.param('id')}`), 404)
    return c.json(projectRun(run, deps))
  })

  // decision：item 唯一的状态迁移入口。执行失败不半提交（409 + 原因，item 保持 open）。
  app.post('/api/sharing/imports/:id/decisions', async (c) => {
    const runId = c.req.param('id')
    const body = await c.req.json().catch(() => null) as { itemId?: string; choice?: string } | null
    const gate = strictBody(c, body, DECISION_KEYS)
    if (gate) return gate
    if (!body?.itemId || !body.choice) return c.json(err('validation_error', '缺少 itemId/choice'), 400)
    const r = decideImportItem(runId, body.itemId, body.choice, { runs: deps.runs, store: deps.store, bindings: deps.bindings, directory: deps.directory })
    if (r.ok) return c.json({ item: r.item })
    if (r.code === 'not_found') return c.json(err('not_found', r.message), 404)
    if (r.code === 'invalid_choice') return c.json(err('validation_error', r.message), 400)
    // already_decided / apply_failed：与现状冲突 → 409，带 item 现状（和激活冲突详情，若有）
    return c.json({ ...err('conflict', r.message), item: r.item ?? null, conflicts: r.conflicts ?? [] }, 409)
  })
}
