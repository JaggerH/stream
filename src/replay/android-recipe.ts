import type { A11yQuery } from './desktop-driver.ts'
import type { ReadSpec } from './desktop-driver.ts'
import type { RecipeMeta } from './recipe.ts'
import type { TextWhere } from './desktop-recipe.ts'
import type { Feature } from './state-graph.ts'

/**
 * A `kind:'android'` recipe drives a phone through the normalized device actions
 * (openspec `device-actions`). Planning and storage stay on the server; the phone only performs
 * ops. Targets are re-evaluable locator expressions — an a11y query (including `viewId`), a
 * resource id, or text with an optional `where` anchor. **No step stores a coordinate**:
 * coordinates drift silently and click something else, the most expensive failure this kind of
 * system has (docs/ENGINE.md §7.5).
 */
export interface AndroidRecipe {
  version: number
  kind: 'android'
  sourceId: string
  /** Which app to drive: one package name, or candidates tried in order. */
  app: AndroidApp
  /** The screen the recipe starts from, as a feature set. Checked after the first step that opens the app. */
  entry?: AndroidStateSpec
  /** The screen a successful run must end on, as a feature set. */
  exit?: AndroidStateSpec
  steps: AndroidStep[]
  /** Optional read of the result subtree; an action-only recipe omits it (with `allowEmpty`). */
  observer?: ReadSpec
  /** Treat an empty harvest as a valid result (action-only recipes). */
  allowEmpty?: boolean
  meta?: RecipeMeta
}

export interface AndroidApp {
  /**
   * The app to drive, by the identifier its phone uses: an Android package name or an iOS bundle
   * id, or a non-empty list of candidates tried in order (a cross-platform recipe can list both).
   */
  id?: string | string[]
  /** The pre-`id` spelling of {@link id}; still read. Give exactly one of `id` / `package`. */
  package?: string | string[]
  /** Optional activity hint for the entry / exit features, not used to launch. */
  activity?: string
  title?: string
}

/** A screen declared by features (entry / exit). Empty is rejected: it would match everything. */
export interface AndroidStateSpec {
  features: Feature[]
  note?: string
}

/**
 * A re-evaluable locator. Exactly one of `query` / `resourceId` / `text` is given.
 * `where` and `ocr` narrow a text lookup.
 */
export interface AndroidLocator {
  /** The a11y vocabulary; `viewId` is the Android resource id (ui.tree v7). */
  query?: A11yQuery & { viewId?: string }
  /** Shorthand for `query: { viewId }`. */
  resourceId?: string
  /** Text to find (an accessibility name or an OCR line), matched exactly first and by containment second. */
  text?: string
  /** Narrow the text target to one side of an anchor on the same row/column. */
  where?: TextWhere
  /** Ask for the on-device OCR tier. Implied by a text locator; explicit `false` forbids it. */
  ocr?: boolean
}

export interface AndroidExpect {
  features: Feature[]
  /** How long to poll for the feature set, default 3000 ms. */
  timeoutMs?: number
}

export interface AndroidStepCommon {
  /** A sentence shown in the failure receipt. It is the step's key for a reader. */
  label?: string
  /** Human intent; the engine does not parse it. */
  intent?: string
  /** The features that must hold after this step. A miss is drift, not success. */
  expect?: AndroidExpect
  /** Skip this step when its locator matches nothing. */
  optional?: boolean
}

export type AndroidStep = AndroidStepCommon &
  (
    | { kind: 'openApp'; id?: string | string[]; package?: string | string[]; fresh?: boolean }
    | { kind: 'tap'; target: AndroidLocator }
    | { kind: 'longPress'; target: AndroidLocator; durationMs?: number }
    | { kind: 'swipe'; from: AndroidLocator; to: AndroidLocator; durationMs?: number }
    | { kind: 'scroll'; dir: 'up' | 'down'; amount?: number; until?: string; maxSteps?: number; timeoutMs?: number }
    | { kind: 'type'; text: string }
    | { kind: 'setText'; target: AndroidLocator; text: string }
    | { kind: 'press'; key: 'Back' | 'Home' | 'Enter' }
    | { kind: 'screenshot' }
    | { kind: 'find'; target: AndroidLocator }
    | { kind: 'windows' }
    | { kind: 'sleep'; ms: number }
  )

