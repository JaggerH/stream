import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { loadRecipePackages, BUILTIN_LAYER_SCAN } from './recipe-package.ts'
import { provisionedConfigSlot } from './recipe-provisioner.ts'
import type { Recipe } from './recipe.ts'

const canonical = (over: Record<string, unknown> = {}): Recipe => ({
  version: 1,
  kind: 'browser',
  sourceId: 'x-create-key',
  cookieDomain: 'x.test',
  entryUrl: 'https://x.test/keys',
  loginCheck: { loggedIn: '#ok' },
  session: { facility: 'x', lifecycle: 'one-shot', visibility: 'interactive' },
  steps: [],
  observers: [],
  output: { itemsAt: '', dedupeBy: '', targetCount: 0, mapping: {} },
  allowEmpty: true,
  extract: { field: 'apiKey', pattern: 'k_[a-z]+' },
  meta: {
    runtime_config: { ref: 'x', fields: { apiKey: { type: 'secret', label: 'X API Key' } } },
  },
  ...over,
} as unknown as Recipe)

describe('provisionedConfigSlot — 判据', () => {
  it('声明了 extract 且目标字段是自己 runtime_config 里的 secret → 报出那一格', () => {
    expect(provisionedConfigSlot(canonical())).toEqual({ ref: 'x', field: 'apiKey' })
  })

  it('没有 extract（只是"我需要这格配置"）→ null', () => {
    // eastmoney-login 就是这个形状：它 *消费* zjzh/jymm（secret_params），不产出。
    // 判据把「需要」和「产出」分开，正是这条自助申请索引不能只看 runtime_config 的原因。
    const { extract: _drop, ...rest } = canonical() as unknown as Record<string, unknown>
    expect(provisionedConfigSlot(rest as unknown as Recipe)).toBeNull()
  })

  it('目标字段没在自己的 runtime_config 里声明成 secret → null（不许凭空往凭据存储塞键）', () => {
    expect(provisionedConfigSlot(canonical({
      meta: { runtime_config: { ref: 'x', fields: { apiKey: { type: 'string', label: 'X' } } } },
    }))).toBeNull()
    expect(provisionedConfigSlot(canonical({
      meta: { runtime_config: { ref: 'x', fields: { other: { type: 'secret', label: 'X' } } } },
    }))).toBeNull()
  })

  it('根本没声明 runtime_config → null（目标 ref 只能是它自己那一格）', () => {
    expect(provisionedConfigSlot(canonical({ meta: {} }))).toBeNull()
  })

  it('不是 canonical browser recipe → null', () => {
    expect(provisionedConfigSlot({
      version: 1, kind: 'http', sourceId: 'h', request: {}, pagination: {}, assert: [], mapping: {},
    } as unknown as Recipe)).toBeNull()
  })
})

// 钉住数字的守卫。判据一旦放宽（比如哪天忘了查 `secret`、或把「声明了 runtime_config」
// 直接当成「能自助申请」），这里当场变红——而线上的表现是：**eastmoney 那张要资金账号和
// 交易密码的卡上，长出一颗一键按钮**。数字不是洁癖，是那颗按钮的闸。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

describe('shipped recipe packages — 谁声明了自助申请', () => {
  const provisioners = () => {
    const loaded = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)
    const out: Array<[string, string]> = []
    for (const [id, recipe] of loaded.recipes) {
      const slot = provisionedConfigSlot(recipe)
      if (slot) out.push([id, slot.ref])
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }

  it('恰好这 4 条内置 recipe 能替用户把一格配置填满', () => {
    expect(provisioners()).toEqual([
      ['@streamapp/firecrawl/firecrawl-create-key', 'firecrawl'],
      ['@streamapp/firecrawl/firecrawl-read-key', 'firecrawl'],
      ['@streamapp/groq/groq-create-key', 'groq'],
      ['@streamapp/zhipu/zhipu-create-key', 'zhipu'],
    ])
  })

  it('eastmoney-login 声明了 runtime_config 却不在名单里——它要这几格，不产出它们', () => {
    const loaded = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)
    const eastmoney = loaded.recipes.get('@streamapp/eastmoney/eastmoney-login')
    expect(eastmoney).toBeDefined()
    expect(eastmoney!.meta?.runtime_config?.ref).toBe('eastmoney')
    expect(provisionedConfigSlot(eastmoney!)).toBeNull()
  })
})
