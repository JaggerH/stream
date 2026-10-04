import { describe, it, expect, vi } from 'vitest'
import { resolveTransport, type TransportDeps } from './transport.ts'
import type { ReplayLauncher } from './browser-fetch.ts'
import type { ObserverRelay } from './observer-pipeline.ts'

const extLauncher = { launch: vi.fn() } as unknown as ReplayLauncher
const extRelay = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  onEvent: vi.fn(),
  sendCommand: vi.fn(),
} as unknown as ObserverRelay

function deps(over: Partial<TransportDeps> = {}): TransportDeps {
  return { extLauncher, extRelay, ...over }
}

describe('resolveTransport', () => {
  it('launcher is the ext launcher', () => {
    expect(resolveTransport(deps()).launcher).toBe(extLauncher)
  })

  it('relayFactory returns the shared CDP relay', () => {
    expect(resolveTransport(deps()).relayFactory({})).toBe(extRelay)
  })

  it('evaluate routes through rawPage.evalExpr', async () => {
    const evalExpr = vi.fn(async () => 'EXT-VALUE')
    const rawPage = { tabId: 7, evalExpr, cdp: vi.fn() }
    const t = resolveTransport(deps())
    expect(await t.evaluate(rawPage, 'window.foo')).toBe('EXT-VALUE')
    expect(evalExpr).toHaveBeenCalledWith('window.foo')
  })

  it('screenshot uses Page.captureScreenshot and decodes base64 → Buffer', async () => {
    const cdp = vi.fn(async () => ({ data: Buffer.from('image-bytes').toString('base64') }))
    const rawPage = { tabId: 7, evalExpr: vi.fn(), cdp }
    const t = resolveTransport(deps())
    const buf = await t.screenshot(rawPage)
    expect(cdp).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({ format: 'jpeg' }))
    expect(buf?.toString()).toBe('image-bytes')
  })

  it('driverFactory builds an ext driver (currentUrl reads via evalExpr)', async () => {
    const evalExpr = vi.fn(async () => 'https://x.com/here')
    const rawPage = { tabId: 7, evalExpr, cdp: vi.fn() }
    const driver = resolveTransport(deps()).driverFactory(rawPage)
    expect(await driver.currentUrl!()).toBe('https://x.com/here')
    expect(evalExpr).toHaveBeenCalledWith('location.href')
  })

  // 留痕的另一端：driver 里那笔 goto 超时记录只有接上 onDebug 才到得了 debug 总线。
  // 不钉这一条，driver 单测照样绿、活体照样一个字都没有。
  it('driverFactory 把 onDebug 传进 driver —— goto 撞上界那笔痕才有地方落', async () => {
    vi.useFakeTimers()
    try {
      const seen: unknown[] = []
      const rawPage = {
        tabId: 7,
        evalExpr: vi.fn(async (expr: string) =>
          expr.includes('readyState') ? { href: 'https://x.com/next', state: 'loading' } : 'https://x.com/old',
        ),
        cdp: vi.fn(),
      }
      const driver = resolveTransport(deps({ onDebug: (e) => seen.push(e) })).driverFactory(rawPage)
      const p = driver.goto('https://x.com/next', 'load')
      await vi.advanceTimersByTimeAsync(16_000)
      await p
      expect(seen).toHaveLength(1)
      expect((seen[0] as { channel: string }).channel).toBe('drive')
    } finally {
      vi.useRealTimers()
    }
  })

  it('url reads the browser-process navigation history, not the page', async () => {
    const cdp = vi.fn(async () => ({ currentIndex: 1, entries: [{ url: 'a' }, { url: 'https://real/here' }] }))
    const rawPage = { tabId: 7, evalExpr: vi.fn(), cdp }
    expect(await resolveTransport(deps()).url(rawPage)).toBe('https://real/here')
    expect(cdp).toHaveBeenCalledWith('Page.getNavigationHistory')
  })

  describe('elementShot', () => {
    it('clips the capture to the element rect read in-page', async () => {
      const evalExpr = vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 50, scale: 1 }))
      const cdp = vi.fn(async () => ({ data: Buffer.from('qr-bytes').toString('base64') }))
      const buf = await resolveTransport(deps()).elementShot({ tabId: 7, evalExpr, cdp }, 'img.qrcode')
      expect(buf?.toString()).toBe('qr-bytes')
      expect(cdp).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.objectContaining({ clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 } }),
      )
    })

    /**
     * 把 elementShot 真正发出去的那段页内表达式**跑一遍**（用假的 document/视口），
     * 而不是断言"发过一条 evalExpr" —— 留白的算法整个在那段字符串里，桩着 evalExpr
     * 只会把它跳过去，测了个寂寞。
     */
    function runRectExpr(expr: string, rect: { x: number; y: number; width: number; height: number },
                         viewport = { w: 1000, h: 800 }) {
      const g = globalThis as unknown as Record<string, unknown>
      const saved = { d: g.document, w: g.innerWidth, h: g.innerHeight }
      g.document = { querySelector: () => ({ getBoundingClientRect: () => rect }) }
      g.innerWidth = viewport.w
      g.innerHeight = viewport.h
      try {
        return (0, eval)(expr) as { x: number; y: number; width: number; height: number }
      } finally {
        g.document = saved.d; g.innerWidth = saved.w; g.innerHeight = saved.h
      }
    }

    async function clipFor(padRatio: number | undefined, rect: { x: number; y: number; width: number; height: number },
                           viewport?: { w: number; h: number }) {
      let expr = ''
      const evalExpr = vi.fn(async (e: string) => { expr = e; return runRectExpr(e, rect, viewport) })
      const cdp = vi.fn(async (_method: string, params?: unknown) => { void params; return { data: '' } })
      await resolveTransport(deps()).elementShot({ tabId: 7, evalExpr, cdp }, 'img.qrcode', padRatio)
      expect(expr).toBeTruthy()
      const sent = cdp.mock.calls[0]![1] as { clip: { x: number; y: number; width: number; height: number; scale: number } }
      return sent.clip
    }

    it('留白：二维码四周要有静默区，紧贴边框裁会扫不出来', async () => {
      // 180×180 的码，12% 短边 = 21.6 → 22px 一圈。
      const clip = await clipFor(0.12, { x: 300, y: 200, width: 180, height: 180 })
      expect(clip).toEqual({ x: 278, y: 178, width: 224, height: 224, scale: 1 })
    })

    it('留白有下限：很小的元素也得留够，不能按比例缩成 2 像素', async () => {
      const clip = await clipFor(0.12, { x: 300, y: 200, width: 40, height: 40 })
      expect(clip.x).toBe(284) // 40*0.12=4.8 → 取下限 16
      expect(clip.width).toBe(72)
    })

    it('留白撞到视口边缘就夹住 —— 负坐标截出来是空图', async () => {
      const clip = await clipFor(0.12, { x: 5, y: 3, width: 200, height: 200 }, { w: 300, h: 250 })
      expect(clip.x).toBe(0)
      expect(clip.y).toBe(0)
      expect(clip.width).toBeLessThanOrEqual(300)
      expect(clip.height).toBeLessThanOrEqual(250)
    })

    it('不传 padRatio → 紧贴元素（留白是调用方按需要的，不是默认行为）', async () => {
      const clip = await clipFor(undefined, { x: 10, y: 20, width: 100, height: 50 })
      expect(clip).toEqual({ x: 10, y: 20, width: 100, height: 50, scale: 1 })
    })

    it('returns null (and captures nothing) when the selector matches nothing', async () => {
      const cdp = vi.fn()
      const buf = await resolveTransport(deps()).elementShot(
        { tabId: 7, evalExpr: vi.fn(async () => null), cdp }, '.missing',
      )
      expect(buf).toBeNull()
      expect(cdp).not.toHaveBeenCalled()
    })
  })
})
