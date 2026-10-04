import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { envCoveredFields, makeRuntimeConfigResolver, runtimeConfigPlugin } from './runtime-config.ts'
import type { RuntimeConfigSpec, SourceManifest } from '../../manifest/types.ts'
import type { SettingsStore } from '../../settings-store.ts'

const srcRoot = join(import.meta.dirname, '../..')

function manifestWith(runtime_config: RuntimeConfigSpec | undefined): SourceManifest {
  return { id: 's', name: 's', adapter: 'builtin', runtime_config } as unknown as SourceManifest
}

const spec = (ref: string, fields: RuntimeConfigSpec['fields']): RuntimeConfigSpec => ({ ref, fields })
const field = (rest: { default?: string } = {}): RuntimeConfigSpec['fields'][string] =>
  ({ type: 'string', label: 'f', ...rest })

// 这些用例走的是**兜底路**（family 未注册的树）：rows.has 恒 false。
// 权威路（source family）的行为由 sources 域测试与引擎测试钉。
const settingsWith = (values: Record<string, Record<string, unknown>>) => ({
  runtimeConfig: (ref: string) => values[ref] ?? {},
  rows: { has: () => false, resolve: (): Record<string, unknown> => ({}) },
})

describe('makeRuntimeConfigResolver', () => {
  it('没声明 runtime_config 的 source 拿到空对象（不去碰设置库）', () => {
    const resolve = makeRuntimeConfigResolver({
      settings: {
        runtimeConfig: () => { throw new Error('不该被调用') },
        rows: { has: () => false, resolve: () => ({}) },
      },
    })
    expect(resolve(manifestWith(undefined))).toEqual({})
  })

  it('family 注册了就走引擎（权威路），不再读旧兜底', () => {
    const resolve = makeRuntimeConfigResolver({
      settings: {
        runtimeConfig: () => { throw new Error('family 在场时不该走兜底') },
        rows: { has: (id) => id === 'source:tmdb', resolve: () => ({ apiKey: 'from-engine' }) },
      },
    })
    expect(resolve(manifestWith(spec('tmdb', { apiKey: field() })))).toEqual({ apiKey: 'from-engine' })
  })

  it('manifest 的 field default 只给缺失的键打底', () => {
    const resolve = makeRuntimeConfigResolver({ settings: settingsWith({ tmdb: { apiKey: 'k' } }) })
    expect(resolve(manifestWith(spec('tmdb', { apiKey: field(), language: field({ default: 'zh-CN' }) }))))
      .toEqual({ apiKey: 'k', language: 'zh-CN' })
  })

  it('存过的值盖掉 default——空串也算存过（用户主动清空 = 要英文）', () => {
    const resolve = makeRuntimeConfigResolver({ settings: settingsWith({ tmdb: { language: '' } }) })
    expect(resolve(manifestWith(spec('tmdb', { language: field({ default: 'zh-CN' }) }))).language).toBe('')
  })

  it('按 manifest 自己的 ref 取值——两个 source 各读各的', () => {
    const resolve = makeRuntimeConfigResolver({ settings: settingsWith({ tmdb: { apiKey: 't' }, omdb: { apiKey: 'o' } }) })
    expect(resolve(manifestWith(spec('tmdb', { apiKey: field() }))).apiKey).toBe('t')
    expect(resolve(manifestWith(spec('omdb', { apiKey: field() }))).apiKey).toBe('o')
  })

  it('挂成 ctx.runtimeConfig，dispose 后消失', async () => {
    const kernel = createKernel()
    kernel.provide('settings', settingsWith({ tmdb: { apiKey: 'k' } }) as unknown as SettingsStore)
    await kernel.plugin(runtimeConfigPlugin)
    expect(kernel.runtimeConfig(manifestWith(spec('tmdb', { apiKey: field() })))).toEqual({ apiKey: 'k' })
    await quiesceKernel(kernel)
    expect(kernel.runtimeConfig).toBeUndefined()
  })

  // inject 是这条依赖的唯一表达：设置库不在树上，解析器就不该存在——而不是拿到一个会在
  // 第一次取值时炸的半成品。
  it('树上没有 settings 时不激活（ctx.runtimeConfig 缺席）', async () => {
    const kernel = createKernel()
    await kernel.plugin(runtimeConfigPlugin)
    expect(kernel.runtimeConfig).toBeUndefined()
    await quiesceKernel(kernel)
  })
})

