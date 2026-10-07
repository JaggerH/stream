import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { sourcesPlugin } from './sources.ts'
import { harvestPlugin } from './harvest.ts'
import { adaptersPlugin } from './adapters.ts'
import { providerPlugin } from './provider.ts'
import { llmPlugin } from './llm.ts'
import { storagePlugin } from './storage.ts'
import { eventsPlugin } from './events.ts'
import { netdiskPlugin } from './netdisk.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { Context } from 'cordis'

/** 装到 provider 域为止（netdisk 域 inject 的七个上游全在这里备齐）。 */
async function mountUpToProvider(opts: { alistToken?: string; alistPackage?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stream-netdisk-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  if (opts.alistPackage) {
    // 网盘底座包在场（且默认启用）= 这份 AList 归 Stream 托管。
    mkdirSync(join(packagesDir, 'alist'))
    writeFileSync(join(packagesDir, 'alist', 'package.json'),
      JSON.stringify({ name: '@t/alist', version: '1.0.0', stream: { id: 'alist', name: 'AList', normalizer: 'alist-norm' } }))
  }

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir, dataDir, manageContainers: false, log: () => {},
    // 空串而不是 undefined：`?? process.env.ALIST_TOKEN` 会把 undefined 交给环境变量，
    // 于是「没配 AList」那条用例在开发机上会随环境时绿时红。
    alistToken: opts.alistToken ?? '',
    catalogSummary: (id) => ({ id } as unknown as PluginSummary),
  })
  await kernel.plugin(sourcesPlugin, {
    builtinDir: packagesDir, dataDir, rsshubCatalog: join(root, 'none.json'), log: () => {},
  })
  await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
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
  await kernel.plugin(eventsPlugin, { path: join(dataDir, 'events.json') })
  await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
  await kernel.plugin(providerPlugin, {
    cacheDb: join(dataDir, 'cache.db'), log: () => {}, runtimeConfigFor: () => ({}),
  })
  await kernel.plugin(llmPlugin, { cacheDb: join(dataDir, 'cache.db') })
  return { kernel, dataDir, root }
}

async function mountNetdisk(kernel: Context, dataDir: string) {
  await kernel.plugin(netdiskPlugin, { dataDir, log: () => {} })
}

describe('netdiskPlugin', () => {
  it('配了 AList token：挂成 ctx.netdisk，三格都在，dispose 后消失', async () => {
    const { kernel, dataDir } = await mountUpToProvider({ alistToken: 'tok' })
    await mountNetdisk(kernel, dataDir)
    const d = kernel.netdisk
    expect(d.netdisk).toBeDefined()
    expect(d.netdiskRoutes).toBeDefined()
    expect(d.subtitleCacheDir).toBe(join(dataDir, 'subtitles'))
    // netdiskRoutes 的每一格都得在——漏一格的症状是对应端点恒 501/503，而单测注入 dep 照过。
    for (const key of ['service', 'store', 'alist', 'settings', 'fetchCookies', 'reconcile', 'transcribeSample'] as const) {
      expect(d.netdiskRoutes![key], key).toBeDefined()
    }
    await quiesceKernel(kernel)
    expect(kernel.netdisk).toBeUndefined()
  })

  /**
   * 门的语义：没配 AList token 时两个字段是 undefined，**但域照样挂**。
   * 把「没配」做成「不挂域」的话，所有按 inject 取它的地方会连带不激活——那是一个
   * 完全不同的、而且没人会喊的失效面。
   */
  it('没配 AList token：域照挂，netdisk/netdiskRoutes 为 undefined', async () => {
    const { kernel, dataDir } = await mountUpToProvider()
    await mountNetdisk(kernel, dataDir)
    expect(kernel.netdisk).toBeDefined()
    expect(kernel.netdisk.netdisk).toBeUndefined()
    expect(kernel.netdisk.netdiskRoutes).toBeUndefined()
    // 字幕缓存目录与网盘配没配无关——它是这一域的常量那一格。
    expect(kernel.netdisk.subtitleCacheDir).toBe(join(dataDir, 'subtitles'))
    await quiesceKernel(kernel)
  })

  /**
   * 托管模式下「启动时没 token」不等于「没配」：容器在睡、登录没跑成而已，取 token 的通道还在。
   * 把它也挡在门外的后果是那一整个进程里绑定/归档/网盘路由全都不存在，而且要等到下次重启
   * ——下次重启时容器多半还在睡。
   */
  it('托管但启动时还没拿到 token：照常装配，客户端带着取 token 的通道', async () => {
    const { kernel, dataDir } = await mountUpToProvider({ alistPackage: true })
    await mountNetdisk(kernel, dataDir)
    expect(kernel.packages.alist.token).toBeUndefined()
    expect(kernel.netdisk.netdisk).toBeDefined()
    const alist = kernel.netdisk.netdiskRoutes!.alist as unknown as { refresh?: () => Promise<string> }
    expect(typeof alist.refresh).toBe('function')
    await quiesceKernel(kernel)
  })

  // 句柄清欠：netdisk.db 上那条 sqlite 连接，搬进来之前从没人关它。
  it('dispose 时关掉 netdisk.db 的 sqlite 连接', async () => {
    const close = vi.spyOn(Database.prototype, 'close')
    const { kernel, dataDir } = await mountUpToProvider({ alistToken: 'tok' })
    await mountNetdisk(kernel, dataDir)
    const closedNetdiskDb = () =>
      close.mock.instances.some((db) => typeof (db as Database.Database).name === 'string'
        && (db as Database.Database).name.endsWith('netdisk.db'))
    expect(closedNetdiskDb()).toBe(false)
    await quiesceKernel(kernel)
    expect(closedNetdiskDb()).toBe(true)
    close.mockRestore()
  })

  /**
   * 接缝 2：AList 的 48h JWT 过期时的重登通道。`packages.alist.refresh` 一直备着却没有
   * 消费者——症状是「跑了两天之后所有网盘操作一起 401」，而 token 明明能自动换发。
   *
   * 这里钉的是**接线本身**（客户端手里那个 refresh 就是 packages 域那一个）：调它，
   * 拿到的是 packages 域「非托管模式」那句话，而不是 undefined。
   */
  it('AlistClient 的 refresh 接上了 packages 域的重登通道', async () => {
    const { kernel, dataDir } = await mountUpToProvider({ alistToken: 'tok' })
    await mountNetdisk(kernel, dataDir)
    const alist = kernel.netdisk.netdiskRoutes!.alist as unknown as { refresh?: () => Promise<string> }
    expect(typeof alist.refresh).toBe('function')
    // 没托管 admin 密码 → packages 域自己抛这句话。抛得出来 = 这一跳真的落到了那边。
    await expect(alist.refresh!()).rejects.toThrow(/非托管模式/)
    await quiesceKernel(kernel)
  })

  /** inject 表达的依赖：provider 域不在树上时本域干脆不激活（而不是拿到一个没有分集索引的引擎）。 */
  it('provider 不在树上时不激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-netdisk-bare-'))
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await mountNetdisk(kernel, dataDir)
    expect(kernel.netdisk).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
