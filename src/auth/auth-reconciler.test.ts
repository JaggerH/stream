import { describe, expect, it } from 'vitest'
import { reconcileAuth, type AuthReconcileDeps } from './auth-reconciler.ts'

// 「需要登录」这个横幅原来只有一个更新时机：**一次采集跑完**（bootstrap 的 onOutcome）。
// 定时采集的源没问题——下一轮 tick 自己会翻。但只有搜索才跑的源（xhs 搜索、抖音）**没有
// 任何东西会自己跑**：用户在浏览器里登录回来了，横幅能一直挂着。判据是活的，展示是缓存的。
//
// 对账器补的就是这个：不跑采集，只用便宜的活证据去核对一次。
function harness(over: Partial<AuthReconcileDeps> = {}) {
  const cleared: string[] = []
  let pushed = 0
  const deps: AuthReconcileDeps = {
    needs: () => [{ facility: 'xhs', sourceIds: ['xhs-search', 'xhs-detail'] }],
    liveVerdict: async () => undefined,
    cookieEvidence: async () => 'UNKNOWN',
    clear: (id) => { cleared.push(id); return true },
    onChanged: () => { pushed++ },
    ...over,
  }
  return { deps, cleared, pushed: () => pushed }
}

describe('reconcileAuth', () => {
  it('lane 活着且判定已登录 → 撤掉横幅（真判据优先，cookie 都不用问）', async () => {
    let askedCookie = false
    const h = harness({
      liveVerdict: async () => 'LOGGED_IN',
      cookieEvidence: async () => { askedCookie = true; return 'GONE' },
    })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual(['xhs-search', 'xhs-detail'])
    expect(askedCookie).toBe(false)
    expect(h.pushed()).toBe(1)
  })

  it('lane 活着且判定还在墙上 → 什么都不动', async () => {
    const h = harness({ liveVerdict: async () => 'WALLED' })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual([])
    expect(h.pushed()).toBe(0)
  })

  it('没有 lane、cookie 回来了 → 撤横幅（证据不是证明，见实现里的失败方向）', async () => {
    const h = harness({ liveVerdict: async () => undefined, cookieEvidence: async () => 'PRESENT' })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual(['xhs-search', 'xhs-detail'])
  })

  it('没有 lane、cookie 确实不在 → 保持横幅', async () => {
    const h = harness({ cookieEvidence: async () => 'GONE' })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual([])
  })

  it('问不出来（扩展没连）→ 保持横幅，**绝不**当成登录成功', async () => {
    // 这是整个对账器最危险的一格：把"我问不出来"当成"登录好了"，等于用户一夜没开电脑，
    // 第二天所有登录横幅自己消失，而会话其实全过期了。
    const h = harness({ liveVerdict: async () => 'UNKNOWN', cookieEvidence: async () => 'UNKNOWN' })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual([])
    expect(h.pushed()).toBe(0)
  })

  it('活证据自己抛错也不能撤横幅 —— 失败一律留在"还需要登录"这一侧', async () => {
    const h = harness({
      liveVerdict: async () => { throw new Error('relay down') },
      cookieEvidence: async () => { throw new Error('relay down') },
    })
    await reconcileAuth(h.deps)
    expect(h.cleared).toEqual([])
  })

  it('没有任何 facility 需要登录 → 一次远程调用都不发', async () => {
    let calls = 0
    const h = harness({
      needs: () => [],
      liveVerdict: async () => { calls++; return undefined },
      cookieEvidence: async () => { calls++; return 'PRESENT' },
    })
    await reconcileAuth(h.deps)
    expect(calls).toBe(0)
    expect(h.pushed()).toBe(0)
  })

  it('清不动（标记本来就不在了）→ 不白推一次', async () => {
    const h = harness({ cookieEvidence: async () => 'PRESENT', clear: () => false })
    await reconcileAuth(h.deps)
    expect(h.pushed()).toBe(0)
  })
})
