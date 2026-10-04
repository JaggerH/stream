import { z } from 'zod'
import { manifestSchema } from '../manifest/loader.ts'
import { PICK_SURFACES, type SourceManifest } from '../manifest/types.ts'
import type { Recipe } from './recipe.ts'
import { namespacedSourceId } from '../registry/source-id.ts'
import { provisionedConfigSlot } from './recipe-provisioner.ts'

/**
 * Shape guard for a recipe's optional `meta` block. All fields optional (a bare
 * recipe carries no meta at all); a malformed meta fails loud at load naming the
 * source. `auth` is left loose here — the final manifestSchema.parse validates it,
 * so auth has ONE validator, not two. Non-strict: an unknown key is ignored (it
 * just doesn't reach the manifest), never a crash.
 */
const recipeMetaSchema = z.object({
  title: z.string().optional(),
  normalizer: z.string().optional(),
  provides: z.array(z.string()).optional(),
  /** 见 `RecipeMeta.uses`：这个 Source 依赖哪些别的 Source（同包内写局部名）。 */
  uses: z.array(z.string().min(1)).optional(),
  homepage: z.string().optional(),
  /**
   * 副作用声明。缺省 = 只读。安装 preview 逐格亮牌（`recipe-install.ts`）。
   *
   * - `'write'` 会写用户账户（点赞/收藏/转存…）
   * - `'send'`  会把**页面上某个元素那一块的截图**发给本包声明的后端服务（`call` 步骤）。
   *
   * **effect 名按「用户担什么」起，不跟步骤名走。** 步骤叫 `call` 是说*你做什么*；而这张牌是
   * 装它的人在决定要不要装时读的，他要知道的是*后果*——所以叫 `send`（东西会离开这台机器），
   * 和 `write`（账户会被改）同一个语域。`write` 本来也不对应任何一个叫 write 的步骤。
   */
  effects: z.array(z.enum(['write', 'send'])).optional(),
  /** 这一条 recipe 自己的频率闸，叠在 facility 那道之上（见 `RecipeMeta.rateLimit`）。给写腿用：
   *  同一个站点上，上架/发送这类动作的安全速率比读腿低一个数量级。
   *
   *  **它不进合成出来的 SourceManifest**——闸门是执行器直接从 canonical recipe 的 `meta` 上读的
   *  （`session-recipe-executor.ts`），走 manifest 反而要拿局部名去查一份装着全名的集合（那正是
   *  这个文件里 `namespacedSourceId` 存在的理由，也是执行器注释里记着的那个"恒为 false"的坑）。
   *  这一格留在这儿只干一件事：**装载期把写错的形状当场拒掉**，别让它静默变成"没声明"。 */
  rateLimit: z
    .object({
      burst: z.number().int().positive(),
      perMinute: z.number().positive(),
      perHour: z.number().positive().optional(),
      maxWaitMs: z.number().int().positive().optional(),
      /** 几条写腿共用一个桶的桶名（见 `FacilityRateLimit.bucket`）：站点数的是账号一小时写了几次，不分动作。 */
      bucket: z.string().min(1).optional(),
    })
    .optional(),
  /** 权限开关——只有这一格为 `true` 的 recipe 才能被 `run_action_recipe` 执行（见
   *  `RecipeMeta.action` 头注，`src/replay/recipe.ts`）。此前这份 schema 是 non-strict、未知键
   *  忽略，`action` 又不在这份 shape 里，于是 `"action": "yes"` 这类打错的值会被静默当成
   *  "没声明"（=== 不是动作，比 === true 更宽松地被忽略）而不是在加载期报错——加进来让 zod
   *  在装载时就把类型不对的 action 值当场拒掉，而不是留到运行时才被当成"未 opt-in"。 */
  action: z.boolean().optional(),
  /** 动作产物的种类（见 `RecipeMeta.produces`）。同 `action`：打错值在装载期就红。 */
  produces: z.enum(['images']).optional(),
  /** 这条动作 recipe 是它那个 facility 的**登录**入口（见 `RecipeMeta.login` 头注）。
   *  和 `action` 同一个理由进这份 schema：打错类型要在装载期就红，不能静默当成"没声明"。 */
  login: z.boolean().optional(),
  description: z.string().optional(),
  categories: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  example_queries: z.array(z.string()).optional(),
  capabilities: z.array(z.enum(['search', 'timeline', 'anchor', 'discover'])).optional(),
  /** 存储语义（`scheduler.modeOf()`）：'feed'(默认) = 无界时间线，增量 + 滑窗；'collection' =
   *  有界名单，快照式整体替换，且不灌进收件箱主流。榜单/名册型 recipe（奖项获奖名单、排行榜）
   *  要声明它——手写 manifest 的 `movie-*` 一直有这一格，recipe 投影以前漏了，于是同样是榜单，
   *  写成 recipe 就会被当成时间线，把整份名单倒进收件箱。 */
  mode: z.enum(['feed', 'collection']).optional(),
  auth: z.unknown().optional(),
  cadence_hint_seconds: z.number().positive().optional(),
  member_timeout_ms: z.number().positive().optional(),
  params_schema: z.record(z.string(), z.unknown()).optional(),
  /** 见 `RecipeMeta.secret_params`：宿主注入的凭据参数名。四道闸在
   *  `recipe-store.ts` 的 `validateSecretParams` 里一处判完。 */
  secret_params: z.array(z.string().min(1)).optional(),
  radar: z.array(z.string()).optional(),
  key_param: z.string().optional(),
  priority: z.number().int().optional(),
  discoverable: z.boolean().optional(),
  /** 见 `pickableIn`：这份 recipe 在哪个选择面能被挑到。缺省 = 两个面都能；`[]` = 谁都挑不到。 */
  pick_in: z.array(z.enum(PICK_SURFACES)).optional(),
  type: z.enum(['post', 'conversation', 'email', 'calendar']).optional(),
  facility: z.object({ key: z.string().min(1), label: z.string().min(1) }).optional(),
  // Source-owned configuration (Source Config Sheet). Also the declaration a recipe's
  // `extract` writes into — see RecipeExtract for why the ref lives here and not in the
  // recipe body.
  runtime_config: z
    .object({
      ref: z.string().min(1),
      fields: z.record(
        z.string(),
        // 与 `src/manifest/loader.ts` 的同名块、`RuntimeConfigField` 三处同一份名单。
        z.object({
          type: z.enum(['secret', 'string', 'boolean']),
          label: z.string().min(1),
          description: z.string().optional(),
          helpUrl: z.string().optional(),
          required: z.boolean().optional(),
          default: z.union([z.string(), z.boolean()]).optional(),
        }),
      ),
      perInstance: z.boolean().optional(),
      // `provisions` **不在这里收**：它由 `provisionedConfigSlot(recipe)` 推出来（见下面拼
      // candidate 那一处）。这个 zod 对象不是 passthrough，所以包作者就算在 meta 里手写一份
      // 也会被静默剥掉——正是想要的：一条判据只有一个真相源。
    })
    .optional(),
})

