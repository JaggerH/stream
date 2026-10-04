import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Recipe } from './recipe.ts'
import { isCanonicalBrowserRecipe } from './recipe.ts'
import { COMPUTE_CAPABILITIES } from './compute-sandbox.ts'
import { localSourceIdProblem } from '../registry/source-id.ts'
import { ELSE_VALUES, validateInterrupt, validateSee, validateTarget, type Else } from './desktop-recipe.ts'
import { AREA_BODY_KEYS, GROUNDING_META_KEYS, GROUNDING_PLATFORMS, STEP_TOP_ONLY_KEYS, assertTemplatesKept, groundingBody, isValidRange } from './desktop-grounding.ts'
import { pathDerivedKeys } from './path-params.ts'

export interface RecipeStore {
  load(sourceId: string): Recipe
}

export function validateRecipe(sourceId: string, obj: unknown): Recipe {
  return validate(sourceId, obj)
}

/**
 * `groundings[].on` / `edges[].on`：只认 platform / app / lang；platform 只认两个；app 要是
 * `satisfiesRange` 认得的区间语法。
 *
 * 拼错的 key 一律拒、不静默忽略：`on: { os: 'win32' }` 被忽略的表现是这条落地方式**在所有平台上
 * 都匹配**（空 key 恒真），于是 mac 上跑起了一份只在 Windows 验过的点法——不报错，只是点空。
 *
 * **`on: {}` 是故意放行的**：它就是「哪儿都适用」的通用键（`keyMatches` 里恒真，`specificity` 为 0，
 * 排序上排在任何带条件的落地方式之后）。拒掉它等于逼人写一个假条件。要拒的只有**写错的 key**，
 * 不是**没写 key**——这两件事长得像，但一个是手滑、一个是明确的表态。
 */
function validateGroundingKey(sourceId: string, on: unknown, where: string): void {
  if (!on || typeof on !== 'object' || Array.isArray(on)) throw new Error(`recipe "${sourceId}": ${where} 要有 on（{ platform?, app?, lang? }）`)
  for (const k of Object.keys(on)) if (!['platform', 'app', 'lang'].includes(k)) throw new Error(`recipe "${sourceId}": ${where}.on 不认识 ${k}（只有 platform / app / lang）`)
  const o = on as { platform?: unknown; app?: unknown; lang?: unknown }
  if (o.platform !== undefined && !(GROUNDING_PLATFORMS as readonly unknown[]).includes(o.platform)) {
    throw new Error(`recipe "${sourceId}": ${where}.on.platform 只认 ${GROUNDING_PLATFORMS.join(' / ')}`)
  }
  // 语法定义只有一份，在 `desktop-grounding.ts`（`isValidRange` 与 `satisfiesRange` 共用同一段
  // 比较子正则）。`^` / `~` / `||` 一概不认——它们在求值那头是"永不匹配"，写下去的人却以为
  // 自己写了个区间，而这条落地方式就此静默消失。
  if (o.app !== undefined && (typeof o.app !== 'string' || !isValidRange(o.app))) {
    throw new Error(`recipe "${sourceId}": ${where}.on.app 不是认得的版本区间（写成 ">=4.0 <4.1" 这种）`)
  }
  if (o.lang !== undefined && (typeof o.lang !== 'string' || !o.lang)) throw new Error(`recipe "${sourceId}": ${where}.on.lang 要是非空字符串`)
}

/**
 * `transport` used to answer "which browser". There is only one now — the user's own Chrome over
 * the extension relay — so nothing reads the field. What a recipe may still SAY about it:
 *
 *  - `'ext-cdp'` — accepted, no-op. Every recipe migrated off cloak declares it, and those
 *    declarations are right, just redundant. Loading them is the point of this arm.
 *  - `'cloak'` — REFUSED at load, with the migration action named. Not silently ignored: a
 *    recipe asking for an unattended stealth browser and quietly getting the user's visible one
 *    is a surprise worth failing over, and load is where a shared recipe gets reviewed.
 *  - anything else — refused as a typo, on the same reasoning as the session-key whitelist
 *    (a misspelling that is silently ignored is the expensive kind).
 */
function rejectRetiredTransport(sourceId: string, r: any): void {
  for (const declared of [r?.transport, r?.session?.transport]) {
    if (declared == null || declared === 'ext-cdp') continue
    if (declared === 'cloak') {
      throw new Error(
        `recipe "${sourceId}": transport "cloak" is retired (CloakBrowser is gone; harvesting runs in the user's own Chrome). Delete the transport key, or set it to "ext-cdp".`,
      )
    }
    throw new Error(`recipe "${sourceId}": unknown transport "${String(declared)}" — the only value is "ext-cdp"`)
  }
}

/**
 * `visibility` used to have three values, and the third one (`foreground`) carried a side effect:
 * the executor pulled the browser window to the front before every run. That side effect is gone
 * (see SessionRecipeExecutor), and with it the reason for a third value — `debug` and `foreground`
 * had already collapsed into "the user is meant to watch this".
 *
 * The migration is a HARD CUT, no alias map: a silently-remapped value is entropy that outlives
 * everyone who remembers why it exists. Which puts the whole cost on this error message — the
 * person holding an old recipe has to learn the new name from the failure itself, not from git log.
 */
/**
 * 步骤级 `press` 放行哪些键 —— **判据见下面用到它的那一处**：只放行「改变状态、但不 actuate
 * 任何东西」的键。加键之前先回答那条判据，别照着这份名单里已有谁来类推。
 */
export const PRESSABLE_KEYS: ReadonlySet<string> = new Set(['Escape', 'Tab'])
/** `press.times` 的上限。纯防手滑（`times: 1000` 会让一步敲上千次键），不是语义的一部分。 */
export const MAX_PRESS_TIMES = 20
/**
 * 桌面步骤的 kind 全集（与 `desktop-recipe.ts` 的 `DesktopStep` 联合体同口径）。
 *
 * **拼错的 kind 不能静默放行**：`kind:'clik'` 过了装载闸，到运行时既不匹配任何分支、也没人喊，
 * 表现是这一步"跑过了"却什么都没做——而后面每一步都以为它做过了。落地方式（grounding）那一侧
 * 同吃这份名单：一条 kind 拼错的落地方式会被选中、然后什么都不做，比没有它更坏。
 * 往 `DesktopStep` 加一种步骤时这里也要加一行。
 */
export const DESKTOP_STEP_KINDS: ReadonlySet<string> = new Set([
  'focus', 'invoke', 'type', 'click', 'scroll', 'press', 'clear', 'wait', 'branch', 'window', 'pickFile',
])

const RETIRED_VISIBILITY: Record<string, 'unattended' | 'interactive'> = {
  silent: 'unattended',
  debug: 'interactive',
  foreground: 'interactive',
}

function rejectRetiredVisibility(sourceId: string, r: any): void {
  const declared = r?.session?.visibility
  const replacement = typeof declared === 'string' ? RETIRED_VISIBILITY[declared] : undefined
  if (!replacement) return
  throw new Error(
    `recipe "${sourceId}": session.visibility "${declared}" is retired — use "${replacement}". ` +
      `unattended = harvest, runs in a background tab and never steals the screen; ` +
      `interactive = a flow the user has to work through themselves (login, create-key), opened in front of them.`,
  )
}

/**
 * `version` 是这份 recipe **自己**的修订号（不是 `schemaVersion` 的形状版本，也不是
 * `hostVersion` 的宿主下界）。它今天的含义就一句话：**"这份 recipe 我动过了，之前那些失败不算数。"**
 *
 * **缺了它，坏掉的源就再也救不回来。** 唯一的消费者是 `RepairLedger`：连续 drift 三次 → 隔离，
 * 隔离记在"version N"上；改好 recipe、把 version 加一 → `shouldRun` 放行、drift 连击清零。
 * 而它的判据是 `recipeVersion > s.recipeVersion` —— **缺 version 时这个比较恒为 false**，于是
 * 那个源一旦被隔离就永久隔离，改多少次都没用。还很安静：隔离期直接 DECLINED（"本轮未采集"），
 * 不报错、不记失败，只是永远不出数。
 *
 * 这里只做**最小的那一步**：声明缺失或不是正整数 → 装载即拒。它今天拦不到任何存量
 * （35 份内置 + 用户装着的都带 version），拦的是将来手写漏掉的那一份。
 *
 * 另一半价值在将来：**同名换义**（把某个字段的含义换掉、不是加字段）之后，没有版本号就无从分辨
 * 新旧，老文件会被按新语义解释而不报任何错。相邻两道闸门都建好了（`schemaVersion` 有上界、
 * `hostVersion` 有下界、retired transport/visibility 都显式拒），唯独这一格空着。
 *
 * **还没做的那一半**：版本区间该拒还是该翻译、翻译由谁做——那要和 `recipe-record-replay-contract`
 * 一起定（翻译在装载点完成、runner 只见 canonical 形状）。在那之前别在这里塞临时兼容，
 * 那是一套写完就要删的东西。
 */
function assertVersion(sourceId: string, r: any): void {
  const declared = r?.version
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return
  throw new Error(
    `recipe "${sourceId}": version must be a positive integer (got ${JSON.stringify(declared)}). ` +
      `每份 recipe 都要申报自己的修订号——修复台账靠"版本变高了"来解除隔离，` +
      `没有它，这个源一旦因连续 drift 被隔离就永远解不开（改多少次都没用）。`,
  )
}

/**
 * recipe 文件里的 `sourceId` 写的是**局部名**——包作者不写自己的 npm 包名，全名（`<包名>/<局部名>`）
 * 由宿主在装载期合成（见 `src/registry/source-id.ts`）。局部名带 `/` 或 `:` 会让合成出来的全名
 * 在解析时二义，所以在装载点就拒掉。今天没有任何 recipe 这么写，这条约束零代价。
 */
