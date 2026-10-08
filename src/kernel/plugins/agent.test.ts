import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { runtimeConfigPlugin } from './runtime-config.ts'
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
import { searchFanoutPlugin } from './search-fanout.ts'
import { conversionsPlugin } from './conversions.ts'
import { agentPlugin, MCP_EXTRAS_DEP_COUNT } from './agent.ts'
import type { PluginSummary, StreamService } from '../../mcp/tools.ts'
import type { StoredItem } from '../../item-store.ts'
import type { Context } from 'cordis'

/**
 * `StreamService` 的替身。agent 域只在**工具真被调用时**才碰它（订阅 / 预览 / 搜目录），
 * 装配期一次都不碰——所以一个空壳足够，不必为了装配拖起整个 scheduler + registry。
 */
const fakeService = {
  search: () => [],
  previewSource: async () => ({ items: [] }),
  streamsResource: () => [],
  subscribe: () => ({}),
  unsubscribe: () => {},
  plugins: () => [],
} as unknown as StreamService

/** 装到 conversions 域为止（agent 域 inject 的十一个上游全在这里备齐）。 */
async function mountUpstream() {
  const root = mkdtempSync(join(tmpdir(), 'stream-agent-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const kernel = createKernel()
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(runtimeConfigPlugin)
  await kernel.plugin(credentialsPlugin, { dataDir, log: () => {}, requiredDomains: () => [] })
  await kernel.plugin(packagesPlugin, {
    packagesDir, dataDir, manageContainers: false, log: () => {},
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
  await kernel.plugin(netdiskPlugin, { dataDir, log: () => {} })
  await kernel.plugin(searchFanoutPlugin, {
    log: () => {},
    normalizeRaw: () => ({}) as StoredItem,
    readSource: async () => [],
  })
  await kernel.plugin(conversionsPlugin, {
    dataDir,
    streamDb: join(dataDir, 'stream.db'),
    log: () => {},
    // 与生产同形：跨域运行时解引用（状态面住 agent 域，它比转换域晚挂）。
    summaryPrompt: () => kernel.agent?.summaryPrompt(),
  })
  return { kernel, dataDir, root }
}

async function mountAgent(
  kernel: Context,
  dataDir: string,
  readSource: (id: string, params: Record<string, unknown>) => Promise<unknown> = async () => [],
) {
  await kernel.plugin(agentPlugin, {
    dataDir,
    log: () => {},
    service: fakeService,
    readSource,
  })
}

describe('agentPlugin', () => {
  it('域整块挂上：八格聚合字段一格不缺', async () => {
    const { kernel, dataDir } = await mountUpstream()
    await mountAgent(kernel, dataDir)
    const d = kernel.agent
    expect(d.onboardWishlist).toBeDefined()
    expect(typeof d.summaryPromptStatus).toBe('function')
    expect(typeof d.setSummaryPrompt).toBe('function')
    // 本域注册的配置 row（spec config-rows-slice1）：summary-prompt（apply 钩子回填热引用）。
    expect(kernel.settings.rows.has('summary-prompt')).toBe(true)
    expect(typeof d.webSearch).toBe('function')
    expect(typeof d.searchAgent.start).toBe('function')
    expect(typeof d.searchAgent.get).toBe('function')
    expect(d.intents).toBeDefined()
    expect(d.mcpExtras).toBeDefined()
    await quiesceKernel(kernel)
  })

  /**
   * **本批的主险**：`buildMcpExtras` 收的是一张逐项转发表，漏一格不报错、不 404——那个工具
   * 只是安静地不注册，模型照样会把动作叙述成已完成。
   *
   * 这条钉的是格数：往表里加一格而忘了改 `MCP_EXTRAS_DEP_COUNT`，装配期的自检当场 throw
   * （下面第二个断言会红）；改了常量而没改这里，这一行会红。两边都得动，谁也漏不掉。
   */
  it('mcpExtras 的转发表格数与 MCP_EXTRAS_DEP_COUNT 一致，且装配期自检通过', async () => {
    expect(MCP_EXTRAS_DEP_COUNT).toBe(46)
    const { kernel, dataDir } = await mountUpstream()
    // 装配没抛 = 表里的实际格数与登记的数字对得上（自检在 agent.ts 的 apply 里）。
    await expect(mountAgent(kernel, dataDir)).resolves.toBeUndefined()
    await quiesceKernel(kernel)
  })

  /**
   * `mcpExtras` 上真正暴露出去的那几个工具口子：转发表里有没有值，决定了工具注册不注册。
   * 这里只抽查跨域最远的那几格（转换底座 / 搜索扇出 / 解析面 / 通知中心 / 本域产物），
   * 它们是 Boot 时代最容易在搬家里掉的那一批。
   */
  it('跨域那几格真的转发到了 mcpExtras 上', async () => {
    const { kernel, dataDir } = await mountUpstream()
    await mountAgent(kernel, dataDir)
    const e = kernel.agent.mcpExtras
    expect(e.conversions).toBeDefined() // ctx.conversions
    expect(typeof e.readUrl).toBe('function') // ctx.conversions
    expect(typeof e.contentSearch).toBe('function') // ctx.search
    expect(typeof e.videoSearch).toBe('function') // ctx.search
    expect(e.resolve).toBeDefined() // ctx.provider + ctx.sources + ctx.stores
    expect(e.events).toBeDefined() // ctx.streamEvents
    expect(e.intents).toBeDefined() // 本域
    expect(typeof e.webSearch).toBe('function') // 本域
    expect(e.searchAgent).toBeDefined() // 本域
    expect(typeof e.cdpLook).toBe('function') // ctx.harvest
    await quiesceKernel(kernel)
  })

  /**
   * 摘要 prompt 是**一份可变引用**：热改之后设置页读回的状态和转换域吃的原值 thunk 必须同时
   * 变。分成两份状态的症状是「改完 prompt 得重启才算数」，而没有一处会报错。
   */
  it('setSummaryPrompt 热改：状态面与转换域吃的 thunk 同时生效', async () => {
    const { kernel, dataDir } = await mountUpstream()
    await mountAgent(kernel, dataDir)
    const d = kernel.agent
    expect(d.summaryPromptStatus().prompt).toBe('')
    expect(d.summaryPrompt()).toBeUndefined()
    await d.setSummaryPrompt('只讲结论')
    expect(d.summaryPromptStatus().prompt).toBe('只讲结论')
    // 转换域拿的就是这一格（bootstrap 把它当 summaryPrompt thunk 传下去）。
    expect(d.summaryPrompt()).toBe('只讲结论')
    await quiesceKernel(kernel)
  })

  // 句柄清欠：agent-runs.db 那条 sqlite 连接，搬进来之前从没人关。
  it('dispose 时关掉 agent-runs.db 那条 sqlite 连接', async () => {
    const { kernel, dataDir } = await mountUpstream()
    await mountAgent(kernel, dataDir)
    const runs = kernel.agent.searchAgent
    // 关之前读得动（否则下面的"读不动"证明不了任何事）。
    expect(() => runs.get('nobody')).not.toThrow()
    await quiesceKernel(kernel)
    // **读它自己的那条连接**——不是数 Database.close 的次数（别的域也在关自己的库）。
    expect(() => runs.get('nobody')).toThrow()
  })

  /** inject 表达的依赖：转换域不在树上时本域干脆不激活（`agentGetTranscript` / `readUrl` 都在它上面）。 */
  it('conversions 不在树上时不激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-agent-bare-'))
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await mountAgent(kernel, dataDir)
    expect(kernel.agent).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
