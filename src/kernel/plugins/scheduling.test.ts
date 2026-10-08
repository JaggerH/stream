import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import { storagePlugin } from './storage.ts'
import { eventsPlugin } from './events.ts'
import { harvestPlugin } from './harvest.ts'
import { authPlugin } from './auth.ts'
import { runtimeConfigPlugin } from './runtime-config.ts'
import { adaptersPlugin } from './adapters.ts'
import { providerPlugin } from './provider.ts'
import { schedulingPlugin } from './scheduling.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { Context } from 'cordis'

async function mountUpToProvider() {
  const root = mkdtempSync(join(tmpdir(), 'stream-scheduling-'))
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
      archive: undefined as never,
      resolveDownload: async () => ({ audio: null }),
      syncEnabled: () => false,
      setSyncEnabled: () => {},
      refMeta: () => ({}),
    } as never),
  })
  await kernel.plugin(eventsPlugin, { path: join(dataDir, 'events.json'), broadcast: () => {} })
  await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
  // authPlugin 现在 inject 'runtimeConfig'（见 auth.test.ts 同一行的注释）。
  await kernel.plugin(runtimeConfigPlugin)
  await kernel.plugin(authPlugin, { dataDir, log: () => {}, requiredCookieDomains: () => [] })
  await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
  await kernel.plugin(providerPlugin, {
    cacheDb: join(dataDir, 'cache.db'), log: () => {}, runtimeConfigFor: () => ({}),
  })
  return { kernel, dataDir, root }
}

const mountScheduling = (kernel: Context) =>
  kernel.plugin(schedulingPlugin, {
    vaultRoot: join(tmpdir(), 'stream-scheduling-vault'),
    vaultEnabled: false,
    runtimeConfigFor: () => ({}),
  })

describe('schedulingPlugin', () => {
  it('挂成 ctx.scheduling：五格都在，dispose 后消失', async () => {
    const { kernel } = await mountUpToProvider()
    await mountScheduling(kernel)
    const d = kernel.scheduling
    expect(d.scheduler).toBeDefined()
    expect(d.service).toBeDefined()
    expect(d.baseAdRules).toBeDefined()
    expect(typeof d.health).toBe('function')
    expect(typeof d.lastHarvestAt).toBe('function')
    await quiesceKernel(kernel)
    expect(kernel.scheduling).toBeUndefined()
  })

  /**
   * 接缝 1（本批主险）：**scheduler ⇄ service 的真环**。service 构造吃 scheduler 的实例，
   * 而 scheduler 的 `onFeedTitle` 回调调 `service.updateResourceStream`——两者在同一个 apply
   * 里闭合。这条钉的是环真的连着：service 认得 scheduler 里的那条流。
   *
   * 断了的症状极安静：新订阅的流永远「未命名」，采集本身一切正常、日志一个字都没有。
   */
  it('真环闭合：service 认得 scheduler 里的流（自动起名的回写路径）', async () => {
    const { kernel } = await mountUpToProvider()
    await mountScheduling(kernel)
    const { scheduler, service } = kernel.scheduling
    scheduler.add({ id: 'ring-1', description: 'ring', sources: [] } as never)
    // service 读的是 scheduler 那份拷贝（它就是围着 scheduler 的一层行为面）。
    expect(scheduler.list().map((s) => s.id)).toContain('ring-1')
    expect(service.streamsResource().map((s) => s.id)).toContain('ring-1')
    // 回写口本身在 service 上——`onFeedTitle` 调的就是它。
    expect(typeof service.updateResourceStream).toBe('function')
    await quiesceKernel(kernel)
  })

  /**
   * 接缝 3：关停两步的**顺序**。撤销是注册的反序，插件先注册 `shutdownAdapters` 后注册 `stop`，
   * 所以撤销时先 stop（不再派新班）再 shutdownAdapters（杀 adapter 名下的子进程）。
   *
   * 这条不是在测 cordis，而是在钉**这个域的关停语义**：顺序反了的话，最后一轮派出去的采集会
   * 打在正在被拆的 adapter 上；漏掉 shutdownAdapters 则是遗留 chrome 跨重启堆积 → OOM。
   * 顺序靠注册序保证，而注册序只是两行代码——所以必须有人钉着它。
   */
  it('关停顺序：先 scheduler.stop() 再 shutdownAdapters()', async () => {
    const { kernel } = await mountUpToProvider()
    await mountScheduling(kernel)
    const scheduler = kernel.scheduling.scheduler as unknown as {
      stop: () => void
      shutdownAdapters: () => Promise<void>
    }
    const calls: string[] = []
    const realStop = scheduler.stop.bind(scheduler)
    const realShutdown = scheduler.shutdownAdapters.bind(scheduler)
    scheduler.stop = () => { calls.push('stop'); realStop() }
    scheduler.shutdownAdapters = async () => { calls.push('shutdownAdapters'); await realShutdown() }
    await quiesceKernel(kernel)
    expect(calls).toEqual(['stop', 'shutdownAdapters'])
  })

  /** inject 表达的依赖：provider 域不在树上时本域干脆不激活（`onItemPersisted` 要富化队列）。 */
  it('provider 不在树上时不激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-scheduling-bare-'))
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await mountScheduling(kernel)
    expect(kernel.scheduling).toBeUndefined()
    await quiesceKernel(kernel)
  })
})

/**
 * 接缝 4：**装载清单读的是 present 的 data 轴，不是「有没有被频道引用」**。
 *
 * `data === 'live'` 的 present（research）在 spec 里明说不入库；但装载一度按
 * `referencedStreamIds()` 装，于是 research 频道绑的流照样按 cadence 被采集、走完
 * 去重/过滤/入库那条有状态的链——live 面自己不写库，旁边那条路一直在写。
 * 断了的症状同样安静：面上一切正常，只有库里悄悄多出东西。
 */
describe('schedulingPlugin 装载清单', () => {
  it('只被 live present(research)引用的流不装进 scheduler；被 collected 频道也引用着的照装', async () => {
    const { kernel } = await mountUpToProvider()
    const channels = kernel.stores.channels
    for (const id of ['s-live', 's-both', 's-collected']) {
      channels.putStream({ id, label: id, strategy: 'fanout', cadence_seconds: 900, members: [], options: {} })
    }
    channels.putChannel({ id: 'rc', label: '研究', present: 'research', stream_ids: ['s-live', 's-both'], options: {} })
    channels.putChannel({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['s-both', 's-collected'], options: {} })
    await mountScheduling(kernel)
    const ids = kernel.scheduling.scheduler.list().map((s) => s.id)
    expect(ids).toContain('s-collected')
    expect(ids).toContain('s-both')
    expect(ids).not.toContain('s-live')
    await quiesceKernel(kernel)
  })
})
