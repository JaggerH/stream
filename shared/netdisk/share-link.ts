/**
 * 「这条链接是哪家网盘的分享」——**唯一一份文法**，前后端都能吃。
 *
 * 它是领域模型，不是包知识：覆盖的网盘里一大半没有对应的包（阿里 / 115 / UC / 天翼…），而
 * 「一条链接是哪种网盘」是资源搜索解析、Agent 抽链、去重键、网盘能力派发共用的判据。以前宿主里
 * 写了四份（parse / content-classify / agent-extract / agent-joints），各认各的一截，漂移了没有
 * 任何测试会喊。spec 2026-09-26-link-recognition-design §7。
 *
 * 判法**按主机**，不按子串：`https://tieba.baidu.com/…`、查询串里提到 `pan.quark.cn` 的链接都不是
 * 网盘分享。各消费方自己的词表（`SourceType`、`NetdiskKind`…）和这里不一致时，在消费方映射。
 */

export type ShareLinkKind = 'quark' | 'baidu' | 'aliyun' | 'tianyi' | 'uc' | 'xunlei' | '123' | '115' | 'mobile' | 'pikpak'

interface Rule {
  kind: ShareLinkKind
  /** 对 URL 的 hostname 跑（锚定整个主机）。 */
  host: RegExp
  /** 分享路径的正则源串，第 1 组 = 分享 id。缺席 = 没有已知的分享路径文法（只认主机）。 */
  share?: string
}

const RULES: readonly Rule[] = [
  { kind: 'quark', host: /^pan\.quark\.cn$/, share: 'https?://pan\\.quark\\.cn/s/([0-9a-zA-Z]+)' },
  { kind: 'baidu', host: /^(?:pan|yun)\.baidu\.com$/, share: 'https?://pan\\.baidu\\.com/s/([0-9a-zA-Z_-]+)' },
  { kind: 'aliyun', host: /^(?:www\.)?(?:aliyundrive|alipan)\.com$/, share: 'https?://(?:www\\.)?(?:aliyundrive|alipan)\\.com/s/([0-9a-zA-Z_-]+)' },
  { kind: 'tianyi', host: /^cloud\.189\.cn$/, share: 'https?://cloud\\.189\\.cn/(?:t|web/share)[/?]([0-9a-zA-Z=&_-]+)' },
  { kind: 'uc', host: /^drive\.uc\.cn$/, share: 'https?://drive\\.uc\\.cn/s/([0-9a-zA-Z]+)' },
  // 123 云盘轮换域名：123pan.com / 123684.com / 123865.com / 123912.com …
  { kind: '123', host: /^(?:www\.)?123(?:pan|\d{3})\.com$/, share: 'https?://(?:www\\.)?123(?:pan|\\d{3})\\.com/s/([0-9a-zA-Z_-]+)' },
  { kind: 'xunlei', host: /^pan\.xunlei\.com$/, share: 'https?://pan\\.xunlei\\.com/s/([0-9a-zA-Z_-]+)' },
  { kind: '115', host: /^(?:www\.)?(?:115|115cdn|anxia)\.com$/ },
  { kind: 'mobile', host: /^caiyun\.139\.com$/ },
  { kind: 'pikpak', host: /^(?:www\.)?mypikpak\.com$/, share: 'https?://mypikpak\\.com/s/([0-9a-zA-Z]+)' },
]

const SHARE_RE = new Map<ShareLinkKind, RegExp>(
  RULES.filter((r) => r.share).map((r) => [r.kind, new RegExp(r.share!)]),
)

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/** 这条链接是哪家网盘的（按主机判），不是网盘 → null。 */
export function shareLinkKindOf(url: string): ShareLinkKind | null {
  const host = typeof url === 'string' ? hostOf(url) : null
  if (!host) return null
  return RULES.find((r) => r.host.test(host))?.kind ?? null
}

/** 抠分享 id。主机不是网盘、或这家没有已知的分享路径文法、或路径对不上 → null。 */
export function shareIdOf(url: string): { kind: ShareLinkKind; id: string } | null {
  const kind = shareLinkKindOf(url)
  const re = kind ? SHARE_RE.get(kind) : undefined
  const m = re?.exec(url)
  return kind && m ? { kind, id: m[1] } : null
}

/** 从一段文本里抽分享链接用的全局正则（`text.matchAll(pattern)`，整串命中就是链接本身）。 */
export const SHARE_LINK_PATTERNS: ReadonlyArray<{ kind: ShareLinkKind; pattern: RegExp }> = RULES
  .filter((r) => r.share)
  .map((r) => ({ kind: r.kind, pattern: new RegExp(r.share!.replace(/\((?!\?)/, '(?:'), 'g') }))
