import { z } from 'zod'
import { PACKAGE_CODE_ENTRY } from './code-entry.ts'
import { manifestSchema } from '../manifest/loader.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { PluginBackend, PluginSourceGrouping } from '../plugins/types.ts'
import type { ExpandSpec, ProviderCategory, ProviderMemberRef } from '../store/types.ts'
import { isProviderMemberRef } from '../store/member-ref.ts'
import { ITEM_ACTION_ICONS, type ItemActionIcon } from '../../shared/item/actions.ts'
import { normalizeLinks, type LinksDeclaration } from './links.ts'

// `links` 的校验住在 links.ts（它和 descriptor 之间只有函数体里的互相引用，见那边头注）。
export { linkPatternProblem } from './links.ts'

/**
 * 一个 Stream 包的描述（`package.json` 的 `stream` 字段）。插件与 recipe 包共用这一份形状——
 * 槽位在不在 = 这个包填没填这一格。权威设计：
 * docs/superpowers/specs/2026-08-05-package-unification-design.md
 *
 * 未知字段一律 strip 不 reject（与 manifestSchema / 旧 descriptorSchema 同一个前向兼容立场）。
 */
export interface StreamDescriptor {
  /** canonical 包身份。旧 recipe 形没有 id，用 facility 顶上。 */
  id: string
  name?: string
  tagline?: string
  description?: string
  homepage?: string
  repository?: string
  docsUrl?: string
  required?: boolean
  /** 设施键（recipe 包必有；插件包可无） */
  facility?: string
  cookieDomain?: string
  rateLimit?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }
  /** 宿主版本下界。P1 只解析携带，校验在 P4。 */
  hostVersion?: string
  /** 内联 Source 清单。文件形态（manifests.yaml）由 scanPackages 合并进来。 */
  sources?: SourceManifest[]
  backend?: PluginBackend
  credentials?: string[]
  normalizer?: string
  /**
   * 这个包带代码：`entry` 是它的 activate 模块（相对包目录），两个名单是它**申报**会注册的
   * adapter / normalizer 名。名单是装载器在**调用 activate 之前**查撞名的唯一依据——先执行
   * 再看返回值，代码就已经跑过了（spec §7 R1）。
   */
  code?: { entry: string; adapters?: string[]; normalizers?: string[]; enrichers?: string[]; connect?: string[] }
  /**
   * 这个包带一个**能力**（`shared/capability/types.ts` 的 `Capability`）：宿主动态 import 这个
   * 模块、取它的 `capability` 导出、经 `src/capabilities/host.ts` mount，它注册的工具从
   * `/api/mcp` 一起出去。值只认字面量 `dist/index.js`（= `PACKAGE_CODE_ENTRY`），因为安装门的
   * 白名单只对这一个含 `/` 的路径开例外——schema 松一格，安装门就得再判一次同一件事。
   */
  capability?: string
  sourceGrouping?: PluginSourceGrouping
  /** npm 壳字段（package.json 顶层，不在 stream 里） */
  pkgName?: string
  pkgVersion?: string
  /** 旧 recipe 包的 schemaVersion。存在 = 这份描述是旧形，调用方据此做版本上界拒绝。 */
  legacySchemaVersion?: number
  /**
   * facility 级送字节策略（spec 2026-09-18-facility-knowledge-in-package §2.1）：命中 `match` 的
   * 媒体直链改由后端代理，`hosts` 是可替换的备选主机。**声明，不是槽位**——宿主只是读表，
   * 与 `rateLimit` / `cookieDomain` 同类，不让一个纯 recipe 包变成"插件"。
   */
  serving?: ServingDeclaration[]
  /** 这个包顶掉了哪些 RSSHub 目录路由（全 id → 退役理由）。只放"上游已使它失效"的。 */
  retires?: Record<string, string>
  /** 这个包出的 Provider 行（spec 2026-09-18-facility-knowledge-stage2-design §2.2）。宿主并进身份表、`ensureSystemRows` 建行。 */
  providers?: ProviderDeclaration[]
  /** 「哪些链接归我、是什么东西」（spec 2026-09-26-link-recognition）：归一后的认领声明，老 `trackUrl` /
   *  `downloadPages` 已翻译进来。见 `src/packages/links.ts`，消费方 `src/links/recognize.ts`。 */
  links?: LinksDeclaration
  /** 「RSSHub 目录里这些命名空间的路由用我的 normalizer」，normalizer 键 = 包 facility。 */
  rsshubNamespaces?: string[]
  /**
   * 目录里标了 `requirePuppeteer`、但带 cookie 走纯 HTTP 就能跑的命名空间：装载目录时不因那个标记
   * 丢掉它们。这是包对上游标记的一句反证，所以住在认领那个站的包里。
   */
  rsshubNoBrowserNamespaces?: string[]
  /** 「把这个域的 cookie 串写进这个环境变量交给 RSSHub」。`{CookieName}` 占位符换成同名 cookie 的值。 */
  rsshubCookieEnv?: string
  /** 「资源搜索里我这个源怎么认」：展示键 / 标签 / 查询参数名 / 条目形状 / 站内搜索页。见 `src/search/seeds.ts`。 */
  searchSources?: SearchSourceDeclaration[]
  /** 「本包的源产出的条目上多带什么」：作者头像去哪取、有哪些可点动作。后端投影时现算，见 `src/packages/item-projection.ts`。 */
  item?: ItemDeclaration
}