function assertLocalSourceId(label: string, r: any): void {
  const declared = r?.sourceId
  // 只管文法，不管有没有：`sourceId` 缺席自有下游的形状校验去说，这里多加一道
  // 只会把那些错的报错文案换成一句离现场更远的话。
  if (typeof declared !== 'string' || !declared) return
  const problem = localSourceIdProblem(declared)
  if (problem) {
    throw new Error(
      `recipe "${label}": sourceId ${problem}。recipe 里写的是**局部名**，` +
      `带命名空间的全名由宿主用你的 npm 包名合成。`,
    )
  }
}

/**
 * `meta.login` 蕴含 `meta.action` —— 登录是有副作用的（建立会话、踢掉同账号在别处的登录）。
 *
 * 半开状态（声明了 login 没声明 action）不能静默存在：宿主会把它当成这个 facility 的登录入口
 * 去跑，而 `run_action_recipe` 那条路又因为 `action !== true` 拒绝它——同一条 recipe 在两条路
 * 上一个能跑一个不能跑，且都不报错，只是行为不一致。
 *
 * 还要有 `session.facility`：宿主就是按它索引"哪个 facility 掉线了该跑哪条"。没有它，这条
 * recipe 声明了自己是登录入口，却没说自己是**谁的**登录入口。
 */
function assertLoginIsAction(sourceId: string, r: any): void {
  if (r?.meta?.login !== true) return
  if (r?.meta?.action !== true) {
    throw new Error(
      `recipe "${sourceId}": meta.login 蕴含 meta.action —— 登录会建立会话、踢掉同账号在别处的登录，` +
        `是不可撤回的副作用。补上 "action": true`,
    )
  }
  if (typeof r?.session?.facility !== 'string' || !r.session.facility) {
    throw new Error(
      `recipe "${sourceId}": meta.login 需要 session.facility —— 宿主按它回答"这个 facility 掉线了该跑哪条"，` +
        `没有它就只声明了"我是登录入口"，没说是谁的`,
    )
  }
}

/**
 * `meta.title` / `meta.purpose`（提示条第二行，见 `RecipeMeta` 那两格的头注）的装载期闸：
 * 都是字符串；`purpose` 里的每个 `{x}` 占位必须是 `params_schema` 声明过的键。
 *
 * 为什么占位要在装载期拒：runner 用 `substitute` 填参，**没声明的洞会原样留在文本里**——
 * 条子上多一对花括号、不报错，作者以为拼错了参数名却没有一处会喊。占位的文法和 `substitute`
 * 同一条正则（`{\w+}`），别在这儿另写一份。`secret_params` 里的名字一律不许出现：purpose 是
 * 要上屏的，宿主注入的凭据不能经它露出去——这条不看 params_schema 有没有同名，直接拒。
 */
function validateDisplayMeta(sourceId: string, meta: any): void {
  if (meta == null) return
  for (const k of ['title', 'purpose'] as const) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') throw new Error(`recipe "${sourceId}": meta.${k} 要是字符串，给的是 ${JSON.stringify(meta[k])}`)
  }
  if (typeof meta.purpose !== 'string') return
  const declared = new Set(Object.keys((meta.params_schema as Record<string, unknown> | undefined) ?? {}))
  const secret = new Set<string>(Array.isArray(meta.secret_params) ? meta.secret_params : [])
  for (const m of (meta.purpose as string).matchAll(/\{(\w+)\}/g)) {
    if (secret.has(m[1])) {
      throw new Error(`recipe "${sourceId}": meta.purpose 里引用了 secret_params 的 {${m[1]}}——purpose 是要上屏的，凭据不能经它露出去`)
    }
    if (!declared.has(m[1])) {
      throw new Error(`recipe "${sourceId}": meta.purpose 里的 {${m[1]}} 没在 params_schema 里声明——填参时它会原样留在提示条上`)
    }
  }
}