export const ANDROID_STEP_KINDS: ReadonlySet<string> = new Set([
  'openApp', 'tap', 'longPress', 'swipe', 'scroll', 'type', 'setText', 'press',
  'screenshot', 'find', 'windows', 'sleep',
])

const COMMON_KEYS = new Set(['kind', 'label', 'intent', 'expect', 'optional'])
const STEP_KEYS: Record<string, ReadonlySet<string>> = {
  openApp: new Set([...COMMON_KEYS, 'id', 'package', 'fresh']),
  tap: new Set([...COMMON_KEYS, 'target']),
  longPress: new Set([...COMMON_KEYS, 'target', 'durationMs']),
  swipe: new Set([...COMMON_KEYS, 'from', 'to', 'durationMs']),
  scroll: new Set([...COMMON_KEYS, 'dir', 'amount', 'until', 'maxSteps', 'timeoutMs']),
  type: new Set([...COMMON_KEYS, 'text']),
  setText: new Set([...COMMON_KEYS, 'target', 'text']),
  press: new Set([...COMMON_KEYS, 'key']),
  screenshot: new Set([...COMMON_KEYS]),
  find: new Set([...COMMON_KEYS, 'target']),
  windows: new Set([...COMMON_KEYS]),
  sleep: new Set([...COMMON_KEYS, 'ms']),
}
const LOCATOR_KEYS = new Set(['query', 'resourceId', 'text', 'where', 'ocr'])
const QUERY_KEYS = new Set(['role', 'name', 'nameContains', 'className', 'viewId', 'path'])
const COORD_KEYS = new Set(['x', 'y', 'w', 'h', 'rect', 'at', 'point', 'centerX', 'centerY'])
const ANDROID_FEATURE_KINDS = new Set(['a11y', 'text', 'android-window'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== undefined && !Array.isArray(v)
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function packageProblem(v: unknown): string | undefined {
  if (nonEmptyString(v)) return undefined
  if (Array.isArray(v) && v.length > 0 && v.every(nonEmptyString)) return undefined
  return 'app.package 要是一个包名，或一组非空包名'
}

/** `id` is the neutral spelling: an Android package name or an iOS bundle id. */
function identifierProblem(v: unknown, field: string): string | undefined {
  if (nonEmptyString(v)) return undefined
  if (Array.isArray(v) && v.length > 0 && v.every(nonEmptyString)) return undefined
  return `${field} 要是一个 app 标识（Android 包名 / iOS bundle id），或一组非空标识`
}

/** `id` with `package` as its legacy alias: at most one may be given; `required` for the app itself. */
function identifierField(o: Record<string, unknown>, where: string, fail: (msg: string) => never, required = true): void {
  if (o.id !== undefined && o.package !== undefined) {
    fail(`${where}.id 与 ${where}.package 只能给一个（package 是 id 的旧拼写）`)
  }
  if (!required && o.id === undefined && o.package === undefined) return
  const problem = identifierProblem(o.id ?? o.package, `${where}.id`)
  if (problem) fail(problem)
}

function assertNoCoordinates(v: unknown, where: string): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoCoordinates(x, `${where}[${i}]`))
    return
  }
  if (!isObject(v)) return
  for (const [k, x] of Object.entries(v)) {
    if (COORD_KEYS.has(k)) {
      throw new Error(`${where}.${k} 是坐标——安卓 recipe 不存坐标，只存可重新求值的定位表达式（query / resourceId / text + where）`)
    }
    assertNoCoordinates(x, `${where}.${k}`)
  }
}