/**
 * `stream.item`（spec 2026-09-26-host-package-boundary-design §4）：让前端不再按站分支。
 * 只作用于**本包的源产出的条目**；参数里的 `{点路径}` 在投影时从条目上取值，取不到整条不出。
 */
export interface ItemDeclaration {
  /** 条目没有 `author_avatar` 但有 `author` 时，去本包的这个 enricher 现取 `{ name, face, url }`。 */
  authorEnrich?: { enricher: string; params: Record<string, string> }
  actions?: ItemActionDeclaration[]
}

export interface ItemActionDeclaration {
  id: string
  icon: ItemActionIcon
  label: string
  /** 动作 recipe 的全名，必须属于本包。 */
  recipe: string
  params: Record<string, string>
  /** 两个状态各自发给 recipe 的 `action` 参数：未按下时发 [0]、已按下时发 [1]。 */
  toggle: [string, string]
}

/**
 * 包声明的一个资源搜索源的展示/取数元数据（spec 2026-09-18-facility-knowledge-in-package 的同一条线：
 * 站点知识住包里）。`source`（本包的局部源名，装载期补成全名）与 `provider`（本包出的 Provider 行 id）
 * **恰给一个**——组合体（expand）以行的身份出现在资源搜索里，不是某一个源。
 */
export interface SearchSourceDeclaration {
  source?: string
  provider?: string
  /** 展示键：打在 Release.source 上，前端按它配徽标。 */
  key: string
  label: string
  /** 这个源的主查询参数名（keyword / query / name…）。 */
  param: string
  /** 条目形状：`digest` = 一条是一篇"片名 + 一串网盘链接"的合集体；`flat` = 一行一个种子。 */
  kind: 'digest' | 'flat'
  nsfw?: boolean
  /** 站内搜索页模板，`{q}` 换成 URL 编码后的查询词。 */
  searchUrl?: string
}

export interface ServingDeclaration {
  /** host 匹配。`.` 开头 = 后缀匹配（含裸域），否则全等。语义同 `ServingPolicy.match`。 */
  match: string
  /** 可替换的备选主机；缺省只打原 host。 */
  hosts?: string[]
  /** 人读的一句结论；实测证据放包 README。 */
  reason: string
  /** 替这台主机取字节时带的 `Referer`（反向防盗链：不带就拒的 CDN）。语义同 `ServingPolicy.referer`。 */
  referer?: string
}