function validate(sourceId: string, obj: unknown): Recipe {
  const r = obj as any
  assertLocalSourceId(sourceId, r)
  assertVersion(sourceId, r)
  rejectRetiredTransport(sourceId, r)
  assertLoginIsAction(sourceId, r)
  validateDisplayMeta(sourceId, r?.meta)
  // Back-compat: the discriminant was renamed `tier: 'B'|'C'` → `kind: 'fetch'|'browser'`.
  // Old on-disk recipes (data/recipes) still carry `tier` — map it so they keep loading.
  if (r && r.kind == null && r.tier != null) {
    r.kind = r.tier === 'B' ? 'fetch' : r.tier === 'C' ? 'browser' : r.tier
  }
  // 'fetch' and 'http' share the whole declarative contract (request/pagination/assert/
  // mapping) — they differ only in who sends the request, so they validate identically.
  // http carries NO entryUrl/cookieDomain: those are browser fields, and requiring them
  // would make the cheapest rung pay the most expensive rung's tax.
  if (r?.kind === 'fetch' || r?.kind === 'http') {
    if (r.kind === 'http' && r.output === 'object') {
      // object 输出：decode 的返回值就是成员结果——pagination/mapping 是 items 输出的字段，
      // 两套形状互斥，混写多半是复制粘贴事故，在装载点（共享 recipe 的审查点）就拒掉。
      if (r.pagination !== undefined || r.mapping !== undefined) {
        throw new Error(`recipe "${sourceId}": object 输出不接 pagination/mapping —— decode 的返回值就是结果`)
      }
    } else {
      const mode = (r.pagination as { mode?: string } | undefined)?.mode
      if (mode !== 'cursor' && mode !== 'increment') {
        throw new Error(`recipe "${sourceId}": pagination.mode must be "cursor" or "increment"`)
      }
    }
    if (r.kind === 'http') {
      if (r.output !== undefined && r.output !== 'items' && r.output !== 'object') {
        throw new Error(`recipe "${sourceId}": output must be "items" or "object"`)
      }
      if (r.jar !== undefined && typeof r.jar !== 'boolean') {
        throw new Error(`recipe "${sourceId}": jar must be a boolean`)
      }
      const prefetches = (r.compute?.prefetch ?? []) as Array<{ parse?: unknown; request?: { redirect?: unknown } }>
      for (const q of [r.request, ...prefetches.map((p) => p.request)]) {
        if (q?.redirect !== undefined && q.redirect !== 'follow' && q.redirect !== 'manual') {
          throw new Error(`recipe "${sourceId}": request.redirect must be "follow" or "manual"`)
        }
      }
      for (const p of prefetches) {
        if (p.parse !== undefined && !['json', 'text', 'none'].includes(p.parse as string)) {
          throw new Error(`recipe "${sourceId}": prefetch.parse must be "json" | "text" | "none"`)
        }
      }
      if (r.compute?.params !== undefined && typeof r.compute.params !== 'string') {
        throw new Error(`recipe "${sourceId}": compute.params must be a code string`)
      }
    }
    // A compute hook must declare a capabilities[] whitelist. Validating it at LOAD (not first
    // fetch) means an unknown/malicious capability name is caught when the recipe is installed
    // — the review point for a shared recipe — not silently at runtime.
    const compute = (r as { compute?: { capabilities?: unknown } }).compute
    if (compute !== undefined) {
      if (!Array.isArray(compute.capabilities)) {
        throw new Error(`recipe "${sourceId}": compute.capabilities must be an array of capability names`)
      }
      for (const c of compute.capabilities) {
        if (!(typeof c === 'string' && c in COMPUTE_CAPABILITIES)) {
          throw new Error(`recipe "${sourceId}": compute declares unknown capability "${String(c)}"`)
        }
      }
    }
    return r as Recipe
  } else if (r?.kind === 'html') {
    // kind:'html' is the same cheap rung as http (bare host fetch) but maps HTML via CSS
    // selectors. Validate the load-bearing shape so a broken recipe fails at install, not
    // silently at harvest: a list selector, at least one list field, increment pagination,
    // and (if present) a detail step that names which field carries the detail URL.
    if (typeof r.request?.url !== 'string' || !r.request.url) {
      throw new Error(`recipe "${sourceId}": html recipe requires request.url`)
    }
    if (typeof r.list?.selector !== 'string' || !r.list.selector) {
      throw new Error(`recipe "${sourceId}": html recipe requires list.selector`)
    }
    if (!r.list.fields || typeof r.list.fields !== 'object' || Object.keys(r.list.fields).length === 0) {
      throw new Error(`recipe "${sourceId}": html recipe requires a non-empty list.fields`)
    }
    if ((r.pagination as { mode?: string } | undefined)?.mode !== 'increment') {
      throw new Error(`recipe "${sourceId}": html recipe pagination.mode must be "increment"`)
    }
    if (r.detail !== undefined && (typeof r.detail.urlFrom !== 'string' || !r.detail.urlFrom)) {
      throw new Error(`recipe "${sourceId}": html recipe detail requires urlFrom (which list field holds the detail URL)`)
    }
    // hops: each one must know its URL (exactly one of url/urlFrom), how to read the body
    // (html default | json), and what to extract. A malformed hop would otherwise fail SILENTLY
    // at harvest — runHop tolerates per-row failures by design, so shape errors must be caught
    // here at install, where they can still be loud.
    if (r.hops !== undefined) {
      if (!Array.isArray(r.hops)) throw new Error(`recipe "${sourceId}": hops must be an array`)
      for (const hop of r.hops as Array<Record<string, unknown>>) {
        const hasUrl = typeof hop?.url === 'string' && hop.url
        const hasUrlFrom = typeof hop?.urlFrom === 'string' && hop.urlFrom
        if (!hasUrl === !hasUrlFrom) {
          throw new Error(`recipe "${sourceId}": each hop requires exactly one of url (a {field} template) or urlFrom (a field name)`)
        }
        if (hop.parse !== undefined && hop.parse !== 'html' && hop.parse !== 'json') {
          throw new Error(`recipe "${sourceId}": hop.parse must be "html" | "json"`)
        }
        if (!hop.fields || typeof hop.fields !== 'object' || Object.keys(hop.fields).length === 0) {
          throw new Error(`recipe "${sourceId}": each hop requires a non-empty fields map`)
        }
        if (hop.parse === 'json') {
          for (const [name, field] of Object.entries(hop.fields as Record<string, { path?: unknown }>)) {
            if (typeof field?.path !== 'string' || !field.path) {
              throw new Error(`recipe "${sourceId}": json hop field "${name}" requires a dot-path`)
            }
          }
        }
      }
    }
    return r as Recipe
  } else if (r?.kind === 'browser') {
    if (isCanonicalBrowserRecipe(r as Recipe)) {
      rejectRetiredVisibility(sourceId, r)
      if (
        !r.session || typeof r.session.facility !== 'string' || !r.session.facility ||
        !['one-shot', 'persistent'].includes(r.session.lifecycle) ||
        !['unattended', 'interactive'].includes(r.session.visibility)
      ) throw new Error(`recipe "${sourceId}": canonical browser recipe requires a valid session`)
      validateSessionKeys(sourceId, r.session as Record<string, unknown>)
      if ('keepAlive' in r.session && (typeof r.session.keepAlive !== 'boolean' || r.session.lifecycle !== 'persistent')) {
        throw new Error(`recipe "${sourceId}": session.keepAlive 只能是布尔值，且只对 lifecycle:"persistent" 有意义`)
      }
      validateLedger(sourceId, r)
      if (!Array.isArray(r.steps) || !Array.isArray(r.observers)) {
        throw new Error(`recipe "${sourceId}": canonical browser recipe requires steps and observers arrays`)
      }
      validateSteps(sourceId, r.steps)
      validateExtract(sourceId, r)
      validateSecretParams(sourceId, r.meta)
      validateCallBeforeSecrets(sourceId, r.meta, r.steps)
      validateNoEvaluateWithSecrets(sourceId, r.meta, r.steps)
      // The real invariant is that SOMETHING is produced — not that both arrays are
      // populated. A pure SSR-state read needs no step (the entry navigation IS the action);
      // an in-page evaluate harvest needs no observer (the step returns the items); an
      // `extract` recipe produces no items at all — its whole output is the captured secret.
      if (r.observers.length === 0 && !r.extract && !r.steps.some((s: { kind?: string }) => s?.kind === 'evaluate')) {
        throw new Error(`recipe "${sourceId}": canonical browser recipe has no item source (no observers, no evaluate step)`)
      }
      for (const observer of r.observers) {
        if (observer?.kind === 'network') {
          if (!observer.urlPattern || !(observer.windowMs > 0) || !(observer.maxBodyBytes > 0)) {
            throw new Error(`recipe "${sourceId}": network observer requires urlPattern and positive bounds`)
          }
        } else if (observer?.kind === 'state') {
          if (!observer.statePath || !['entry', 'after-step', 'final'].includes(observer.trigger)) {
            throw new Error(`recipe "${sourceId}": state observer requires statePath and trigger`)
          }
          if (observer.collection != null && !['array', 'values', 'single'].includes(observer.collection)) {
            throw new Error(`recipe "${sourceId}": state observer collection must be array, values, or single`)
          }
        } else if (observer?.kind === 'dom') {
          if (!observer.itemSelector || !observer.fields || Object.keys(observer.fields).length === 0) {
            throw new Error(`recipe "${sourceId}": dom observer requires itemSelector and fields`)
          }
        } else throw new Error(`recipe "${sourceId}": unknown observer kind`)
      }
      if (
        !r.output || typeof r.output.itemsAt !== 'string' || typeof r.output.dedupeBy !== 'string' ||
        typeof r.output.targetCount !== 'number' || !r.output.mapping || typeof r.output.mapping !== 'object'
      ) throw new Error(`recipe "${sourceId}": canonical browser recipe requires output mapping`)
      if (r.output.files !== undefined) {
        // 文件字段必须是 mapping 里有的名字，且每条要么 ext 要么 extFrom：声明错了要在装载期响，
        // 不然落盘那一步找不到字段就静默跳过、base64 照样进账本、护栏再把整条 run 打成 error。
        const files = r.output.files
        if (!files || typeof files !== 'object' || Array.isArray(files)) {
          throw new Error(`recipe "${sourceId}": output.files must be an object keyed by mapping field`)
        }
        for (const [field, spec] of Object.entries(files as Record<string, unknown>)) {
          if (!(field in r.output.mapping)) {
            throw new Error(`recipe "${sourceId}": output.files.${field} is not a mapping field`)
          }
          const s = spec as { ext?: unknown; extFrom?: unknown } | null
          const ext = s && typeof s.ext === 'string' && s.ext
          const extFrom = s && typeof s.extFrom === 'string' && s.extFrom
          if (!s || (!ext && !extFrom)) {
            throw new Error(`recipe "${sourceId}": output.files.${field} needs ext or extFrom`)
          }
          if (extFrom && !(extFrom in r.output.mapping)) {
            throw new Error(`recipe "${sourceId}": output.files.${field}.extFrom "${extFrom}" is not a mapping field`)
          }
        }
      }
      if (
        !r.loginCheck || typeof r.loginCheck.loggedIn !== 'string' || !r.loginCheck.loggedIn ||
        typeof r.loginCheck.wall !== 'string' || !r.loginCheck.wall
      ) throw new Error(`recipe "${sourceId}": browser-recipe requires loginCheck.loggedIn and loginCheck.wall strings`)
      // `challenge` 可选，但**声明了就必须是非空字符串**：空串会让 `driver.exists('')` 这种
      // 无意义查询每轮都跑一次，而它的结果既不是"被挑战"也不是"没被挑战"——静默失效的判据
      // 比没有判据更危险（这一条是本仓库反复栽的形状）。
      if (r.loginCheck.challenge !== undefined && (typeof r.loginCheck.challenge !== 'string' || !r.loginCheck.challenge)) {
        throw new Error(`recipe "${sourceId}": loginCheck.challenge must be a non-empty string when present`)
      }
      return r as Recipe
    }
    const harvest = r.harvest
    if (!harvest || typeof harvest !== 'object') {
      throw new Error(`recipe "${sourceId}": browser-recipe requires a harvest object`)
    }
    // 'state' and 'eval' harvests neither scroll nor click (a one-shot SSR read / a
    // self-paced request-client loop), so empty actions is valid (and expected). Every
    // other mode drives the page and needs at least one action.
    const noActionMode = harvest.mode === 'state' || harvest.mode === 'eval'
    if (!Array.isArray(r.actions) || (!noActionMode && r.actions.length === 0)) {
      throw new Error(`recipe "${sourceId}": browser-recipe requires non-empty actions array`)
    }
    validateSteps(sourceId, r.actions)
    validateSecretParams(sourceId, r.meta)
    validateCallBeforeSecrets(sourceId, r.meta, r.actions)
    validateNoEvaluateWithSecrets(sourceId, r.meta, r.actions)
    if (harvest.mode === 'eval') {
      if (
        typeof harvest.call !== 'string' || !harvest.call ||
        typeof harvest.itemsAt !== 'string' || !harvest.itemsAt ||
        typeof harvest.cursorField !== 'string' ||
        typeof harvest.dedupeBy !== 'string' || !harvest.dedupeBy ||
        typeof harvest.targetCount !== 'number' ||
        !harvest.mapping || typeof harvest.mapping !== 'object' || Object.keys(harvest.mapping).length === 0
      ) {
        throw new Error(`recipe "${sourceId}": browser-recipe eval harvest requires call + itemsAt + dedupeBy strings, numeric targetCount, and a non-empty mapping`)
      }
    } else if (harvest.mode === 'state') {
      if (
        typeof harvest.statePath !== 'string' || !harvest.statePath ||
        typeof harvest.dedupeBy !== 'string' ||
        typeof harvest.targetCount !== 'number' ||
        !harvest.mapping || typeof harvest.mapping !== 'object' || Object.keys(harvest.mapping).length === 0
      ) {
        throw new Error(`recipe "${sourceId}": browser-recipe state harvest requires statePath + dedupeBy strings, numeric targetCount, and a non-empty mapping`)
      }
    } else if (harvest.mode === 'dom') {
      if (
        typeof harvest.itemSelector !== 'string' ||
        typeof harvest.dedupeBy !== 'string' ||
        typeof harvest.targetCount !== 'number' ||
        !harvest.fields || typeof harvest.fields !== 'object' || Object.keys(harvest.fields).length === 0
      ) {
        throw new Error(`recipe "${sourceId}": browser-recipe dom harvest requires itemSelector + dedupeBy strings, numeric targetCount, and a non-empty fields map`)
      }
      if (!(harvest.dedupeBy in harvest.fields)) {
        throw new Error(`recipe "${sourceId}": browser-recipe dom harvest dedupeBy "${harvest.dedupeBy}" must be one of fields`)
      }
    } else if (
      typeof harvest.urlPattern !== 'string' ||
      typeof harvest.dedupeBy !== 'string' ||
      typeof harvest.itemsAt !== 'string' ||
      typeof harvest.targetCount !== 'number'
    ) {
      throw new Error(`recipe "${sourceId}": browser-recipe xhr harvest requires urlPattern, dedupeBy, itemsAt strings and numeric targetCount`)
    }
    if (
      !r.loginCheck ||
      typeof r.loginCheck.loggedIn !== 'string' || !r.loginCheck.loggedIn ||
      typeof r.loginCheck.wall !== 'string' || !r.loginCheck.wall
    ) {
      throw new Error(`recipe "${sourceId}": browser-recipe requires loginCheck.loggedIn and loginCheck.wall strings`)
    }
    return r as Recipe
  } else if (r?.kind === 'desktop') {
    // kind:'desktop' — the host-desktop Engine drives a native app via the OS a11y tree.
    // `app.process` 是一个名字或一组候选（跨平台，见 `desktop-recipe.ts` 的 `ProcessMatch`）；
    // 空数组和数组里混进非字符串都拒——那种 recipe 会在活体上以「找不到窗口」失败，真因离现场很远。
    const proc = r.app?.process
    const procOk =
      typeof proc === 'string' ||
      (Array.isArray(proc) && proc.length > 0 && proc.every((p: unknown) => typeof p === 'string' && p.length > 0))
    if (!r.app || (!procOk && typeof r.app.windowClass !== 'string')) {
      throw new Error(`recipe "${sourceId}": desktop recipe requires app.process (a name or a non-empty list of names) or app.windowClass`)
    }
    // `a11y` 是事实申报（见 `RecipeAppMatch.a11y`）。非布尔一律拒：`"no"` / `0` 在下游
    // `?? true` 那一步会被静默当成 true，作者以为关了、其实什么都没变。
    if (r.app.a11y !== undefined && typeof r.app.a11y !== 'boolean') {
      throw new Error(`recipe "${sourceId}": app.a11y 只认 true / false（省略 = true），给的是 ${JSON.stringify(r.app.a11y)}`)
    }
    if (!Array.isArray(r.steps)) {
      throw new Error(`recipe "${sourceId}": desktop recipe requires a steps array`)
    }
    // 写错的值不能静默退回屏幕路——那条路会抢屏，而作者以为自己选的是不抢屏的那条。
    if (r.input !== undefined && r.input !== 'message') {
      throw new Error(`recipe "${sourceId}": input 只认 "message"（省略 = 投给屏幕），给的是 ${JSON.stringify(r.input)}`)
    }
    // 判据只有一份，在 `desktop-recipe.ts`——本机那张 `interrupts.json` 走的是同一组函数
    // （见 `validateSee` 的头注）。这里只负责把 `recipe "<id>": ` 这个前缀拼上去。
    const at = (where: string) => `recipe "${sourceId}": ${where}`
    const areaNames = new Set<string>(r.areas ? Object.keys(r.areas as Record<string, unknown>) : [])
    const referencedAreas = new Set<string>()
    const checkSee = (see: unknown, where: string) => {
      const s = validateSee(see, at(where), { areas: areaNames })
      if (s.area) referencedAreas.add(s.area)
      return s
    }
    /** 会**改变界面状态**的步骤。`focus`/`window`/`branch`/`wait` 不在其中：它们不动界面
     *  （`window` 只是换范围、`branch` 只是读一次状态），没有"做完该看见什么"可言。 */
    const ACTION_STEP_KINDS = new Set(['invoke', 'type', 'click', 'scroll', 'press', 'clear', 'pickFile'])
    /** `params_schema` 声明过的键（参数分支 `when.param` 只认它们）。在 steps 校验前填好。 */
    const declaredParams = new Set<string>()
    const checkTarget = (st: { query?: unknown; see?: unknown }, where: string) => {
      validateTarget(st, at(where), { areas: areaNames })
      // 动作位引用的区域一样算引用——否则一份"只在动作位用了这块区域"的 recipe 会被死区域那道闸拒掉。
      const a = (st.see as { area?: unknown } | undefined)?.area
      if (typeof a === 'string' && a) referencedAreas.add(a)
    }
    /**
     * 一份动作 body（顶层步骤，或 `groundings[]` 里的一条）的 kind 级校验。抽成函数只为一件事：
     * **grounding 必须过和顶层同一套规矩**——两份判据一分家，就会出现「顶层拒、落地方式里放行」
     * 这种静默错位（写 recipe 的人只能靠撞）。`i` 是这一步在 `steps` 里的下标，只有 `branch.skip`
     * 用得上（它要知道跳过之后还剩几步）。
     */
    const checkStepBody = (st: Record<string, unknown>, where: string, i: number, opts: { grounding?: boolean } = {}) => {
      if (!DESKTOP_STEP_KINDS.has(st.kind as string)) {
        throw new Error(`recipe "${sourceId}": ${where}.kind 不认识：${JSON.stringify(st.kind)}（只有 ${[...DESKTOP_STEP_KINDS].join(' / ')}）`)
      }
      // **`branch` 不能当落地方式。** 它是判据（读一次状态、决定跳几步），而判据只住顶层；
      // runner 也只在候选之前评顶层的 branch，一条 `kind:'branch'` 的 grounding 被选中之后
      // 走到的是 `runStep` 那个"不认识的 kind"出口——装载期就拒掉，别留给运行时去撞。
      if (opts.grounding && st.kind === 'branch') {
        throw new Error(`recipe "${sourceId}": ${where} 是 branch——分支是判据不是落地方式，只能写在顶层步骤上`)
      }
      // `click` 的两种写法互斥，比例必须真是比例。写出界的比例（`at: {x: 1.5}`）在运行时换算成
      // 窗口外的一个点，点击照样"成功"发出去、落在别的窗口上——没有任何一处会喊。
      if (st.kind === 'click' && st.at !== undefined) {
        if (st.x !== undefined || st.y !== undefined) {
          throw new Error(`recipe "${sourceId}": ${where} 同时给了 at 和 x/y——按窗口比例点和按坐标点只能占一个`)
        }
        const a = st.at as { x?: unknown; y?: unknown }
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`recipe "${sourceId}": ${where}.at 要是 { x, y }`)
        for (const axis of ['x', 'y'] as const) {
          const v = a[axis]
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
            throw new Error(`recipe "${sourceId}": ${where}.at.${axis} 要是 0..1 的比例（窗口宽/高的几成），给的是 ${JSON.stringify(v)}`)
          }
        }
      }
      // 步骤级的 `press` **只放行 Escape**。Enter 继续禁：回车用 `type` 的 `\n`，别给同一件事
      // 两种写法。而 Escape 没有第二种写法，它是**复位**唯一的手段——桌面应用有状态，上一轮失败
      // 会把界面留在搜索模式之类的样子，下一轮从那儿开跑会一步步"成功"地点在错的东西上
      // （QQ 活体 2026-09-07：搜索框里留着上一轮的字，正文被打进了搜索框）。
      // 这道闸原先一刀切禁掉 press，理由却只讲得通 Enter 那一半——禁令的范围比它的理由宽，
      // 复位就此没了着落。
      // **这不是一份"先例清单"，是一条判据**——要加键先回答它，别照着"Escape 和 Tab 都在
      // 里面"类推：**只放行「改变状态、但不 actuate 任何东西」的键。**
      //
      // 按键和坐标一样**没有收件人**——谁持有焦点谁收下。所以这道闸真正防的不是"某个特定的
      // 键"，是"recipe 能敲任意键"（`Ctrl+W`、`Alt+F4`、`Delete` 全在同一条路上，落到谁身上
      // 取决于当时的焦点）。放行的两个都只挪状态：**Escape** 复位（复位唯一的手段——桌面应用
      // 有状态，上一轮失败会把界面留在搜索模式，下一轮从那儿开跑会一步步"成功"地点在错的
      // 东西上；QQ 活体 2026-09-07：搜索框里留着上一轮的字，正文被打进了搜索框），
      // **Tab** 挪焦点（QQ 活体 2026-09-08：点完会话行焦点停在 `Document`，Tab×6 才走进消息
      // 输入框，而那个空输入框在识别层没有任何靶子可指）。
      //
      // **Enter / 空格这类会触发当前控件的一律不放行**：它们 actuate，而 actuate 的收件人是
      // "此刻碰巧有焦点的那个东西"。Enter 另有 `type "\n"` 那条路，同一件事不给两种写法。
      if (st.kind === 'press' && !PRESSABLE_KEYS.has(String(st.key))) {
        throw new Error(
          `recipe "${sourceId}": ${where} 是 press ${String(st.key)}——步骤里只放行「改变状态但不 actuate」的键` +
            `（今天是 ${[...PRESSABLE_KEYS].join(' / ')}）；回车用 type 的 \\n，别给同一件事两种写法`,
        )
      }
      // `times`：同一个键连按 N 次。**只为一件事存在**——六次 Tab 写成六个步骤，就是六个
      // `blind` 各自讲同一句话，而"6 是怎么来的、怎么重新求"没有一个地方写得下。
      if (st.kind === 'press' && st.times !== undefined) {
        const n = st.times
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PRESS_TIMES) {
          throw new Error(`recipe "${sourceId}": ${where}.times 要是 1..${MAX_PRESS_TIMES} 的整数（防手滑写出 times: 1000）`)
        }
        // 连按的中间态在识别层没有任何可观察变化，硬写 `expect` 只会写出一个恒真的装饰。
        // 和"动作步必须有判据、或说清为什么没有"同一条纪律。
        //
        // **落地方式（grounding）豁免这一条**：判据只住顶层，一条 grounding 自己不许带 `blind`；
        // 而顶层一旦给了 `expect` 就不能再给 `blind`。三条叠起来，一个"顶层有 expect、落地方式是
        // Tab×6"的写法永远装不进去——而那正是这套东西要支持的形状（换了怎么按，做完该看见什么不变）。
        // 判据在顶层，这里不必再问一遍。
        if (n > 1 && st.blind === undefined && !opts.grounding) {
          throw new Error(`recipe "${sourceId}": ${where} 连按 ${n} 次，必须给 blind 说清为什么这一步没有可观察的后果（逐次按键在画面上看不出来）`)
        }
      }
      if (st.kind === 'branch') {
        const w = st.when as { see?: unknown; query?: unknown; param?: unknown; equals?: unknown } | undefined
        const byParam = w?.param !== undefined
        if (byParam) {
          // 参数分支（`DesktopParamCondition`）：不读屏，所以 see / query 一个都不许带——两种判据混在
          // 一条 when 里，成立与否就说不清是谁说了算。`param` 必须是 params_schema 声明过的键：拼错的
          // 分支永远不成立，而表现是"开关没生效、照常发了"。
          if (w!.see !== undefined || w!.query !== undefined) throw new Error(`recipe "${sourceId}": ${where}.when 给了 param 就不能再给 see / query`)
          if (typeof w!.param !== 'string' || !declaredParams.has(w!.param)) throw new Error(`recipe "${sourceId}": ${where}.when.param 要是 params_schema 里声明过的键，给的是 ${JSON.stringify(w!.param)}`)
          const eq = w!.equals
          if (!['string', 'number', 'boolean'].includes(typeof eq)) throw new Error(`recipe "${sourceId}": ${where}.when.equals 只能是字符串 / 数字 / 布尔`)
        } else {
          if (!w || (w.see === undefined) === (w.query === undefined)) throw new Error(`recipe "${sourceId}": ${where}.when 必须恰好给 see 或 query 之一（或按参数分支：param + equals）`)
          if (w.see !== undefined) checkSee(w.see, `${where}.when`)
        }
        const n = st.skip
        // 读屏的分支跳到末尾 = "什么都没做却 ok"，几乎必是写错；参数分支跳到末尾正是它的用途
        // （`send:false` 吃掉最后那一发回车）——见 `DesktopStepKind` 的 branch 头注。
        const maxSkip = byParam ? r.steps.length - 1 - i : r.steps.length - 2 - i
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > maxSkip) {
          throw new Error(`recipe "${sourceId}": ${where}.skip 要是正整数，且${byParam ? '不超出 recipe 末尾' : '跳过之后至少还剩一步'}（现有 ${r.steps.length} 步，这是第 ${i} 步）`)
        }
        // `unverified`：只有参数分支说得通——读屏的分支成立说明状态已经读到了，那不叫"没验"。
        if (st.unverified !== undefined) {
          if (typeof st.unverified !== 'string' || !st.unverified.trim()) throw new Error(`recipe "${sourceId}": ${where}.unverified 要是一句说明为什么这一路没有判据的话`)
          if (!byParam) throw new Error(`recipe "${sourceId}": ${where}.unverified 只对参数分支有意义——读屏的分支成立就是读到了状态，不是没验`)
        }
      }
      if (st.kind === 'pickFile') {
        // `path` 必须是非空字符串（通常是 `{path}` 模板）；`dialog` 借 window 的 match 形状；两个超时都是正数。
        if (typeof st.path !== 'string' || !st.path.trim()) throw new Error(`recipe "${sourceId}": ${where}.path 要是要选的文件路径（通常写成 format:"path" 参数的 {path}）`)
        if (st.dialog !== undefined) {
          const d = st.dialog as Record<string, unknown>
          if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new Error(`recipe "${sourceId}": ${where}.dialog 要是 window 那种 match 对象（process / title / titleAnyOf）`)
          if (d.title !== undefined && typeof d.title !== 'string') throw new Error(`recipe "${sourceId}": ${where}.dialog.title 要是字符串`)
          // 空数组会退化成"任何标题都算"——匹配上主窗自己，然后往主窗的树里找文件名框。
          if (d.titleAnyOf !== undefined && (!Array.isArray(d.titleAnyOf) || d.titleAnyOf.length === 0 || d.titleAnyOf.some((t) => typeof t !== 'string' || !t))) throw new Error(`recipe "${sourceId}": ${where}.dialog.titleAnyOf 要是非空字符串数组`)
        }
        for (const k of ['timeoutMs', 'closeTimeoutMs'] as const) {
          if (st[k] !== undefined && (typeof st[k] !== 'number' || !(st[k] as number > 0))) throw new Error(`recipe "${sourceId}": ${where}.${k} 要是正数（毫秒）`)
        }
      }
      if (st.kind === 'invoke' || st.kind === 'type') checkTarget(st as { query?: unknown; see?: unknown }, where)
      if (st.kind === 'invoke' && st.query === undefined && st.see === undefined) throw new Error(`recipe "${sourceId}": ${where} invoke 要给 query 或 see`)
      for (const slot of ['expect', 'require'] as const) {
        if (st[slot] === undefined) continue
        const ex = st[slot] as { see?: unknown; query?: unknown; fresh?: unknown }
        if ((ex.see === undefined) === (ex.query === undefined)) throw new Error(`recipe "${sourceId}": ${where}.${slot} 必须恰好给 see 或 query 之一`)
        if (ex.see !== undefined) checkSee(ex.see, `${where}.${slot}`)
        // `fresh`：只有 `expect` 有"动作前 / 动作后"两帧可比；`require` 是"此刻必须为真"，没有前一帧。
        // 只认文字目标——它比的是文字表里的位置，控件树查询和图标都没有这张清单。
        if (ex.fresh !== undefined) {
          if (ex.fresh !== true) throw new Error(`recipe "${sourceId}": ${where}.${slot}.fresh 只能写 true（不要就别写）`)
          if (slot !== 'expect') throw new Error(`recipe "${sourceId}": ${where}.require 不能带 fresh——前置条件只有"此刻"一帧，没有"动作前"可比`)
          if (typeof (ex.see as { text?: unknown } | undefined)?.text !== 'string') throw new Error(`recipe "${sourceId}": ${where}.expect.fresh 只配 see.text（比的是文字的位置）`)
        }
      }
      if (st.else !== undefined && !ELSE_VALUES.includes(st.else as Else)) {
        throw new Error(`recipe "${sourceId}": ${where}.else 只认 drift / retry / abort，给的是 ${String(st.else)}`)
      }
      // **动作步骤必须说清"做完该看见什么"**：给 `expect`，或者写 `blind` 说明为什么这一步
      // 没有可观测的后果。二选一，装载期强制。
      //
      // 「我点了一个东西，接下来就该看见某个东西」本来就是这条链路的基础规则，只是此前是**可选**
      // 的——量过一次：21 个动作步里 18 个没写（2026-09-07）。规则写在文档里、没人守，因为不守
      // 也不会有任何提示；代价是点空了要拖到两三步之后才以别的面目冒出来。逼这一句，是把
      // "忘了写"和"想过、确实没有"分开——后者是合法的（有些转移在某个后端上真的看不见），
      // 前者不是。
      if (ACTION_STEP_KINDS.has(st.kind as string) && !st.expect && !st.blind) {
        throw new Error(`recipe "${sourceId}": ${where}（${st.kind}${st.label ? ` ${st.label}` : ''}）是动作步骤，必须给 expect（做完该看见什么），或者给 blind 说明为什么这一步没有可观测的后果`)
      }
      if (st.blind !== undefined && (typeof st.blind !== 'string' || !st.blind.trim())) {
        throw new Error(`recipe "${sourceId}": ${where}.blind 要是一句说明为什么没有可观测后果的话`)
      }
      if (st.blind !== undefined && st.expect !== undefined) {
        throw new Error(`recipe "${sourceId}": ${where} 同时给了 expect 和 blind——"有判据"和"没有判据"只能占一个`)
      }
    }
    // `label` 从"出错时怎么跟人说"升级成**这一步的键**：本机 override 与贡献回来的落地方式都按它
    // 认人。没有它，一条 override 只能按下标认步——而下标会随着 recipe 多插一步整体错位，表现是
    // 一份"还能装载、只是点错地方"的 recipe，没有任何一处会喊。
    // 具名区域（spec §3.4）：一块区域只描述"看哪儿"，所以 grounding 的 body 只许有 `region`。
    if (r.areas !== undefined) {
      if (typeof r.areas !== 'object' || r.areas === null || Array.isArray(r.areas)) throw new Error(`recipe "${sourceId}": areas 要是 { 名字: 区域 } 的对象`)
      for (const [name, a] of Object.entries(r.areas as Record<string, Record<string, unknown>>)) {
        const aw = `areas.${name}`
        if (!name.trim()) throw new Error(`recipe "${sourceId}": areas 里有空名字`)
        if (typeof a !== 'object' || a === null) throw new Error(`recipe "${sourceId}": ${aw} 要是对象`)
        if (a.intent !== undefined && typeof a.intent !== 'string') throw new Error(`recipe "${sourceId}": ${aw}.intent 要是字符串`)
        if (a.region !== undefined) validateSee({ text: '_', region: a.region }, at(aw))   // 借 validateSee 的 region 判据，别再写一份
        if (a.groundings !== undefined) {
          if (!Array.isArray(a.groundings)) throw new Error(`recipe "${sourceId}": ${aw}.groundings 要是数组`)
          a.groundings.forEach((g: Record<string, unknown>, gi: number) => {
            const gw = `${aw}.groundings[${gi}]`
            validateGroundingKey(sourceId, g.on, gw)
            for (const k of Object.keys(g)) if (!GROUNDING_META_KEYS.includes(k) && !AREA_BODY_KEYS.includes(k)) throw new Error(`recipe "${sourceId}": ${gw} 带了 ${k}——区域的落地方式只许有 region`)
            if (g.region === undefined) throw new Error(`recipe "${sourceId}": ${gw} 要给 region`)
            validateSee({ text: '_', region: g.region }, at(gw))
          })
        }
        if (a.region === undefined && !(Array.isArray(a.groundings) && a.groundings.length > 0)) throw new Error(`recipe "${sourceId}": ${aw} 要有 region 或 groundings 之一（空区域什么都罩不住）`)
      }
    }
    const labels = new Set<string>()
    const schema = (r.meta?.params_schema as Record<string, { format?: unknown } | undefined> | undefined) ?? {}
    const paramNames = Object.keys(schema)
    for (const k of paramNames) {
      declaredParams.add(k)
      // `format:'path'` 的参数在执行前派生出 `_name` / `_stem6` / `_ext` / `_kind`（`materializeParams`）：
      // 按扩展名分流的 `branch` 要指向它们，名单与派生处同一份（`path-params.ts`）。
      if (schema[k]?.format === 'path') for (const d of pathDerivedKeys(k)) declaredParams.add(d)
    }
    r.steps.forEach((st: Record<string, unknown>, i: number) => {
      const where = `steps[${i}]`
      if (typeof st.label !== 'string' || !st.label.trim()) throw new Error(`recipe "${sourceId}": ${where} 要有 label——本机 override 与贡献物都拿它当这一步的键`)
      if (labels.has(st.label)) throw new Error(`recipe "${sourceId}": ${where} 的 label 重复：「${st.label}」`)
      labels.add(st.label)
      checkStepBody(st, where, i)
      if (st.groundings !== undefined) {
        if (!Array.isArray(st.groundings)) throw new Error(`recipe "${sourceId}": ${where}.groundings 要是数组`)
        st.groundings.forEach((g: Record<string, unknown>, gi: number) => {
          const gw = `${where}.groundings[${gi}]`
          validateGroundingKey(sourceId, g.on, gw)
          for (const k of STEP_TOP_ONLY_KEYS) if (g[k] !== undefined) throw new Error(`recipe "${sourceId}": ${gw} 带了 ${k}——它只能在顶层（判据与落地方式无关）`)
          // body 过和顶层同一套 kind 校验；顶层的 expect / blind 借给它，免得"动作步必须有 expect 或 blind"那条在这儿误报
          checkStepBody({ ...groundingBody(g), ...(st.expect !== undefined ? { expect: st.expect } : {}), ...(st.blind !== undefined ? { blind: st.blind } : {}) }, gw, i, { grounding: true })
          assertTemplatesKept(st, g, paramNames, `recipe "${sourceId}": ${gw}`)
        })
      }
    })
    // 条件边本期只校验形状、不执行（runner 在跑任何一步之前就以 `edges-unsupported` 判 drift）。先把格式钉住，
    // 免得本机 override 与包各写各的，到真要执行那天有两份互不兼容的存量。
    if (r.edges !== undefined) {
      if (!Array.isArray(r.edges)) throw new Error(`recipe "${sourceId}": edges 要是数组`)
      r.edges.forEach((e: Record<string, unknown>, ei: number) => {
        const ew = `edges[${ei}]`
        if (typeof e.from !== 'string' || !labels.has(e.from)) throw new Error(`recipe "${sourceId}": ${ew}.from 指向不存在的步骤：${JSON.stringify(e.from)}`)
        validateGroundingKey(sourceId, e.on, ew)
        if (!Array.isArray(e.insert)) throw new Error(`recipe "${sourceId}": ${ew}.insert 要是步骤数组`)
        // 插进去的步骤和主 steps 一样是步骤：同一套 kind 校验、同样要有 label。**label 只在这条边
        // 内部唯一**，不和主 steps 比——插进来的那几步是这条边自己的东西，撞名的是它自己的账。
        const inserted = new Set<string>()
        e.insert.forEach((ins: Record<string, unknown>, ii: number) => {
          const iw = `${ew}.insert[${ii}]`
          if (typeof ins.label !== 'string' || !ins.label.trim()) throw new Error(`recipe "${sourceId}": ${iw} 要有 label——插进来的也是步骤`)
          if (inserted.has(ins.label)) throw new Error(`recipe "${sourceId}": ${iw} 的 label 重复：「${ins.label}」`)
          inserted.add(ins.label)
          checkStepBody(ins, iw, ii)
        })
      })
    }
    if (r.interrupts !== undefined) {
      if (!Array.isArray(r.interrupts)) throw new Error(`recipe "${sourceId}": interrupts 必须是数组`)
      r.interrupts.forEach((it: unknown, i: number) => {
        const parsed = validateInterrupt(it, at(`interrupts[${i}]`), { areas: areaNames })
        if (parsed.see.area) referencedAreas.add(parsed.see.area)
        if (parsed.dismiss.kind === 'invoke' && parsed.dismiss.see?.area) referencedAreas.add(parsed.dismiss.see.area)
      })
    }
    for (const name of areaNames) if (!referencedAreas.has(name)) throw new Error(`recipe "${sourceId}": areas.${name} 没有任何 see 引用——死区域比没有更坏（读的人以为它在生效）`)
    // observer/read 是**采集型**的必填项。动作型（`allowEmpty`）整个省掉它们——判据必须和
    // runner 那一处**同口径**，否则会出现"类型允许、装载拒绝"的两套规矩，而写 recipe 的人
    // 只能靠撞。省掉它们的唯一合法理由就是 allowEmpty，所以这里也只放行这一档。
    const actionOnly = r.allowEmpty === true && r.observer === undefined && r.read === undefined
    if (!actionOnly) {
      if (
        !r.observer || typeof r.observer.itemQuery !== 'object' ||
        !r.observer.fields || typeof r.observer.fields !== 'object' || Object.keys(r.observer.fields).length === 0 ||
        typeof r.observer.dedupeBy !== 'string'
      ) {
        throw new Error(`recipe "${sourceId}": desktop recipe requires observer with itemQuery, non-empty fields, and dedupeBy (or allowEmpty with neither observer nor read)`)
      }
      if (!r.read || typeof r.read.dedupeBy !== 'string' || typeof r.read.targetCount !== 'number') {
        throw new Error(`recipe "${sourceId}": desktop recipe requires read.dedupeBy and numeric read.targetCount`)
      }
    }
    // map（可选）：抽字段的正则**必须在装载时就编译**。留到运行期才炸，表现是"这一轮什么都没抽到"
    // ——和"页面变了、抽取规则不匹配了"长得一模一样，会把一个打字错误伪装成源站漂移。
    if (r.map !== undefined) {
      if (typeof r.map !== 'object' || r.map === null || Array.isArray(r.map)) {
        throw new Error(`recipe "${sourceId}": desktop recipe map must be an object of { from, match }`)
      }
      for (const [field, rule] of Object.entries(r.map as Record<string, unknown>)) {
        const rr = rule as { from?: unknown; match?: unknown }
        if (typeof rr?.from !== 'string' || !rr.from || typeof rr?.match !== 'string' || !rr.match) {
          throw new Error(`recipe "${sourceId}": desktop recipe map.${field} requires non-empty from and match strings`)
        }
        try {
          new RegExp(rr.match)
        } catch (e) {
          throw new Error(`recipe "${sourceId}": desktop recipe map.${field}.match is not a valid regex — ${(e as Error).message}`)
        }
      }
    }
    return r as Recipe
  } else {
    throw new Error(`recipe "${sourceId}": kind must be "http", "html", "fetch", "browser" or "desktop"`)
  }
}

