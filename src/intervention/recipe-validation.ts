import { readFileSync } from 'node:fs'
import type { Recipe } from '../replay/recipe.ts'
import { validateRecipe } from '../replay/recipe-store.ts'
import type { RecipeValidation } from './types.ts'
import { canonicalJson } from './canonical.ts'

/**
 * 候选 recipe 的四格校验（spec §5.2 第 6 步、§7.2 主判据）。**这是闸，任务书只是提示**：
 * agent 把 `expect` 改顺眼了、把 version 跳到 9、把文件写坏了，全在这儿拦。
 *
 * 四格各自独立说话，`ok` 之外的字串就是「为什么不过」，原样发回 agent（task-book.ts
 * `buildValidationFeedback`）和给人看（提议卡）。`probe` 多两个 skipped 档：**没跑 ≠ 过**，
 * 但也不算不过——它决定的是提议卡上那一格显示什么，不决定 `ok`。
 */
/**
 * 断言 = 任务的定义（spec 三条纪律第一条）。这里列的就是「什么算断言」的**全集**；
 * 往 recipe 加一种断言字段，就要来加一行——**漏一行的代价是这道闸对那种 recipe 完全失效，
 * 而且照样报 `assertions: 'ok'`**（漏了 V1 那两格就是这么发现的）。
 *
 * 磁盘上同时存在两种 browser recipe，断言字段的名字**完全不同**：
 *  - V1 `BrowserRecipe`：`actions[].expect` + `harvest.assert`（`recipe.ts` §BrowserRecipe，仍被装载器接受）
 *  - canonical：`steps[].expect` + `observers[].input.assert` + `output.assert`
 *    （observer 没自己的 `input` 时**继承 `recipe.output`**，所以 `output.assert` 是那一档的默认漂移守卫）
 * 两种都要看：只看 canonical 的话，一份 V1 recipe 的 expect 被改光了，快照仍然是两个空数组。
 *
 * `meta.params_schema` 里每个键的 `required` 也在快照里——**参数契约也是任务定义的一部分**：
 * 候选把某个参数改成 `required: true`，活体 probe 就会被判成 `skipped-needs-params` 而跳过，
 * 等于 agent 自己关掉了最后一道实测闸。
 */
export function assertionSnapshot(recipe: unknown): string {
  const r = (recipe ?? {}) as Record<string, unknown>
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  const schema = obj(obj(r.meta)?.params_schema) ?? {}
  return canonicalJson({
    loginCheck: r.loginCheck ?? null,
    assert: r.assert ?? null,
    // canonical browser 的 steps[].expect；desktop 的 steps[] 还带一格 `require`——
    // **前置条件**，守的正是 `expect` 够不着的那类判据：「点下去之前，这个会话的标题必须是他」。
    // 发错人那道闸就挂在它上面（`desktop-recipe.ts` DesktopStepCommon），所以它和 expect 一样是断言。
    steps: arr(r.steps).map((s) => ({ expect: s?.expect ?? null, require: s?.require ?? null })),
    observers: arr(r.observers).map((o) => obj(o?.input)?.assert ?? null),
    outputAssert: obj(r.output)?.assert ?? null,
    // V1 browser
    actions: arr(r.actions).map((a) => a?.expect ?? null),
    harvestAssert: obj(r.harvest)?.assert ?? null,
    // 参数契约
    params: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, obj(v)?.required === true])),
  })
}

/** `meta.params_schema` 里 `required: true` 的键——有一个就说明这份 recipe 不能空手跑，活体 probe 免谈。 */
export function requiredParams(recipe: unknown): string[] {
  const schema = ((recipe as { meta?: { params_schema?: Record<string, { required?: boolean } | unknown> } })?.meta?.params_schema) ?? {}
  return Object.entries(schema)
    .filter(([, v]) => (v as { required?: boolean } | null)?.required === true)
    .map(([k]) => k)
}

export interface ValidateCandidateInput {
  localSourceId: string
  original: unknown
  candidatePath: string
  /** 缺席 = skipped-no-executor（没跑，不是过了）。 */
  probe?: (recipe: Recipe) => Promise<{ outcome: string; reason?: string; items: number }>
}

/** schema 没过时，后面三格一律**说自己没看**——装懂比不说更坏。 */
const NOT_LOOKED = '（schema 没过，没看）'
const NOT_RUN = '（schema 没过，没跑）'

export async function validateCandidate(i: ValidateCandidateInput): Promise<{ ok: boolean; validation: RecipeValidation; candidate?: Recipe }> {
  const v: RecipeValidation = { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(i.candidatePath, 'utf8'))
  } catch (e) {
    v.schema = `读不到或不是 JSON：${e instanceof Error ? e.message : String(e)}`
    v.version = NOT_LOOKED
    v.assertions = NOT_LOOKED
    v.probe = NOT_RUN
    return { ok: false, validation: v }
  }
  let candidate: Recipe
  try {
    candidate = validateRecipe(i.localSourceId, raw)
  } catch (e) {
    v.schema = e instanceof Error ? e.message : String(e)
    v.version = NOT_LOOKED
    v.assertions = NOT_LOOKED
    v.probe = NOT_RUN
    return { ok: false, validation: v }
  }
  const want = Number((i.original as { version?: unknown })?.version ?? 0) + 1
  const got = (candidate as { version?: number }).version
  if (got !== want) v.version = `version 必须是 ${want}（原版 +1），现在是 ${String(got)}`
  if (assertionSnapshot(i.original) !== assertionSnapshot(candidate)) {
    // 这句原样发回 agent（`task-book.ts` buildValidationFeedback），所以**覆盖到的字段要点名**：
    // 只说「改了断言」，agent 不知道该回去看哪一格，多半会把定位又改一遍再撞一次。
    v.assertions =
      '改了断言——只许修定位。锁住的是：步骤的 expect 与 require、loginCheck、' +
      '各处 assert（顶层 assert、harvest.assert、output.assert、observer 的 input.assert）、' +
      'meta.params_schema 里每个参数的 required'
  }
  if (v.version !== 'ok' || v.assertions !== 'ok') {
    v.probe = '（前面没过，没跑）'
    return { ok: false, validation: v, candidate }
  }
  if (!i.probe) return { ok: true, validation: v, candidate }
  // **问原版，不问候选**：候选是 agent 写的，拿它来决定「要不要跑活体 probe」等于让被考的人
  // 自己出卷子——加一个 `required: true` 就能把最后一道实测闸变成 skipped。参数契约本身也在
  // 断言快照里锁着（上面那一格），这里是第二道：两条都得漏，才可能绕过去。
  if (requiredParams(i.original).length) {
    v.probe = 'skipped-needs-params'
    return { ok: true, validation: v, candidate }
  }
  try {
    const r = await i.probe(candidate)
    if (r.outcome === 'ok' && r.items > 0) {
      v.probe = 'ok'
      return { ok: true, validation: v, candidate }
    }
    v.probe = `活体 probe ${r.outcome}${r.reason ? `：${r.reason}` : ''}（${r.items} 条）`
    return { ok: false, validation: v, candidate }
  } catch (e) {
    v.probe = `活体 probe 抛错：${e instanceof Error ? e.message : String(e)}`
    return { ok: false, validation: v, candidate }
  }
}