function checkQuery(q: unknown, where: string): void {
  if (!isObject(q)) throw new Error(`${where}.query 要是对象`)
  for (const k of Object.keys(q)) {
    if (!QUERY_KEYS.has(k)) throw new Error(`${where}.query 带了不认识的键 ${k}（只有 ${[...QUERY_KEYS].join(' / ')}）`)
  }
  for (const k of ['role', 'name', 'nameContains', 'className', 'viewId'] as const) {
    if (q[k] !== undefined && !nonEmptyString(q[k])) throw new Error(`${where}.query.${k} 要是非空字符串`)
  }
  if (q.name !== undefined && q.nameContains !== undefined) {
    throw new Error(`${where}.query 的 name 与 nameContains 只能给一个（全等 / 包含）`)
  }
  if (q.path !== undefined) {
    if (!Array.isArray(q.path) || q.path.length === 0) throw new Error(`${where}.query.path 要是非空数组`)
    q.path.forEach((seg, i) => checkQuery(seg, `${where}.query.path[${i}]`))
  }
}

function checkLocator(v: unknown, where: string): void {
  if (!isObject(v)) throw new Error(`${where} 要是定位对象（query / resourceId / text）`)
  assertNoCoordinates(v, where)
  for (const k of Object.keys(v)) {
    if (!LOCATOR_KEYS.has(k)) throw new Error(`${where} 带了不认识的键 ${k}（只有 ${[...LOCATOR_KEYS].join(' / ')}）`)
  }
  const forms = ['query', 'resourceId', 'text'].filter((k) => v[k] !== undefined)
  if (forms.length === 0) throw new Error(`${where} 要给 query / resourceId / text 之一`)
  if (forms.length > 1) throw new Error(`${where} 的 query / resourceId / text 只能给一个`)
  if (v.query !== undefined) checkQuery(v.query, where)
  if (v.resourceId !== undefined && !nonEmptyString(v.resourceId)) throw new Error(`${where}.resourceId 要是非空字符串`)
  if (v.text !== undefined && !nonEmptyString(v.text)) throw new Error(`${where}.text 要是非空字符串`)
  if (v.where !== undefined && v.text === undefined) throw new Error(`${where}.where 只配 text`)
  if (v.where !== undefined) checkWhere(v.where, `${where}.where`)
  if (v.ocr !== undefined) {
    if (typeof v.ocr !== 'boolean') throw new Error(`${where}.ocr 只认 true / false`)
    if (v.text === undefined) throw new Error(`${where}.ocr 只配 text`)
  }
}

function checkWhere(w: unknown, where: string): void {
  if (!isObject(w)) throw new Error(`${where} 要是 { anchor, side, maxDist? }`)
  for (const k of Object.keys(w)) {
    if (!['anchor', 'side', 'maxDist'].includes(k)) throw new Error(`${where} 带了不认识的键 ${k}`)
  }
  if (!isObject(w.anchor) || !nonEmptyString(w.anchor.text)) throw new Error(`${where}.anchor 要是 { text }`)
  if (!['left', 'right', 'above', 'below'].includes(String(w.side))) {
    throw new Error(`${where}.side 只认 left / right / above / below`)
  }
  if (w.maxDist !== undefined && (typeof w.maxDist !== 'number' || !Number.isFinite(w.maxDist) || w.maxDist < 0)) {
    throw new Error(`${where}.maxDist 要是非负数（锚点尺寸的倍数）`)
  }
}

