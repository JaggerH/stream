import { describe, it, expect } from 'vitest'
import {
  localSourceIdProblem, localNameOf, namespacedSourceId, localNamespace,
  resolveBySourceId, AmbiguousSourceIdError,
} from './source-id.ts'

describe('localSourceIdProblem', () => {
  it('accepts an ordinary local name', () => {
    expect(localSourceIdProblem('xhs-home')).toBeNull()
    expect(localSourceIdProblem('fetch-url')).toBeNull()
  })

  it("拒 '/'——它是包名与局部名的分隔符", () => {
    expect(localSourceIdProblem('a/b')).toMatch(/\//)
  })

  it("拒 ':'——它会让 Registry.get 的第 2 级剥离在全名上误触发", () => {
    expect(localSourceIdProblem('rsshub:weibo')).toMatch(/:/)
  })

  it('拒空 id', () => {
    expect(localSourceIdProblem('')).not.toBeNull()
  })
})

describe('全名 ↔ 局部名', () => {
  it('scoped 包名自带一个 / —— 局部名仍是最后一段（局部名不含 /，所以精确、不是猜）', () => {
    const full = namespacedSourceId('@streamapp/xhs', 'xhs-home')
    expect(full).toBe('@streamapp/xhs/xhs-home')
    expect(localNameOf(full)).toBe('xhs-home')
  })

  it('无 scope 的包名', () => {
    expect(localNameOf(namespacedSourceId('my-recipes', 'fetch-url'))).toBe('fetch-url')
  })

  it('没有 npm 名的手放包用 local/<目录名>', () => {
    expect(localNameOf(namespacedSourceId(localNamespace('evil'), 'fetch-url'))).toBe('fetch-url')
  })

  it('裸名原样返回（旧 manifest / 用户手打）', () => {
    expect(localNameOf('fetch-url')).toBe('fetch-url')
  })
})

/**
 * 按全名建的表要用它来取，**别裸 `Map.get`**。
 *
 * 这不是便利功能，是消掉一处真实的不对称：`Registry.get` 有四级裸名解析，而 `liveRecipes`
 * 这类 Map 直接 `get` 就没有——同一个 id 两条路答案不同。代价活体见过（2026-09-03）：
 * `run_action_recipe` 传 `eastmoney-login` 恒 not-found，正确的全名是
 * `@streamapp/eastmoney/eastmoney-login`，而那条 recipe `discoverable: false`，
 * **正确的名字在任何搜索面上都查不出来**。
 */
describe('resolveBySourceId', () => {
  const table = new Map([
    ['@streamapp/eastmoney/eastmoney-login', 'A'],
    ['@streamapp/qq/qq-send', 'B'],
  ])

  it('全名直接命中', () => {
    expect(resolveBySourceId(table, '@streamapp/eastmoney/eastmoney-login')).toBe('A')
  })

  it('裸名（局部名）也认', () => {
    expect(resolveBySourceId(table, 'eastmoney-login')).toBe('A')
  })

  it('真的没有 → undefined', () => {
    expect(resolveBySourceId(table, 'nope')).toBeUndefined()
    expect(resolveBySourceId(table, '@x/nope')).toBeUndefined()
  })

  /** 已经是全名却没命中就是真没有——不该再拿它的最后一段去撞别的包。 */
  it('给的是全名就不再退回裸名匹配', () => {
    expect(resolveBySourceId(table, '@other/eastmoney-login')).toBeUndefined()
  })

  /** 撞名**抛**，不挑一个：动作 recipe 挑错了就是去跑了另一个包的副作用。 */
  it('裸名命中多条 → 抛，并列出候选', () => {
    const dup = new Map([['@a/login', 1], ['@b/login', 2]])
    expect(() => resolveBySourceId(dup, 'login')).toThrow(AmbiguousSourceIdError)
    expect(() => resolveBySourceId(dup, 'login')).toThrow(/@a\/login.*@b\/login/s)
  })
})