// recipe 未声明 cadence_hint_seconds 时的默认采集周期：2d。
// （内置 recipe 多数显式声明了自己的周期；此默认只影响新写的 recipe 没填 hint 的情形。）
const DEFAULT_CADENCE_SECONDS = 172800

/**
 * Project a Recipe into a SourceManifest so a recipe self-describes as a Source —
 * no separate manifests.yaml need be authored (an agent that generates the recipe
 * just fills `meta`). Structural fields derive from the recipe body (`id`, always
 * `adapter: 'replay'`); discovery fields come from `recipe.meta`; the rest default.
 * The result is run through `manifestSchema` so it is valid-by-construction — the
 * same validator plugin sources go through, so a synthesized source and a
 * hand-written one meet the identical bar.
 *
 * `auth` defaults to `none`. **它不是装饰，别照"replay 不读它"推出"可以不写"** —— 那句话本身
 * 是对的（ReplayAdapter 取数只用 recipe 的 cookieDomain 和用户 Chrome 里现成的登录态，"要登录"
 * 在运行时表现为 NeedsLoginError），但 `manifest.auth` **另有一个消费者**：
 * `requiredCookieDomains`（`src/credentials/required-domains.ts`）——**后端下发给扩展的
 * "该同步哪些域的 cookie"那份名单**。一条要登录态的 recipe 不申报，那个域就不在名单里，
 * 扩展不去读它，取数拿到空 cookie。
 *
 * **漏报的表现是最坏的那种**：它和"用户没登录"一字不差。2026-09-03 东财栽过一次——这段注释
 * 当时写着 "display-only and safe to leave off"，包作者照做，于是那个域全靠 `config.yaml` 里
 * 一块给别的东西用的配置意外顶着，删掉那块就整条断，而没有一处会喊。
 *
 * 所以：**这条 recipe 要用户的登录态，就在 `meta.auth` 里申报它的 cookieDomain。**
 * 同形写法见 `packages/xhs/*.recipe.json`（`login: 'qr'`，Stream 能弹扫码面板）、
 * `packages/groq/groq-create-key.recipe.json`（`login: 'oauth'`，Stream 替他点掉"用 Google
 * 继续"，骑浏览器里已有的第三方登录态）与 `packages/eastmoney/eastmoney-login.recipe.json`
 * （`login: 'cookie'`，会话住在用户自己 Chrome 的 cookie 快照里，不要面板）。包描述里的 `stream.credentials` **顶不上**：那是许可
 * 名单（宿主可以把这个域交给这个包），不是需求名单（去用户浏览器把它取回来）。
 */
