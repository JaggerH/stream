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
import type { Adapter } from '../../adapters/types.ts'
import type { PluginSummary } from '../../mcp/tools.ts'

async function mount() {
  const root = mkdtempSync(join(tmpdir(), 'stream-adapters-'))
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
  return { kernel, dataDir, packagesDir, root }
}

describe('adaptersPlugin', () => {
  it('挂成 ctx.adapters：四个宿主 adapter 都在，dispose 后消失', async () => {
    const { kernel, dataDir } = await mount()
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    const adapters = kernel.adapters
    expect(adapters).toBeInstanceOf(Map)
    for (const name of ['builtin', 'rsshub', 'browser', 'replay'] as const) {
      expect(adapters.get(name), name).toBeDefined()
    }
    await quiesceKernel(kernel)
    expect(kernel.adapters).toBeUndefined()
  })

  /**
   * 汇入的那一步：带 code 槽位的包自己 `activate()` 交出来的 adapter 必须和四个宿主件住同一张
   * Map。漏了这一步不会报错——只是那些包的 source 在采集时找不到自己的 adapter，逐条落成
   * "unknown adapter" 的失败，而包页面上它显示得好好的。
   */
  it('把 ctx.packages.activated.adapters 汇进同一张 Map', async () => {
    const { kernel, dataDir } = await mount()
    const fake = { fetch: async () => [] } as unknown as Adapter
    kernel.packages.activated.adapters.set('some-package', fake)
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    expect(kernel.adapters.get('some-package')).toBe(fake)
    // 宿主件没有被包挤掉
    expect(kernel.adapters.get('builtin')).toBeDefined()
    await quiesceKernel(kernel)
  })

  /**
   * recipe 的分层查找必须**调用时**才解归并快照。装配期解开 `.current` = 冻结在启动那一刻，
   * 热装的 recipe 包永远查不到，而且不报错——只是那个 source 每轮都报"没有 recipe"。
   */
  it('recipe 快照是调用时才解的：装配期不碰 liveRecipes.current', async () => {
    const { kernel, dataDir } = await mount()
    let reads = 0
    const holder = kernel.sources.liveRecipes
    const inner = holder.current
    Object.defineProperty(holder, 'current', { get: () => { reads++; return inner }, configurable: true })
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    expect(reads).toBe(0)
    await quiesceKernel(kernel)
  })

  // inject 表达的是"本域整个建在 harvest 的产物上"。harvest 不在树上 → 本域干脆不激活，
  // 而不是拿到一个半截的 adapter Map（那种形状只会在某次采集时才崩，离现场十万八千里）。
  it('harvest 不在树上时不激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-adapters-noharvest-'))
    const packagesDir = join(root, 'packages')
    const dataDir = join(root, 'data')
    mkdirSync(packagesDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(root, 'none.json'), '')
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
    await kernel.plugin(adaptersPlugin, { dataDir, log: () => {}, runtimeConfigFor: () => ({}) })
    expect(kernel.adapters).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
