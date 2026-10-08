import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { conversionsPlugin, type ConversionsConfig } from './conversions.ts'
import type { PluginSummary } from '../../mcp/tools.ts'
import type { Context } from 'cordis'

/**
 * 两次幂等迁移的**顺序**（先把旧表搬进来，再把表内的 stt/parse 收成 extract）——错序的症状
 * 是旧转写记录搬进来了却赶不上那趟改写，老条目永久「未转写」+ 用户重转一次重复计费。
 * 两个真实现照跑（只包一层记账），所以这条守的是顺序，不是把迁移换成假的。
 */
const migrationOrder: string[] = []
vi.mock('../../conversions/migrate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../conversions/migrate.ts')>()
  return {
    ...actual,
    migrateLegacyConversions: (...args: Parameters<typeof actual.migrateLegacyConversions>) => {
      migrationOrder.push('legacy')
      return actual.migrateLegacyConversions(...args)
    },
  }
})
vi.mock('../../conversions/migrate-to-extract.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../conversions/migrate-to-extract.ts')>()
  return {
    ...actual,
    migrateConversionsToExtract: (...args: Parameters<typeof actual.migrateConversionsToExtract>) => {
      migrationOrder.push('to-extract')
      return actual.migrateConversionsToExtract(...args)
    },
  }
})

/**
 * 这台机器上有没有 ffmpeg。**能力自述里必须算进它**：转写的第一步就是把源字节喂给 ffmpeg
 * 重编码/切块，它不在时 stt 分支必然失败——而在这条改动之前 `branches.stt` 照样报 true，
 * 用户点下去、等一分半钟，换回一句 `spawn ffmpeg ENOENT`（活体 2026-09-04 干净装机）。
 */
const ffmpeg = { present: true }
vi.mock('../../media/ffmpeg-bin.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../media/ffmpeg-bin.ts')>()
  return { ...actual, mediaToolAvailable: (tool: 'ffmpeg' | 'ffprobe') => (tool === 'ffmpeg' ? ffmpeg.present : true) }
})

/** standby 名册：`identifyReady` 的第二个来源，用它验「不许装配期求值」。 */
const standby = { managed: false }
vi.mock('../../plugins/standby/hook.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugins/standby/hook.ts')>()
  return { ...actual, standbyManaged: () => standby.managed }
})

