import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import { harvestPlugin } from './harvest.ts'
import { eventsPlugin } from './events.ts'
import { adaptersPlugin } from './adapters.ts'
import { providerPlugin, type ProviderService } from './provider.ts'
import { storagePlugin } from './storage.ts'
import { makeResolveDownload } from '../../audio/resolve-download.ts'
import { ProviderStatsStore } from '../../providers/stats-store.ts'
import { PROVIDER_CALLSITES } from '../../providers/callsites.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { BuiltinAdapter } from '../../adapters/builtin/adapter.ts'
import type { Context } from 'cordis'

/** 装到 adapters 域为止（provider 域自己挂不挂由各条用例决定）。 */
async function mountUpToAdapters() {
  const root = mkdtempSync(join(tmpdir(), 'stream-provider-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir, dataDir, manageContainers: false, log: () => {},
    catalogSummary: (id) => ({ id } as unknown as PluginSummary),
  })
  await kernel.plugin(sourcesPlugin, {
    builtinDir: packagesDir, dataDir, rsshubCatalog: join(root, 'none.json'), log: () => {},
  })
  await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
  // provider 域 inject 它：collect 调用点的开机体检要发通知（见 provider.ts 的 auditCollect 段）。
  await kernel.plugin(eventsPlugin, { path: join(dataDir, 'events.json') })
  return { kernel, dataDir, root }
}

/** 存储域（下载队列的家）：`resolveDownload` 按真实接线走 —— 惰性从 `ctx.provider` 取。 */
async function mountStorage(kernel: Context, dataDir: string) {
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
      resolveDownload: makeResolveDownload(() => kernel.provider as ProviderService | undefined),
      syncEnabled: () => false,
      setSyncEnabled: () => {},
      refMeta: () => ({}),
    }),
  })
}

async function mountProvider(kernel: Context, dataDir: string) {
  await kernel.plugin(providerPlugin, {
    cacheDb: join(dataDir, 'cache.db'),
    log: () => {},
    runtimeConfigFor: () => ({}),
  })
}

async function mountAll() {
  const { kernel, dataDir, root } = await mountUpToAdapters()
  await mountStorage(kernel, dataDir)
  await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
  await mountProvider(kernel, dataDir)
  return { kernel, dataDir, root }
}

