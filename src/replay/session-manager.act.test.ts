import { describe, expect, it } from 'vitest'
import type { Transport } from './transport.ts'
import type { RecipeSessionSpec } from './recipe.ts'
import type { ActionSpec } from './interactive-gate.ts'
import { RecipeSessionManager } from './session-manager.ts'

// cloak 侧的 act：和 cdp_act(target:chrome:<tabId>) 过同一道门（interactive-gate）、走同一份落地逻辑
// （run-action），只是地址从 tabId 换成 facility+laneKey。
//
// 域名复核是这里的命门，且理由不是"TOCTOU 小心翼翼"——**门本身的正确性依赖它**：
// classifyAction 判跨站 goto，靠的是拿 targetUrl 的 host 和调用方给的 action.domain
// 比。调用方给个假 domain，跨站 goto 就读成同站 → 低危 → 门直接放行。ext-cdp 那边
// 是扩展的 assertDomain 用 chrome.tabs.get 兜住的；cloak 没有扩展，只能自己拿
// Transport.url（浏览器进程的记录，页面 JS 伪造不了）兜。

const spec: RecipeSessionSpec = { facility: 'demo', lifecycle: 'persistent', visibility: 'unattended' }

/** 记录 driver 上真正被调到的动作——用它证明"被拦下的动作一次都没落到页面上"。
 *  `featurePresent` 控制 exists（confirm 轮询读它）：默认 true（特征已在 → confirmed）。 */
function fakeTransport(pageUrl = 'https://a.example/p', featurePresent = true) {
  const did: string[] = []
  let url = pageUrl
  const transport: Transport = {
    launcher: {
      async launch() {
        return { page: {} as never, rawPage: { tag: 'raw' }, close: async () => {} }
      },
    },
    driverFactory: () =>
      ({
        goto: async (u: string) => { did.push(`goto:${u}`) },
        back: async () => { did.push('back') },
        openItem: async () => {},
        click: async (s: string) => { did.push(`click:${s}`); return true },
        type: async (s: string, t: string) => { did.push(`type:${s}=${t}`) },
        submit: async (s: string) => { did.push(`submit:${s}`) },
        scrollOnce: async (px: number) => { did.push(`scroll:${px}`) },
        exists: async () => featurePresent,
        sleep: async () => {},
        evalJson: async (e: string) => { did.push(`eval:${e}`); return 42 },
      }) as never,
    relayFactory: () => undefined,
    evaluate: async () => undefined,
    screenshot: async () => null,
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => url,
  }
  return { transport, did, navigateTo: (u: string) => { url = u } }
}

async function managerWithLiveTab(t: Transport) {
  const mgr = new RecipeSessionManager(() => t)
  await (await mgr.acquire(spec, 'https://a.example/p')).release()
  return mgr
}

const act = (a: Partial<ActionSpec>): ActionSpec => ({ kind: 'click', domain: 'a.example', selector: '#x', ...a })

describe('RecipeSessionManager.act — 门', () => {
  it('高危动作被拦下，且一次都没落到页面上（绝不先斩后奏）', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)

    const r = await mgr.act('demo', act({ kind: 'submit', selector: '#form' }))

    expect(r).toMatchObject({ status: 'needs-confirmation' })
    expect(r?.reason).toBeTruthy()
    expect(f.did).toEqual([]) // 命门：拦下 = 什么都没做
  })

  it('用户确认后（confirmed）才真执行', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)

    const r = await mgr.act('demo', act({ kind: 'submit', selector: '#form' }), { confirmed: true })

    expect(r).toMatchObject({ status: 'done' })
    expect(f.did).toEqual(['submit:#form'])
  })

  it('低危动作自主直行，不打断', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)

    expect(await mgr.act('demo', act({ kind: 'click', selector: '#a' }))).toMatchObject({ status: 'done' })
    expect(await mgr.act('demo', act({ kind: 'scroll', px: 300 }))).toMatchObject({ status: 'done' })
    expect(f.did).toEqual(['click:#a', 'scroll:300'])
  })

  it('exists / look 的返回值原样带回来', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)

    expect(await mgr.act('demo', act({ kind: 'exists', selector: '#a' }))).toEqual({ status: 'done', result: true })
    expect(await mgr.act('demo', act({ kind: 'look', expression: '1+1' }))).toEqual({ status: 'done', result: 42 })
  })

  it('带 expect：动作后特征出现 → confirmed（不再是判断不了的 done）', async () => {
    const f = fakeTransport('https://a.example/p', true) // 特征已在
    const mgr = await managerWithLiveTab(f.transport)
    const r = await mgr.act('demo', act({ kind: 'click', selector: '#a', expect: '.modal' }))
    // expect 一路穿到 confirm：门 → 域名复核 → runAction → 轮询特征。acted-unconfirmed 那路
    // （及短 deadline）由 run-action.confirm.test.ts 单测覆盖，不在这里实跑 3s。
    expect(r).toMatchObject({ status: 'confirmed' })
    expect(f.did).toContain('click:#a') // 点确实点了
  })
})

describe('RecipeSessionManager.act — 域名复核（门的前提，不是锦上添花）', () => {
  it('页面已经跑到别的域名 → 拒绝执行', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)
    f.navigateTo('https://evil.example/x') // 页面自己重定向走了

    await expect(mgr.act('demo', act({ kind: 'click', selector: '#a' }))).rejects.toThrow(/evil\.example/)
    expect(f.did).toEqual([])
  })

  it('假 domain 骗不过门——跨站 goto 谎称同站，复核照样拦', async () => {
    // 这条是命门：光看 classifyAction，domain='evil.example' + targetUrl=evil.example
    // 就是"同站导航"，低危、放行。挡住它的只有复核——页面真实在 a.example。
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)

    await expect(
      mgr.act('demo', { kind: 'goto', domain: 'evil.example', targetUrl: 'https://evil.example/x' }),
    ).rejects.toThrow(/a\.example/)
    expect(f.did).toEqual([])
  })

  it('纯读不做域名复核——读一个跳走的页面只是读到没用的东西，不会把动作落到非预期的站上', async () => {
    const f = fakeTransport()
    const mgr = await managerWithLiveTab(f.transport)
    f.navigateTo('https://evil.example/x')

    expect(await mgr.act('demo', act({ kind: 'look', expression: '1+1' }))).toMatchObject({ status: 'done' })
  })
})

describe('RecipeSessionManager.act — lane', () => {
  it('没有活 tab → null（与 look/shot 同形，不是抛异常）', async () => {
    const f = fakeTransport()
    const mgr = new RecipeSessionManager(() => f.transport) // 没 acquire 过
    expect(await mgr.act('demo', act({}))).toBeNull()
  })

  it('排在 lane 的 tail 后面——act 不与正跑着的 recipe 交错', async () => {
    const f = fakeTransport()
    const mgr = new RecipeSessionManager(() => f.transport)
    const held = await mgr.acquire(spec, 'https://a.example/p') // 租约在手，tail 未放

    let done = false
    const pending = mgr.act('demo', act({ kind: 'click', selector: '#a' })).then((r) => { done = true; return r })
    await Promise.resolve()
    expect(done).toBe(false) // 被 tail 挡住
    expect(f.did).toEqual([])

    await held.release()
    expect(await pending).toMatchObject({ status: 'done' })
    expect(done).toBe(true)
  })
})
