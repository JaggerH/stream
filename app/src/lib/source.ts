// Shared, presentation-free helpers for browsing/adding/editing a plugin Source. Extracted from
// App's PluginPanel so the SourcePicker (browse) and SourceEditor (config) components — and
// their reuse from the Provider/Target pages — can share one source of truth without importing the
// giant app shell.
import type { ParamSpec, SourceDetail, SourceSummary } from './types.ts'
import { SOURCE_META } from './source-domains.ts'

/** Which stream surface a subscribed source feeds. 'audio' schedules like a timeline (歌单). */
export type ChannelRole = 'timeline' | 'search' | 'audio'

export const CHANNEL_ROLE_LABEL: Record<ChannelRole, { name: string; hint: string }> = {
  timeline: { name: 'Timeline', hint: '定时抓进时间线' },
  search: { name: 'Search', hint: '搜索时参与' },
  audio: { name: '歌单', hint: '音乐/电台源' },
}

/** The plugin capability a role requires (audio rides the timeline capability). */
export const channelCapFor = (role: ChannelRole) => (role === 'audio' ? 'timeline' : role)
export const sourceSlug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()

export type FillResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; missing: string }

/** Apply spec defaults to blank fields, then verify every required param is
 *  non-blank. Mirrors the old inline logic in subscribeSelected. */
export function fillAndValidateParams(
  schema: Record<string, ParamSpec>,
  input: Record<string, string>,
): FillResult {
  const params: Record<string, string> = { ...input }
  for (const [key, spec] of Object.entries(schema)) {
    if (!params[key] && spec.default) params[key] = spec.default
    if (spec.required && !params[key]?.trim()) return { ok: false, missing: key }
  }
  return { ok: true, params }
}

export function paramOptions(spec: ParamSpec): { label: string; value: string }[] {
  return Array.isArray(spec.options)
    ? spec.options
        .filter((option) => typeof option?.value === 'string' && option.value)
        .map((option) => ({ value: option.value, label: option.label || option.value }))
    : []
}

/** A source as it appears in a catalog listing (summary) or a fully-fetched detail. */
export type CatalogSource = SourceSummary | SourceDetail

/** seal 之后 title 恒为展示名(装载时已推导),这里零逻辑直读。 */
export function sourceTitle(source: CatalogSource): string {
  return source.title || source.id.replace(/^rsshub:/, '')
}

export function sourceSummary(source: CatalogSource): string {
  const desc = source.description?.replace(/\s+/g, ' ').trim()
  if (desc && desc !== sourceTitle(source)) return desc
  return source.id.replace(/^rsshub:/, '')
}

export function sourceDomId(source: CatalogSource): string {
  return `source-row-${source.id.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

export type RsshubDocsBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'callout'; text: string; tone?: string }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; rows: string[][] }

export function sourceDocsMarkdown(source: SourceDetail): string {
  return source.docs?.markdown?.trim() || ''
}

export interface DocsBlocksOptions {
  /** `#` 的起始层级。默认 2(即 #→h2 ... ###→h4,四级顶格封顶)——source-config 抽屉里渲染的是
   *  route 文档片段,不该出现和抽屉标题抢位的整版 h1。研究页面的 text view 传 1,拿标准 markdown
   *  语义(#→h1),因为那里 markdown 就是整份内容,不是嵌在别的容器里的说明文字。 */
  headingBase?: 1 | 2
}

export function rsshubDocsBlocks(markdown: string, options?: DocsBlocksOptions): RsshubDocsBlock[] {
  const headingBase = options?.headingBase ?? 2
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: RsshubDocsBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null
  let codeLang = ''
  let callout: { tone: string; lines: string[] } | null = null
  let table: string[][] = []
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }
  const flushList = () => {
    if (list?.items.length) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  const flushCallout = () => {
    if (callout) blocks.push({ type: 'callout', tone: callout.tone, text: callout.lines.join('\n').trim() })
    callout = null
  }
  const flushTable = () => {
    if (table.length) blocks.push({ type: 'table', rows: table })
    table = []
  }
  const flushLoose = () => {
    flushParagraph(); flushList(); flushTable()
  }
  const parseTableRow = (line: string) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
  const isTableRow = (line: string) => /^\|.+\|$/.test(line)
  const isTableSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)
  for (const raw of lines) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (code) {
      if (trimmed.startsWith('```')) {
        blocks.push({ type: 'code', lang: codeLang, text: code.join('\n') })
        code = null
        codeLang = ''
      } else {
        code.push(line)
      }
      continue
    }
    if (trimmed.startsWith('```')) {
      flushLoose(); flushCallout()
      code = []
      codeLang = trimmed.replace(/^```/, '').trim()
      continue
    }
    if (trimmed.startsWith(':::')) {
      flushLoose()
      if (callout) flushCallout()
      else callout = { tone: trimmed.replace(/^:::\s*/, '').trim() || 'tip', lines: [] }
      continue
    }
    if (callout) {
      callout.lines.push(line)
      continue
    }
    if (!trimmed) {
      flushLoose()
      continue
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushLoose()
      // headingBase=2(默认)时 #→h2...###→h4,是 source-config 抽屉的原始映射;headingBase=1 时
      // #→h1,是研究页面 text view 要的标准 markdown 语义。见 DocsBlocksOptions 注释。
      const level = Math.min(Math.max(heading[1].length + (headingBase - 1), headingBase), 4) as 1 | 2 | 3 | 4
      blocks.push({ type: 'heading', level, text: heading[2] })
      continue
    }
    const quote = trimmed.match(/^>\s?(.+)$/)
    if (quote) {
      flushLoose()
      blocks.push({ type: 'blockquote', text: quote[1] })
      continue
    }
    if (isTableSeparator(trimmed) && table.length) {
      continue
    }
    if (isTableRow(trimmed)) {
      flushParagraph(); flushList()
      table.push(parseTableRow(trimmed))
      continue
    }
    if (table.length) flushTable()
    const item = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/)
    if (item) {
      flushParagraph()
      const ordered = /\d+\./.test(item[1])
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(item[2])
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  flushLoose(); flushCallout()
  return blocks
}

export function sourceDocsUrl(source: SourceDetail): string | undefined {
  const ns = source.facility?.key || (source.id.startsWith('rsshub:') ? source.id.slice('rsshub:'.length).split('/')[0] : '')
  if (source.id.startsWith('rsshub:') && ns) return `https://docs.rsshub.app/routes/${ns}`
  return source.docs?.url
}

export function facilityHomepageUrl(facilityKey: string): string | undefined {
  const domain = SOURCE_META[facilityKey]?.d
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return undefined
  return `https://${domain}`
}

export function facilityDocsUrl(facilityKey: string): string {
  return `https://docs.rsshub.app/routes/${facilityKey}`
}

const PLUGIN_CAPABILITY_LABEL: Record<string, string> = {
  timeline: '时间线',
  search: '搜索',
  audio: '音频',
}

export function pluginCapabilityLabel(capability: string): string {
  return PLUGIN_CAPABILITY_LABEL[capability] ?? capability
}