// 部署环境变量回落：宿主那张表（DEPLOYMENT_ENV_FALLBACK）说「这个 ref 的这一格，存储里空着就读哪个
// 环境变量」。它保住的是「BYOK 不填则回退环境变量」这条既有承诺——厂商转写搬进包之后，包只看得到
// runtimeConfig，读不到进程环境（包不许自己读 env）。
describe('makeRuntimeConfigResolver — 部署环境变量回落', () => {
  const cf = spec('cloudflare', { apiKey: { type: 'secret', label: 'k' }, accountId: field() })

  it('存储里空着的格从表里指定的环境变量补上', () => {
    const resolve = makeRuntimeConfigResolver({
      settings: settingsWith({}),
      env: { CLOUDFLARE_WORKERS_AI_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' },
    })
    expect(resolve(manifestWith(cf))).toMatchObject({ apiKey: 'tok', accountId: 'acc' })
  })

  it('存储的值胜过环境变量（运行时拿到的 key 必须运行时生效）', () => {
    const resolve = makeRuntimeConfigResolver({
      settings: settingsWith({ cloudflare: { apiKey: 'stored', accountId: 'acc-stored' } }),
      env: { CLOUDFLARE_WORKERS_AI_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' },
    })
    expect(resolve(manifestWith(cf))).toMatchObject({ apiKey: 'stored', accountId: 'acc-stored' })
  })

  it('表里没有的 ref / 没声明的格一律不碰环境（包不能借一个 ref 名读任意环境变量）', () => {
    const resolve = makeRuntimeConfigResolver({
      settings: settingsWith({}),
      env: { CLOUDFLARE_WORKERS_AI_TOKEN: 'tok', SOME_SECRET: 's' },
    })
    expect(resolve(manifestWith(spec('other', { apiKey: { type: 'secret', label: 'k' } })))).toEqual({})
    // 同一个 ref，但 manifest 没声明 apiKey 这一格 → 不补
    expect(resolve(manifestWith(spec('cloudflare', { accountId: field() })))).not.toHaveProperty('apiKey')
  })
})

/** 递归收 `src/` 下所有 .ts（跳过测试自己），返回相对 srcRoot 的路径。 */
function sourceFiles(dir = srcRoot, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...sourceFiles(join(dir, e.name), rel))
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(rel)
  }
  return out
}

// 一致性守卫：解析表达式只能有一个实现。复制出第五份内联闭包时这条当场变红——四份逐字相同的闭包
// 漂移是静默的（改一处 default 语义、漏改三处，只表现为"部分采集路径吃旧默认"，无人报错）。
describe('runtimeConfig 解析只有一个实现', () => {
  it('全仓只有解析器自己调 withRuntimeDefaults', () => {
    const callers = sourceFiles().filter((f) =>
      /withRuntimeDefaults\s*\(/.test(readFileSync(join(srcRoot, f), 'utf8')))
    expect(callers.sort()).toEqual(['kernel/plugins/runtime-config.ts', 'manifest/runtime-config.ts'])
  })

  it('bootstrap 只造一个解析器，四个消费点共用它', () => {
    const src = readFileSync(join(srcRoot, 'bootstrap.ts'), 'utf8')
    expect(src.match(/makeRuntimeConfigResolver\(/g) ?? []).toHaveLength(1)
    // 1 定义 + 3 处传递：Scheduler 直吃，另两处经域插件的 config 转交——`adaptersPlugin`
    // （BuiltinAdapter）与 `providerPlugin`（ResolveEngine + 分集索引，两个消费点在同一份
    // config 里）。**消费点仍是四个，只是有两个搬进了内核域**；关键不变量没变：全仓只有一个
    // 实例，域插件绝不自己 `makeRuntimeConfigResolver()`（那会让"同一份判据"悄悄变成两份，
    // 上一条用例从 withRuntimeDefaults 那一侧把这个也封住了）。
    expect(src.match(/\bruntimeConfigFor\b/g) ?? []).toHaveLength(4)
    // 两个域插件都只**收**它，不自己造。
    for (const f of ['kernel/plugins/adapters.ts', 'kernel/plugins/provider.ts']) {
      expect(readFileSync(join(srcRoot, f), 'utf8')).not.toMatch(/makeRuntimeConfigResolver\(/)
    }
  })
})

// 「哪几格部署环境变量兜得住」——给配置面板的必填判据用（面板只看得到存储那一侧，不问这一句就会把
// 只靠环境变量配好的用户拦在保存门外）。只回字段名，**绝不回值**：这张回执会出现在浏览器里。
describe('envCoveredFields', () => {
  it('只列表里有、且环境变量非空的格；不回值', () => {
    const covered = envCoveredFields('cloudflare', ['apiKey', 'accountId'], { CLOUDFLARE_ACCOUNT_ID: 'acc' })
    expect(covered).toEqual(['accountId'])
  })
  it('表外的 ref、没声明的格一律不列', () => {
    expect(envCoveredFields('groq', ['apiKey'], { CLOUDFLARE_WORKERS_AI_TOKEN: 'tok' })).toEqual([])
    expect(envCoveredFields('cloudflare', ['apiKey'], { CLOUDFLARE_ACCOUNT_ID: 'acc' })).toEqual([])
  })
})
