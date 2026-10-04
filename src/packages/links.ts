/**
 * `package.json#stream.links`——「哪些链接归我、是什么东西」的**唯一一张声明表**
 * （spec 2026-09-26-link-recognition-design §3）。宿主的认领函数（`src/links/recognize.ts`）只读它。
 *
 * 这里管两件事：`linkPatternProblem`（一条 pattern 能不能用）与 `normalizeLinks`（把声明归一成每条都带
 * platform 的形状，并把迁移期别名 `trackUrl` / `downloadPages` 翻译进来）。结构层的 zod 形状在
 * descriptor.ts（`linksRawSchema`），和其余声明位的 schema 放在一起。
 *
 * **与 descriptor.ts 的环引用**：这里 import `servingHostProblem` / `credentialDomainProblem`，
 * descriptor.ts 又 import 这里的 `normalizeLinks`——两边都只在**函数体里**用对方的东西，模块初始化时
 * 互不触碰，所以谁先被加载都安全。往这个文件的顶层加任何「初始化时就读 descriptor 导出」的代码
 * （比如拿它的 schema 拼新 schema），这条环就会在「先加载 links.ts」的那条路上炸成 TDZ。
 */
import { credentialDomainProblem, servingHostProblem, type RawLinks } from './descriptor.ts'

export type LinkKind = 'track' | 'download-page'
export type DownloadYield = 'magnet' | 'ed2k' | 'quark' | 'baidu' | 'aliyun' | 'unknown'

export interface LinkHost { host: string; platform: string }
export interface LinkPattern { kind: LinkKind; pattern: string; platform: string; yields?: DownloadYield }

/** 归一后的声明：每个 host / pattern 都带着它的 platform。 */
export interface LinksDeclaration {
  hosts: LinkHost[]
  shortHosts: string[]
  patterns: LinkPattern[]
  /** 这份声明里有多少是从迁移期别名翻译来的（给「谁还在用老写法」留痕）。 */
  legacy?: Array<'trackUrl' | 'downloadPages'>
}

/** pattern 源串长度上限：一条「这是我家的什么」的 URL 文法不需要更长，而它要对每一个粘进来的 URL 跑一遍。 */
const LINK_PATTERN_MAX_SOURCE = 200

/** 嵌套量词的启发式：一个**自身被量化**的、内部也以量词收尾的分组（`(a+)+`、`(.*)*`…）——灾难性回溯最常见的形状。 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}]\)[+*{]/

/** 反证样本：都是**别人家**的 URL，一条都不许命中。这张表是全局的、先声明者胜，一条过宽的文法
 *  等于把别人家的链接认领走（`download-page` 那一档还会让宿主去抓它）。 */
const LINK_PATTERN_CONTROL_URLS = [
  'https://example.com/',
  'https://example.org/a/b?id=123',
  'http://localhost:8900/x/1',
  'https://192.168.1.1/song/1',
]

/** 时间闸：拿两条病理串跑，两次里最好的一次超过它就判这条文法有回溯风险。 */
const LINK_PATTERN_PROBE_BUDGET_MS = 50

/** 平台键拼进派发键 `<platform>-<名词>`，所以只收一个标识符形状。 */
const PLATFORM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** 源串开头的协议前缀（整串锚定）。 */
const SCHEME_PREFIX = /^\^https\??:(?:\/\/|\\\/\\\/)/

/** 一个主机被一张主机表覆盖吗：全等，或按 label 边界的后缀（`evil-x.com` 不算 `x.com`）。 */
export function hostCovered(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase()
  return hosts.some((d) => h === d || h.endsWith(`.${d}`))
}

/** pattern 的 host 段：协议前缀之后、第一个路径分隔（`/` 或 `\/`）之前。没有协议前缀 → null。 */
function hostSectionOf(pattern: string): string | null {
  const m = SCHEME_PREFIX.exec(pattern)
  if (!m) return null
  const rest = pattern.slice(m[0].length)
  let i = 0
  while (i < rest.length) {
    const c = rest[i]
    if (c === '\\') {
      if (rest[i + 1] === '/') break
      i += 2
      continue
    }
    if (c === '/') break
    i++
  }
  return rest.slice(0, i)
}

