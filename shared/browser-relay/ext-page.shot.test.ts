import { describe, it, expect, vi } from 'vitest'
import { makeExtPageDriver } from './ext-page.ts'
import type { ExtRawPage } from './ext-page.ts'

// ── 截一个元素：先在页内画，画不出来才截屏 ────────────────────────────────────
// 截屏要合成器真的产出一帧，而被盖住/最小化/锁屏的窗口不产帧——那正是"无人值守的定时任务
// 在锁着屏的早上截验证码"的场景。`<img>`/`<canvas>` 的像素本来就在页面进程里，画进 canvas
// 读出来完全不经合成器。这组测试钉住这个次序，以及"画不出来要老实回落"。

const RECT = { x: 10, y: 20, width: 80, height: 30 }
const JPEG_B64 = '/9j/AAAA'

function makeRaw(evalResult: unknown, cdpResult: unknown = { data: 'FROMSCREENSHOT' }) {
  const cdp = vi.fn(async (_method: string, _params?: unknown) => cdpResult)
  const raw = {
    tabId: 5,
    evalExpr: vi.fn(async () => evalResult),
    cdp,
  } as unknown as ExtRawPage
  return { raw, cdp }
}

describe('ExtPageDriver.shotOf', () => {
  it('页内画成了 → 直接用那份像素，一次截屏都不发', async () => {
    const { raw, cdp } = makeRaw({ ...RECT, data: `data:image/jpeg;base64,${JPEG_B64}` })
    const out = await makeExtPageDriver(raw).shotOf!('#imgValidCode')
    expect(out).toBe(JPEG_B64) // 去掉 data: 前缀，回的是纯 base64（和截屏那条同一种形状）
    expect(cdp).not.toHaveBeenCalled()
  })

  it('画不出来（跨源污染画布 / 不是图）→ 老实回落到截屏', async () => {
    const { raw, cdp } = makeRaw({ ...RECT, data: null })
    const out = await makeExtPageDriver(raw).shotOf!('#someDiv')
    expect(out).toBe('FROMSCREENSHOT')
    expect(cdp).toHaveBeenCalledOnce()
    expect(cdp.mock.calls[0][0]).toBe('Page.captureScreenshot')
  })

  // 点一下验证码图 = 换一张，此后 complete 有一小段是 false。那会儿回落到截屏，正好落进
  // "遮挡窗口截不到"里——整条链会在"刚点完刷新"这一刻必然失败（活体撞到过）。
  it('图还在加载 → null（"还没好"），绝不回落到截屏', async () => {
    const { raw, cdp } = makeRaw({ ...RECT, data: null, loading: true })
    expect(await makeExtPageDriver(raw).shotOf!('#imgValidCode')).toBeNull()
    expect(cdp).not.toHaveBeenCalled()
  })

  it('元素不在 / 零尺寸 → null，不发任何命令', async () => {
    const { raw, cdp } = makeRaw(null)
    expect(await makeExtPageDriver(raw).shotOf!('#nope')).toBeNull()
    expect(cdp).not.toHaveBeenCalled()
  })

  // 页内那段脚本必须真的去试着画，而不是只量个矩形——否则这条路等于没加，
  // 而症状是"遮挡窗口照样截不到"，和没改一模一样。
  it('页内那段脚本会去画 canvas，不是只量矩形', async () => {
    const { raw } = makeRaw({ ...RECT, data: null })
    await makeExtPageDriver(raw).shotOf!('#imgValidCode')
    const expr = String((raw.evalExpr as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(expr).toContain('drawImage')
    expect(expr).toContain('toDataURL')
    // 跨源图 toDataURL 会抛，抛了必须回落而不是让整次读作废。
    expect(expr).toContain('catch')
  })
})
