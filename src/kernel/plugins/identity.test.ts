import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { credentialsPlugin } from './credentials.ts'
import { packagesPlugin } from './packages.ts'
import { DeviceFetch } from '../../devices/fetch.ts'
import { ArticleCache } from '../../content/extract.ts'
import { sourcesPlugin } from './sources.ts'
import { storagePlugin } from './storage.ts'
import { eventsPlugin } from './events.ts'
import { harvestPlugin } from './harvest.ts'
import { authPlugin } from './auth.ts'
import { identityPlugin } from './identity.ts'
import { SiteIdentityStore } from '../../identity/identity-store.ts'
import { runtimeConfigPlugin } from './runtime-config.ts'
import type { PluginSummary } from '../../mcp/tools.ts'

async function mount() {
  const root = mkdtempSync(join(tmpdir(), 'stream-identity-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const frames: unknown[] = []

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    deviceFetch: new DeviceFetch(),
    articles: () => new ArticleCache(),
    netMode: 'none' as const,
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
  await kernel.plugin(eventsPlugin, { path: join(dataDir, 'events.json'), broadcast: (m) => void frames.push(m) })
  await kernel.plugin(harvestPlugin, { dataDir, log: () => {} })
  // authPlugin 现在 inject 'runtimeConfig'（login:oauth 的 account 要在每次登录时现取，见
  // auth.ts startLogin 的注释）——生产装配（bootstrap.ts）里它挂在 authPlugin 之前，这里补齐。
  await kernel.plugin(runtimeConfigPlugin)
  await kernel.plugin(authPlugin, {
    dataDir, log: () => {},
    broadcast: (m) => void frames.push(m),
    requiredCookieDomains: () => [],
  })
  const store = new SiteIdentityStore(join(dataDir, 'stream.db'))
  await kernel.plugin(identityPlugin, { store, deviceFetch: new DeviceFetch(), log: () => {} })
  return { kernel, frames, dataDir, store }
}

describe('identityPlugin', () => {
  /**
   * 同 auth.test 那条 without-inject 回归：facility 表、会话声明、whoami 都是**调用时**才读别的域，
   * 挂载期一切正常。所以要真调一次。
   */
  it('挂成 ctx.siteIdentities；刷新真的读得到各域（不是 without inject），dispose 后消失', async () => {
    const { kernel, store } = await mount()
    const svc = kernel.siteIdentities!
    expect(svc).toBeDefined()
    await expect(svc.refresh()).resolves.toEqual([]) // 没有在线节点
    expect(await svc.nodeConnected('local')).toEqual([]) // 兼容槽说不出节点
    expect(await svc.afterLogin('nope', 'local')).toBeUndefined()
    expect(svc.list()).toEqual([])
    store.record('xhs', 'node_a', { state: 'signed-in', accountId: 'A' })
    expect(svc.list()).toMatchObject([{ facility: 'xhs', nodeId: 'node_a', online: false }])
    // 路由器同域挂出：没有节点表 = 一个候选都没有，身份目标照样 identity-offline（不回落）
    await expect(kernel.identityRouter!.resolve({ target: { kind: 'identity', accountId: 'A' }, facility: 'xhs', purpose: 'action' }))
      .rejects.toMatchObject({ code: 'identity-offline' })
    await quiesceKernel(kernel)
    expect(kernel.siteIdentities).toBeUndefined()
    expect(kernel.identityRouter).toBeUndefined()
  })
})
