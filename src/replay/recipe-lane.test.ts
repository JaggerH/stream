import { describe, expect, it } from 'vitest'
import { RecipeSessionManager } from './session-manager.ts'
import { SessionRecipeExecutor } from './session-recipe-executor.ts'
import { validateRecipe } from './recipe-store.ts'
import { resolveTransport, type Transport, type TransportDeps } from './transport.ts'
import type { CanonicalBrowserRecipe, RecipeSessionSpec } from './recipe.ts'

// 回归锁：recipe 的 session.laneKey 到底通不通到 lane 池的键上？
// 写它是为了别再靠读代码推断——上一次我照着 commit 标题推断，把一个错说法钉进了 6 处。
//
// 注意 driver 必须是真的（走 resolveTransport 造 ext driver），不能塞个 `{}`：
// 空 driver 会让 run 变成 blocked → markBlocked → release 时被驱逐 → lane 消失，
// 看起来就像"lane 机制不工作"。第一版探针就是这么骗到我自己的。

const testDeps: TransportDeps = {
  extLauncher: null as never,
  extRelay: undefined as never,
}
/** 真 driver（ext-cdp 那套），但 launcher 换成计数用的假货。 */
const transportFor = (launcher: Transport['launcher']): Transport => ({
  ...resolveTransport(testDeps),
  launcher,
})

function fake() {
  const launched: string[] = []
  let n = 0
  const launcher: Transport['launcher'] = {
    async launch(url: string) {
      const id = ++n
      launched.push(url)
      return {
        page: { evaluate: async () => undefined as never },
        rawPage: {
          tabId: id,
          async cdp() { return {} },
          async evalExpr(e: string) {
            if (e.includes('extractCards')) return [{ id: `from-tab-${id}` }]
            if (e.includes('document.querySelector')) return e.includes('.me')
            return undefined
          },
        },
        close: async () => {},
      }
    },
  }
  const resolve = (_spec: RecipeSessionSpec) => transportFor(launcher)
  return { resolve, launched }
}

const base: CanonicalBrowserRecipe = {
  version: 5, kind: 'browser', sourceId: 'demo', cookieDomain: 'x.test', entryUrl: 'https://x.test/',
  loginCheck: { loggedIn: '.me', wall: '.wall' },
  session: { facility: 'demo', lifecycle: 'persistent', visibility: 'unattended' },
  steps: [],
  observers: [{ kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
  output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'id' } },
}

describe('探针：recipe session.laneKey → lane 池', () => {
  it('两条 recipe 同 facility、不同 laneKey → 两个 tab，各自活着', async () => {
    const f = fake()
    const sessions = new RecipeSessionManager(f.resolve)
    const exec = new SessionRecipeExecutor(sessions, f.resolve)

    await exec.execute({ ...base, sourceId: 'feed', session: { ...base.session, laneKey: 'feed' } }, {})
    await exec.execute({ ...base, sourceId: 'detail', session: { ...base.session, laneKey: 'detail' } }, {})

    expect(f.launched).toHaveLength(2) // 两个 tab
    expect(sessions.lanes().map((l) => l.laneKey).sort()).toEqual(['detail', 'feed'])
  })

  it('不写 laneKey → 都挤在默认 lane 上（今天所有采集 recipe 的现状）', async () => {
    const f = fake()
    const sessions = new RecipeSessionManager(f.resolve)
    const exec = new SessionRecipeExecutor(sessions, f.resolve)

    await exec.execute({ ...base, sourceId: 'feed' }, {})
    await exec.execute({ ...base, sourceId: 'detail' }, {})

    expect(f.launched).toHaveLength(1) // 同一个 tab
    expect(sessions.lanes()).toHaveLength(1)
  })

  it('装载校验放行 laneKey（不是未知键被拒）', () => {
    const r = validateRecipe('demo', { ...base, session: { ...base.session, laneKey: 'detail' } })
    expect((r as CanonicalBrowserRecipe).session.laneKey).toBe('detail')
  })

  // laneKey 打错字是**安静而合理地**坏掉：没有报错，recipe 落回默认 lane，开始驱动别的
  // recipe 正骑着的那个 tab。什么都不抛，采集只是变得很怪（feed 滚到一半被导航走、账本
  // 全部失配），然后你去错的地方找原因。laneKey 离"悄悄变成它的反面"只差一个字母换位，
  // 且不像 facility 打错——下游没有任何一环会发现。所以装载期就拒。
  it('laneKey 打错字 → 装载期就报错，不静默落回默认 lane', () => {
    expect(() => validateRecipe('demo', { ...base, session: { ...base.session, laneKye: 'detail' } })).toThrow(
      /unknown session key "laneKye"/,
    )
  })

  it('认得的 session 键全部放行（校验不能把合法 recipe 一起拒了）', () => {
    expect(() =>
      validateRecipe('demo', {
        ...base,
        session: { facility: 'x', laneKey: 'detail', lifecycle: 'persistent', visibility: 'unattended' },
      }),
    ).not.toThrow()
  })
})