/**
 * Every key a `session` block may carry. Anything else is a typo.
 *
 * `transport` is on this list even though `RecipeSessionSpec` no longer HAS that field: the
 * runtime stopped choosing browsers (see rejectRetiredTransport), but recipes written while it
 * did still say `"transport": "ext-cdp"`, and those are correct-by-accident, not broken. Keep
 * accepting it as a no-op — do NOT delete it from this set to "match the type", or every such
 * recipe fails to load with "unknown session key".
 */
const SESSION_KEYS = new Set(['facility', 'laneKey', 'lifecycle', 'visibility', 'transport', 'keepAlive'])

/**
 * Reject unknown keys in `session` — same rule as the removed camouflage fields below: accepting
 * then ignoring a key silently changes a trusted recipe's behavior.
 *
 * This one bites hardest on `laneKey`, because ignoring it FAILS QUIETLY AND PLAUSIBLY. A recipe
 * that meant `laneKey: 'detail'` but wrote `laneKye` gets no error — it lands on the facility's
 * DEFAULT lane and starts driving the tab some other recipe is riding. Nothing throws; the harvest
 * just gets strange (the feed gets navigated away mid-scroll, ledgers stop matching) and you go
 * hunting in the wrong place. `laneKey` is exactly one 'e'-transposition away from silently
 * meaning its opposite, and unlike a bad `facility` there is no downstream check to catch it.
 */
