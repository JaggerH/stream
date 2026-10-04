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
import { authPlugin, resolveLoginAuthSpec } from './auth.ts'
import { runtimeConfigPlugin } from './runtime-config.ts'
import type { RuntimeConfigResolver } from './runtime-config.ts'
import type { SessionAuthSpec, SourceManifest } from '../../manifest/types.ts'
import type { PluginSummary } from '../../mcp/tools.ts'

async function mount() {
  const root = mkdtempSync(join(tmpdir(), 'stream-auth-'))
  const packagesDir = join(root, 'packages')
  const dataDir = join(root, 'data')
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const frames: unknown[] = []

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
  return { kernel, frames, dataDir }
}

describe('authPlugin', () => {
  it('挂成 ctx.auth（建在 harvest 域产物上），dispose 后消失', async () => {
    const { kernel } = await mount()
    const a = kernel.auth
    expect(a.authFacilities()).toEqual([])   // 没有任何源 = 没有横幅
    expect(a.reconcileAuthNow).toBeTypeOf('function')
    expect(a.startLogin).toBeTypeOf('function')
    expect(a.cookiePuller).toBeDefined()
    await quiesceKernel(kernel)
    expect(kernel.auth).toBeUndefined()
  })

  /**
   * **这一条是 2026-09-03 活体崩溃的回归测试。**
   *
   * 「登录态掉了自己登回来」那条链路的宿主实现一度写在 `packages` 域里、直接读 `ctx.sources`
   * / `ctx.harvest`。tsc 过、7686 条测试全绿，**真机第一次调用就炸**：
   * `cannot get property "sources" without inject` —— `sources` 自己 `inject: ['packages']`，
   * packages 域再 inject 回去是环，Cordis 拒；而它是**调用时**才取，所以挂载期一切正常。
   *
   * 现在实现回填在本域（它已经握着 sources / harvest / credentials）。判据要能分辨
   * **接线**和**执行**这两件事：用一个不存在的 facility 去调，正确的失败是"没有登录 recipe"
   * （说明已经读到了 recipe 表）；错误的失败是"without inject"（根本没读到）。
   *
   * 光挂载不调用是抓不到这个 bug 的——挂载期它一点问题都没有。
   */
  it('登录能力接到了包那一层，且真的够得着 recipe 表（不是 without inject）', async () => {
    const { kernel } = await mount()
    await expect(kernel.packages.facilityLogin('nope')).rejects.toThrow(/没有登录 recipe/)
    await expect(kernel.packages.facilityLogin('nope')).rejects.not.toThrow(/without inject/)
    await quiesceKernel(kernel)
  })

  // 对账是**惰性**的：没有横幅挂着就一个远程调用都不发。这条同时证明它不抛——三个触发点
  // （扩展连上 / 每分钟 / 打开面板）都 `.catch(()=>{})`，真抛了会被完全吞掉。
  it('没有横幅时对账是空转，不抛', async () => {
    const { kernel } = await mount()
    await expect(kernel.auth.reconcileAuthNow()).resolves.toBeUndefined()
    await quiesceKernel(kernel)
  })

  // 认不出这个 facility 时**必须出声**（emit failed），不能静默什么都不做——静默的形状是
  // 用户点了「重新登录」，面板一直转圈。
  it('未知 facility 的 startLogin 明确报失败', async () => {
    const { kernel } = await mount()
    const events: Array<{ kind: string }> = []
    await kernel.auth.startLogin('nope', (e) => void events.push(e))
    expect(events.map((e) => e.kind)).toEqual(['failed'])
    await quiesceKernel(kernel)
  })

  // 横幅的推送口：一次同步既发原 `auth-needed` 帧（AuthPanel 依赖它），也进通知中心。
  // 没有 need 时两样都不该发——否则每轮采集都会刷一条空通知。
  it('syncAuthBanner 在没有 need 时不推任何帧', async () => {
    const { kernel, frames } = await mount()
    frames.length = 0
    kernel.auth.syncAuthBanner()
    expect(frames).toEqual([])
    await quiesceKernel(kernel)
  })
})

describe('resolveLoginAuthSpec — login:oauth 的 account 必须调用时现取', () => {
  const manifest = { id: 'groq-create-key', runtime_config: { ref: 'groq', fields: {} } } as unknown as SourceManifest
  const oauthAuth = {
    type: 'session', facility: 'groq', login: 'oauth',
    loginUrl: 'https://console.groq.com/login', oauthButton: '#oauth-google',
    accountSelector: '[data-identifier="{email}"]',
  } as SessionAuthSpec

  // 承重墙。这条测试如果被"改回装配期求值"的实现骗过（两种写法都返回同一个值），它就没有牙——
  // 靠"装配时读到空、之后用户填上了、下一次调用取到新值"这个时序差把两种写法区分开：装配期求值
  // 只会在第一次调用时把当时的空快照焊死，之后 runtimeConfig 里的值再怎么变都追不上。
  // `account` 只住在 SessionAuthSpec 的 oauth 那一支上，联合类型上直接点它 tsc 不认——
  // 这里断言到 oauth 那一支再读，别把整个返回值 cast 成 any（那会把返回类型的其余部分一起蒙掉）。
  const accountOf = (spec: SessionAuthSpec) => (spec as Extract<SessionAuthSpec, { login: 'oauth' }>).account

  it('装配时 googleAccount 为空、之后用户填上了 → 下一次调用取到新值', () => {
    let stored: Record<string, unknown> = {}
    const runtimeConfig: RuntimeConfigResolver = () => stored
    expect(accountOf(resolveLoginAuthSpec(manifest, oauthAuth, runtimeConfig))).toBeUndefined()
    stored = { googleAccount: 'me@example.com' }
    expect(accountOf(resolveLoginAuthSpec(manifest, oauthAuth, runtimeConfig))).toBe('me@example.com')
  })

  it('非 oauth 的 auth 原样透传，不去查 runtimeConfig', () => {
    const qrAuth = { type: 'session', facility: 'x', login: 'qr', loginUrl: 'u', qrSelector: 's' } as SessionAuthSpec
    const runtimeConfig: RuntimeConfigResolver = () => { throw new Error('不该被调用') }
    expect(resolveLoginAuthSpec(manifest, qrAuth, runtimeConfig)).toBe(qrAuth)
  })
})