/**
 * 包出的一条 Provider 行（spec 2026-09-18-facility-knowledge-stage2-design §2.2）。
 * 形状 = `SystemIdentity` 去掉 `default*` 前缀（`label`/`description`/`members`），加 `callsites`。
 * **是声明不是槽位**：`fillsPluginSlot` 不认它，纯声明的包仍是 recipe 包。
 */
export interface ProviderDeclaration {
  id: string
  category: ProviderCategory
  /** 具名 serves 键（**不含**兜底）。撞名在装载期硬拒，见 src/providers/identities.ts。 */
  serveKeys: string[]
  /** 本 category 的兜底行。包出的行几乎不该要它——兜底是宿主的位置。 */
  fallback?: boolean
  strategy: 'sequential' | 'concurrent' | 'expand'
  /** 仅 strategy:'expand' 用（依赖式 A→B 组合子配置）。 */
  expand?: ExpandSpec
  /** 这条行申报的能力标签：`{mode:'auto', provides}` 段展开时把它当一个组合成员收进去（同源 manifest 的 `provides`）。 */
  provides?: string[]
  contract?: Record<string, unknown> | null
  label: string
  description: string
  members: ProviderMemberRef[]
  /** 这一行是哪些调用点的**默认成员**（调用点的默认行列表 = 宿主默认 ∪ 声明了它的包行）。 */
  callsites?: string[]
}

const devSchema = z.object({
  image: z.string().min(1),
  mount: z.string().min(1),
  workdir: z.string().optional(),
  command: z.string().min(1),
})

const backendSchema = z.object({
  image: z.string().min(1),
  service: z.string().min(1).optional(),
  port: z.number().int().positive(),
  health: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  gpu: z.boolean().optional(),
  volumes: z.array(z.string().min(1)).optional(),
  mem: z.string().min(1).optional(),
  // 只认 Config.User 的数字形（uid / uid:gid）。名字形（`root`）要镜像的 /etc/passwd 配合，
  // 换一个镜像就静默失效，不收。
  user: z.string().regex(/^\d+(:\d+)?$/).optional(),
  publish: z.number().int().positive().optional(),
  dev: devSchema.optional(),
  standby: z
    .object({ idleMinutes: z.number().int().min(1), startTimeoutSeconds: z.number().int().min(5).optional() })
    .optional(),
})

const sourceGroupingSchema = z.object({
  enabled: z.boolean().default(true),
  resolver: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
})

const rateLimitSchema = z.object({
  burst: z.number().int().positive(),
  perMinute: z.number().positive(),
  // 长时窗累计预算（`FacilityRateLimit.perHour`）。**这一格必须在这里出现**：zod 对象解析会把
  // 没声明的键直接丢掉——漏在这儿的话，包里写了 perHour 也一路静默变成"没有累计上限"。
  perHour: z.number().positive().optional(),
  maxWaitMs: z.number().int().positive().optional(),
})

/**
 * 常见公共后缀（注册局那一层）。**不是完整 PSL**——完整 PSL 要拉一份外部数据、还会过期；
 * 这里只挡最容易被顺手写下的那些。单标签（`cn`、`localhost`）由 `credentialDomainProblem`
 * 的"不含点"那条统一拒掉，所以这份名单真正承重的是多标签那几条（`com.cn`、`co.uk`…）。
 */
const PUBLIC_SUFFIXES = new Set([
  // 单标签（与"不含点"那条重叠，留着是为了让名单读起来完整）
  'com', 'net', 'org', 'edu', 'gov', 'cn', 'io', 'co', 'me', 'tv', 'cc', 'info', 'biz', 'app', 'dev', 'xyz',
  'uk', 'jp', 'kr', 'tw', 'hk', 'us', 'de', 'fr', 'ru', 'in', 'br', 'au', 'ca', 'nl', 'it', 'es', 'sg', 'nz',
  // 多标签
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'co.kr', 'or.kr',
  'com.tw', 'com.hk', 'com.br', 'com.mx', 'com.sg', 'co.in', 'co.nz',
])

