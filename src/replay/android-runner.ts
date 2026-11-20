import type { Rect } from './desktop-driver.ts'
import { matchesWhere } from './desktop-see.ts'
import type { AndroidDriver } from './android-driver.ts'
import type { AndroidLocator, AndroidRecipe, AndroidStep } from './android-recipe.ts'
import { AndroidPerception, androidProbeFromDriver, type AndroidProbe } from './android-state-perception.ts'
import { substitute } from './interpret.ts'
import { captureAndroidScene, type Scene } from './scene.ts'
import type { StateVerdict } from './state-classify.ts'
import { classifyWithPerception } from './state-classify.ts'
import type { Feature, Observation, StateGraph } from './state-graph.ts'

export interface AndroidRunOptions {
  /** The failure-path state graph. Empty / absent = every failure classifies as `unknown`. */
  stateGraph?: StateGraph
  /** Called for every state a failure classification recognizes (feed the discrimination gate). */
  onObserved?: (o: Observation) => void
  signal?: AbortSignal
  /** Poll interval while waiting for an `expect` / entry / exit feature set. Default 200 ms. */
  pollMs?: number
  /** Default expectation window. Default 3000 ms. */
  expectTimeoutMs?: number
}

/**
 * A run's outcome. Step failures are not thrown: the caller gets `drift` plus the classification
 * and a readable scene, the same way a failed `expect` is reported on the browser and desktop
 * paths. `steps` is how many steps ran (the failing index is the next one).
 */
export interface AndroidRunOutcome {
  outcome: 'ok' | 'drift' | 'cancelled'
  items: Record<string, string>[]
  steps: number
  reason?: string
  /** The failure-path verdict (dead end / escape hatch / identified / ambiguous / unknown). */
  state?: StateVerdict
  /** The screen at the moment of failure — foreground app and visible elements. */
  scene?: Scene
}

class StepFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepFailure'
  }
}

type Located = { ref: string; rect: Rect; name: string }

const center = (r: Rect): { x: number; y: number } => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) })

/**
 * Resolve a locator against the live screen. A text locator reads the frame once (with the OCR
 * tier) so its `where` anchor can see the whole screen; a query locator asks the device directly,
 * because only the device has the tree hierarchy (`path`). Ambiguity is an error, never a guess:
 * clicking one of two identical names is exactly how the wrong recipient gets a message
 * (docs/ENGINE.md §7.4).
 */
async function locate(driver: AndroidDriver, loc: AndroidLocator, params: Record<string, string>): Promise<Located | null> {
  if (loc.resourceId !== undefined) {
    const found = await driver.find({ viewId: substitute(loc.resourceId, params) })
    return exactlyOne(found.elements, loc)
  }
  if (loc.query !== undefined) {
    const found = await driver.find(substituteQuery(loc.query, params))
    return exactlyOne(found.elements, loc)
  }
  const want = substitute(loc.text ?? '', params)
  const found = await driver
    .find({}, { ocr: loc.ocr === false ? 'off' : 'on' })
    .catch(async (e) => {
      // A text locator still has the accessibility names when the device has no OCR capability.
      if (loc.ocr !== false && /ui\.ocr/.test(String((e as Error)?.message ?? ''))) return driver.find({}, { ocr: 'off' })
      throw e
    })
  const named = found.elements.filter((e) => e.name)
  const exact = named.filter((e) => e.name === want)
  const contains = exact.length ? exact : named.filter((e) => e.name.includes(want))
  const texts = named.map((e) => ({ text: e.name, rect: e.rect }))
  const narrowed = loc.where ? contains.filter((e) => matchesWhere(e.rect, loc.where!, texts)) : contains
  return exactlyOne(narrowed, loc)
}

function exactlyOne(elements: Array<{ ref: string; rect: Rect; name: string }>, loc: AndroidLocator): Located | null {
  if (elements.length === 0) return null
  if (elements.length > 1) {
    const what = loc.resourceId ?? loc.text ?? JSON.stringify(loc.query)
    throw new StepFailure(`ambiguous-target: ${elements.length} 个元素匹配 ${what}——定位必须唯一，先用 where / resourceId 收窄`)
  }
  const e = elements[0]
  return { ref: e.ref, rect: e.rect, name: e.name }
}

function substituteQuery(q: NonNullable<AndroidLocator['query']>, params: Record<string, string>): NonNullable<AndroidLocator['query']> {
  return {
    ...q,
    ...(q.role !== undefined ? { role: substitute(q.role, params) } : {}),
    ...(q.name !== undefined ? { name: substitute(q.name, params) } : {}),
    ...(q.nameContains !== undefined ? { nameContains: substitute(q.nameContains, params) } : {}),
    ...(q.className !== undefined ? { className: substitute(q.className, params) } : {}),
    ...(q.viewId !== undefined ? { viewId: substitute(q.viewId, params) } : {}),
  }
}