function validateSessionKeys(sourceId: string, session: Record<string, unknown>): void {
  for (const key of Object.keys(session)) {
    if (!SESSION_KEYS.has(key)) {
      throw new Error(
        `recipe "${sourceId}": unknown session key "${key}" — 认得的只有 ${[...SESSION_KEYS].join(' / ')}（打错的键会被静默忽略，所以这里拒绝）`,
      )
    }
  }
}

/**
 * `ledger` 声明的是"这份 recipe 的产出同时也是一本有序账本"（见 RecipeLedger）。写错就静默失效，
 * 而失效的表现是**下游的 detail 每次都掉进 fallback-nav**——出得来数据、不报错，只是定位早就
 * 全线崩了。所以在装载时拒绝，别留给运行期。
 */
function validateLedger(sourceId: string, r: Record<string, unknown>): void {
  const ledger = r.ledger
  if (ledger === undefined) return
  const idField = (ledger as { idField?: unknown } | null)?.idField
  if (!ledger || typeof ledger !== 'object' || typeof idField !== 'string' || !idField) {
    throw new Error(`recipe "${sourceId}": ledger 需要非空的 idField（产出里哪个字段是身份）`)
  }
}

/** Reject removed camouflage fields explicitly: accepting then ignoring them would
 * silently change a trusted browser recipe's behavior. */
