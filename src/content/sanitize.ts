/** Shared HTML sanitizer for untrusted, server-fetched content (extracted article
 *  bodies, package enricher comments) before the app renders it with
 *  dangerouslySetInnerHTML. 前端自己不消毒——它信的是这一份。
 *
 *  **别换回 DOMPurify-on-linkedom**：linkedom 的 document 没有 `implementation.createHTMLDocument`，
 *  DOMPurify 判 `isSupported=false` 后把输入原样放行（静默空操作，script / onerror 全部原样出去）；
 *  补上 shim 之后 linkedom 的 DOMParser 解析片段又不对，输出变成空串。所以这里直接用 linkedom 解析、
 *  自己走一遍 DOM。守卫是 `sanitize.test.ts` 里那批攻击 payload + 一段必须原样保留的正常富文本。 */

import { parseHTML } from 'linkedom'

/** 连同子树整棵剪掉的元素：能执行脚本、嵌别的文档、改页面元信息或提交表单的一律不留。 */
const DROP_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'noscript', 'template', 'svg', 'math',
  'portal', 'title', 'head', 'xmp', 'plaintext', 'noembed', 'noframes',
])

/** 没有结束标签的元素。 */
const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'hr', 'img', 'source', 'track', 'wbr'])

/** 值是 URL 的属性：协议不在白名单里就整条删。 */
const URL_ATTRS = new Set([
  'href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite',
  'longdesc', 'lowsrc', 'dynsrc', 'data', 'codebase', 'ping', 'manifest', 'icon',
])

/** 不管值是什么都不留的属性：内联样式（`expression(` / `url(javascript:` 一类）、内嵌文档。 */
const DROP_ATTRS = new Set(['style', 'srcdoc'])

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i

/** 一个 URL 能不能留。`allowDataImage` 只给图片源（src / srcset）。 */
function safeUrl(raw: string, allowDataImage: boolean): boolean {
  // 浏览器解析协议前会吃掉空白与控制字符（`java\tscript:`）——判之前先照做一遍。
  // eslint-disable-next-line no-control-regex
  const url = raw.replace(/[\u0000- \u007f-\u009f]/g, '')
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (!scheme) return true // 相对路径 / 协议相对 `//host`（跟随页面协议，即 http(s)）
  if (SAFE_SCHEMES.has(scheme)) return true
  return allowDataImage && scheme === 'data' && DATA_IMAGE.test(url)
}

/** srcset 的每个候选（`url 描述符`）都得过；有一个不过整条删。 */
function safeSrcset(value: string): boolean {
  return value
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .every((u) => u === '' || safeUrl(u, true))
}

interface DomNode {
  nodeType: number
  nodeName: string
  nodeValue?: string | null
  childNodes: ArrayLike<DomNode>
  attributes?: ArrayLike<{ name: string; value: string }>
  removeAttribute?: (name: string) => void
  remove: () => void
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')

/**
 * 自己序列化，不用 linkedom 的 innerHTML：它不转义属性值里的 `&` / `<` / `>`。浏览器按 innerHTML
 * 解析时那几个字符在引号里是惰性的，但"安全靠下游的解析细节"不是这个函数该有的前提——输出的每个
 * 属性值、每段文字都按最保守的规则转义，读的人不必知道 HTML 解析器的边角。
 */
function serialize(node: DomNode): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) { out += escText(child.nodeValue ?? ''); continue }
    if (child.nodeType !== 1) continue
    const tag = child.nodeName.toLowerCase()
    const attrs = Array.from(child.attributes ?? []).map(({ name, value }) => ` ${name}="${escAttr(value)}"`).join('')
    out += `<${tag}${attrs}>`
    if (!VOID_ELEMENTS.has(tag)) out += `${serialize(child)}</${tag}>`
  }
  return out
}

function clean(node: DomNode): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8) { child.remove(); continue } // 注释（含条件注释）
    if (child.nodeType !== 1) continue
    const tag = child.nodeName.toLowerCase()
    if (DROP_ELEMENTS.has(tag)) { child.remove(); continue }
    for (const { name, value } of Array.from(child.attributes ?? [])) {
      const n = name.toLowerCase()
      const bad =
        n.startsWith('on') ||
        DROP_ATTRS.has(n) ||
        (n === 'srcset' ? !safeSrcset(value) : URL_ATTRS.has(n) && !safeUrl(value, n === 'src'))
      if (bad) child.removeAttribute?.(name)
    }
    clean(child)
  }
}

export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
  const body = document.body as unknown as DomNode | null
  // 解析不出 body（输入把文档结构打坏了）→ 什么都不给，不回落到原文。
  if (!body) return ''
  clean(body)
  return serialize(body)
}

type HtmlBearing = { html?: unknown; replies?: unknown }

function cleanComments(list: unknown, clean: (html: string) => string): unknown {
  if (!Array.isArray(list)) return list
  return list.map((c: unknown) => {
    if (!c || typeof c !== 'object') return c
    const row = c as HtmlBearing
    return {
      ...row,
      ...(typeof row.html === 'string' ? { html: clean(row.html) } : {}),
      ...(row.replies !== undefined ? { replies: cleanComments(row.replies, clean) } : {}),
    }
  })
}

/**
 * 一个富化结果（`{ article?, comments?, … }`）里所有会被前端原样渲染的 html 消毒一遍：
 * `article.html` 与 `comments[].html`（递归到 `replies`）。其余字段原样保留；不是对象的、
 * 或既没有 `article` 也没有 `comments` 的返回值（作者信息之类）原样返回同一个引用。
 * 宿主收包的 enricher 时套上它（`sanitizeEnricher`）。`clean` 只为测试开口（钉"哪几格被洗了"），
 * 生产永远是 `sanitizeHtml`。
 */
export function sanitizeEnrichment(value: unknown, clean: (html: string) => string = sanitizeHtml): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const v = value as { article?: unknown; comments?: unknown }
  if (v.article === undefined && v.comments === undefined) return value
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  if (v.article && typeof v.article === 'object') {
    const a = v.article as HtmlBearing
    if (typeof a.html === 'string') out.article = { ...a, html: clean(a.html) }
  }
  if (v.comments !== undefined) out.comments = cleanComments(v.comments, clean)
  return out
}