/** host 段里的字面域名（反转义、小写）。`www\.example\.com` → `www.example.com`。 */
export function literalHostsOf(pattern: string): string[] {
  const section = hostSectionOf(pattern)
  if (!section) return []
  const tokens = section.match(/(?:[a-z0-9-]+\\\.)+[a-z]{2,}/gi) ?? []
  return [...new Set(tokens.map((t) => t.replace(/\\\./g, '.').toLowerCase()))]
}

/** host 段里能让它越过主机边界的通配：裸 `.`、取反字符类、`\S` 一类。有了它 `^https://.*\.x\.com`
 *  就能命中 `https://evil.com/a.x.com`——这张表兼作 SSRF 白名单，不能留这个口子。 */
function hostWildcardOf(section: string): string | null {
  for (let i = 0; i < section.length; i++) {
    const c = section[i]
    if (c === '\\') {
      const e = section[i + 1]
      if (e && 'SWDsw'.includes(e)) return `\\${e}`
      i++
      continue
    }
    if (c === '.') return '.'
    if (c === '[' && section[i + 1] === '^') return '[^'
  }
  return null
}

/** 拿两条病理串跑一遍，回墙钟耗时（ms）。 */
function probe(re: RegExp): number {
  const started = performance.now()
  for (const s of ['a'.repeat(2000), `https://x.example/${'a?'.repeat(1000)}`]) re.test(s)
  return performance.now() - started
}

/**
 * 一条 `links.patterns` 能不能用（null = 能）。合并了原 `trackUrl` 与 `downloadPages` 两份校验。
 *
 * - 形状：以 `^https://` 或 `^https?://` 开头（整串锚定开头）、能编译、不匹配空串；
 *   `track` 必须有命名组 `id`；`download-page` 必须以 `$` 结尾（**它兼作 SSRF 白名单**）且带 `yields`。
 * - 广度：host 段至少指名一个字面域名（转义的 `\.` + 字母），且**每个都落在本包的 `hosts` 里**
 *   （包不能靠 pattern 去认领别家的链接）；host 段不许有能越过主机边界的通配；不许命中控制 URL。
 * - 复杂度：源串不超 200 字符、不含嵌套量词，病理串实跑两次最好的一次不超 50ms。
 */