function validateSteps(sourceId: string, steps: unknown[]): void {
  for (const [stepIndex, step] of steps.entries()) {
    if (!step || typeof step !== 'object') continue
    if ('humanize' in step) {
      throw new Error(`recipe "${sourceId}": step.humanize was removed; use explicit task steps and pacing instead`)
    }
    const s = step as { kind?: string; call?: unknown; itemsAt?: unknown; expect?: Record<string, unknown> }
    if (s.kind === 'evaluate' && (typeof s.call !== 'string' || !s.call || typeof s.itemsAt !== 'string' || !s.itemsAt)) {
      throw new Error(`recipe "${sourceId}": evaluate step requires a non-empty call and itemsAt`)
    }
    if (s.kind === 'setFiles') {
      const f = step as { selector?: unknown; paths?: unknown }
      if (typeof f.selector !== 'string' || !f.selector || typeof f.paths !== 'string') {
        throw new Error(`recipe "${sourceId}": setFiles step 需要非空的 selector 和字符串 paths（通常是 "{files}"）`)
      }
    }
    if (s.expect !== undefined) {
      const e = s.expect
      if (!e || typeof e.selector !== 'string' || !e.selector) {
        throw new Error(`recipe "${sourceId}": step.expect 需要非空的 selector`)
      }
      if (e.state !== undefined && e.state !== 'present' && e.state !== 'gone') {
        throw new Error(`recipe "${sourceId}": step.expect.state 只能是 "present" 或 "gone"`)
      }
      // 数量变多本身已经蕴含"出现了"，两个一起声明说的是两件事，运行期只能挑一件干 ——
      // 那就是"收下了却不生效"的字段，装载期直接拒。
      if (e.countIncreases !== undefined && e.state !== undefined) {
        throw new Error(
          `recipe "${sourceId}": step.expect 的 countIncreases 与 state 互斥 —— 数量变多已经蕴含"出现了"`,
        )
      }
      if (e.countIncreases !== undefined && e.alreadyThere) {
        throw new Error(
          `recipe "${sourceId}": step.expect 的 countIncreases 与 alreadyThere 互斥 —— countIncreases 本来就是` +
            `"元素本来就在、要等它变多"的正解，用不着再关掉恒真闸门`,
        )
      }
      // locate / openTarget 支持 expect（跑在它们各自的内建确认之后、observers 读之前），但**不支持
      // retryEvery**，而且必须在这里就报错、不能静默忽略 —— 一个"收下了却不生效"的字段正是这次要修
      // 的那个坑，静默忽略等于把它原样复制一份。理由是重复且昂贵：两者各自已经有自己的重试机制。
      if (e.retryEvery !== undefined && (s.kind === 'locate' || s.kind === 'openTarget')) {
        throw new Error(
          `recipe "${sourceId}": step.expect.retryEvery 不支持 ${s.kind} 步骤 —— 它已经有自己的重试（` +
            (s.kind === 'locate'
              ? 'locate 失败会回落 fallbackUrl；重做一次 locate = 重新滚动定位 + 一次拟人点击，是这条路径的耗时大头'
              : 'openTarget 自带 maxScrolls 重试循环') +
            `），再叠一层重做是重复且昂贵的。要放宽只调 expect.timeout`,
        )
      }
      // retryEvery 会把动作**整个重做一遍**。scroll/openItems 自带循环与 dwell，重做等于把它们
      // 跑第二遍（多滚一屏、多开几条），那不是重试，是静默地改变了这一步做的事。
      if (e.retryEvery !== undefined && s.kind !== 'click' && s.kind !== 'type') {
        throw new Error(
          `recipe "${sourceId}": step.expect.retryEvery 只能用在 click / type 上（这一步是 ${s.kind}）—— 重做一次有副作用的动作不叫重试`,
        )
      }
      // 重试搬去了步骤层（见 RecipeAction.retryFrom 头注）。留在 expect 里的那两个键必须
      // **显式拒**、不能静默忽略：一份照着旧写法写的 recipe 会在"重试从没生效"的情况下
      // 一路跑绿，而那恰恰就是这次要修的病。
      for (const moved of ['retryFrom', 'retryTimes'] as const) {
        if (e[moved] !== undefined) {
          throw new Error(
            `recipe "${sourceId}": step#${stepIndex} 的 expect.${moved} 已经搬到步骤这一层 —— ` +
              `写成 { kind: …, ${moved}: … }，别写在 expect 里。重试管的是"这一步失败了怎么办"，` +
              `而失败有两种（expect 没满足 / call 的结果不合格），后一种没有 expect 可挂`,
          )
        }
      }
    }
    validateStepRetry(sourceId, stepIndex, step as Record<string, unknown>)
    validateCallOptions(sourceId, stepIndex, step as Record<string, unknown>)
    // `position` 是"点元素盒子里的哪个像素"，而页内 `el.click()` 根本没有坐标这回事。
    // 两个一起写 = 有一个不生效，而且不生效的那个还恰好是有活体理由才写上去的那个
    // （Turnstile 的复选框在最左边，点中心会落在文字上）。装载期拒。
    if (s.kind === 'click' && (s as { synthetic?: unknown }).synthetic && (s as { position?: unknown }).position) {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 同时给了 click.synthetic 和 click.position —— ` +
          `页内 el.click() 没有坐标可言，position 会被静默忽略。要按坐标点就别开 synthetic`,
      )
    }
  }
}

/**
 * 步骤层的 `retryFrom` / `retryTimes`。
 *
 * **必须指向更早的步**：指向自己或后面的步会让游标原地打转或往前跳，而那不是"重来"，
 * 是一个静默的死循环 / 乱序执行。装载期拒，别等运行期。
 */
function validateStepRetry(sourceId: string, stepIndex: number, s: Record<string, unknown>): void {
  const from = s.retryFrom
  if (from !== undefined) {
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from >= stepIndex) {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 的 retryFrom=${String(from)} 必须是 0…${stepIndex - 1} ` +
          `之间的整数 —— 它是"回到更早那一步重走"，指向自己或后面的步会变成原地打转`,
      )
    }
    if (s.retryTimes === undefined) {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 声明了 retryFrom 就必须给 retryTimes ` +
          `—— 不给次数上限等于把重试次数交给 timeout 决定，而每一次重来都是一次真的动作`,
      )
    }
  }
  const times = s.retryTimes
  if (times !== undefined) {
    if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
      throw new Error(`recipe "${sourceId}": step#${stepIndex} 的 retryTimes 必须是 ≥1 的整数`)
    }
    if (from === undefined) {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 给了 retryTimes 却没有 retryFrom —— 收下一个不生效的字段正是这里在防的事`,
      )
    }
  }
}

/**
 * `call.options`：**只许字面量**。
 *
 * 这是 `call` 那一格第 2 条边界的延长线（见 `recipe.ts`）：`options` 存在的意义是"让通用
 * 服务换个档位跑"，一旦它能引用参数袋，一条第三方 recipe 就能写 `{ note: "{jymm}" }` 把
 * 宿主注入的交易密码送到它点名的服务去——而那条 recipe 在安装预览里跟现在长得一模一样。
 * 引擎侧本来就不对 `options` 做插值，这道闸是把"不插值"从一个实现细节变成一条**说出来的
 * 契约**：写了 `{…}` 就当场拒，而不是让它带着一对没被替换的花括号安静地发出去。
 */
function validateCallOptions(sourceId: string, stepIndex: number, s: Record<string, unknown>): void {
  if (s.kind !== 'call' || s.options === undefined) return
  const opts = s.options
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error(`recipe "${sourceId}": step#${stepIndex} 的 call.options 必须是一个对象`)
  }
  for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
    if (k === 'image') {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 的 call.options 不许有 "image" —— 送什么图归 input.shotOf 管，` +
          `在这儿再写一个只会静默盖掉它`,
      )
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 的 call.options.${k} 只能是字符串 / 数字 / 布尔`,
      )
    }
    if (typeof v === 'string' && /\{[A-Za-z_][\w]*\}/.test(v)) {
      throw new Error(
        `recipe "${sourceId}": step#${stepIndex} 的 call.options.${k} 里有 {参数} —— options 只收字面量，` +
          `引擎不对它做插值。参数袋里装着宿主注入的凭据，能引用它就等于给了一条外泄路`,
      )
    }
  }
}

