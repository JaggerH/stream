import type { Context } from 'cordis'
import { CookieProvider, type CookieSource } from '../../credentials/cookie-provider.ts'
import { DeviceCookieStores, type PushedCookieStore, type CookieHealth } from '../../credentials/pushed-cookie-store.ts'
import { CredentialResolver } from '../../credentials/resolver.ts'
import { TokenProvider } from '../../credentials/token-provider.ts'
import type { CredentialProvider } from '../../credentials/types.ts'

declare module 'cordis' {
  interface Context {
    /** 登录态与 API key 这一域（`src/kernel/plugins/credentials.ts`）。 */
    credentials: CredentialsService
  }
}

/** 扩展该读哪些域的 cookie —— `GET /api/ext/sync-config` 的返回形状。 */
export interface ExtSyncConfig {
  requiredDomains: string[]
}

export interface CredentialsService {
  /**
   * 「这一次该读的那份」登录态：每次调用按 `cookieStores.current()` 解析（browser-identity D10）——执行内是
   * 这次执行选定的节点，执行外是本机默认节点；没有节点时就是 `data/cookies/local.json`（升级前的那份）。
   */
  pushedCookies: Pick<PushedCookieStore, 'fetch' | 'status' | 'replace'>
  /** 每个槽位（设备或节点）各一份登录态；执行读自己选定的那份。 */
  cookieStores: DeviceCookieStores
  /** 供 cookie 的 provider；`reconfigure` 可热换来源，持它引用的 adapter 无需重新接线。 */
  cookieProvider: CookieProvider
  /** 按逻辑名解 BYOK key（stored → env 两层）。 */
  tokenProvider: TokenProvider
  /** 所有 provider 合成的解析口，adapter 拿 `fn()` 用。 */
  resolver: CredentialResolver
  /** 现在这一份登录态快照长什么样（握着哪些域、多旧）。纯本地读，绝不抛。 */
  cookieHealth(): Promise<CookieHealth>
  /** 扩展该读哪些域。 */
  extSyncConfig(): ExtSyncConfig
}

export interface CredentialsConfig {
  /** 可写状态根目录——`PushedCookieStore` 的落盘位置。 */
  dataDir: string
  /** 部署环境（BYOK 的环境变量回落）。**显式传入**，域里不读 `process.env`；缺席 = 没有环境回落。 */
  env?: Readonly<Record<string, string | undefined>>
  log: (...args: unknown[]) => void
  /**
   * 这台 Stream 需要同步哪些 cookie 域。**前向引用是有意的**：它从 registry + 已订阅流推出来，
   * 而那两样在装配序上远在本域之后。传一个惰性 thunk，比把凭证域挪到装配末尾要诚实——
   * 这条依赖是"调用时才成立"，不是"装载时才成立"。
   */
  requiredDomains: () => string[]
}

/**
 * 凭证这一域：登录态（cookie）与 API key 的构造。
 *
 * **登录态只有一个来源**：后端在 ext-relay 上向用户的 Chrome 要（`CookiePuller`），整份写进
 * `PushedCookieStore`。**别再引入"从某台第三方服务器拉 cookie"那种形状**——那让一个必须常驻的
 * 进程成为采集的硬依赖，而它一停的表现是最坏的那种：取 cookie 静默失败、采集全程游客态、
 * 一切看着正常。
 *
 * provider 仍然是一层可换源的接缝（`reconfigure`），因为 adapter 持的是它的引用。
 *
 * 没有 `ctx.effect()`：这一域里没有任何对象持句柄或定时器（cookie 的定时拉取住在
 * `CookiePuller`，是采集域的事）。
 */
export const credentialsPlugin = {
  name: 'credentials',
  inject: ['settings'],
  apply(ctx: Context, config: CredentialsConfig): void {
    const settings = ctx.settings

    const cookieStores = new DeviceCookieStores(config.dataDir, config.log)
    // 不再是固定的 local 那份：节点之后，本机的登录态有好几份（每个 profile 一份），读哪份每次现解。
    // 槽位解析器由 auth 域回填（它要扩展中继，比本域晚建）；回填前就是 local。
    const pushedCookies: CredentialsService['pushedCookies'] = {
      fetch: () => cookieStores.current().fetch(),
      status: () => cookieStores.current().status(),
      replace: (cookies) => cookieStores.current().replace(cookies),
    }
    const cookieSource: CookieSource = cookieStores

    const providers: CredentialProvider[] = []
    const cookieProvider = new CookieProvider(cookieSource)
    providers.push(cookieProvider)
    config.log(`[stream] cookies: ${pushedCookies.status().domains.length} domains held`)
    // BYOK STT keys resolved by logical name (see TokenProvider / cf-whisper). Two layers:
    // runtime_config `<logical name>.apiKey` first, env second. The stored layer is what the
    // Source Config Sheet writes — and what a recipe's one-shot `extract` writes after it goes
    // and creates the key itself, which is the whole point of it outranking env: a key obtained
    // at runtime has to take effect at runtime, not after someone edits .env and restarts.
    const tokenProvider = new TokenProvider(
      {
        cloudflare: 'CLOUDFLARE_WORKERS_AI_TOKEN',
        groq: 'GROQ_API_KEY',
        openai: 'OPENAI_API_KEY',
      },
      config.env ?? {},
      (name) => {
        const v = settings.runtimeConfig(name).apiKey
        return typeof v === 'string' && v ? v : null
      },
    )
    providers.push(tokenProvider)

    /** 域名归一由 provider 那一份负责（剥前导点 + 小写），两边共用同一个答案。 */
    const cookieHealth = async (): Promise<CookieHealth> => ({
      domains: await cookieProvider.availableDomains(),
      updatedAt: pushedCookies.status().updatedAt,
    })

    /** `requiredDomains` 是扩展**读哪些域的 cookie**的真相源。它必须从这里下发而不是由扩展自己
     *  维护一份默认清单：漏一个域不会报错，只会让 broker 永远答 "no cookie for domain"，采集/转存
     *  全程游客态却看着一切正常（quark.cn 就这么漏了）。扩展把它与用户自填的域取并集。 */
    const extSyncConfig = (): ExtSyncConfig => ({ requiredDomains: config.requiredDomains() })

    ctx.provide('credentials', {
      pushedCookies,
      cookieStores,
      cookieProvider,
      tokenProvider,
      resolver: new CredentialResolver(providers),
      cookieHealth,
      extSyncConfig,
    })
  },
}