export function linkPatternProblem(p: { kind: LinkKind; pattern: string; yields?: string }, hosts: readonly string[]): string | null {
  const src = p.pattern
  if (src.length > LINK_PATTERN_MAX_SOURCE) return `'${src.slice(0, 40)}…' 有 ${src.length} 个字符，超过上限 ${LINK_PATTERN_MAX_SOURCE}`
  if (!SCHEME_PREFIX.test(src)) return `'${src}' 必须以 ^https:// 或 ^https?:// 开头（整串锚定开头）`
  if (NESTED_QUANTIFIER.test(src)) return `'${src}' 含嵌套量词（被量化的分组内部又以量词收尾），有灾难性回溯风险`
  let re: RegExp
  try { re = new RegExp(src) } catch (e) { return `'${src}' 不是合法正则：${(e as Error).message}` }
  if (re.test('')) return `'${src}' 匹配空串，等于认领所有输入`
  if (p.kind === 'track') {
    if (!/\(\?<id>/.test(src)) return `'${src}' 是 track，必须有命名捕获组 (?<id>…)`
    if (p.yields) return `'${src}' 是 track，yields 只给 download-page`
  } else {
    if (!src.endsWith('$')) return `'${src}' 是 download-page，必须以 $ 结尾（整串锚定——它兼作宿主去抓取的白名单）`
    if (!p.yields) return `'${src}' 是 download-page，必须写 yields（解开后是什么）`
  }
  const section = hostSectionOf(src) ?? ''
  const wildcard = hostWildcardOf(section)
  if (wildcard) return `'${src}' 的主机段里有通配 '${wildcard}'，能越过主机边界`
  const literal = literalHostsOf(src)
  if (!literal.length) return `'${src}' 的主机段没有指名任何字面域名（需要转义的 '\\.' + 字母）`
  const foreign = literal.find((h) => !hostCovered(h, hosts))
  if (foreign) return `'${src}' 指名的 ${foreign} 不在本包的 links.hosts 里（包不能靠 pattern 认领别家的链接）`
  const hit = LINK_PATTERN_CONTROL_URLS.find((url) => re.test(url))
  if (hit) return `'${src}' 命中了与它无关的 ${hit}，文法过宽`
  // 取两次里最好的那次：一次 GC 暂停就够把一条正当的文法判成回溯风险，真有回溯的两次都会超。
  const spent = Math.min(probe(re), probe(re))
  if (spent > LINK_PATTERN_PROBE_BUDGET_MS) return `'${src}' 跑病理串两次都超过 ${LINK_PATTERN_PROBE_BUDGET_MS}ms（最好的一次 ${spent.toFixed(0)}ms），有回溯风险`
  return null
}

/** 一个 host 条目的问题（null = 能用）。只收公网主机、至少两段标签、不是公共后缀。 */
function hostProblem(host: string): string | null {
  if (host.split('.').filter(Boolean).length < 2) return `'${host}' 只有一段标签，不是一个站点主机`
  return servingHostProblem(host) ?? credentialDomainProblem(host)
}

function normHost(host: string): string {
  return host.trim().replace(/^\.+/, '').toLowerCase()
}

/** 老 `trackUrl` 的协议前缀写法（剥掉后统一补 `^https?://`）。 */
const LEGACY_SCHEME_PREFIXES = ['(?:https?://)?', '(https?://)?', 'https?://', 'https://', 'http://', '(?:https?:\\/\\/)?', 'https?:\\/\\/', 'https:\\/\\/', 'http:\\/\\/']

/**
 * 迁移期别名 `trackUrl` 的一条 → `links.patterns` 的 track。老文法未锚定、第 1 个捕获组是 id：
 * 剥掉可能写着的开头 `^` 与协议，补上 `^https?://(?:[a-z0-9-]+\.)*`（保留老文法「任何子域都认」的语义），
 * 把第一个非 `(?` 的捕获组改名成 `(?<id>`。改不出来（没有捕获组）→ null。
 */
export function translateLegacyTrackUrl(source: string): string | null {
  let body = source.startsWith('^') ? source.slice(1) : source
  const prefix = LEGACY_SCHEME_PREFIXES.find((p) => body.startsWith(p))
  if (prefix) body = body.slice(prefix.length)
  // 老校验把「裸 `.` + 字母」也算字面域名点（`www.example.com/…`）；新校验只认转义的——主机段里
  // 夹在两个标签字符之间的裸点按字面转义，`(.+)` 这种通配点不动（它照样会被判成越界通配）。
  const slash = body.search(/\/|\\\//)
  const hostRun = slash < 0 ? body : body.slice(0, slash)
  body = hostRun.replace(/(?<=[A-Za-z0-9-])(?<!\\)\.(?=[A-Za-z0-9])/g, '\\.') + body.slice(hostRun.length)
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue }
    if (body[i] === '(' && body[i + 1] !== '?') {
      return `^https?://(?:[a-z0-9-]+\\.)*${body.slice(0, i)}(?<id>${body.slice(i + 1)}`
    }
  }
  return null
}

/**
 * 把一个包的 `links`（及迁移期别名）归一成 `LinksDeclaration`。有问题**抛**，信息是给人看的原因
 * ——`parseStreamDescriptor` 包上包路径，走 `onPackageError`（这个包拒装，其余照装）。
 *
 * platform：显式 `links` 缺省取 `facility`，没有 facility 就必须每条显式写；迁移期别名翻译出来的
 * 条目 platform = `facility ?? id`——与 RecipePackage.facility 同一个数（老写法的曲目平台
 * 恒等于包 facility，翻译不改这个答案）。
 */