/**
 * `extract` 写的是**凭据存储**，所以它的守卫钉在装载点 —— 也就是一份共享 recipe 被审查的那一刻，
 * 而不是等到运行时静默变成空操作。三条都不放过：字段名要有、正则要能编译、**目标槽必须是这份
 * recipe 自己 `meta.runtime_config` 里声明成 `secret` 的那一个**。最后一条是要害：抽取只能填进
 * 自己声明过的 secret 槽，不能凭空往凭据存储里塞一个键，也不能借道别的字段类型。
 */
/**
 * `meta.secret_params` 的装载期闸门——**四道判据在这一处判完**，不散落在运行期。
 *
 * 为什么全放装载期：这四条全是 recipe 的**静态性质**，一份 recipe 要么合法要么不合法，
 * 跟这次跑什么无关。装载期拒 = 那份 recipe 根本进不来，错误指名道姓；留到运行期 = 一条
 * 会外泄的 recipe 安安静静躺在盘上，等哪天真跑到那一步才炸（或者更糟，不炸）。
 *
 * 第 3 条（只给内置包）不在这里——它判的是**这份 recipe 从哪来**，装载器才知道，
 * 见注入那一侧（`session-recipe-executor.ts`）。这里判的是 recipe 自己说了什么。
 */
export function validateSecretParams(sourceId: string, meta: any): void {
  const names: unknown = meta?.secret_params
  if (names === undefined) return
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !n)) {
    throw new Error(`recipe "${sourceId}": meta.secret_params 必须是非空字符串的数组`)
  }
  if (names.length === 0) return

  // 闸 1 + 2：只能读自己那一格，且字段必须已声明为 secret。和写那一侧（validateExtract）
  // 同一条规矩、同一份声明——不能凭空点一个名字进凭据存储，也不能凭空点一个名字出来。
  const spec = meta?.runtime_config
  if (!spec?.ref || !spec?.fields) {
    throw new Error(
      `recipe "${sourceId}": 声明了 secret_params 就必须有自己的 meta.runtime_config（ref + fields）——` +
      `凭据只能从这份 recipe 自己那一格读，recipe 运行期没有办法指名去读别处的配置`,
    )
  }
  for (const name of names as string[]) {
    if (spec.fields[name]?.type !== 'secret') {
      throw new Error(
        `recipe "${sourceId}": secret_params 的 "${name}" 必须在自己的 meta.runtime_config.fields 里` +
        `声明为 type:"secret" —— 不能凭空点一个字段名把值取出来`,
      )
    }
  }
}