function packagesOf(v: string | string[] | undefined,): string[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Replay a `kind:'android'` recipe over an injected driver (built from the embedder's own
 * `ops` function). Steps run in order; `expect` / entry / exit feature sets are polled on the
 * live screen. A failure stops the run and is classified against `opts.stateGraph`; nothing is
 * retried inside the same run (repeating an action with side effects is the most expensive
 * mistake this path can make).
 */
export async function runAndroidRecipe(
  recipe: AndroidRecipe,
  params: Record<string, string>,
  driver: AndroidDriver,
  opts: AndroidRunOptions = {},
): Promise<AndroidRunOutcome> {
  const probe: AndroidProbe = androidProbeFromDriver(driver)
  const perception = new AndroidPerception(probe)
  const pollMs = opts.pollMs ?? 200
  const defaultTimeout = opts.expectTimeoutMs ?? 3000
  const graph: StateGraph = opts.stateGraph ?? { states: [], transitions: [] }
  const started = Date.now()

  const waitFeatures = async (features: AndroidStepFeatureSet, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (opts.signal?.aborted) return false
      if (await perception.check(features)) return true
      if (Date.now() >= deadline) return false
      await sleep(pollMs)
    }
  }

  let entryPending = !!recipe.entry
  let index = 0
  try {
    for (; index < recipe.steps.length; index++) {
      if (opts.signal?.aborted) return { outcome: 'cancelled', items: [], steps: index, reason: 'aborted before step' }
      const step = recipe.steps[index]
      const label = step.label ?? `step#${index}`
      if (step.kind === 'openApp') {
        const candidates = packagesOf(step.package).length ? packagesOf(step.package) : packagesOf(recipe.app.package)
        let opened = false
        for (const pkg of candidates) {
          if (await driver.openApp(pkg, step.fresh)) {
            opened = true
            // Scope subsequent finds to the app; failing to scope is not fatal (the device may
            // answer only the foreground window), but it must not hide a failed launch.
            await driver.scopeWindow({ process: pkg }).catch(() => {})
            break
          }
        }
        if (!opened) throw new StepFailure(`openApp: 没有候选包能到前台（${candidates.join(' / ')}）`)
      } else if (step.kind === 'tap') {
        const at = await locate(driver, step.target, params)
        if (!at) {
          if (step.optional) continue
          throw new StepFailure(`tap: 找不到目标 ${describeLocator(step.target)}`)
        }
        await driver.tap(at.rect)
      } else if (step.kind === 'longPress') {
        const at = await locate(driver, step.target, params)
        if (!at) {
          if (step.optional) continue
          throw new StepFailure(`longPress: 找不到目标 ${describeLocator(step.target)}`)
        }
        await driver.longPress(at.rect, step.durationMs)
      } else if (step.kind === 'swipe') {
        const from = await locate(driver, step.from, params)
        const to = await locate(driver, step.to, params)
        if (!from || !to) {
          if (step.optional) continue
          throw new StepFailure(`swipe: 找不到 ${!from ? 'from' : 'to'} 端 ${describeLocator(!from ? step.from : step.to)}`)
        }
        await driver.swipe(center(from.rect), center(to.rect), step.durationMs)
      } else if (step.kind === 'scroll') {
        await driver.scroll(step.dir, {
          ...(step.until !== undefined
            ? { until: substitute(step.until, params), maxSteps: step.maxSteps, timeoutMs: step.timeoutMs }
            : { amount: step.amount }),
        })
      } else if (step.kind === 'type') {
        await driver.type(substitute(step.text, params))
      } else if (step.kind === 'setText') {
        const at = await locate(driver, step.target, params)
        if (!at) {
          if (step.optional) continue
          throw new StepFailure(`setText: 找不到目标 ${describeLocator(step.target)}`)
        }
        await driver.setText(at.ref, substitute(step.text, params))
      } else if (step.kind === 'press') {
        await driver.press(step.key)
      } else if (step.kind === 'screenshot') {
        await driver.screenshot()
      } else if (step.kind === 'find') {
        const at = await locate(driver, step.target, params)
        if (!at) {
          if (step.optional) continue
          throw new StepFailure(`find: 找不到目标 ${describeLocator(step.target)}`)
        }
      } else if (step.kind === 'windows') {
        await driver.windows()
      } else if (step.kind === 'sleep') {
        await driver.sleep(step.ms)
      }

      if (entryPending && step.kind === 'openApp') {
        entryPending = false
        const ok = await waitFeatures(recipe.entry!.features, defaultTimeout)
        if (!ok) throw new StepFailure('entry features not met（入口状态与声明不符）')
      }
      if (step.expect) {
        const ok = await waitFeatures(step.expect.features, step.expect.timeoutMs ?? defaultTimeout)
        if (!ok) throw new StepFailure(`expect not met（${step.expect.timeoutMs ?? defaultTimeout}ms 内没等到声明的特征）`)
      }
    }

    if (entryPending) {
      entryPending = false
      if (!(await waitFeatures(recipe.entry!.features, defaultTimeout))) {
        throw new StepFailure('entry features not met（入口状态与声明不符）')
      }
    }
    if (recipe.exit && !(await waitFeatures(recipe.exit.features, defaultTimeout))) {
      throw new StepFailure('exit features not met（出口状态与声明不符）')
    }

    let items: Record<string, string>[] = []
    if (recipe.observer) {
      items = await driver.readSubtree(recipe.observer as unknown as Record<string, unknown>)
      if (items.length === 0 && !recipe.allowEmpty) {
        throw new StepFailure('observer 读到 0 条——界面没到位或结构漂了（动作型 recipe 用 allowEmpty）')
      }
    }
    return { outcome: 'ok', items, steps: index }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    const state = await classifyWithPerception(perception, graph, opts.onObserved).catch((): StateVerdict => ({ kind: 'unknown' }))
    const scene = await captureAndroidScene(probe)
    return {
      outcome: 'drift',
      items: [],
      steps: index,
      reason: `${recipe.steps[index]?.label ?? `step#${index}`}（${recipe.steps[index]?.kind ?? 'unknown'}）：${reason}（${Date.now() - started}ms）`,
      state,
      scene,
    }
  }
}

type AndroidStepFeatureSet = Feature[]

function describeLocator(loc: AndroidLocator): string {
  if (loc.resourceId !== undefined) return `resourceId=${loc.resourceId}`
  if (loc.query !== undefined) return `query=${JSON.stringify(loc.query)}`
  return `text=${JSON.stringify(loc.text)}${loc.where ? ` where=${JSON.stringify(loc.where)}` : ''}`
}