export function normalizeLinks(
  raw: RawLinks | undefined,
  legacy: { trackUrl?: string[]; downloadPages?: Array<{ pattern: string; kind: DownloadYield }> },
  pkg: { facility?: string; id: string },
): LinksDeclaration | undefined {
  if (!raw && !legacy.trackUrl?.length && !legacy.downloadPages?.length) return undefined
  const platformOf = (explicit: string | undefined, where: string): string => {
    const p = explicit ?? pkg.facility
    if (!p) throw new Error(`${where}: 没有 stream.facility 时必须显式写 platform`)
    if (!PLATFORM_RE.test(p)) throw new Error(`${where}: platform '${p}' 不是合法的平台键（字母数字、下划线、连字符）`)
    return p
  }
  const hosts: LinkHost[] = []
  const addHost = (host: string, platform: string, where: string): void => {
    const h = normHost(host)
    const problem = hostProblem(h)
    if (problem) throw new Error(`${where}: ${problem}`)
    if (hosts.some((x) => x.host === h)) throw new Error(`${where}: 主机 '${h}' 重复`)
    hosts.push({ host: h, platform })
  }
  raw?.hosts.forEach((entry, i) => {
    const where = `links.hosts[${i}]`
    if (typeof entry === 'string') addHost(entry, platformOf(undefined, where), where)
    else addHost(entry.host, platformOf(entry.platform, where), where)
  })

  const patterns: LinkPattern[] = (raw?.patterns ?? []).map((p, i) => ({
    kind: p.kind,
    pattern: p.pattern,
    platform: platformOf(p.platform, `links.patterns[${i}]`),
    ...(p.yields ? { yields: p.yields } : {}),
  }))

  // 迁移期别名：翻译成 patterns，hosts 由 pattern 里的字面域名推出来（老写法没有 hosts 这一格）。
  const used: Array<'trackUrl' | 'downloadPages'> = []
  const legacyPlatform = (): string => platformOf(pkg.facility ?? pkg.id, 'trackUrl/downloadPages')
  const adoptHostsOf = (pattern: string, where: string): void => {
    const names = hosts.map((h) => h.host)
    for (const h of literalHostsOf(pattern)) if (!hostCovered(h, names)) addHost(h, legacyPlatform(), where)
  }
  legacy.trackUrl?.forEach((src, i) => {
    const where = `trackUrl[${i}]`
    const pattern = translateLegacyTrackUrl(src)
    if (!pattern) throw new Error(`${where}: '${src}' 没有捕获组，翻译不出 track id`)
    adoptHostsOf(pattern, where)
    patterns.push({ kind: 'track', pattern, platform: legacyPlatform() })
    if (!used.includes('trackUrl')) used.push('trackUrl')
  })
  legacy.downloadPages?.forEach((d, i) => {
    adoptHostsOf(d.pattern, `downloadPages[${i}]`)
    patterns.push({ kind: 'download-page', pattern: d.pattern, platform: legacyPlatform(), yields: d.kind })
    if (!used.includes('downloadPages')) used.push('downloadPages')
  })

  const hostNames = hosts.map((h) => h.host)
  const shortHosts = (raw?.shortHosts ?? []).map((s, i) => {
    const h = normHost(s)
    const problem = hostProblem(h)
    if (problem) throw new Error(`links.shortHosts[${i}]: ${problem}`)
    if (!hostCovered(h, hostNames)) throw new Error(`links.shortHosts[${i}]: '${h}' 不在 links.hosts 里（短链主机必须同时归本包）`)
    return h
  })

  patterns.forEach((p, i) => {
    const problem = linkPatternProblem(p, hostNames)
    if (problem) throw new Error(`links.patterns[${i}]: ${problem}`)
  })

  return { hosts, shortHosts, patterns, ...(used.length ? { legacy: used } : {}) }
}
