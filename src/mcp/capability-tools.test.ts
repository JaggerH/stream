import { describe, it, expect } from 'vitest'
import { zodShapeFromParameters, withCapabilityTools } from './capability-tools.ts'
import type { McpExtras } from './tool-catalog.ts'

describe('zodShapeFromParameters', () => {
  const parse = (params: Parameters<typeof zodShapeFromParameters>[0], input: unknown) => {
    const shape = zodShapeFromParameters(params)
    const obj = Object.entries(shape)
    const out: Record<string, unknown> = {}
    for (const [k, t] of obj) {
      const r = t.safeParse((input as Record<string, unknown>)[k])
      if (!r.success) return { ok: false as const, key: k }
      if (r.data !== undefined) out[k] = r.data
    }
    return { ok: true as const, value: out }
  }

  it('required: true → 必填，其余可选', () => {
    const p = { a: { type: 'string', required: true }, b: { type: 'string' } }
    expect(parse(p, { a: 'x' }).ok).toBe(true)
    expect(parse(p, {})).toEqual({ ok: false, key: 'a' })
  })

  it('string / number / integer / boolean 各自校验', () => {
    expect(parse({ n: { type: 'number', required: true } }, { n: 1.5 }).ok).toBe(true)
    expect(parse({ n: { type: 'integer', required: true } }, { n: 1.5 }).ok).toBe(false)
    expect(parse({ b: { type: 'boolean', required: true } }, { b: 'yes' }).ok).toBe(false)
    expect(parse({ s: { type: 'string', required: true } }, { s: 1 }).ok).toBe(false)
  })

  it('enum 收敛成字面量集合', () => {
    const p = { netdisk: { type: 'string', enum: ['quark', 'baidu'], required: true } }
    expect(parse(p, { netdisk: 'quark' }).ok).toBe(true)
    expect(parse(p, { netdisk: 'aliyun' }).ok).toBe(false)
  })

  it('array 按 items 校验元素', () => {
    const p = { xs: { type: 'array', items: { type: 'string' }, required: true } }
    expect(parse(p, { xs: ['a'] }).ok).toBe(true)
    expect(parse(p, { xs: [1] }).ok).toBe(false)
  })

  // 翻不动的类型退回 unknown 而不是抛：一个包用了没见过的参数类型，代价该是"这一格没校验"，
  // 不是"整个包装不上"。
  it('没见过的类型退回 unknown，什么都收', () => {
    expect(parse({ x: { type: 'quaternion', required: true } }, { x: { any: 'thing' } }).ok).toBe(true)
  })

  it('description 带进去', () => {
    expect(zodShapeFromParameters({ a: { type: 'string', description: '给谁' } }).a.description).toBe('给谁')
  })
})

describe('withCapabilityTools', () => {
  it('补上 capabilityTools 那一格', () => {
    const out = withCapabilityTools({ isCommunitySource: () => false }, () => [])
    expect(out.capabilityTools?.()).toEqual([])
  })

  // 这一条钉的是「别用 spread」：base 里的 getter 必须还是 getter。改成
  // `{ ...base, capabilityTools }` 它会红——读到的是包裹那一刻的值。
  it('base 上的 getter 仍然每次现算', () => {
    let n = 0
    const base = { get liveField() { return `v${++n}` } } as unknown as McpExtras
    const out = withCapabilityTools(base, () => [])
    const read = () => (out as unknown as { liveField: string }).liveField
    expect(read()).toBe('v1')
    expect(read()).toBe('v2')
  })

  it('不改原对象', () => {
    const base: McpExtras = { isCommunitySource: () => false }
    withCapabilityTools(base, () => [])
    expect(base.capabilityTools).toBeUndefined()
  })
})

// `type:'object'` 一律退成 record 的代价不是"校验松了"，是**模型看不见内层字段叫什么**：
// 导出的 JSON-Schema 里那一格只剩「一个对象」，一个 `{ query, limit }` 的入参对模型而言
// 变成"随便塞点什么"，它只能猜。
describe('zodShapeFromParameters：object 递归翻内层', () => {
  const shapeOf = (params: Parameters<typeof zodShapeFromParameters>[0]) => zodShapeFromParameters(params)

  it('有 properties 就翻进去，内层类型照样校验', () => {
    const t = shapeOf({
      filter: { type: 'object', required: true, properties: { limit: { type: 'integer' }, q: { type: 'string' } } },
    }).filter
    expect(t.safeParse({ limit: 3, q: 'x' }).success).toBe(true)
    expect(t.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(t.safeParse({ q: 1 }).success).toBe(false)
  })

  it('内层没被点名的字段是可选的（顶层那条 `required: true` 管不到内层）', () => {
    const t = shapeOf({
      filter: { type: 'object', required: true, properties: { q: { type: 'string' } } },
    }).filter
    expect(t.safeParse({}).success).toBe(true)
  })

  // 两套文法共用 `required` 这个键，靠**类型**分辨：`true` 是 DSH 那条「这一格自己必填」，
  // 数组是 JSON-Schema 那条「内层这几个名字必填」。所以一个对象属性没法同时表达两者——
  // 那是两套文法撞在一个键上的结果，不是这里的取舍。
  it('内层用 JSON-Schema 的 `required: [...]` 点名的字段是必填', () => {
    const t = shapeOf({
      filter: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } }, required: ['q'] },
    }).filter
    // 这一格自己是可选的（顶层没写 `required: true`），给了就得带上 q。
    expect(t.safeParse(undefined).success).toBe(true)
    expect(t.safeParse({ q: 'x' }).success).toBe(true)
    expect(t.safeParse({ n: 1 }).success).toBe(false)
  })

  it('嵌套两层也翻得动', () => {
    const t = shapeOf({
      a: { type: 'object', required: true, properties: { b: { type: 'object', properties: { c: { type: 'boolean' } } } } },
    }).a
    expect(t.safeParse({ b: { c: true } }).success).toBe(true)
    expect(t.safeParse({ b: { c: 'yes' } }).success).toBe(false)
  })

  it('没有 properties（真的就是一张自由字典）才回落成 record', () => {
    const t = shapeOf({ bag: { type: 'object', required: true } }).bag
    expect(t.safeParse({ whatever: 1 }).success).toBe(true)
    expect(t.safeParse('not an object').success).toBe(false)
  })

  it('数组的元素是对象时同样翻内层', () => {
    const t = shapeOf({
      xs: { type: 'array', required: true, items: { type: 'object', properties: { n: { type: 'integer' } } } },
    }).xs
    expect(t.safeParse([{ n: 1 }]).success).toBe(true)
    expect(t.safeParse([{ n: 'x' }]).success).toBe(false)
  })
})
