import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import { harvestPlugin } from './harvest.ts'
import { adaptersPlugin } from './adapters.ts'
import { providerPlugin } from './provider.ts'
import { storagePlugin } from './storage.ts'
import { searchFanoutPlugin } from './search-fanout.ts'
import { eventsPlugin } from './events.ts'
import type { StoredItem } from '../../item-store.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { Context } from 'cordis'

/** Scheduler 的替身。**故意先留空**——本域挂载时它还不存在（真实装配序里 Scheduler 更晚建）。 */
type FakeScheduler = {
  normalizeRaw: (sourceId: string, raw: unknown) => StoredItem
  readSource: (sourceId: string, params: Record<string, unknown>) => Promise<unknown[]>
}

/** 一个内置 recipe 包，recipe 的 `meta` 原样透传——用来种一个**自报了墙钟上限**的源。 */
function writeRecipePackage(dir: string, facility: string, sourceId: string, meta: Record<string, unknown> = {}) {
  const pkgDir = join(dir, facility)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: `@t/${facility}`, version: '1.0.0', stream: { id: facility, facility, name: facility } }),
  )
  writeFileSync(
    join(pkgDir, `${sourceId}.recipe.json`),
    JSON.stringify({
      version: 1, kind: 'http', sourceId,
      request: { url: `https://${facility}.example/feed` },
      pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'items', maxPages: 1 },
      mapping: { guid: 'id', title: 'title' },
      meta: { capabilities: ['search'], key_param: 'keyword', ...meta },
    }),
  )
}

async function mountUpToProvider(seed?: (packagesDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'stream-search-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  seed?.(packagesDir)

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir, dataDir, manageContainers: false, log: () => {}, alistToken: '',
    catalogSummary: (id) => ({ id } as unknown as PluginSummary),
  })
  await kernel.plugin(sourcesPlugin, {
    builtinDir: packagesDir, dataDir, rsshubCatalog: join(root, 'none.json'), log: () => {},
  })
  await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
  // provider 域 inject 它（collect 调用点的开机体检要发通知）——不挂 provider 域就不激活。
  await kernel.plugin(eventsPlugin, { path: join(dataDir, 'events.json') })
  await kernel.plugin(storagePlugin, {
    dataDir,
    streamDb: join(dataDir, 'stream.db'),
    cacheDb: join(dataDir, 'cache.db'),
    legacyItemDb: join(dataDir, 'items.db'),
    legacyDedupDb: join(dataDir, 'dedup.db'),
    audioArchiveRoot: join(dataDir, 'audio'),
    audioArchiveDb: join(dataDir, 'audio.db'),
    log: () => {},
    downloadQueueDeps: () => ({
      archive: { status: () => ({}) } as never,
      resolveDownload: async () => null as never,
      syncEnabled: () => false,
      setSyncEnabled: () => {},
      refMeta: () => ({}),
    }),
  })
  await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
  await kernel.plugin(providerPlugin, {
    cacheDb: join(dataDir, 'cache.db'), log: () => {}, runtimeConfigFor: () => ({}),
  })
  return { kernel, dataDir, root }
}

/** Scheduler 那两口以 thunk 下传：**挂载这一刻 `scheduler` 还是空的**，与真实装配序一致。 */
async function mountSearch(kernel: Context, scheduler: { current?: FakeScheduler }) {
  await kernel.plugin(searchFanoutPlugin, {
    log: () => {},
    normalizeRaw: (sourceId, raw) => scheduler.current!.normalizeRaw(sourceId, raw),
    readSource: (sourceId, params) => scheduler.current!.readSource(sourceId, params),
  })
}

