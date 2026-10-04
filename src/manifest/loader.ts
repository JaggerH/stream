import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { MANIFEST_SCHEMA_VERSION, PICK_SURFACES, type SourceManifest } from './types.ts'

const cookieInjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().min(1) }),
  z.object({ kind: z.literal('transform'), ref: z.string().min(1) }),
])

export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  // `optional` 镜像 RSSHub 的 `requireConfig[].optional`（见 types.ts AuthSpec）：目录派生的 AuthSpec
  // 不经这里，但包手写的 manifest 要经——zod 对象默认**剥掉**未声明的键，这一格漏了就是「YAML 里写着
  // optional: true、装载出来没有」，于是没 cookie 时 resolver 抛错而不是游客态放行。
  z.object({ type: z.literal('cookie'), domain: z.string().min(1), inject: cookieInjectSchema, optional: z.literal(true).optional() }),
  z.object({ type: z.literal('token'), name: z.string().min(1), optional: z.literal(true).optional() }),
  // session has three login variants (a discriminatedUnion can't split the same `type` twice, so
  // login is an enum with per-variant fields optional here). login:qr — user scans a QR into the
  // facility profile (single-session sites), needs loginUrl+qrSelector. login:oauth — rides the
  // user's own already-logged-in Google session through a third-party OAuth button, needs
  // loginUrl+oauthButton+accountSelector+account. login:cookie — the login lives in the broker
  // (the cookie snapshot, read from the user's own Chrome); the launcher injects a fresh cookie
  // for cookieDomain, no scan, and an expired session is re-established by the user logging in on
  // their own Chrome. The stricter per-login shape is the SessionAuthSpec union.
  z.object({
    type: z.literal('session'),
    facility: z.string().min(1),
    login: z.enum(['qr', 'oauth', 'cookie']),
    loginUrl: z.string().min(1).optional(),
    qrSelector: z.string().min(1).optional(),
    oauthButton: z.string().min(1).optional(),
    accountSelector: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    // Shared by both variants: login:cookie injects for it, login:qr observes it (the cheap
    // "is the session cookie even there" half of login detection).
    cookieDomain: z.string().min(1).optional(),
    sessionCookies: z.array(z.string().min(1)).optional(),
  }),
]).superRefine((v, ctx) => {
  // login:oauth 的三个字段（loginUrl/oauthButton/accountSelector）在 SessionAuthSpec（types.ts）
  // 里是必填的，但上面那个扁平对象为了兼容 qr/cookie 两支把它们全标成 optional——不补这道闸，
  // `login:'oauth'` 缺任何一个都能直接通过校验，装配期不报错，运行期才在实际登录时炸。
  // `account` 不在这份必填清单里——它是用户各自的邮箱，不是包该提供的东西（见 types.ts 上
  // 那个字段的头注），recipe 里没有它是合法的常态，不是漏填。
  // 只收紧 oauth 这一支：qr 的宽松是既有行为，不在本次范围内，别在这里一并收紧。
  if (v.type !== 'session' || v.login !== 'oauth') return
  for (const field of ['loginUrl', 'oauthButton', 'accountSelector'] as const) {
    if (!v[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `login:'oauth' 缺 ${field}` })
  }
})

const apiQueryParamSchema = z.object({
  from: z.string().min(1),
  default: z.union([z.string(), z.number()]).optional(),
  required: z.boolean().optional(),
})

// 字段类型这份名单有**三处**（这里、`recipe-manifest.ts` 的同名块、`RuntimeConfigField`），
// 加一种就要三处同改：漏掉任何一处的表现都是"schema 认、另一处拒"，而拒的那一句话
// （`Invalid option: expected one of …`）离真因很远。
const runtimeConfigFieldSchema = z.object({
  type: z.enum(['secret', 'string', 'boolean']),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  helpUrl: z.string().url().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.boolean()]).optional(),
})

const runtimeConfigSchema = z.object({
  ref: z.string().min(1),
  fields: z.record(z.string().min(1), runtimeConfigFieldSchema).default({}),
  perInstance: z.boolean().optional(),
  instanceNamespace: z.string().regex(/^[a-z][\w-]*$/).optional(),
  /** 见 types.ts `RuntimeConfigSpec.provisions`：跑一趟能自己填上的字段名。 */
  provisions: z.array(z.string().min(1)).optional(),
}).refine((spec) => Object.keys(spec.fields).length > 0, 'at least one field required')
  .refine(
    // 只能声明补自己这一格里有的字段——凭空点一个名字，下游只会以"补完还是缺"这种无关症状爆出来。
    (spec) => (spec.provisions ?? []).every((f) => f in spec.fields),
    'provisions must name fields declared in this runtime_config',
  )
  .refine(
    (spec) => !spec.perInstance || !!spec.instanceNamespace,
    'perInstance source must declare instanceNamespace (it is the whitelist for instance key refs)',
  )

/** Declarative api binding OR a named handler (see ApiBinding in types.ts). */
export const apiBindingSchema = z.union([
  z.object({
    endpoint: z.string().min(1),
    query: z.record(z.string(), apiQueryParamSchema).optional(),
    unwrap: z.string().optional(),
    normalize: z.string().optional(),
  }),
  z.object({ handler: z.string().min(1) }),
])

/**
 * Required fields are required; optional fields get defaults. Unknown keys are
 * stripped (not rejected) so future schema additions don't break old loaders.
 */