/**
 * 一条 `credentials` 申报合不合法。不合法返回给人看的原因，合法返回 null。
 *
 * 为什么要管：取 cookie 是**后缀匹配**（`credentials/cookie-provider.ts`），
 * 于是申报 `cn` 就等于申报了 `*.cn` 下**所有**站点的登录态——申报名单本来是这个包的授权边界，
 * 写一个后缀就把边界掏空了。边界必须落在具体站点上。
 */
export function credentialDomainProblem(domain: string): string | null {
  const d = domain.trim().replace(/^\.+/, '').toLowerCase()
  if (!d) return '空条目'
  if (!d.includes('.')) {
    return `'${domain}' 是单标签，不是一个站点域名；申报它等于申报它下面所有站点的登录态`
  }
  if (PUBLIC_SUFFIXES.has(d)) {
    return `'${domain}' 是公共后缀，不是一个站点域名；申报一个后缀 = 申报它下面所有站点的登录态`
  }
  return null
}

const credentialsSchema = z.array(z.string()).superRefine((list, ctx) => {
  list.forEach((domain, i) => {
    const problem = credentialDomainProblem(domain)
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        path: [i],
        message: `${problem}。请写具体站点域名（如 'example.com'、'pan.quark.cn'）`,
      })
    }
  })
})

/**
 * `serving.hosts` 是让**后端**去连的地址（不是 302 给浏览器）——第三方包能借它让后端打内网。
 * 装载时能判的只有字面量：私网/loopback/链路本地 IP、单标签名。解析到私网 IP 的公网主机名
 * 这里判不出来（不做 DNS），这是已知边界，写在 PACKAGE.md 的字段说明里。
 */
export function servingHostProblem(host: string): string | null {
  const raw = host.trim()
  if (!raw) return '空条目'
  // 先归一再判：判据要落在 **URL 层真正会去连的那个主机** 上，不是声明里那串字面量。
  // `0177.0.0.1`（八进制）、`[::ffff:127.0.0.1]`（IPv4 映射）、`localhost.`（尾点）三种写法
  // 逐字符看都不像内网，`u.host = <它>` 之后全是 loopback/私网——绕过判据的正是这一步差异。
  let canonical: string
  try {
    canonical = new URL(`http://${raw}`).hostname.toLowerCase()
  } catch {
    return `'${host}' 不是一个能解析的主机`
  }
  if (!canonical) return `'${host}' 不是一个能解析的主机`
  let h = canonical.replace(/\.$/, '').replace(/^\[|\]$/g, '')
  // IPv4 映射的 IPv6（`::ffff:a.b.c.d`，归一后是 `::ffff:7f00:1` 这种十六进制形）拆回 IPv4 判
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const [hi, lo] = [parseInt(mappedHex[1], 16), parseInt(mappedHex[2], 16)]
    h = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  } else if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    h = h.slice('::ffff:'.length)
  }
  if (!h) return `'${host}' 不是一个能解析的主机`
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 127) return `'${host}' 是 loopback 地址`
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return `'${host}' 是私网地址`
    if (a === 169 && b === 254) return `'${host}' 是链路本地地址`
    return null
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return `'${host}' 是 loopback 地址`
    if (/^f[cd]/.test(h)) return `'${host}' 是私网地址`
    if (/^fe[89ab]/.test(h)) return `'${host}' 是链路本地地址`
    return null
  }
  if (!h.includes('.')) return `'${host}' 是单标签名（localhost / 内网短名），后端不替包连它`
  return null
}

/**
 * `match` 决定这条策略**捕获谁的流量**——带上 `hosts` 之后它还会替换掉主机，
 * 所以一个 `.fm` 就是"这个包接管整个 .fm 下所有 facility 的字节"。边界必须落在具体站点上：
 * 去掉前导点之后至少两段标签。
 */