/** 装到 netdisk 域为止（conversions 域 inject 的六个上游全在这里备齐；packages 域是 sources 的上游，顺带在）。 */
async function mountUpstream() {
  const root = mkdtempSync(join(tmpdir(), 'stream-conversions-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // cloudflare 那一档「配没配好」读的是它 manifest 里的 required 字段——拷**真** manifests.yaml
  // 进来（只去掉代码槽位：这里不跑成员，只问注册表里的清单），改了真清单这里跟着变。
  const cfDir = join(packagesDir, 'cloudflare')
  mkdirSync(cfDir)
  copyFileSync(fileURLToPath(new URL('../../../packages/cloudflare/manifests.yaml', import.meta.url)), join(cfDir, 'manifests.yaml'))
  writeFileSync(join(cfDir, 'package.json'), JSON.stringify({
    name: '@streamapp/cloudflare', version: '1.0.0',
    stream: { type: 'recipe', id: 'cloudflare', name: 'Cloudflare Workers AI', facility: 'cloudflare', schemaVersion: 1 },
  }))

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
  return { kernel, dataDir, root }
}

async function mountConversions(
  kernel: Context,
  dataDir: string,
  summaryPrompt = () => 'p',
  probeFpEngine: ConversionsConfig['probeFpEngine'] = async () => null,
) {
  await kernel.plugin(conversionsPlugin, {
    dataDir,
    streamDb: join(dataDir, 'stream.db'),
    log: () => {},
    summaryPrompt,
    // 默认注入永不 resolve 出引擎的探测：既有用例不该真 spawn ffmpeg——audio-fp 仍会
    // 注册（available:false），不影响任何一条既有断言（守卫一只查 kind 存在，不查 available）。
    probeFpEngine,
  })
}

/** 没有任何 STT token 的环境。**必须显式清掉**——开发机上真有 key 时这几条会莫名变号。 */
function noSttTokens() {
  vi.stubEnv('GROQ_API_KEY', '')
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('CLOUDFLARE_WORKERS_AI_TOKEN', '')
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '')
}

function withGroq() {
  noSttTokens()
  vi.stubEnv('GROQ_API_KEY', 'test-key')
}

afterEach(() => {
  vi.unstubAllEnvs()
  migrationOrder.length = 0
  standby.managed = false
  ffmpeg.present = true
})

describe('conversionsPlugin', () => {
  /**
   * **这一批能力的存在与否不再由「启动那一刻有没有 key」决定**（2026-09-05）。
   *
   * 旧写法：一把 key 都没有 → `ensureTranscribeRow` 返回 null → 挂在它下面的转写 / 说话人识别 /
   * 摘要 / 声纹库 / job 账本**整批不构造**。于是用户申请到 key 之后功能仍然不存在，要重启后端
   * 才冒出来——活体（2026-09-04，win-test 干净装机）：一键申请 16.7s 拿到 key、`configured:true`，
   * `branches.stt` 仍然 false，重启才 true。
   *
   * 现在：永远构造，「能不能用」交给各自的活判据（stt 看 `sttConfigured()`，identify 看
   * `identifyReady()`）。**这不是把不诚实换个地方**——`branches.stt` 在没钥匙时仍然是 false，
   * 下面那条钉着。
   */
  it('一把 STT key 都没有：能力照样注册，但 branches.stt 诚实地报 false', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const d = kernel.conversions
    // 无条件那半边：runner / 转成文字 / 归堆后台工 / agent 读转写，一格都不许缺。
    expect(d.conversions).toBeDefined()
    expect(typeof d.readUrl).toBe('function')
    expect(d.storyFoldWorker).toBeDefined()
    expect(typeof d.agentGetTranscript).toBe('function')
    // 曾经的"条件那半边"：现在无条件构造。声纹库尤其重要——enroll 那几条 HTTP 路由要它，
    // 而它以前在没 STT key 的机器上根本不存在。
    expect(d.speakerRegistry).toBeDefined()
    expect(d.voiceprintEngine).toBeDefined()
    expect(d.capabilityJobs).toBeDefined()
    // 五个 kind 全登记——一把 key 都没有也一样。
    expect(d.conversions.kinds().map((k) => k.kind).sort()).toEqual(['audio-fp', 'extract', 'frames', 'identify', 'summary'])
    // 而自述仍然诚实：没钥匙就是跑不了。
    expect(d.conversions.kinds().find((k) => k.kind === 'extract')?.branches?.stt).toBe(false)
    await quiesceKernel(kernel)
  })

  it('有 STT token：五个 kind 全登记，branches.stt 为 true', async () => {
    withGroq()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const d = kernel.conversions
    expect(d.speakerRegistry).toBeDefined()
    expect(d.voiceprintEngine).toBeDefined()
    expect(d.capabilityJobs).toBeDefined()
    expect(d.conversions.kinds().map((k) => k.kind).sort()).toEqual(['audio-fp', 'extract', 'frames', 'identify', 'summary'])
    expect(d.conversions.kinds().find((k) => k.kind === 'extract')?.branches?.stt).toBe(true)
    await quiesceKernel(kernel)
  })

  /**
   * **这条是整件事的判据**：后端起来之后才配上 key，不重启就该能用。
   *
   * 牙：把 `sttConfigured()` 改回装配期求值（或把 `available` 改回读
   * `transcribeRow.members.length`），这条当场红。
   */
  it('装配之后才配上 key：不重启，branches.stt 立刻变 true', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const sttOf = () => kernel.conversions.conversions.kinds().find((k) => k.kind === 'extract')?.branches?.stt
    expect(sttOf()).toBe(false)
    // 用户此刻在设置页点了「一键帮我完成」，key 落地。后端没有重启。
    vi.stubEnv('GROQ_API_KEY', 'just-provisioned')
    expect(sttOf()).toBe(true)
    // 反向也要活：key 被撤掉就该回到 false（一个恒 true 的实现同样能骗过上一行）。
    vi.stubEnv('GROQ_API_KEY', '')
    expect(sttOf()).toBe(false)
    await quiesceKernel(kernel)
  })

  /**
   * cloudflare 那一档要两样：token **和** account id（它 manifest 里 `accountId` 是 required）。
   * 少一样就不算数——否则一台只填了 token 的机器会把 stt 报成可用，然后在真跑的时候失败。
   */
  it('cloudflare 只有 token、没有 account id → 不算配好', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const sttOf = () => kernel.conversions.conversions.kinds().find((k) => k.kind === 'extract')?.branches?.stt
    vi.stubEnv('CLOUDFLARE_WORKERS_AI_TOKEN', 'tok')
    expect(sttOf()).toBe(false)
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct')
    expect(sttOf()).toBe(true)
    await quiesceKernel(kernel)
  })

  /**
   * accountId 只填在配置页（runtime_config `cloudflare.accountId`）也算配好——成员执行时现读的
   * 就是这一份（存储优先、空着回落环境变量），判据必须和它同源。以前这里只看环境变量，只填配置页
   * 的用户被误报「没配」。
   */
  it('cloudflare 的 account id 只填在配置页 → 算配好', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const sttOf = () => kernel.conversions.conversions.kinds().find((k) => k.kind === 'extract')?.branches?.stt
    vi.stubEnv('CLOUDFLARE_WORKERS_AI_TOKEN', 'tok')
    expect(sttOf()).toBe(false)
    kernel.settings.setRuntimeConfig('cloudflare', { accountId: 'acct' }, [])
    expect(sttOf()).toBe(true)
    await quiesceKernel(kernel)
  })

  /**
   * 能力自述必须诚实：ffmpeg 不在 = `branches.stt` 为 false，哪怕 STT 源配得好好的。
   *
   * 把 `available` 改回只看 `transcribeRow.members.length > 0`，这条当场红。第二半（装了
   * ffmpeg 就该是 true）同样必须在——只断言 false 的话，一个恒 false 的实现也是绿的，
   * 那就把「诚实」修成了「一律说不行」。
   */
  it('没有 ffmpeg 时 branches.stt 为 false（有 STT 源也一样）', async () => {
    withGroq()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const branchesOf = () => kernel.conversions.conversions.kinds().find((k) => k.kind === 'extract')?.branches
    expect(branchesOf()?.stt).toBe(true)
    // 判据是活的：装配之后 ffmpeg 消失（或用户中途装上），下一次问就该换答案。
    ffmpeg.present = false
    expect(branchesOf()?.stt).toBe(false)
    // 同一份判据也管抽帧——它的第一步同样是 ffmpeg。
    expect(kernel.conversions.conversions.kinds().find((k) => k.kind === 'frames')?.available).toBe(false)
    await quiesceKernel(kernel)
  })

  it('两次幂等迁移的顺序是「先搬旧表、再收成 extract」', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    expect(migrationOrder).toEqual(['legacy', 'to-extract'])
    await quiesceKernel(kernel)
  })

  /**
   * `identifyReady` 不许在装配期求值：声纹容器归 standby 管，host 档下装配那一刻它多半没醒。
   * 冻结成 false 的症状是这个进程**永远**不补说话人，而没有任何一处会报错。
   */
  it('identifyReady 是惰性的：装配之后 standby 醒过来，identify 立刻变可用', async () => {
    withGroq()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const availableOf = (kind: string) => kernel.conversions.conversions.kinds().find((k) => k.kind === kind)?.available
    expect(availableOf('identify')).toBe(false)
    standby.managed = true // 装配之后才醒
    expect(availableOf('identify')).toBe(true)
    await quiesceKernel(kernel)
  })

  /**
   * MinerU 是可选包（`stream add @streamapp/mineru`），装在用户层——用户层的包**不进**
   * `ctx.packages.plugins`（那份只扫内置层），它的容器描述符住 BackendDirectory、由 standby 管。
   * 所以「mineru 装了没」不能再问 `plugins.some(id === 'mineru')`（内置层里永远没有它，恒 false
   * → OCR 梯子永远不亮），得和 identifyReady 同一个形状：standby 管着它、或有地址可达。
   * 同样必须惰性：host 档下装配那一刻容器多半睡着。
   */
  it('mineru 可达性是惰性的：装配之后 standby 接管 mineru，OCR 梯子立刻点亮', async () => {
    noSttTokens()
    vi.stubEnv('MINERU_URL', '')
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const parseRow = kernel.stores.channels.getProvider('parse')
    // 前提：parse 行只有 ocr-mineru 那一个默认成员——判据在这条用例里只取决于 mineru 可达性。
    expect(parseRow?.members.map((m) => ('source' in m ? m.source : null))).toEqual(['@streamapp/builtin/ocr-mineru'])
    const kindsOf = () => kernel.conversions.conversions.kinds()
    const ocrOf = () => kindsOf().find((k) => k.kind === 'extract')?.branches?.ocr
    const framesOf = () => kindsOf().find((k) => k.kind === 'frames')?.available
    expect(ocrOf()).toBe(false)
    expect(framesOf()).toBe(false)
    standby.managed = true // 装配之后才接管（容器可以还睡着——withAwake 会叫醒它）
    expect(ocrOf()).toBe(true)
    expect(framesOf()).toBe(true)
    await quiesceKernel(kernel)
  })

  // 句柄清欠：三条 sqlite 连接（conversions 表所在的 stream.db、jobs.db、voiceprint.db），
  // 搬进来之前从没人关它们。
  it('dispose 时关掉三条 sqlite 连接', async () => {
    withGroq()
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    const d = kernel.conversions
    const registry = d.speakerRegistry!
    const jobs = d.capabilityJobs!
    const runner = d.conversions
    // 关之前三条都读得动（否则下面的"读不动"证明不了任何事）。
    expect(() => runner.list({})).not.toThrow()
    expect(() => registry.getItemTimeline('nobody')).not.toThrow()
    expect(() => jobs.sweep()).not.toThrow()
    await quiesceKernel(kernel)
    // **读它自己的那条连接**（不是数 Database.close 的次数——stream.db 上还有存储域的连接，
    // 那样数出来的绿灯与本域的 effect 没关系）。
    expect(() => runner.list({})).toThrow()
    expect(() => registry.getItemTimeline('nobody')).toThrow()
    expect(() => jobs.sweep()).toThrow()
  })

  /**
   * ConversionRunner 的失败重排与 StoryFoldWorker 的兜底巡检都是 `setTimeout`，两者都**没有
   * stop 面**——本域这一侧记账清掉。留着的话，同进程第二次装配（测试、将来的重启）会让上一轮
   * 的回调打在已经关掉的库上。
   */
  it('dispose 时清掉在飞的定时器（story-fold 巡检那条）', async () => {
    noSttTokens()
    // 间隔要在**调用的那一刻**读：clearTimeout 会把 `_idleTimeout` 抹成 -1，事后回看
    // mock.calls 里的同一个对象只会看到 -1（第一版就是这么假红的）。
    const clearedMs: number[] = []
    const realClear = globalThis.clearTimeout
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((t: Parameters<typeof realClear>[0]) => {
      const ms = (t as unknown as { _idleTimeout?: number } | undefined)?._idleTimeout
      if (typeof ms === 'number') clearedMs.push(ms)
      return realClear(t)
    }) as typeof realClear)
    const { kernel, dataDir } = await mountUpstream()
    await mountConversions(kernel, dataDir)
    await quiesceKernel(kernel)
    // 认那一条具体的定时器（5 分钟的兜底巡检），不是"dispose 期间 clearTimeout 被调过"
    // ——后者别的域也会让它变绿，那种绿灯和本域的 effect 没关系。
    expect(clearedMs).toContain(5 * 60_000)
    clear.mockRestore()
  })

  /**
   * audio-fp 的 `available` 必须是**读探测结果的 thunk**，不是装配期求值的布尔：装配那一刻
   * 探测多半还没回来（真实现要 spawn ffmpeg/fpcalc），把它冻成 false 的症状是这个进程
   * **永远**判定指纹引擎不可用，而没有任何一处会报错——把 `available: () => fpEngine.current
   * !== null` 改回 `available: fpEngine.current !== null` 之类的装配期快照，这条当场红。
   */
  it('audio-fp 的 available 是活的 thunk：探测回来之后才变可用', async () => {
    noSttTokens()
    const { kernel, dataDir } = await mountUpstream()
    let resolveEngine!: (engine: 'ffmpeg' | 'fpcalc' | null) => void
    const probeFpEngine = () => new Promise<'ffmpeg' | 'fpcalc' | null>((resolve) => { resolveEngine = resolve })
    await mountConversions(kernel, dataDir, () => 'p', probeFpEngine)
    const availableOf = () => kernel.conversions.conversions.kinds().find((k) => k.kind === 'audio-fp')?.available
    // 探测还没回来：可用性必须是 false，不是 undefined（kind 已注册）。
    expect(availableOf()).toBe(false)
    resolveEngine('ffmpeg')
    await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    expect(availableOf()).toBe(true)
    await quiesceKernel(kernel)
  })

  /** inject 表达的依赖：provider 域不在树上时本域干脆不激活。 */
  it('provider 不在树上时不激活', async () => {
    noSttTokens()
    const root = mkdtempSync(join(tmpdir(), 'stream-conversions-bare-'))
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
    await mountConversions(kernel, dataDir)
    expect(kernel.conversions).toBeUndefined()
    await quiesceKernel(kernel)
  })
})