export function recipeToManifest(recipe: Recipe, pkgFacility: string, namespace: string): SourceManifest {
  const parsedMeta = recipeMetaSchema.safeParse(recipe.meta ?? {})
  if (!parsedMeta.success) {
    const issue = parsedMeta.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    throw new Error(`recipe "${recipe.sourceId}": meta.${path} — ${issue?.message}`)
  }
  const meta = parsedMeta.data
  const facility = meta.facility ?? { key: pkgFacility, label: pkgFacility }

  const provisionedSlot = provisionedConfigSlot(recipe)

  // meta.radar carries flat RSSHub-Radar source patterns → structured `radar` (what
  // the radar matcher needs) AND flattened `matchers` (Provider {mode:'auto',matches}
  // + registry.sourcesMatchingRadar). Deriving both here keeps the recipe author to
  // one list.
  const patterns = meta.radar?.length ? meta.radar : undefined
  const radar = patterns?.map((s) => ({ source: [s] }))
  const matchers = patterns ? [...new Set(patterns)] : undefined

  const candidate = {
    // recipe 里写的是局部名；`namespace`（= 包的 npm 名）在这里拼成全名。见 registry/source-id.ts。
    id: namespacedSourceId(namespace, recipe.sourceId),
    adapter: 'replay',
    title: meta.title,
    normalizer: meta.normalizer,
    provides: meta.provides,
    // `uses` 和 `sourceId` 同一条规矩：包作者写局部名，全名由宿主在装载期合成。含 `/` 的原样
    // 收下——局部名不许含 `/`（见 localSourceIdProblem），所以那只可能是**指着别的包**的全名。
    uses: meta.uses?.map((u) => (u.includes('/') ? u : namespacedSourceId(namespace, u))),
    homepage: meta.homepage,
    effects: meta.effects,
    // 结构性字段：object 输出的 recipe，其 Source 的结果形状随之是对象（执行器缝上解包）。
    ...(recipe.kind === 'http' && recipe.output === 'object' ? { output: 'object' as const } : {}),
    type: meta.type ?? 'post',
    description: meta.description ?? `${facility.label} 数据源`,
    topics: meta.topics ?? [],
    categories: meta.categories ?? [],
    facility,
    example_queries: meta.example_queries ?? [],
    capabilities: meta.capabilities ?? ['timeline'],
    mode: meta.mode,
    auth: meta.auth ?? { type: 'none' },
    params_schema: meta.params_schema ?? {},
    cadence_hint_seconds: meta.cadence_hint_seconds ?? DEFAULT_CADENCE_SECONDS,
    member_timeout_ms: meta.member_timeout_ms,
    discoverable: meta.discoverable ?? true,
    pick_in: meta.pick_in,
    key_param: meta.key_param,
    priority: meta.priority,
    // `provisions` **是推出来的，不是手写的**：真相是 `provisionedConfigSlot(recipe)`（全仓
    // 唯一判据，同时也是写口 sink 的绑定条件）。让包作者在 meta 里再抄一遍，就是把一条
    // 判据分成两份会漂移的——漂了没有一处会喊：多写一个字段名，agent 去劝用户跑一条补不上
    // 它的 recipe；漏写，一条真能自助补的 recipe 就从选项里消失。
    runtime_config: meta.runtime_config && {
      ...meta.runtime_config,
      ...(provisionedSlot ? { provisions: [provisionedSlot.field] } : {}),
    },
    radar,
    matchers,
  }

  const parsed = manifestSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    throw new Error(`recipe "${recipe.sourceId}": synthesized manifest invalid — ${path}: ${issue?.message}`)
  }
  return parsed.data as SourceManifest
}
