import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { validateRecipe } from '../recipe-store.ts'
import type { ActionFeature, RecipeAction, BrowserRecipe, XhrHarvest } from '../recipe.ts'

/** translate only emits XHR-harvest drafts; DOM harvests are authored/calibrated by hand */
export type RecipeDraft = Omit<BrowserRecipe, 'harvest'> & { harvest: XhrHarvest }

export interface TranslateResult {
  recipe: RecipeDraft
  untranslated: string[]
}

interface BrowserUseStep {
  model_output?: { action?: unknown[] } | null
  state?: { interacted_element?: unknown } | null
}

interface XhrCandidate {
  url: string
  body?: unknown
  score: number
}

const NOOP_ACTIONS = new Set(['done', 'extract_content', 'wait', 'wait_for_element'])
const GOTO_ACTIONS = new Set(['navigate', 'go_to_url', 'open_url'])
const TYPE_ACTIONS = new Set(['input_text', 'type'])
const SUBMIT_ACTIONS = new Set(['search', 'submit'])
const SCROLL_ACTIONS = new Set(['scroll', 'scroll_down', 'scroll_up'])
const CLICK_ACTIONS = new Set(['click', 'click_element', 'click_element_by_index'])

function historySteps(history: unknown): BrowserUseStep[] {
  if (Array.isArray(history)) return history as BrowserUseStep[]
  if (history && typeof history === 'object') {
    const obj = history as { history?: unknown; all_results?: unknown }
    if (Array.isArray(obj.history)) return obj.history as BrowserUseStep[]
    if (Array.isArray(obj.all_results)) return obj.all_results as BrowserUseStep[]
  }
  return []
}

function singleAction(action: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!action || typeof action !== 'object') return null
  const entries = Object.entries(action as Record<string, unknown>)
  if (entries.length !== 1) return null
  const [name, rawArgs] = entries[0]
  return {
    name,
    args: rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {},
  }
}

