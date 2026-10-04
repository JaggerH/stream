import type { Context } from 'cordis'
import { withRuntimeDefaults } from '../../manifest/runtime-config.ts'
import type { SourceManifest } from '../../manifest/types.ts'

declare module 'cordis' {
  interface Context {
    /** 「这个 source 跑起来时该拿到哪份配置」的唯一判据（`src/kernel/plugins/runtime-config.ts`）。 */
    runtimeConfig: RuntimeConfigResolver
  }
}

/** 由 manifest 解出该 source 的运行时配置；没声明 `runtime_config` 的 source 拿空对象。 */
export type RuntimeConfigResolver = (manifest: SourceManifest) => Record<string, unknown>

export interface RuntimeConfigDeps {
  /** 设置库：`rows`（配置 row 引擎的 source family，权威路径）+ `runtimeConfig`（兜底读口）。 */
  settings: {
    runtimeConfig(ref: string): Record<string, unknown>
    rows: { has(id: string): boolean; resolve(id: string): Record<string, unknown> }
  }
  /** 部署环境（缺省 `process.env`）——只经 `DEPLOYMENT_ENV_FALLBACK` 那张表读，测试注入假环境。 */
  env?: Record<string, string | undefined>
}

/**
 * 「某个 source 的运行时配置怎么解」——全仓唯一实现。
 *
 * 它就是「读存储的值 + 打底 manifest 的 field default」两步，本身平淡；单独立成具名工厂是因为
 * **消费点有四个**（BuiltinAdapter / Scheduler / ResolveEngine / 分集索引），以前是四份逐字相同
 * 的内联闭包。那个形状的事故是静默的：改一处 default 语义、漏改另外三处，表现只是"部分采集路径
 * 吃到旧默认"，没有任何一处会报错（`language` 长期落 en-US 就是这么来的）。
 *
 * 依赖经参数进来而不是模块级 import：同一个进程里可以有第二棵树（测试即是），全局单例会让两棵树
 * 互相看见对方的设置库。
 */
export function makeRuntimeConfigResolver(deps: RuntimeConfigDeps): RuntimeConfigResolver {
  const env = deps.env ?? process.env
  return (manifest) => {
    if (!manifest.runtime_config) return {}
    const ref = manifest.runtime_config.ref
    // 权威路径：配置 row 引擎的 source family（sources 域注册；schema 默认打底、空串尊重
    // 与 withRuntimeDefaults 同判据，但 status/密文/写入语义只有引擎一份）。
    // family 不在（没挂 sources 域的测试树）才回落旧实现——兜底，不是第二条权威路。
    const id = `source:${ref}`
    const resolved = deps.settings.rows.has(id)
      ? deps.settings.rows.resolve(id)
      : withRuntimeDefaults(manifest.runtime_config, deps.settings.runtimeConfig(ref))
    return withDeploymentEnv(ref, Object.keys(manifest.runtime_config.fields ?? {}), resolved, env)
  }
}

/**
 * 部署环境变量 → runtime_config 格的回落表：「这个 ref 的这一格，存储里空着就读这个环境变量」。
 *
 * 为什么是宿主的一张表：**环境变量名是部署的知识**，不是某个包的——包不许自己读进程环境
 * （docs/PACKAGE.md §3.2 `config`），也没有「申报我要读哪个环境变量」的声明位（那等于任何第三方包
 * 都能借一个 ref 名读走宿主的任意密钥）。它保住的是「BYOK 不填则回退环境变量」这条既有承诺：
 * 转写档搬进包之后，包只看得到 `context.runtimeConfig`。同一批变量名也在
 * `src/kernel/plugins/credentials.ts` 的 TokenProvider 表里（那条给宿主自己的 `token()` 用）。
 *
 * 只补**manifest 声明了的格**、只在存储值为空时补——存储胜过环境（运行时拿到的 key 要运行时生效）。
 * 和存储层一样，同 ref 的包都拿得到这一份（runtime_config 的 ref 本来就是按设施共享的）。
 */
const DEPLOYMENT_ENV_FALLBACK: Record<string, Record<string, string>> = {
  cloudflare: { apiKey: 'CLOUDFLARE_WORKERS_AI_TOKEN', accountId: 'CLOUDFLARE_ACCOUNT_ID' },
}

/**
 * 这个 ref 的哪几格由部署环境变量兜得住（表里有、且环境变量此刻非空）。只回字段名、**不回值**——
 * 消费方是配置面板的必填判据（`POST /api/source-runtime-config/status` 的 `envFallback`），那张回执会
 * 出现在浏览器里。和 `withDeploymentEnv` 读同一张表：面板说「兜得住」的格，执行时就真的补得上。
 */
export function envCoveredFields(
  ref: string, declared: string[], env: Record<string, string | undefined> = process.env,
): string[] {
  const table = DEPLOYMENT_ENV_FALLBACK[ref]
  if (!table) return []
  return declared.filter((field) => !!table[field] && !!env[table[field]])
}

/** 按回落表给解析结果补环境变量；表外的 ref / 没声明的格原样返回。 */
function withDeploymentEnv(
  ref: string, declared: string[], resolved: Record<string, unknown>, env: Record<string, string | undefined>,
): Record<string, unknown> {
  const table = DEPLOYMENT_ENV_FALLBACK[ref]
  if (!table) return resolved
  const out = { ...resolved }
  for (const field of declared) {
    const envVar = table[field]
    const cur = out[field]
    if (!envVar || (typeof cur === 'string' ? cur : cur != null)) continue
    const v = env[envVar]
    if (v) out[field] = v
  }
  return out
}

/**
 * 把解析器挂成 `ctx.runtimeConfig`；随 fiber dispose 自动消失。
 *
 * 设置库经 `inject` 从内核取而不是由调用方喂进来：这两个域现在都住在内核上，用装载顺序表达
 * 「settings 先于 runtimeConfig」等于把一条依赖藏进 bootstrap 的行序里——换个挂载点就静默拿到
 * 一个还没有设置库的解析器。声明出来之后，settings 不在树上这个 fiber 就干脆不激活。
 */
export const runtimeConfigPlugin = {
  name: 'runtimeConfig',
  inject: ['settings'],
  apply(ctx: Context): void {
    ctx.provide('runtimeConfig', makeRuntimeConfigResolver({ settings: ctx.settings }))
  },
}