/**
 * 闸 4：**`call` 只能出现在任何用到 secret 参数的步骤之前。**
 *
 * 要挡的外泄链是有方向的：读出凭据 → 打进一个**可见**输入框 → `call` 那一块的截图 →
 * 值离开这台机器。注意它必须**先**把凭据弄上页面，`call` 才偷得到东西。所以判据是次序，
 * 不是"两格互斥"。
 *
 * **为什么不是互斥**（这一条是改过的，理由记下来免得有人改回去）：互斥会逼出一个畸形形状。
 * 真实的登录流程恰好是反方向的——验证码必须**先**认出来（`call`）才填得了表，凭据是**之后**
 * 才上页面的。一刀切互斥就把这条唯一合理的次序也否了，逼人把一次登录拆成两条 recipe 协同，
 * 而拆出来的两条各自都更难读、更难验，安全上一分钱也没多买到。
 *
 * 判"用到 secret"的口径：这一步的**会被参数替换的那些字段**里出现了 `{某个 secret 名}`。
 * 今天只有两处会替换（`goto.url` / `type.text`，见 `actions.ts` 的 `substitute` 调用点）——
 * **加了新的替换点，这里要跟着加**，否则会漏判成"没用到凭据"而放行后面的 `call`。
 *
 * 纵深里的位置：闸 3 已经把 secret 限死在内置包，所以这一闸防的是**我们自己写错次序**，
 * 不是防第三方。那正好也是它该有的力度——不该贵到把唯一合理的流程也挡掉。
 */
/**
 * 闸 5：**拿得到凭据的 recipe，不许有 `evaluate` 步骤。**
 *
 * `evaluate` 会把**整个参数袋 `JSON.stringify` 进一段在页面里执行的表达式**
 * （`recipe-runner.ts` 的 `runEvaluateStep`：`(${step.call})(cursor, pageSize, ${JSON.stringify(params)})`）。
 * 注入的凭据一旦进了参数袋，就会随之进入站点自己的 JS 上下文——站点的任何脚本都读得到。
 * 这不是"理论上"，是那一行代码今天的行为。
 *
 * **为什么是静态禁而不是运行期过滤**：过滤（把 secret 从传给 evaluate 的那份里剔掉）要求
 * 每一个将来把 params 递出去的地方都记得剔一次，而漏掉一处不会有任何东西报错。装载期禁掉是
 * fail-closed 的那一侧：两样都要的那天，改法是**显式**给 evaluate 过滤参数并在这里放行，
 * 那时理由会被写下来。
 *
 * 顺带一提这条为什么是接线时才发现的：闸 4 盯的是 `call`（我自己加的那一格），而这条泄漏在
 * 一个**早就存在**的步骤里。**加一格能拿到凭据的能力，要回头扫的是"谁会把参数袋递出去"**，
 * 不只是自己刚加的那一格。
 */
function validateNoEvaluateWithSecrets(sourceId: string, meta: any, steps: unknown[]): void {
  const names = meta?.secret_params
  if (!Array.isArray(names) || names.length === 0) return
  const at = steps.findIndex((s) => (s as { kind?: string })?.kind === 'evaluate')
  if (at >= 0) {
    throw new Error(
      `recipe "${sourceId}": secret_params 与 evaluate 步骤不能共存（step#${at}）。` +
      `evaluate 会把整个参数袋序列化进页面里执行的表达式，注入的凭据会随之落进站点自己的 JS 上下文。`,
    )
  }
}

function validateCallBeforeSecrets(sourceId: string, meta: any, steps: unknown[]): void {
  const names = meta?.secret_params
  if (!Array.isArray(names) || names.length === 0) return
  const holes = new Set((names as string[]).map((n) => `{${n}}`))
  let secretOnPageAt: number | null = null
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as { kind?: string; url?: unknown; text?: unknown }
    // 会被 substitute 处理的字段，逐个看有没有引用 secret 名字
    const substituted = [s?.url, s?.text].filter((v): v is string => typeof v === 'string')
    if (secretOnPageAt === null && substituted.some((v) => [...holes].some((h) => v.includes(h)))) {
      secretOnPageAt = i
      continue
    }
    if (secretOnPageAt !== null && s?.kind === 'call') {
      throw new Error(
        `recipe "${sourceId}": step#${i} 的 call 排在 step#${secretOnPageAt}（用到了 secret 参数）之后。` +
        `凭据一旦上了页面，后面再 call 就是「打进可见输入框 → 截图送出去」那条外泄链——` +
        `把 call 挪到所有用到 {secret} 的步骤之前（登录这类流程天然就是这个次序：先认验证码，再填表）。`,
      )
    }
  }
}

function validateExtract(sourceId: string, r: any): void {
  const e = r.extract
  if (e === undefined) return
  if (!e || typeof e.field !== 'string' || !e.field || typeof e.pattern !== 'string' || !e.pattern) {
    throw new Error(`recipe "${sourceId}": extract 需要非空的 field 与 pattern`)
  }
  try {
    new RegExp(e.pattern)
  } catch (error) {
    throw new Error(`recipe "${sourceId}": extract.pattern 不是合法正则（${error instanceof Error ? error.message : String(error)}）`)
  }
  // 与 `provisionedConfigSlot`（`recipe-provisioner.ts`）同一条规则的两个角色：这里是**装载期
  // 的强制**（不合规就拒收，响亮），那边是**运行期的查询**（合规就报出它填哪一格，用来绑 sink
  // 和点亮界面上那颗一键按钮）。放宽这里等于放宽那边——改之前先去看它的头注。
  const declared = r.meta?.runtime_config?.fields?.[e.field]
  if (declared?.type !== 'secret') {
    throw new Error(
      `recipe "${sourceId}": extract.field "${e.field}" 必须在 meta.runtime_config.fields 里声明为 type:"secret" —— 抽取只能写自己声明过的 secret 槽`,
    )
  }
  // 第四条：`from.network` 的 glob 本身要能用。**不要求 recipe 另外声明一个 network observer**
  // ——引擎按这个 glob 自己挂一份「只捕获、不累积」的观察（`ObserverPipeline` 的 `secretCapture`）。
  //
  // 这条守卫曾经是反过来的：强制 recipe 声明一个同 glob 的 observer。那个耦合本身就是错的——
  // 凭证不是 item，那个 observer 一旦进 items 管线，它抓到的响应就会被空 output 判成 malformed
  // → drift，而 drift 优先级高于 allowEmpty，于是它**盖住 extract 的真实结论**（活体
  // zhipu-create-key：`1 out of 1 responses were malformed`，抽取到底有没有拿到 key 完全看不见）。
  const fromNetwork = e.from?.network
  if (fromNetwork !== undefined && (typeof fromNetwork !== 'string' || !fromNetwork)) {
    throw new Error(`recipe "${sourceId}": extract.from.network 必须是非空的 URL glob`)
  }
}

/** Load `<dir>/<sourceId>.json`, parse, and validate the recipe shape. */
/**
 * Store backed by the mounted package map, with an optional fallback store
 * (e.g. the legacy file store) consulted for sourceIds no package provides.
 */
export function makeRecipePackageStore(recipes: Map<string, Recipe> | (() => Map<string, Recipe>), fallback?: RecipeStore): RecipeStore {
  const current = typeof recipes === 'function' ? recipes : () => recipes
  return {
    load(sourceId: string): Recipe {
      const hit = current().get(sourceId)
      if (hit) return hit
      if (fallback) return fallback.load(sourceId)
      throw new Error(`no recipe package provides source "${sourceId}" (and no fallback store configured)`)
    },
  }
}

export function makeFileRecipeStore(dir: string): RecipeStore {
  return {
    load(sourceId: string): Recipe {
      const path = join(dir, `${sourceId}.json`)
      let text: string
      try {
        text = readFileSync(path, 'utf-8')
      } catch {
        throw new Error(`recipe not found for source "${sourceId}" (${path})`)
      }
      return validate(sourceId, JSON.parse(text))
    },
  }
}
