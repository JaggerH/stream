import type { LinkCanonicalSpec } from '../packages/links.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

/**
 * 「粘贴进来的任意形态 → 规范地址」的引擎（宿主侧的唯一实现；形状规则由各包在自己的
 * `stream.links.canonical` 里声明，宿主不硬编码任何平台——spec 2026-11-15 链接规范化）。
 *
 * 三步，全部发生在**认领之后、交给包取数之前**：
 * 1. **分享文案里抽出链接**（通用、无平台知识）：整段文案里找第一段 http(s) 地址，剥掉尾部的
 *    全角标点。各站的「分享」弹窗复制出来的往往是一句话加一条链接。
 * 2. **认领 + 短链展开**（复用 LinkRecognizer.resolve——只跟包声明过的 shortHosts）。
 * 3. **按平台规范**：命中 `canonical[platform]` 的某条 pattern → 按 template 重写规范 URL；
 *    认领了却没有一条命中 → **输入错误**（「这个地址形状还不认识」），不是取数失败——
 *    让用户改输入，而不是让采集端背锅去重试。
 */

/** 从一段分享文案里抽出第一条 http(s) 链接（剥掉尾部全角标点 / 引号）；没有 → null。 */
export function extractUrlFromText(text: string): string | null {
  const raw = String(text ?? '')
  const m = /https?:\/\/[^\s"'<>「」【】（），。；！？、]+/i.exec(raw)
  if (!m) return null
  return m[0].replace(/[），。；！？、】」”』%.,;:!?)\]]+$/, '')
}

/** 规范化的一条结果。`error` 在场 = 输入不成立（认得平台但抽不出规范地址）。 */
export interface NormalizedLink {
  /** 交给取数层的地址：规范化成功是规范地址，没声明规范化的平台是展开后的原地址。 */
  url: string
  platform?: string
  package?: string
  claimed: boolean
  /** 分享文案里抽出来的地址（给调用方在回执里把主语换对）。 */
  extracted?: true
  error?: string
}

const QUERY_APPEND_ALLOWED = /^[A-Za-z0-9._~%+=/-]+$/

/** 按 keepQuery / dropQuery 从原 URL 的 query 里留下要带走的参数（都不声明 = 一律不带）。 */
function queryFor(spec: LinkCanonicalSpec, original: string): string {
  let q: URLSearchParams
  try { q = new URL(original).searchParams } catch { return '' }
  const names = [...new Set(q.keys())].filter((k) =>
    spec.keepQuery ? spec.keepQuery.includes(k) : spec.dropQuery ? !spec.dropQuery.includes(k) : false,
  )
  if (!names.length) return ''
  const kept = new URLSearchParams()
  for (const k of names) for (const v of q.getAll(k)) if (QUERY_APPEND_ALLOWED.test(v)) kept.set(k, v)
  const s = kept.toString()
  return s ? `?${s}` : ''
}

/** 一条 pattern 命中后的规范 URL；没命中 → null。模板洞按命名组填，query 按声明接。 */
function applyRule(spec: LinkCanonicalSpec, rule: { pattern: string; template: string }, url: string): string | null {
  let re: RegExp
  try { re = new RegExp(rule.pattern) } catch { return null }
  const m = re.exec(url)
  if (!m) return null
  const canonical = rule.template.replace(/\{(\w+)\}/g, (_whole, name: string) =>
    m.groups?.[name] != null ? String(m.groups[name]) : '')
  // 模板自带 query（作品地址把 id 放在 query 里的平台）就不再接原 query——两个来源会拼重。
  return canonical.includes('?') ? canonical : canonical + queryFor(spec, url)
}

function canonicalSpecFor(entries: LinkTableEntry[], platform: string): { entry: LinkTableEntry; spec: LinkCanonicalSpec } | null {
  for (const e of entries) {
    const spec = e.canonical?.[platform]
    if (spec) return { entry: e, spec }
  }
  return null
}

/** 引擎依赖：认领（含短链展开）+ 现取的声明表。**都经 LinkRecognizer**，宿主只有一个对象要拿。 */
export interface LinkNormalizerDeps {
  recognize: (url: string, opts?: { fetch?: typeof fetch }) => Promise<{ url: string; package: string; platform: string; kind?: string; id?: string; yields?: unknown } | null>
  table: () => LinkTableEntry[]
}

export function makeLinkNormalizer(deps: LinkNormalizerDeps) {
  return async (raw: string, opts: { fetch?: typeof fetch } = {}): Promise<NormalizedLink> => {
    // ① 分享文案 → 链接（通用的那一步；不是链接的输入原样走认领，让没认领的老路兜住）。
    const extracted = extractUrlFromText(raw)
    const target = extracted ?? raw
    // ② 认领（shortHosts 已在 recognizer 里展开）。没人认领：原样交回（宿主直链分支 / link 原型接手）。
    const ref = await deps.recognize(target, opts).catch(() => null)
    if (!ref) return { url: target, claimed: false, ...(extracted ? { extracted: true } : {}) }
    // ③ 按平台规范。这个平台没声明 canonical：原地址（展开后的）就是答案。
    const hit = canonicalSpecFor(deps.table(), ref.platform)
    if (!hit) return { url: ref.url, platform: ref.platform, package: ref.package, claimed: true, ...(extracted ? { extracted: true } : {}) }
    for (const rule of hit.spec.patterns) {
      const canonical = applyRule(hit.spec, rule, ref.url)
      if (canonical) {
        return { url: canonical, platform: ref.platform, package: ref.package, claimed: true, ...(extracted ? { extracted: true } : {}) }
      }
    }
    return {
      url: ref.url, platform: ref.platform, package: ref.package, claimed: true,
      ...(extracted ? { extracted: true } : {}),
      error: `这个地址形状还不认识：${hostPathOf(ref.url)}（认领平台 ${ref.platform}，但抽不出规范的作品地址）`,
    }
  }
}

/** 报错里的 `<host+path>`：只指形状，不带 query——query 里常有签名 / 凭据参数。 */
function hostPathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url.slice(0, 80)
  }
}