describe('searchFanoutPlugin', () => {
  it('挂成 ctx.search：六格都在，dispose 后消失', async () => {
    const { kernel } = await mountUpToProvider()
    await mountSearch(kernel, {})
    for (const key of [
      'normalizeSearchItem', 'renormalizeItems', 'contentSearch', 'priceSearch', 'priceSearchDetailed', 'resaleSearch',
      'videoSearch', 'videoSearchStream', 'facetResources',
    ] as const) {
      expect(typeof kernel.search[key], key).toBe('function')
    }
    await quiesceKernel(kernel)
    expect(kernel.search).toBeUndefined()
  })

  /**
   * 接缝：六个字段里有两个吃 `Scheduler`，而 Scheduler 比本域晚建（批次 8 才进内核）。
   * 所以配置里给的是 **thunk 不是实例**——装配期一次都不解引用，调用时才解。
   *
   * 这条钉的正是这一点：挂载时 `scheduler.current` 是 undefined（挂载本身不该崩），
   * 之后补上，同一个 `normalizeSearchItem` 立刻取到它。传实例的话装配期就是 TDZ/undefined。
   */
  it('Scheduler 那两口是 thunk：挂载时还没有它，调用时才解引用', async () => {
    const { kernel } = await mountUpToProvider()
    const scheduler: { current?: FakeScheduler } = {}
    // 挂载不该因为「Scheduler 还没有」而崩——这就是 thunk 存在的理由。
    await expect(mountSearch(kernel, scheduler)).resolves.toBeUndefined()
    scheduler.current = {
      normalizeRaw: (sourceId) => ({ id: `${sourceId}#1` } as unknown as StoredItem),
      readSource: async () => [],
    }
    expect(kernel.search.normalizeSearchItem('xhs', {})).toEqual({ id: 'xhs#1' })
    await quiesceKernel(kernel)
  })

  /** 空扇出的形状：没有成员就是空结果，不是抛错（一个源塌了从不该让整次搜索变白页）。 */
  it('没有可用成员时 contentSearch / videoSearch / facetResources 各自给空结果', async () => {
    const { kernel } = await mountUpToProvider()
    await mountSearch(kernel, { current: { normalizeRaw: () => ({} as StoredItem), readSource: async () => [] } })
    await expect(kernel.search.contentSearch('anything')).resolves.toEqual([])
    const v = await kernel.search.videoSearch('anything')
    expect(v.shows).toEqual([])
    expect(v.loose).toEqual([])
    // 种子行的成员一个都没产出 → 它们**必须以 timing 出现**（declined/errored 也要能被看见），
    // 而不是悄悄从结果里消失：一个源塌了要显示成塌了，不是显示成"没有这个源"。
    expect(v.sources.every((s) => s.count === 0)).toBe(true)
    expect(kernel.search.facetResources('q', [], [])).toEqual({ shows: [], loose: [], sources: [] })
    await quiesceKernel(kernel)
  })

  /**
   * 「一个源封顶多久」只有一个真相源 = manifest 的 `member_timeout_ms`（recipe 写在
   * `meta.member_timeout_ms`）。这条钉的是**流式路也读它**——它以前读的是 `SEARCH_SOURCE_META`
   * 里另一张表，于是同一个源在批量路和流式路上各有各的上限，两边单看都对。
   *
   * 判据故意用**自报得比默认更紧**：源申报 20ms、实际跑 300ms → 必须报 timeout。回退成读那张
   * 旧表（或干脆读默认 15s）时，300ms 跑得完，状态会变成 'empty'——测试当场变红。
   */
  it('流式路的墙钟读源自报的 member_timeout_ms，不是另一张表', async () => {
    const { kernel } = await mountUpToProvider((packagesDir) =>
      writeRecipePackage(packagesDir, 'slowfac', 'slow-search', { member_timeout_ms: 20 }),
    )
    await mountSearch(kernel, {
      current: {
        normalizeRaw: () => ({} as StoredItem),
        readSource: async () => {
          await new Promise((r) => setTimeout(r, 300))
          return [{ title: 'x', link: 'magnet:?xt=1' }]
        },
      },
    })
    kernel.stores.channels.putProvider({
      id: 'slow-row', label: 'slow', description: '', category: 'search', serves: ['search-download'],
      strategy: 'concurrent', members: [{ source: 'slow-search' }], contract: null, options: {},
    })
    const events = []
    for await (const e of kernel.search.videoSearchStream('q', { providerId: 'slow-row' })) events.push(e)
    const src = events.find((e) => e.type === 'source')
    expect(src).toBeDefined()
    expect(src!.timing.status).toBe('timeout')
    expect(src!.timing.ms).toBeLessThan(300)
    await quiesceKernel(kernel)
  })

  /** inject 表达的依赖：provider 域不在树上时本域干脆不激活（而不是拿到一个没有执行器的扇出）。 */
  it('provider 不在树上时不激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-search-bare-'))
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await mountSearch(kernel, {})
    expect(kernel.search).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
