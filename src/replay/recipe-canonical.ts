import type {
  BrowserRecipe,
  CanonicalBrowserRecipe,
  DomHarvest,
  EvalHarvest,
  Harvest,
  RecipeObserver,
  RecipeOutput,
  RecipeStep,
  StateHarvest,
} from './recipe.ts'
import { domAccumulatorInput, evalAccumulatorInput, stateAccumulatorInput } from './dom-harvest.ts'

const DEFAULT_NETWORK_WINDOW_MS = 30_000
const DEFAULT_NETWORK_BODY_BYTES = 2 * 1024 * 1024

function outputFor(harvest: Harvest): RecipeOutput {
  if (harvest.mode === 'dom') return domAccumulatorInput(harvest)
  if (harvest.mode === 'state') return stateAccumulatorInput(harvest)
  if (harvest.mode === 'eval') return evalAccumulatorInput(harvest)
  return harvest
}

function observersFor(harvest: Harvest): RecipeObserver[] {
  if (harvest.mode === 'dom') {
    const h = harvest as DomHarvest
    return [{ kind: 'dom', itemSelector: h.itemSelector, fields: h.fields, trigger: 'after-step' }]
  }
  if (harvest.mode === 'state') {
    const h = harvest as StateHarvest
    return [{ kind: 'state', statePath: h.statePath, trigger: 'entry' }]
  }
  if (harvest.mode === 'eval') return []
  return [{
    kind: 'network',
    urlPattern: harvest.urlPattern,
    windowMs: DEFAULT_NETWORK_WINDOW_MS,
    maxBodyBytes: DEFAULT_NETWORK_BODY_BYTES,
  }]
}

function stepsFor(recipe: BrowserRecipe): RecipeStep[] {
  if (recipe.harvest.mode !== 'eval') return recipe.actions
  const h = recipe.harvest as EvalHarvest
  return [
    ...recipe.actions,
    {
      kind: 'evaluate',
      call: h.call,
      itemsAt: h.itemsAt,
      cursorField: h.cursorField,
      ...(h.pageSize == null ? {} : { pageSize: h.pageSize }),
      ...(h.maxPages == null ? {} : { maxPages: h.maxPages }),
    },
  ]
}

/** Translate the supported v1 actions+harvest shape into the new runtime contract. */
export function canonicalizeBrowserRecipe(recipe: BrowserRecipe): CanonicalBrowserRecipe {
  return {
    version: recipe.version,
    kind: 'browser',
    sourceId: recipe.sourceId,
    cookieDomain: recipe.cookieDomain,
    entryUrl: recipe.entryUrl,
    ...(recipe.entryWait == null ? {} : { entryWait: recipe.entryWait }),
    loginCheck: recipe.loginCheck,
    session: {
      facility: recipe.meta?.facility?.key ?? (recipe.cookieDomain || recipe.sourceId),
      lifecycle: 'one-shot',
      visibility: 'unattended',
    },
    steps: stepsFor(recipe),
    observers: observersFor(recipe.harvest),
    output: outputFor(recipe.harvest),
    ...(recipe.meta == null ? {} : { meta: recipe.meta }),
  }
}