export function servingMatchProblem(match: string): string | null {
  const m = match.trim().replace(/^\.+/, '').toLowerCase()
  if (!m) return '空条目'
  if (m.split('.').filter(Boolean).length < 2) {
    return `'${match}' 只有一段标签，等于接管它下面所有站点的字节`
  }
  return null
}

const servingSchema = z.array(z.object({
  match: z.string().min(1),
  hosts: z.array(z.string().min(1)).optional(),
  reason: z.string().min(1),
  referer: z.string().regex(/^https?:\/\/[^\s]+$/, 'serving.referer 必须是 http(s) 地址').optional(),
}).superRefine((decl, ctx) => {
  const matchProblem = servingMatchProblem(decl.match)
  if (matchProblem) {
    ctx.addIssue({ code: 'custom', path: ['match'], message: `${matchProblem}。请写具体站点域名（如 '.example.fm'）` })
  }
  decl.hosts?.forEach((host, i) => {
    const problem = servingHostProblem(host)
    if (problem) ctx.addIssue({ code: 'custom', path: ['hosts', i], message: `${problem}。serving.hosts 只收公网主机` })
  })
}))

const retiresSchema = z.record(z.string(), z.string().min(1, '退役理由不能为空')).superRefine((rec, ctx) => {
  for (const key of Object.keys(rec)) {
    if (!key.startsWith('rsshub:')) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'retires 的键是 RSSHub 目录 id，必须以 rsshub: 开头' })
    }
  }
})

/** 环境变量名模板的文法：全大写下划线，中间可以嵌 `{CookieName}` 占位符。
 *  `RSSHub` 对某些站是按登录用户 id 分键的（`XXX_COOKIE_<uid>`），这条文法就是为它。 */
const RSSHUB_COOKIE_ENV_RE = /^[A-Z][A-Z0-9_]*(\{[A-Za-z0-9_]+\}[A-Z0-9_]*)*$/

/** 这条模板能不能用。不合法返回给人看的原因，合法返回 null。 */
export function rsshubCookieEnvProblem(template: string): string | null {
  if (!RSSHUB_COOKIE_ENV_RE.test(template)) {
    return `'${template}' 不是合法的环境变量名模板（大写字母/数字/下划线，可嵌 {CookieName} 占位符，且必须以字母开头）`
  }
  return null
}

