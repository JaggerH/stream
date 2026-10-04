import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { makeCdpLauncher } from '../browser.ts'
import { runBrowserRecipe, type RunBrowserOutcome } from '../browser-drive.ts'
import { makeFileRecipeStore, type RecipeStore } from '../recipe-store.ts'
import type { Recipe, BrowserRecipe } from '../recipe.ts'
import { acquireFacilityLock } from './facility-lock.ts'

export interface ValidateOptions {
  root?: string
  /** recipe json dir; default <root>/data/recipes */
  recipesDir?: string
  params?: Record<string, string>
  /** DI (tests) */
  store?: RecipeStore
  runBrowser?: typeof runBrowserRecipe
  launch?: typeof makeCdpLauncher
  lock?: (locksRoot: string, facility: string) => Promise<{ release(): Promise<void> }>
  /** record-mode wall handler (DI for tests); default prompts the operator to log in */
  onWall?: () => Promise<'resume' | 'abort'>
}

/** Default record-mode wall handler: pause, tell the operator to log in, resume on Enter.
 *  Non-interactive terminal (no TTY, e.g. CI or piped stdin) → abort cleanly instead of
 *  hanging on a prompt no human can answer; the run then reports needsLogin. */
async function promptResumeOnWall(): Promise<'resume' | 'abort'> {
  if (!input.isTTY) {
    process.stderr.write('[record] 登录墙出现，但当前非交互式终端 → 放弃。请在你自己那个带调试端口的 Chrome 窗口里登录该站点，然后重新执行验证。\n')
    return 'abort'
  }
  process.stderr.write('[record] 登录墙出现：请在浏览器窗口中完成登录，然后回车继续（Ctrl-C 放弃）…\n')
  const rl = createInterface({ input, output })
  try {
    await rl.question('')
  } finally {
    rl.close()
  }
  return 'resume'
}

export interface ValidateReport {
  ok: boolean
  outcome: RunBrowserOutcome['outcome']
  itemCount: number
  targetCount: number
  seed: number
  driftReason: string | null
}

function requireBrowserRecipe(sourceId: string, recipe: Recipe): BrowserRecipe {
  if (recipe.kind !== 'browser' || !('actions' in recipe)) {
    throw new Error(`record validate: recipe "${sourceId}" is kind ${recipe.kind} — only browser recipes are replayed here (fetch recipes validate via schema on save)`)
  }
  return recipe
}

/**
 * `record validate <sourceId>` — one real deterministic replay via runBrowserRecipe in the
 * developer's own debuggable Chrome (see browser.ts; start it with --remote-debugging-port).
 * Success = outcome ok, drift=null, items >= harvest.targetCount (plan Phase 3 acceptance).
 *
 * Running it in the developer's browser is also what makes a login wall answerable: the prompt
 * below asks them to log in, and the window they log into is the window doing the replay.
 */
export async function runValidate(sourceId: string, opts: ValidateOptions = {}): Promise<ValidateReport> {
  const root = opts.root ?? process.cwd()
  const recipesDir = opts.recipesDir ?? join(root, 'data', 'recipes')
  const store = opts.store ?? makeFileRecipeStore(recipesDir)
  const recipe = requireBrowserRecipe(sourceId, store.load(sourceId))

  // Serializes two validates of the same source; nothing owns a browser profile any more.
  const locksRoot = join(root, 'data', 'locks')
  const lock = await (opts.lock ?? acquireFacilityLock)(locksRoot, sourceId)
  try {
    const launcher = (opts.launch ?? makeCdpLauncher)()
    // record mode: a login wall pauses + prompts + resumes (vs replay's abort→needsLogin)
    const hooks = { onWall: opts.onWall ?? promptResumeOnWall }
    const result = await (opts.runBrowser ?? runBrowserRecipe)(recipe, opts.params ?? {}, launcher, undefined, undefined, hooks)
    const targetCount = recipe.harvest.targetCount
    const ok = result.outcome === 'ok' && result.driftReason == null && result.items.length >= targetCount
    return {
      ok,
      outcome: result.outcome,
      itemCount: result.items.length,
      targetCount,
      seed: result.seed,
      driftReason: result.driftReason,
    }
  } finally {
    await lock.release()
  }
}

export function formatReport(sourceId: string, r: ValidateReport): string {
  const verdict = r.ok ? 'PASS' : 'FAIL'
  const detail = `outcome=${r.outcome} items=${r.itemCount}/${r.targetCount} seed=${r.seed}` +
    (r.driftReason ? ` drift=${r.driftReason}` : '')
  return `[record] validate ${sourceId}: ${verdict} (${detail})`
}