function checkFeatures(v: unknown, where: string): void {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${where}.features 要是非空数组（空数组会匹配一切）`)
  v.forEach((f, i) => {
    const at = `${where}.features[${i}]`
    if (!isObject(f)) throw new Error(`${at} 要是特征对象`)
    const kind = String(f.kind)
    if (!ANDROID_FEATURE_KINDS.has(kind)) {
      throw new Error(`${at}.kind 是 ${kind}——安卓这条路线只能判 a11y / text / android-window 特征`)
    }
    if (kind === 'a11y') {
      checkQuery(f.query, at)
      if (f.absent !== undefined && typeof f.absent !== 'boolean') throw new Error(`${at}.absent 只认 true / false`)
    } else if (kind === 'text') {
      if (!nonEmptyString(f.text)) throw new Error(`${at}.text 要是非空字符串`)
      if (f.region !== undefined) throw new Error(`${at}.region 是坐标——安卓特征只用 text + where`)
      if (f.where !== undefined) checkWhere(f.where, `${at}.where`)
      if (f.absent !== undefined && typeof f.absent !== 'boolean') throw new Error(`${at}.absent 只认 true / false`)
    } else {
      if (f.package !== undefined && packageProblem(f.package) !== undefined) {
        throw new Error(`${at}.package 要是一个包名或一组非空包名`)
      }
      for (const k of ['activity', 'title'] as const) {
        if (f[k] !== undefined && !nonEmptyString(f[k])) throw new Error(`${at}.${k} 要是非空字符串`)
      }
      if (f.package === undefined && f.activity === undefined && f.title === undefined) {
        throw new Error(`${at} 至少要给 package / activity / title 之一`)
      }
      if (f.absent !== undefined && typeof f.absent !== 'boolean') throw new Error(`${at}.absent 只认 true / false`)
    }
  })
}

function checkExpect(v: unknown, where: string): void {
  if (!isObject(v)) throw new Error(`${where}.expect 要是对象`)
  for (const k of Object.keys(v)) {
    if (!['features', 'timeoutMs'].includes(k)) throw new Error(`${where}.expect 带了不认识的键 ${k}`)
  }
  checkFeatures(v.features, `${where}.expect`)
  if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== 'number' || !(v.timeoutMs > 0))) {
    throw new Error(`${where}.expect.timeoutMs 要是正数（毫秒）`)
  }
}

function checkStateSpec(v: unknown, where: string): void {
  if (!isObject(v)) throw new Error(`${where} 要是 { features }`)
  for (const k of Object.keys(v)) {
    if (!['features', 'note'].includes(k)) throw new Error(`${where} 带了不认识的键 ${k}`)
  }
  checkFeatures(v.features, where)
  if (v.note !== undefined && typeof v.note !== 'string') throw new Error(`${where}.note 要是字符串`)
}

function duration(v: unknown, where: string, max: number): void {
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max)) {
    throw new Error(`${where}.durationMs 要是 0..${max} 之间的正数（毫秒）`)
  }
}

/**
 * Validate one Android recipe at load time. The message names the recipe and the offending
 * place — a broken recipe must fail at install, not at the first target that silently matches
 * nothing.
 */
export function validateAndroidRecipe(sourceId: string, r: Record<string, unknown>): void {
  const fail = (msg: string): never => {
    throw new Error(`recipe "${sourceId}": ${msg}`)
  }
  for (const k of Object.keys(r)) {
    if (!['version', 'kind', 'sourceId', 'app', 'entry', 'exit', 'steps', 'observer', 'allowEmpty', 'meta'].includes(k) && !k.startsWith('_')) {
      fail(`不认识的键 ${k}`)
    }
  }
  const app = r.app
  if (!isObject(app)) fail('android recipe requires app.id (or its legacy spelling app.package)')
  const appObj = app as Record<string, unknown>
  identifierField(appObj, 'app', fail)
  if (appObj.activity !== undefined && !nonEmptyString(appObj.activity)) fail('app.activity 要是非空字符串')
  if (appObj.title !== undefined && !nonEmptyString(appObj.title)) fail('app.title 要是非空字符串')
  if (r.entry !== undefined) checkStateSpec(r.entry, 'entry')
  if (r.exit !== undefined) checkStateSpec(r.exit, 'exit')
  if (!Array.isArray(r.steps) || r.steps.length === 0) fail('android recipe requires a non-empty steps array')
  if (r.allowEmpty !== undefined && typeof r.allowEmpty !== 'boolean') fail('allowEmpty 只认 true / false')
  if (r.observer !== undefined) {
    const o = r.observer
    if (!isObject(o)) fail('observer 要是对象')
    const obs = o as Record<string, unknown>
    if (!isObject(obs.itemQuery)) fail('observer.itemQuery 要是对象')
    if (!isObject(obs.fields) || Object.keys(obs.fields as object).length === 0) fail('observer.fields 要是非空对象')
    if (!nonEmptyString(obs.dedupeBy)) fail('observer.dedupeBy 要是非空字符串')
  }

  const labels = new Set<string>()
  ;(r.steps as unknown[]).forEach((raw, i) => {
    const where = `steps[${i}]`
    if (!isObject(raw)) fail(`${where} 要是对象`)
    const step = raw as Record<string, unknown>
    assertNoCoordinates(step, where)
    const kind = String(step.kind)
    if (!ANDROID_STEP_KINDS.has(kind)) fail(`${where}.kind 不认识：${JSON.stringify(step.kind)}（只有 ${[...ANDROID_STEP_KINDS].join(' / ')}）`)
    const allowed = STEP_KEYS[kind]
    for (const k of Object.keys(step)) {
      if (!allowed.has(k) && !k.startsWith('_')) fail(`${where}（${kind}）带了不认识的键 ${k}`)
    }
    const label = step.label
    if (label !== undefined) {
      if (!nonEmptyString(label)) fail(`${where}.label 要是非空字符串`)
      const labelText = label as string
      if (labels.has(labelText)) fail(`${where}.label 与前面某一步重复：${labelText}`)
      labels.add(labelText)
    }
    if (step.intent !== undefined && typeof step.intent !== 'string') fail(`${where}.intent 要是字符串`)
    if (step.optional !== undefined && typeof step.optional !== 'boolean') fail(`${where}.optional 只认 true / false`)
    if (step.expect !== undefined) checkExpect(step.expect, where)

    switch (kind) {
      case 'openApp':
        identifierField(step, where, fail, false)
        if (step.fresh !== undefined && typeof step.fresh !== 'boolean') fail(`${where}.fresh 只认 true / false`)
        break
      case 'tap':
      case 'find':
        if (step.target === undefined) fail(`${where}（${kind}）要给 target`)
        checkLocator(step.target, `${where}.target`)
        break
      case 'longPress':
        if (step.target === undefined) fail(`${where}（longPress）要给 target`)
        checkLocator(step.target, `${where}.target`)
        duration(step.durationMs, where, 5000)
        break
      case 'swipe':
        if (step.from === undefined || step.to === undefined) fail(`${where}（swipe）要给 from 与 to`)
        checkLocator(step.from, `${where}.from`)
        checkLocator(step.to, `${where}.to`)
        duration(step.durationMs, where, 10000)
        break
      case 'scroll': {
        if (step.dir !== 'up' && step.dir !== 'down') fail(`${where}.dir 只认 up / down`)
        const hasAmount = step.amount !== undefined
        const hasUntil = step.until !== undefined
        if (hasAmount === hasUntil) fail(`${where} 的 amount 与 until 只能给一个（按步数滚 / 滚到出现某段文字）`)
        if (hasAmount && (typeof step.amount !== 'number' || !Number.isInteger(step.amount) || step.amount < 1 || step.amount > 10)) {
          fail(`${where}.amount 要是 1..10 的整数`)
        }
        if (hasUntil && !nonEmptyString(step.until)) fail(`${where}.until 要是非空字符串`)
        if (step.maxSteps !== undefined && (typeof step.maxSteps !== 'number' || !Number.isInteger(step.maxSteps) || step.maxSteps < 1 || step.maxSteps > 50)) {
          fail(`${where}.maxSteps 要是 1..50 的整数`)
        }
        if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== 'number' || step.timeoutMs < 0 || step.timeoutMs > 60000)) {
          fail(`${where}.timeoutMs 要是 0..60000 的毫秒数`)
        }
        break
      }
      case 'type':
      case 'setText':
        if (typeof step.text !== 'string') fail(`${where}.text 要是字符串`)
        if (kind === 'setText') {
          if (step.target === undefined) fail(`${where}（setText）要给 target`)
          checkLocator(step.target, `${where}.target`)
        }
        break
      case 'press':
        if (step.key !== 'Back' && step.key !== 'Home' && step.key !== 'Enter') fail(`${where}.key 只认 Back / Home / Enter`)
        break
      case 'sleep':
        if (typeof step.ms !== 'number' || !Number.isInteger(step.ms) || step.ms < 0 || step.ms > 600000) {
          fail(`${where}.ms 要是 0..600000 的整数（毫秒）`)
        }
        break
      case 'screenshot':
      case 'windows':
        break
    }
  })
}