const rsshubCookieEnvSchema = z.string().min(1).superRefine((tpl, ctx) => {
  const problem = rsshubCookieEnvProblem(tpl)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

const providerSchema = z.array(z.object({
  id: z.string().min(1),
  category: z.enum(['search', 'resolve', 'download', 'transform', 'transcribe', 'llm', 'metadata', 'images', 'data']),
  serveKeys: z.array(z.string().min(1)).min(1, 'serveKeys 至少一个键——一条谁都不服务的行是死配置'),
  fallback: z.boolean().optional(),
  strategy: z.enum(['sequential', 'concurrent', 'expand']),
  contract: z.record(z.string(), z.unknown()).nullable().optional(),
  label: z.string().min(1),
  description: z.string().min(1),
  members: z.array(z.unknown()).min(1, 'members 至少一条').superRefine((members, ctx) => {
    members.forEach((m, i) => {
      if (!isProviderMemberRef(m)) {
        ctx.addIssue({ code: 'custom', path: [i], message: 'members 里这一条不是合法的 Provider 成员形状（见 src/store/member-ref.ts）' })
      }
    })
  }),
  callsites: z.array(z.string().min(1)).optional(),
  expand: z.object({
    map: z.record(z.string(), z.string()),
    assemble: z.object({ url: z.string().min(1), type: z.string().min(1), desc: z.string().min(1) }),
    handleCap: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  }).optional(),
  provides: z.array(z.string().min(1)).optional(),
}).superRefine((row, ctx) => {
  // 只有一半的行会在执行器里静默变成一条取不到东西的顺序梯子（宿主静态表由 index.real.test.ts 钉同一条）。
  if (!!row.expand !== (row.strategy === 'expand')) {
    ctx.addIssue({ code: 'custom', path: ['expand'], message: 'expand 配置与 strategy:"expand" 必须同进同退' })
  }
}))

const searchSourcesSchema = z.array(z.object({
  source: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  key: z.string().min(1),
  label: z.string().min(1),
  param: z.string().min(1),
  kind: z.enum(['digest', 'flat']),
  nsfw: z.boolean().optional(),
  searchUrl: z.string().optional(),
}).superRefine((s, ctx) => {
  if ((s.source == null) === (s.provider == null)) {
    ctx.addIssue({ code: 'custom', message: 'searchSources 的一条必须恰给 source 或 provider 之一' })
  }
  if (s.searchUrl != null) {
    if (!/^https?:\/\//.test(s.searchUrl)) ctx.addIssue({ code: 'custom', path: ['searchUrl'], message: 'searchUrl 必须是 http(s) 地址' })
    else if (!s.searchUrl.includes('{q}')) ctx.addIssue({ code: 'custom', path: ['searchUrl'], message: 'searchUrl 必须带 {q} 占位（查询词填在哪）' })
  }
}))

const DOWNLOAD_YIELDS = ['magnet', 'ed2k', 'quark', 'baidu', 'aliyun', 'unknown'] as const

/**
 * `links` 的结构层（形状对不对，spec 2026-09-26-link-recognition §3）。语义校验在
 * `src/packages/links.ts` 的 `normalizeLinks` 里——它要看 facility 和整张 hosts 表。
 */
const linksRawSchema = z.object({
  hosts: z.array(z.union([
    z.string().min(1),
    z.object({ host: z.string().min(1), platform: z.string().min(1) }),
  ])).min(1, 'hosts 至少一个主机——一张谁都不认领的表是死声明'),
  shortHosts: z.array(z.string().min(1)).optional(),
  patterns: z.array(z.object({
    kind: z.enum(['track', 'download-page']),
    pattern: z.string().min(1),
    yields: z.enum(DOWNLOAD_YIELDS).optional(),
    platform: z.string().min(1).optional(),
  })).optional(),
})
export type RawLinks = z.infer<typeof linksRawSchema>

/** 迁移期别名 `downloadPages` 的结构层（翻译成 `links.patterns` 后才做语义校验）。 */
const legacyDownloadPagesSchema = z.array(z.object({ pattern: z.string().min(1), kind: z.enum(DOWNLOAD_YIELDS) }))

const rsshubNamespacesSchema = z.array(z.string().min(1))

/** `{点路径}` 占位符的文法：只认取值，不认表达式。与 `src/packages/item-projection.ts` 的代入同一条。 */
export const ITEM_PLACEHOLDER_RE = /\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g

/** 一个参数值里除了合法占位符之外还有没有花括号——有就是想写表达式，拒。 */
export function itemParamProblem(value: string): string | null {
  if (/[{}]/.test(value.replace(ITEM_PLACEHOLDER_RE, ''))) {
    return `'${value}' 里有不合文法的占位符（只认 {点路径}，不认表达式 / 条件）`
  }
  return null
}

const itemParamsSchema = z.record(z.string(), z.string()).superRefine((params, ctx) => {
  for (const [k, v] of Object.entries(params)) {
    const problem = itemParamProblem(v)
    if (problem) ctx.addIssue({ code: 'custom', path: [k], message: problem })
  }
})

const itemSchema = z.object({
  authorEnrich: z.object({ enricher: z.string().min(1), params: itemParamsSchema }).optional(),
  actions: z.array(z.object({
    id: z.string().min(1),
    icon: z.enum(ITEM_ACTION_ICONS, { message: `icon 只认宿主词表：${ITEM_ACTION_ICONS.join(' / ')}` }),
    label: z.string().min(1),
    recipe: z.string().min(1),
    params: itemParamsSchema,
    toggle: z.tuple([z.string().min(1), z.string().min(1)], { message: 'toggle 必须恰好两个非空值（未按下 / 已按下时发给 recipe 的 action）' }),
  })).optional(),
}).superRefine((item, ctx) => {
  const seen = new Set<string>()
  item.actions?.forEach((a, i) => {
    if (seen.has(a.id)) ctx.addIssue({ code: 'custom', path: ['actions', i, 'id'], message: `动作 id '${a.id}' 重复` })
    seen.add(a.id)
  })
})

/**
 * `item` 里要看**包的其它格**才判得了的两条：动作 recipe 属于本包（npm 名前缀）、`authorEnrich`
 * 用的是本包申报的 enricher。放在 package.json 层判，因为 npm 名在 `stream` 之外。
 */
function itemOwnershipProblems(
  name: string | undefined,
  enrichers: readonly string[] | undefined,
  item: z.infer<typeof itemSchema>,
): Array<{ path: PropertyKey[]; message: string }> {
  const out: Array<{ path: PropertyKey[]; message: string }> = []
  item.actions?.forEach((a, i) => {
    const path = ['stream', 'item', 'actions', i, 'recipe']
    if (!name) out.push({ path, message: '包没有 npm 名（package.json#name），动作 recipe 的归属无从核对' })
    else if (!a.recipe.startsWith(`${name}/`)) {
      out.push({ path, message: `'${a.recipe}' 必须是本包的全名（${name}/<局部名>）——一个包不能把按钮挂到别家的动作上` })
    }
  })
  if (item.authorEnrich && !(enrichers ?? []).includes(item.authorEnrich.enricher)) {
    out.push({
      path: ['stream', 'item', 'authorEnrich', 'enricher'],
      message: `'${item.authorEnrich.enricher}' 不在本包的 code.enrichers 里`,
    })
  }
  return out
}

const codeSchema = z.object({
  entry: z.string().min(1),
  adapters: z.array(z.string().min(1)).optional(),
  normalizers: z.array(z.string().min(1)).optional(),
  /** `/api/enrich?source=<名字>` 的名字。撞名（包与包、包与宿主自己的 source 名）装载期硬拒。 */
  enrichers: z.array(z.string().min(1)).optional(),
  /** `POST /api/credentials/<域名>/connect` 的域名。每个都必须出现在 `credentials` 里。 */
  connect: z.array(z.string().min(1)).optional(),
})

const streamSchema = z.object({
  id: z.string().min(1).optional(),
  /** 旧 recipe 形的判别字段，读进来即丢弃——形状由 legacySchemaVersion 记住 */
  type: z.literal('recipe').optional(),
  schemaVersion: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  tagline: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  docsUrl: z.string().url().optional(),
  required: z.boolean().optional(),
  facility: z.string().min(1).optional(),
  cookieDomain: z.string().optional(),
  author: z.string().optional(),
  rateLimit: rateLimitSchema.optional(),
  hostVersion: z.string().min(1).optional(),
  sources: z.array(manifestSchema).optional(),
  backend: backendSchema.optional(),
  credentials: credentialsSchema.optional(),
  normalizer: z.string().optional(),
  /** normalizer 的迁移期别名，仍受理 */
  presenter: z.string().optional(),
  code: codeSchema.optional(),
  // 只认那一个字面量（理由见 code-entry.ts 与 StreamDescriptor.capability 的注释）。
  capability: z.literal(PACKAGE_CODE_ENTRY).optional(),
  sourceGrouping: sourceGroupingSchema.optional(),
  serving: servingSchema.optional(),
  retires: retiresSchema.optional(),
  providers: providerSchema.optional(),
  // 迁移期别名（spec 2026-09-26-link-recognition §6）：只做结构层，装载时翻译成 `links.patterns`
  // 后统一过 `linkPatternProblem`。内置包不许再写它们（src/packages/legacy-link-fields.guard.test.ts）。
  trackUrl: z.array(z.string().min(1)).optional(),
  links: linksRawSchema.optional(),
  rsshubNamespaces: rsshubNamespacesSchema.optional(),
  rsshubNoBrowserNamespaces: rsshubNamespacesSchema.optional(),
  rsshubCookieEnv: rsshubCookieEnvSchema.optional(),
  searchSources: searchSourcesSchema.optional(),
  downloadPages: legacyDownloadPagesSchema.optional(),
  item: itemSchema.optional(),
})

/**
 * `package.json#stream` 受理的全部键（**从 schema 现取，不手抄**）。
 *
 * 唯一的消费者是 `declaresFacilityKnowledge` 的漂移守卫（`src/replay/recipe-package.ts`）：
 * 它用「全部键 − 明确不属于 facility 知识的那些」反推那条判据该覆盖哪几格，于是往上面加一格
 * 声明而忘了回补判据，测试当场红。手抄一份名单在这里就等于把守卫本身也变成会漂的东西。
 */
export const STREAM_DECLARATION_KEYS: readonly string[] = Object.keys(streamSchema.shape)

const packageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  stream: streamSchema,
}).superRefine((pkg, ctx) => {
  if (!pkg.stream.item) return
  for (const p of itemOwnershipProblems(pkg.name, pkg.stream.code?.enrichers, pkg.stream.item)) {
    ctx.addIssue({ code: 'custom', ...p })
  }
})

/** 把 zod issue path 格式化成人可读的形状：数字下标用 `[n]`，其余用 `.` 连接。 */
export function formatIssuePath(path: PropertyKey[]): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${String(seg)}` : String(seg)
  }
  return out || '(root)'
}

export function parseStreamDescriptor(raw: unknown, label: string): StreamDescriptor {
  const parsed = packageJsonSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = formatIssuePath(issue?.path ?? [])
    throw new Error(`Invalid Stream package ${label}: ${path} — ${issue?.message}`)
  }
  const { name, version, stream } = parsed.data
  const id = stream.id ?? stream.facility
  if (!id) throw new Error(`Invalid Stream package ${label}: stream.id — required (or stream.facility)`)
  let links: LinksDeclaration | undefined
  try {
    links = normalizeLinks(stream.links, { trackUrl: stream.trackUrl, downloadPages: stream.downloadPages }, { facility: stream.facility, id })
  } catch (e) {
    throw new Error(`Invalid Stream package ${label}: ${(e as Error).message}`)
  }

  const out: StreamDescriptor = {
    id,
    name: stream.name,
    tagline: stream.tagline,
    description: stream.description,
    homepage: stream.homepage,
    repository: stream.repository,
    docsUrl: stream.docsUrl,
    required: stream.required,
    facility: stream.facility,
    cookieDomain: stream.cookieDomain,
    rateLimit: stream.rateLimit,
    hostVersion: stream.hostVersion,
    sources: stream.sources as SourceManifest[] | undefined,
    backend: stream.backend as PluginBackend | undefined,
    credentials: stream.credentials,
    normalizer: stream.normalizer ?? stream.presenter,
    code: stream.code,
    capability: stream.capability,
    sourceGrouping: stream.sourceGrouping as PluginSourceGrouping | undefined,
    serving: stream.serving,
    retires: stream.retires,
    providers: stream.providers as ProviderDeclaration[] | undefined,
    links,
    rsshubNamespaces: stream.rsshubNamespaces,
    rsshubNoBrowserNamespaces: stream.rsshubNoBrowserNamespaces,
    rsshubCookieEnv: stream.rsshubCookieEnv,
    searchSources: stream.searchSources as SearchSourceDeclaration[] | undefined,
    item: stream.item as ItemDeclaration | undefined,
    pkgName: name,
    pkgVersion: version,
    legacySchemaVersion: stream.schemaVersion,
  }
  for (const k of Object.keys(out) as (keyof StreamDescriptor)[]) if (out[k] === undefined) delete out[k]
  return out
}
