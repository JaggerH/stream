/**
 * 「这条链接是谁家的、是什么东西」——宿主**唯一**的认领函数（spec 2026-09-26-link-recognition §4）。
 *
 * 源码不认识任何站：认领表来自各包的 `package.json#stream.links`（装载与校验在
 * `src/packages/links.ts`，并表与撞名在 `src/replay/recipe-package.ts` 的 `linkTableOf`）。
 * 这里只回答「给一条链接，回哪个包 / 哪个平台 / 什么类型 / id」；知道是什么之后交给谁做，是派发的事
 * （调用点按 `<platform>-<名词>` 查 Provider 行）。
 *
 * **每次查都现取**（同 `src/media/serving.ts`）：热装的包下一次认领就生效。正则对象按源串缓存。
 *
 * 顺序：先 `patterns`（声明序，先声明先赢），命中给出 kind / id；没命中再按 `hosts`（label 边界的后缀
 * 匹配，最长后缀胜）只给 platform。
 */
import type { DownloadYield, LinkKind } from '../packages/links.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

export interface LinkRef {
  /** 认领所依据的地址（短链已展开时是展开后的那一个）。 */
  url: string
  /** 认领它的包（npm 名，没有就是 facility）。 */
  package: string
  platform: string
  kind?: LinkKind
  /** kind 需要 id 时（track）的命名组 `id`。 */
  id?: string
  /** download-page 专用：解开后是什么。 */
  yields?: DownloadYield
}

export interface LinkDebug { key: string; title: string; summary: string; ok: boolean }

let tableSource: () => LinkTableEntry[] = () => []
let debugSink: (e: LinkDebug) => void = () => {}
const compiled = new Map<string, RegExp | null>()

/** 装配层把「所有包的 links 并成的那张表」以 thunk 挂进来（`src/kernel/plugins/sources.ts`）。 */
export function setLinkDeclarationSource(source: () => LinkTableEntry[]): void {
  tableSource = source
}

/** 装配层把 debug bus 接进来（channel `links`）。 */
export function setLinkDebugSink(sink: (e: LinkDebug) => void): void {
  debugSink = sink
}

/** 往 debug bus 的 `links` 频道发一条（认领 / 展开 / 老写法兼容留痕都走它）。 */
export function emitLinkDebug(e: LinkDebug): void {
  try { debugSink(e) } catch { /* debug 不许打断认领 */ }
}

function regexOf(kind: LinkKind, pattern: string): RegExp | null {
  const key = `${kind}\u0000${pattern}`
  if (compiled.has(key)) return compiled.get(key)!
  let re: RegExp | null
  // track 大小写不敏感（同原 trackUrl）；download-page 兼作抓取白名单，按原样区分大小写（同原 downloadPages）。
  try { re = new RegExp(pattern, kind === 'track' ? 'i' : '') } catch { re = null }   // 装载期已拒过；真到这儿当它不认领
  compiled.set(key, re)
  return re
}

function parseHost(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function covers(host: string, declared: string): boolean {
  return host === declared || host.endsWith(`.${declared}`)
}

/** 按主机找认领者：最长后缀胜。 */
function hostClaim(host: string, table: LinkTableEntry[]): { entry: LinkTableEntry; platform: string } | null {
  let best: { entry: LinkTableEntry; platform: string; len: number } | null = null
  for (const entry of table) {
    for (const h of entry.hosts) {
      if (covers(host, h.host) && (!best || h.host.length > best.len)) best = { entry, platform: h.platform, len: h.host.length }
    }
  }
  return best
}

/** 不发网络请求：只看主机和 patterns。没人认领 / 不是 http(s) 链接 → null。 */
export function recognizeLinkSync(url: string): LinkRef | null {
  if (typeof url !== 'string' || !url) return null
  const host = parseHost(url)
  if (!host) return null
  const table = tableSource()
  for (const entry of table) {
    for (const p of entry.patterns) {
      const m = regexOf(p.kind, p.pattern)?.exec(url)
      if (!m) continue
      const id = m.groups?.id
      if (p.kind === 'track' && !id) continue
      return {
        url, package: entry.package, platform: p.platform, kind: p.kind,
        ...(id ? { id } : {}),
        ...(p.yields ? { yields: p.yields } : {}),
      }
    }
  }
  const claim = hostClaim(host, table)
  return claim ? { url, package: claim.entry.package, platform: claim.platform } : null
}

const MAX_HOPS = 3
const HOP_TIMEOUT_MS = 5000

/**
 * 命中某包 `shortHosts` 的链接先展开再认，其余等同 `recognizeLinkSync`。
 *
 * **只打包声明过的公网主机**（shortHosts 装载期过了 `servingHostProblem`），所以不是开放代理：
 * `redirect:'manual'` 一跳一跳地跟，最多 3 跳、每跳 5 秒；下一跳的主机不在任何包的 `hosts` 里就停，
 * 按停下前最后一个有人认领的地址认（不替陌生主机发请求）。展开失败按原链接认——至少还拿得到 platform
 * ——原因进 debug bus，不吞成「没人认领」。
 */
export async function recognizeLink(url: string, opts: { fetch?: typeof fetch } = {}): Promise<LinkRef | null> {
  const doFetch = opts.fetch ?? fetch
  const table = tableSource()
  const isShort = (u: string): boolean => {
    const h = parseHost(u)
    return !!h && table.some((e) => e.shortHosts.some((s) => covers(h, s)))
  }
  if (!isShort(url)) return recognizeLinkSync(url)
  let current = url
  try {
    for (let hop = 0; hop < MAX_HOPS && isShort(current); hop++) {
      const res = await doFetch(current, { redirect: 'manual', signal: AbortSignal.timeout(HOP_TIMEOUT_MS) })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) break
      const next = new URL(location, current).toString()
      const nextHost = parseHost(next)
      if (!nextHost || !hostClaim(nextHost, table)) {
        emitLinkDebug({ key: url, title: '短链展开停在无人认领的主机', summary: `${current} → ${next}：目标主机不归任何包，不跟，按 ${current} 认`, ok: true })
        break
      }
      current = next
    }
  } catch (e) {
    emitLinkDebug({ key: url, title: '短链展开失败', summary: `${current}：${(e as Error).message}；按原链接认`, ok: false })
    return recognizeLinkSync(url)
  }
  return recognizeLinkSync(current)
}