export const manifestSchema = z.object({
  schema_version: z.number().default(MANIFEST_SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  pluginId: z.string().optional(),
  adapter: z.string().min(1),
  type: z.enum(['post', 'conversation', 'email', 'calendar']).default('post'),
  description: z.string().default(''),
  topics: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  facility: z.object({ key: z.string().min(1), label: z.string().min(1) }).optional(),
  example_queries: z.array(z.string()).default([]),
  // 四个值全是**取数**语义。动作型 Source（桌面 recipe 那类：发一条消息、点一个按钮）一样都不占，
  // 它的 capabilities 就该是空的——所以这里不能一刀 `.min(1)`。但空数组对一个普通 Source 是真错误
  // （什么都不能做，却还躺在候选池里等着被选中），所以判据挂在下面的 superRefine 上：**只有把自己
  // 从所有选择面上摘出去的 Source（`discoverable: false`）才允许空**。
  capabilities: z.array(z.enum(['search', 'timeline', 'anchor', 'discover'])).default([]),
  // object = 这个 Source 交回一个判决对象而非条目数组；执行器缝上据此解包。缺省 items。
  output: z.enum(['items', 'object']).optional(),
  auth: authSchema,
  params_schema: z.record(z.string(), z.unknown()).default({}),
  runtime_config: runtimeConfigSchema.optional(),
  route: z.string().optional(),
  cadence_hint_seconds: z.number().positive(),
  member_timeout_ms: z.number().positive().optional(),
  discoverable: z.boolean().default(true),
  /** 见 `pickableIn`。缺省（不写）= 两个选择面都能挑到；`[]` = 谁都挑不到（代码/流程直调的那些）。 */
  pick_in: z.array(z.enum(PICK_SURFACES)).optional(),
  normalizer: z.string().optional(),
  // deprecated alias for `normalizer` — kept accepted so pre-rename manifests (including
  // user-owned data/ recipes outside this repo) still validate; resolved as normalizer ?? presenter.
  presenter: z.string().optional(),
  mode: z.enum(['feed', 'collection']).optional(),
  fan_out: z
    .object({
      dimension: z.string().min(1),
      strategy: z.enum(['batch', 'window', 'scatter']),
      batch_key: z.array(z.string()).default([]),
      window_size: z.number().positive().optional(),
      max_concurrent: z.number().positive().optional(),
    })
    .optional(),
  radar: z
    .array(z.object({ source: z.array(z.string()).default([]), target: z.string().optional() }))
    .optional(),
  // flattened radar `source` patterns for Provider {mode:'auto',matches} + radar resolve
  // (registry.sourcesMatchingRadar); native manifests may declare directly. Real
  // SourceManifest fields — keep them so schema-validated loads don't strip them.
  matchers: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  /** 见 `SourceManifest.uses`：这个 Source 的产出依赖哪些别的 Source。 */
  uses: z.array(z.string().min(1)).optional(),
  provides: z.array(z.string()).default([]),
  /**
   * 副作用声明（见 recipe `meta.effects`）——只读源缺省无此字段。
   *
   * **这份取值必须和 `recipe-manifest.ts` 那份逐字一致**：recipe 的 meta 会被合成成一份
   * manifest 再过这里，两边分家的表现是「recipe 自己校验得过、合成那一步炸掉」，而报错
   * （`synthesized manifest invalid — effects.1`）指的是合成产物，离真正该改的地方隔着一层。
   * 加一个新取值就得同时改两处——真踩过一次。
   */
  effects: z.array(z.enum(['write', 'send'])).optional(),
  priority: z.number().int().optional(),
  key_param: z.string().optional(),
  fixed_params: z.record(z.string(), z.unknown()).optional(),
  api: apiBindingSchema.optional(),
}).superRefine((m, ctx) => {
  // 见 `capabilities` 那一格：空只对「已经把自己从所有选择面上摘出去」的动作型 Source 成立。
  // 一个还 discoverable 的 Source 报空 capabilities，是在说「我在候选池里，但我什么都不能做」。
  if (m.capabilities.length === 0 && m.discoverable) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities'],
      message: 'empty capabilities is only allowed on an action-only source (set discoverable: false)',
    })
  }
})

export type LoadWarning = { file: string; message: string }
export type LoadOptions = { onWarn?: (w: LoadWarning) => void }

const MIN_DESCRIPTION_LEN = 20

/**
 * Load + validate every `*.yaml` manifest in a directory.
 * Throws on the first invalid manifest (naming the file + offending field).
 * Warns (but still loads) manifests that are likely undiscoverable.
 */
export function loadManifests(dir: string, opts: LoadOptions = {}): SourceManifest[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  const out: SourceManifest[] = []

  for (const file of files) {
    const raw = parseYaml(readFileSync(join(dir, file), 'utf8'))
    const parsed = manifestSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const path = issue?.path.join('.') || '(root)'
      throw new Error(`Invalid manifest ${file}: ${path} — ${issue?.message}`)
    }

    const m = parsed.data as SourceManifest
    if (m.description.length < MIN_DESCRIPTION_LEN && m.topics.length === 0) {
      opts.onWarn?.({
        file,
        message: `source "${m.id}" has a thin description and no topics — it may be undiscoverable`,
      })
    }
    out.push(m)
  }

  return out
}