function interactedAt(interacted: unknown, index: number): Record<string, unknown> | null {
  const value = Array.isArray(interacted) ? interacted[index] : interacted
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function selectorFrom(interacted: Record<string, unknown> | null): string | null {
  const selector = interacted?.css_selector ?? interacted?.selector ?? interacted?.xpath
  return typeof selector === 'string' && selector.trim() ? selector : null
}

function featureFrom(interacted: Record<string, unknown> | null): ActionFeature | undefined {
  const selector = selectorFrom(interacted)
  if (!selector) return undefined
  const role = interacted?.role
  return {
    selector,
    ...(typeof role === 'string' && role ? { role } : {}),
  }
}

function argString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function isExploratoryScroll(args: Record<string, unknown>): boolean {
  const text = JSON.stringify(args).toLowerCase()
  return /\b(until|target|count|nth|condition)\b/.test(text) || /第\s*\d+|至少\s*\d+|\d+\s*(items?|posts?|articles?|条|篇|个|屏|次)/i.test(text)
}

function toRecipeAction(
  name: string,
  args: Record<string, unknown>,
  interacted: Record<string, unknown> | null,
): { action?: RecipeAction; untranslated?: string } {
  if (NOOP_ACTIONS.has(name)) return {}

  if (GOTO_ACTIONS.has(name)) {
    const url = argString(args, ['url'])
    return url ? { action: { kind: 'goto', url } } : { untranslated: `${name}: missing url` }
  }

  if (TYPE_ACTIONS.has(name)) {
    const text = argString(args, ['text', 'value'])
    const selector = selectorFrom(interacted) ?? 'TODO: input selector'
    return text
      ? { action: { kind: 'type', selector, text, ...(featureFrom(interacted) ? { feature: featureFrom(interacted) } : {}) } }
      : { untranslated: `${name}: missing text` }
  }

  if (SUBMIT_ACTIONS.has(name)) {
    return { action: { kind: 'submit', selector: selectorFrom(interacted) ?? 'TODO: submit selector' } }
  }

  if (SCROLL_ACTIONS.has(name)) {
    if (isExploratoryScroll(args)) {
      return { untranslated: `${name}: dropped exploratory scroll-until/ordinal goal as replay-unstable` }
    }
    return { action: { kind: 'scroll', dwell_s: [5, 20], maxTimes: 20, noProgressStop: 2 } }
  }

  if (CLICK_ACTIONS.has(name)) {
    if (name === 'click_element_by_index' || 'index' in args) {
      return { untranslated: `${name}: dropped ordinal click as replay-unstable` }
    }
    const selector = selectorFrom(interacted)
    if (!selector) return { untranslated: `${name}: missing stable selector` }
    return {
      action: {
        kind: 'openItems',
        selector,
        count: [1, 1],
        dwell_s: [5, 20],
        back: false,
        ...(featureFrom(interacted) ? { feature: featureFrom(interacted) } : {}),
      },
    }
  }

  return { untranslated: `${name}: no deterministic recipe action mapping` }
}

function firstGoto(actions: RecipeAction[]): string | null {
  const hit = actions.find((a): a is Extract<RecipeAction, { kind: 'goto' }> => a.kind === 'goto')
  return hit?.url ?? null
}

function cookieDomainFrom(url: string | null): string {
  if (!url) return 'TODO.cookie.domain'
  try {
    const host = new URL(url).hostname
    const parts = host.split('.')
    return parts.length <= 2 ? host : parts.slice(-2).join('.')
  } catch {
    return 'TODO.cookie.domain'
  }
}

function sourceIdFrom(url: string | null): string {
  const domain = cookieDomainFrom(url)
  if (domain.startsWith('TODO')) return 'recipe-draft'
  return domain.split('.')[0] || 'recipe-draft'
}

function collectXhrCandidates(value: unknown, out: XhrCandidate[] = []): XhrCandidate[] {
  if (Array.isArray(value)) {
    for (const child of value) collectXhrCandidates(child, out)
    return out
  }
  if (!value || typeof value !== 'object') return out

  const obj = value as Record<string, unknown>
  const rawUrl = obj.url ?? obj.request_url ?? obj.requestUrl
  const typ = obj.type ?? obj.resource_type ?? obj.resourceType
  const method = obj.method ?? obj.request_method
  if (typeof rawUrl === 'string' && (typ === 'xhr' || typ === 'fetch' || typeof method === 'string')) {
    out.push({ url: rawUrl, body: obj.body ?? obj.response ?? obj.json, score: xhrScore(rawUrl) })
  }
  for (const child of Object.values(obj)) collectXhrCandidates(child, out)
  return out
}

function xhrScore(url: string): number {
  let score = 0
  if (/recommend|feed|search|timeline|list/i.test(url)) score += 10
  if (/api|graphql|ajax|xhr/i.test(url)) score += 5
  if (/\.js|\.css|\.png|\.jpg|\.svg|\.ico/i.test(url)) score -= 20
  return score
}

function deriveUrlPattern(xhrSamples: unknown): string | null {
  const [best] = collectXhrCandidates(xhrSamples).sort((a, b) => b.score - a.score)
  if (!best) return null
  try {
    const u = new URL(best.url)
    return `*${u.pathname}*`
  } catch {
    return best.url.includes('*') ? best.url : `*${best.url}*`
  }
}

function inferDedupeBy(pattern: string | null): string {
  if (pattern && /juejin|recommend_all_feed|article/i.test(pattern)) return 'article_id'
  return 'TODO.dedupeBy'
}

function inferItemsAt(pattern: string | null): string {
  if (pattern && /recommend_all_feed/i.test(pattern)) return 'data'
  return 'TODO.items'
}

export function translateHistory(history: unknown, xhrSamples?: unknown): TranslateResult {
  const actions: RecipeAction[] = []
  const untranslated: string[] = []

  for (const [stepIndex, step] of historySteps(history).entries()) {
    const rawActions = step.model_output?.action ?? []
    for (const [actionIndex, rawAction] of rawActions.entries()) {
      const parsed = singleAction(rawAction)
      if (!parsed) {
        untranslated.push(`step ${stepIndex}.${actionIndex}: malformed browser-use action`)
        continue
      }
      const result = toRecipeAction(parsed.name, parsed.args, interactedAt(step.state?.interacted_element, actionIndex))
      if (result.action) actions.push(result.action)
      if (result.untranslated) untranslated.push(`step ${stepIndex}.${actionIndex}: ${result.untranslated}`)
    }
  }

  const entryUrl = firstGoto(actions) ?? 'https://TODO.entry.url/'
  const urlPattern = deriveUrlPattern(xhrSamples) ?? 'TODO: add matched XHR urlPattern'
  const itemsAt = inferItemsAt(urlPattern)
  const dedupeBy = inferDedupeBy(urlPattern)
  if (!xhrSamples) untranslated.push('XHR: missing samples; harvest urlPattern/itemsAt/dedupeBy left as TODO')
  if (urlPattern.startsWith('TODO')) untranslated.push('XHR: no replayable XHR sample found')

  return {
    recipe: {
      version: 1,
      kind: 'browser',
      sourceId: sourceIdFrom(entryUrl),
      cookieDomain: cookieDomainFrom(entryUrl),
      entryUrl,
      loginCheck: { loggedIn: 'TODO: selector only present when logged in', wall: 'TODO: selector only present on the login/verify wall' },
      actions,
      harvest: {
        urlPattern,
        dedupeBy,
        itemsAt,
        targetCount: 100,
        mapping: { title: 'TODO', link: 'TODO', author: 'TODO' },
        assert: [{ path: itemsAt, desc: 'feed list present' }],
      },
    },
    untranslated,
  }
}

export function renderRecipeDraftYaml(recipe: RecipeDraft, untranslated: string[]): string {
  const lines: string[] = []
  if (untranslated.length > 0) {
    lines.push('# UNTRANSLATED:')
    for (const item of untranslated) lines.push(`# - ${item}`)
  } else {
    lines.push('# UNTRANSLATED: none')
  }
  lines.push(stringifyYaml(recipe).trimEnd())
  return lines.join('\n') + '\n'
}

async function latestExplorePath(facilityDir: string): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(facilityDir)
  } catch {
    throw new Error(`record translate: no profile directory found: ${facilityDir}`)
  }
  const candidates = entries.filter((name) => /^explore-.*\.json$/.test(name)).sort()
  const latest = candidates.at(-1)
  if (!latest) throw new Error(`record translate: no explore-*.json found in ${facilityDir}`)
  return join(facilityDir, latest)
}

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    await stat(path)
  } catch {
    return undefined
  }
  return JSON.parse(await readFile(path, 'utf-8'))
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export async function runTranslate(facility: string, opts: { historyPath?: string; root?: string } = {}): Promise<string> {
  const root = opts.root ?? process.cwd()
  const facilityDir = join(root, 'data', 'browser-profiles', facility)
  const historyPath = opts.historyPath ?? await latestExplorePath(facilityDir)
  const history = JSON.parse(await readFile(historyPath, 'utf-8'))
  const xhr = await optionalJson(`${historyPath}.xhr.json`)
  const result = translateHistory(history, xhr)
  if (result.recipe.sourceId === 'recipe-draft') result.recipe.sourceId = facility
  validateRecipe(result.recipe.sourceId, result.recipe)

  const out = join(facilityDir, `recipe-draft-${timestamp()}.yaml`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, renderRecipeDraftYaml(result.recipe, result.untranslated))
  return out
}