describe('providerPlugin', () => {
  it('挂成 ctx.provider：执行面一整套都在，dispose 后消失', async () => {
    const { kernel } = await mountAll()
    const p = kernel.provider
    for (const key of [
      'resolveEngine', 'intentResolver', 'radarMatcher', 'providerStats', 'providerDirectory',
      'providerExecutor', 'providerBindings', 'videoDetails', 'videoEnrich', 'episodeIndex',
      'netdiskShare', 'netdiskPlay', 'netdiskFolder', 'llmForTask',
    ] as const) {
      expect(p[key], key).toBeDefined()
    }
    await quiesceKernel(kernel)
    expect(kernel.provider).toBeUndefined()
  })

  // 句柄清欠：providerStats 在 cache.db 上开着一条 sqlite 连接，搬进来之前从没人关它。
  // 同进程第二次装配（测试、将来的重启）不关就是一条泄漏的连接，进程退出前没人抱怨。
  it('dispose 时关掉 providerStats 的 sqlite 连接', async () => {
    const close = vi.spyOn(ProviderStatsStore.prototype, 'close')
    const { kernel } = await mountAll()
    expect(close).not.toHaveBeenCalled()
    await quiesceKernel(kernel)
    expect(close).toHaveBeenCalledTimes(1)
    close.mockRestore()
  })

  /**
   * 接缝 1（本批最脆的一条）：下载队列住存储域，Provider 执行器住本域，后者晚得多才挂上。
   * 队列的 `resolveDownload` 因此只能**调用时**从 ctx 取。
   *
   * 这条钉的是「provider 还没挂就 drain 一次」——正确的结果是 drain 自己不崩、那条作业带着
   * 一句人话的 last_error 留在账本上，而不是抛穿到调度器、也不是被当成"这首歌没资源"记进终态。
   * 搬家前那个闭包直接引用前向 `let`：装配期解引用是 TDZ 崩，运行期抓到 undefined 则是
   * 「启动后前几分钟解析不出网址、之后自愈、零报错」。
   */
  it('provider 挂载前 drain 下载队列：显式失败，不崩', async () => {
    const { kernel, dataDir } = await mountUpToAdapters()
    await mountStorage(kernel, dataDir)
    const queue = kernel.stores.downloadQueue
    const id = queue.enqueue({ platform: 'netease', id: '424262' })
    await expect(queue.drain()).resolves.toBeUndefined()
    const job = queue.jobs().find((j) => j.id === id)
    expect(job?.last_error).toMatch(/provider/i)
    // 「没解析成」不等于「这首歌没有」：作业没被判死，重排等下一轮。
    expect(job?.state).not.toBe('done')
    await quiesceKernel(kernel)
  })

  // 同一条接缝的另一半：provider 挂上之后，同一个队列不再报那句话（惰性取真的取到了）。
  it('provider 挂上后同一个队列能取到执行器', async () => {
    const { kernel, dataDir } = await mountUpToAdapters()
    await mountStorage(kernel, dataDir)
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    await mountProvider(kernel, dataDir)
    const queue = kernel.stores.downloadQueue
    const id = queue.enqueue({ platform: 'netease', id: '424262' })
    await queue.drain()
    const job = queue.jobs().find((j) => j.id === id)
    expect(job?.last_error ?? '').not.toMatch(/provider 域未装载|Provider 执行器还没挂上/)
    await quiesceKernel(kernel)
  })

  /**
   * 批次 1 挂的那笔账：`providerDirectoryPlugin` 过去靠 bootstrap 里的行序保证"存储域已经
   * 挂好了"。现在由本域的 `inject: ['stores']` 表达——stores 不在树上，本域干脆不激活，
   * 而不是拿到一个还没有库的目录。
   */
  it('stores 不在树上时不激活（UserStore→providerDirectory 的依赖由 inject 表达）', async () => {
    const { kernel, dataDir } = await mountUpToAdapters()
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    await mountProvider(kernel, dataDir)
    expect(kernel.provider).toBeUndefined()
    expect(kernel.providerDirectory).toBeUndefined()
    await quiesceKernel(kernel)
  })

  // 同一域里还挂了 `ctx.providerDirectory`（按 inject 取读模型的服务不必经本域的聚合对象）。
  it('顺带把 ctx.providerDirectory 挂上', async () => {
    const { kernel } = await mountAll()
    expect(kernel.providerDirectory).toBeDefined()
    await quiesceKernel(kernel)
  })

  /**
   * 接缝 3 的一半：系统身份行必须先于 `ProviderBindings.ensureDefaults`。反了的话种出的绑定
   * 指向不存在的行，表现是"这个调用点没配置"而不是任何一处报错。
   * 这里只能钉住结果：挂完之后每个调用点都已经有一条绑定。
   */
  it('系统行先于绑定默认值：挂完每个调用点都已有绑定', async () => {
    const { kernel } = await mountAll()
    const bindings = kernel.provider.providerBindings
    for (const c of PROVIDER_CALLSITES) {
      expect(bindings.fixed(c.id) === null || typeof bindings.fixed(c.id) === 'string', c.id).toBe(true)
    }
    // 再挂一次不该重复种（ensureDefaults 幂等）——它每次启动都跑。
    expect(() => bindings.ensureDefaults(PROVIDER_CALLSITES)).not.toThrow()
    await quiesceKernel(kernel)
  })

  /**
   * 存量体检：升级前用户可以把一条自建的 sequential 行绑到 video.detail.*（那时还没有 collect
   * 标记），升级后每次进详情页都会在执行器里炸，而那是整页级的失败。开机把它换回默认行 +
   * 发一条通知（响但不瘫）。这里钉的是**接线**：体检真的在 boot 跑了，事件真的发出去了。
   */
  it('collect 调用点的存量绑定不合格 → 开机回落默认行并发一条通知', async () => {
    const { kernel, dataDir } = await mountUpToAdapters()
    await mountStorage(kernel, dataDir)
    const channels = kernel.stores.channels
    channels.putProvider({ id: 'legacy-seq', label: 'legacy-seq', description: '', category: 'metadata', strategy: 'sequential', members: [], contract: null, options: {}, serves: [] } as never)
    channels.putProviderBinding({ callsiteId: 'video.detail.metadata', providerIds: ['legacy-seq'] })

    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    await mountProvider(kernel, dataDir)

    expect(kernel.provider.providerBindings.fixed('video.detail.metadata')).toBe('video-metadata')
    const emitted = kernel.streamEvents.list().filter((e) => e.type === 'provider.binding-fallback')
    expect(emitted).toHaveLength(1)
    expect(emitted[0].title).toContain('video.detail.metadata')
    expect(emitted[0].body).toContain('sequential')
    await quiesceKernel(kernel)
  })

  // 反面：默认绑定（系统行都是 concurrent）全合格 → 一条通知都不该有，否则每次开机都在吵。
  it('全合格 → 零通知', async () => {
    const { kernel } = await mountAll()
    expect(kernel.streamEvents.list().filter((e) => e.type === 'provider.binding-fallback')).toHaveLength(0)
    await quiesceKernel(kernel)
  })

  // 看板数据平面退役（本任务）：三条 run 查询注册摘掉，但 research-runs 是 live/research present
  // 两个详情面直接靠 builtin adapter 执行的源函数，必须留着。
  it('research-runs 仍注册——live 面靠它执行源函数', async () => {
    const { kernel } = await mountAll()
    const builtinAdapter = kernel.adapters.get('builtin') as BuiltinAdapter
    expect(builtinAdapter.modes()).toContain('research-runs')
    await quiesceKernel(kernel)
  })

  it('三条看板查询不再注册', async () => {
    const { kernel } = await mountAll()
    const builtinAdapter = kernel.adapters.get('builtin') as BuiltinAdapter
    const modes = builtinAdapter.modes()
    for (const id of ['run-list', 'run-metrics', 'run-timeseries']) {
      expect(modes, id).not.toContain(id)
    }
    await quiesceKernel(kernel)
  })
})
