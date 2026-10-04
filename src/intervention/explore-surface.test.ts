import { describe, it, expect, vi } from 'vitest'
import { browserSurface, type CdpVerbs } from './explore-surface.ts'

function fakeCdp(page: { url: string; items: unknown[]; title?: string }) {
  const acts: unknown[] = []
  const cdp: CdpVerbs = {
    look: vi.fn(async (a) => {
      if (a.inventory) return { value: { items: page.items, truncated: false } }
      if (a.js === 'location.href') return { value: page.url }
      if (a.js?.startsWith('!!document.querySelector')) return { value: a.js.includes('"#yes"') }
      if (a.js?.includes('document.title')) return { value: { t: page.title ?? 't', x: 'body text' } }
      return { value: null }
    }),
    act: vi.fn(async (a) => { acts.push(a); return { status: a.kind === 'click' && a.ref === 99 ? 'not-found' : 'done' } }),
    shot: vi.fn(async () => ({ shot: 'AAAA' })),
  }
  return { cdp, acts }
}

describe('browserSurface', () => {
  it('url / inventory / exists 全走 look；click 带 ref + 当前域名 + confirmed；back 是 kind:back', async () => {
    const { cdp, acts } = fakeCdp({ url: 'https://www.xiaohongshu.com/explore?a=1', items: [{ n: 1, tag: 'a', href: '/x', rect: { x: 0, y: 0, w: 1, h: 1 } }] })
    const s = browserSurface(cdp, 'chrome:7')
    expect(await s.url()).toBe('https://www.xiaohongshu.com/explore?a=1')
    expect((await s.inventory())[0]!.n).toBe(1)
    expect(await s.exists('#yes')).toBe(true)
    expect(await s.exists('#no')).toBe(false)
    expect(await s.click(1)).toBe(true)
    expect(await s.click(99)).toBe(false)
    await s.back()
    expect(acts[0]).toMatchObject({ target: 'chrome:7', kind: 'click', ref: 1, domain: 'www.xiaohongshu.com', confirmed: true })
    expect(acts[2]).toMatchObject({ target: 'chrome:7', kind: 'back', domain: 'www.xiaohongshu.com' })
  })
  it('scene：截图 + 元素表 + 标题正文；inventory 回 __error 时元素表为空且不抛', async () => {
    const { cdp } = fakeCdp({ url: 'https://a.example/p', items: [{ n: 3, tag: 'button', name: '搜索', rect: { x: 1, y: 2, w: 3, h: 4 } }], title: 'T' })
    const sc = await browserSurface(cdp, 'chrome:1').scene()
    expect(sc).toMatchObject({ side: 'browser', url: 'https://a.example/p', title: 'T', shot: { mime: 'image/jpeg', base64: 'AAAA' } })
    expect(sc.elements[0]).toMatchObject({ n: 3, name: '搜索' })
    ;(cdp.look as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ value: { __error: 'boom' } }))
    expect((await browserSurface(cdp, 'chrome:1').inventory())).toEqual([])
  })
  it('settle：连续稳一段才返回；一直在变也要按上限退出（不能永远等下去）', async () => {
    // 前两拍还在变（导航中），之后不动
    let tick = 0
    const probing = (a: { js?: string }): unknown =>
      a.js?.includes('readyState')
        ? { value: { h: 'https://a.example/x', r: tick++ < 2 ? 'loading' : 'complete', n: tick < 2 ? tick : 9 } }
        : { value: null }
    const stable: CdpVerbs = { look: vi.fn(async (a) => probing(a)), act: vi.fn(async () => ({})), shot: vi.fn(async () => ({ shot: null })) }
    const t0 = Date.now()
    await browserSurface(stable, 'chrome:1').settle()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500)

    // 永远在变（轮询 / 动画的站点）：**必须有上限**，否则每一次 act 都挂在这儿
    let n = 0
    const never: CdpVerbs = {
      look: vi.fn(async (a) => (a.js?.includes('readyState') ? { value: { h: 'https://a.example/x', r: 'complete', n: n++ } } : { value: null })),
      act: vi.fn(async () => ({})), shot: vi.fn(async () => ({ shot: null })),
    }
    const t1 = Date.now()
    await browserSurface(never, 'chrome:1').settle()
    const spent = Date.now() - t1
    expect(spent).toBeGreaterThanOrEqual(3000)
    expect(spent).toBeLessThan(5000)
  }, 15_000)

  it('target 不是 chrome:<tabId> 直接抛：探索面只认这一档', () => {
    const { cdp } = fakeCdp({ url: 'x', items: [] })
    expect(() => browserSurface(cdp, 'facility:xhs')).toThrow(/chrome:<tabId>/)
  })
})
