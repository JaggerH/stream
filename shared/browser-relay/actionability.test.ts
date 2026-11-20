import { describe, it, expect, vi } from 'vitest'
import {
  ACTION_FAILURE_CODES,
  isActionFailureCode,
  prepareClick,
  prepareType,
  readBackValue,
  waitForTap,
  type ActionabilityPage,
} from './actionability.ts'
import { makeExtPageDriver, type ExtRawPage } from './ext-page.ts'
import { actWithConfirm, runActionDetailed } from './run-action.ts'

const RECT = { left: 100, top: 200, width: 300, height: 72 }
const VISIBLE = { left: 100, top: 200, width: 300, height: 72 }
const VIEWPORT = { w: 1280, h: 720 }

const SUCCESS_PROBE = {
  found: true,
  tag: 'button',
  desc: '<button#go> "Go"',
  visible: true,
  hiddenBy: null,
  zeroSize: false,
  disabled: false,
  disabledBy: null,
  editable: false,
  rect: RECT,
  viewport: VIEWPORT,
}

const SUCCESS_SCROLL = {
  found: true,
  stable: true,
  rect: RECT,
  viewport: VIEWPORT,
  visibleRect: VISIBLE,
}

/** 按表达式里出现的标记回答——测的是「这一步问了什么」，不是页内实现。 */
function fakePage(answers: {
  probe?: unknown
  scroll?: unknown
  hit?: unknown
  focus?: unknown
  read?: unknown
  tap?: unknown
}): ActionabilityPage & { evals: string[] } {
  const evals: string[] = []
  return {
    evals,
    async evalExpr<T>(expr: string): Promise<T> {
      evals.push(expr)
      if (expr.includes('window.__streamActionTap || null')) return (answers.tap ?? null) as T
      if (expr.includes('checkVisibility')) return (answers.probe ?? SUCCESS_PROBE) as T
      if (expr.includes('scrollIntoView')) return (answers.scroll ?? SUCCESS_SCROLL) as T
      if (expr.includes('elementFromPoint')) return (answers.hit ?? { ok: true }) as T
      if (expr.includes('el.focus()')) return (answers.focus ?? { ok: true }) as T
      if (expr.includes('isContentEditable')) return (answers.read ?? { ok: true }) as T
      if (expr.includes('__streamActionTapOff')) return true as T
      throw new Error(`unexpected expression: ${expr.slice(0, 80)}`)
    },
  }
}

describe('prepareClick — 可操作性流水线', () => {
  it('选择器没命中 → not-found', async () => {
    const p = fakePage({ probe: { found: false } })
    const r = await prepareClick(p, '#gone')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('not-found')
  })

  it('display:none / visibility:hidden / 零尺寸 / opacity:0 → not-visible，原因点名是哪一种', async () => {
    const p = fakePage({
      probe: { ...SUCCESS_PROBE, visible: false, hiddenBy: 'display:none', desc: '<button#ghost> "Hidden"' },
    })
    const r = await prepareClick(p, '#ghost')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason.code).toBe('not-visible')
      expect(r.reason.reason).toContain('display:none')
      expect(r.reason.reason).toContain('#ghost')
    }
  })

  it('disabled / aria-disabled / fieldset disabled → disabled', async () => {
    const p = fakePage({ probe: { ...SUCCESS_PROBE, disabled: true, disabledBy: 'aria-disabled="true"' } })
    const r = await prepareClick(p, '#off')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason.code).toBe('disabled')
      expect(r.reason.reason).toContain('aria-disabled')
    }
  })

  it('滚动后仍与视口无交集 → outside-viewport', async () => {
    const p = fakePage({ scroll: { ...SUCCESS_SCROLL, visibleRect: null } })
    const r = await prepareClick(p, '#far')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('outside-viewport')
  })

  it('命中别的元素 → covered，原因里带遮挡元素简述', async () => {
    const p = fakePage({
      hit: {
        ok: false,
        hasHit: true,
        hitDesc: '<div#consent-banner> "We use cookies. Accept"',
        desc: '<button#next> "Next page"',
      },
    })
    const r = await prepareClick(p, '#next')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason.code).toBe('covered')
      expect(r.reason.reason).toContain('consent-banner')
      expect(r.reason.reason).toContain('#next')
    }
  })

  it('命中点为空 → covered（不是「点成功了」）', async () => {
    const p = fakePage({ hit: { ok: false, hasHit: false, hitDesc: null, desc: '<button#next> "Next"' } })
    const r = await prepareClick(p, '#next')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('covered')
  })

  it('命中测试时节点已被替换 → detached', async () => {
    const p = fakePage({ hit: { code: 'detached' } })
    const r = await prepareClick(p, '#row')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('detached')
  })

  it('通过全部检查 → 落在可见部分的中心', async () => {
    const p = fakePage({})
    const r = await prepareClick(p, '#go')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.point).toEqual({ x: 250, y: 236 }) // 100+300/2, 200+72/2
  })

  it('position 偏移相对元素矩形左上角，不被滚动改写', async () => {
    const p = fakePage({})
    const r = await prepareClick(p, '#go', { x: 36, y: 36 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.point).toEqual({ x: 136, y: 236 })
  })
})

describe('prepareType — 写入前检查', () => {
  it('不可编辑 → not-editable', async () => {
    const p = fakePage({ probe: { ...SUCCESS_PROBE, editable: false, desc: '<div#msg> "read only"' } })
    const r = await prepareType(p, '#msg')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('not-editable')
  })

  it('聚焦失败 → not-editable，不是「写进去了」', async () => {
    const p = fakePage({ probe: { ...SUCCESS_PROBE, editable: true }, focus: { code: 'not-editable' } })
    const r = await prepareType(p, '#email')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.code).toBe('not-editable')
  })

  it('通过 → 目标已聚焦', async () => {
    const p = fakePage({ probe: { ...SUCCESS_PROBE, editable: true } })
    const r = await prepareType(p, '#email')
    expect(r.ok).toBe(true)
    expect(p.evals.some((e) => e.includes('el.focus()'))).toBe(true)
  })
})

describe('写入回读 / 点击送达', () => {
  it('回读不一致 → ok:false（且不把值带回来）', async () => {
    const p = fakePage({ read: { ok: false } })
    await expect(readBackValue(p, '#email', 'a@example.invalid')).resolves.toEqual({ ok: false, detached: false })
  })

  it('回读时节点被换 → detached', async () => {
    const p = fakePage({ read: { detached: true } })
    await expect(readBackValue(p, '#email', 'x')).resolves.toEqual({ ok: false, detached: true })
  })

  it('收到可信 click → confirmed；没收到 → unconfirmed', async () => {
    await expect(waitForTap(fakePage({ tap: { trusted: true } }))).resolves.toBe('confirmed')
    await expect(waitForTap(fakePage({ tap: null }), 60)).resolves.toBe('unconfirmed')
  })

  it('失败分类码是稳定集合', () => {
    for (const code of ['not-found', 'not-visible', 'disabled', 'covered', 'detached', 'outside-viewport']) {
      expect(ACTION_FAILURE_CODES).toContain(code)
      expect(isActionFailureCode(code)).toBe(true)
    }
    expect(isActionFailureCode('nope')).toBe(false)
  })
})

/** 驱动层：失败一个 Input.* 都不发；成功才走可信三连。 */
function driverRaw(answers: {
  probe?: unknown
  scroll?: unknown
  hit?: unknown
  tap?: unknown
  read?: unknown
}) {
  const cdp: Array<{ method: string; params: unknown }> = []
  const raw: ExtRawPage = {
    tabId: 7,
    async evalExpr<T>(expr: string): Promise<T> {
      if (expr.includes('window.__streamActionTap || null')) {
        return (answers.tap === undefined ? { trusted: true } : answers.tap) as T
      }
      if (expr.includes('checkVisibility')) return (answers.probe ?? SUCCESS_PROBE) as T
      if (expr.includes('scrollIntoView')) return (answers.scroll ?? SUCCESS_SCROLL) as T
      if (expr.includes('elementFromPoint')) return (answers.hit ?? { ok: true }) as T
      if (expr.includes('isContentEditable')) return (answers.read ?? { ok: true }) as T
      if (expr.includes('innerWidth')) return { x: 10, y: 10 } as T
      if (expr.includes('el.focus()')) return { ok: true } as T
      if (expr.includes('__streamActionTapOff')) return true as T
      throw new Error(`unexpected expression: ${expr.slice(0, 80)}`)
    },
    async cdp(method: string, params?: unknown) {
      cdp.push({ method, params })
      return {}
    },
  }
  return { raw, cdp, driver: makeExtPageDriver(raw, { humanCursor: false }) }
}

describe('makeExtPageDriver — 回执与零输入保证', () => {
  it('被遮挡 → clickReceipt.ok=false / code=covered，且没有一条 Input.*', async () => {
    const { driver, cdp } = driverRaw({ hit: { ok: false, hasHit: true, hitDesc: '<div#banner>', desc: '<button#next>' } })
    const r = await driver.clickReceipt('#next')
    expect(r.ok).toBe(false)
    expect(r.reason?.code).toBe('covered')
    expect(cdp.filter((c) => c.method.startsWith('Input.'))).toHaveLength(0)
  })

  it('禁用 / 隐藏同样零输入', async () => {
    for (const probe of [
      { ...SUCCESS_PROBE, disabled: true, disabledBy: 'disabled' },
      { ...SUCCESS_PROBE, visible: false, hiddenBy: 'visibility:hidden' },
    ]) {
      const { driver, cdp } = driverRaw({ probe })
      const r = await driver.clickReceipt('#x')
      expect(r.ok).toBe(false)
      expect(cdp.filter((c) => c.method.startsWith('Input.'))).toHaveLength(0)
    }
  })

  it('成功 → 落点 + 可信三连 + delivery', async () => {
    const { driver, cdp } = driverRaw({})
    const r = await driver.clickReceipt('#go')
    expect(r).toMatchObject({ ok: true, delivery: 'confirmed', point: { x: 250, y: 236 } })
    const press = cdp.find((c) => (c.params as any)?.type === 'mousePressed')
    expect(press?.params).toMatchObject({ x: 250, y: 236 })
  })

  it('页面没回可信 click → delivery=unconfirmed，但不算失败', async () => {
    const { driver } = driverRaw({ tap: null })
    // 让 waitForTap 的轮询尽快结束：这里用真实 700ms 上界，可以接受一次。
    const r = await driver.clickReceipt('#go')
    expect(r.ok).toBe(true)
    expect(r.delivery).toBe('unconfirmed')
  })

  it('旧布尔投影：失败=false（且非 not-found 的失败也不再假成功）', async () => {
    const { driver } = driverRaw({ hit: { ok: false, hasHit: true, hitDesc: '<div#banner>', desc: '<button#next>' } })
    expect(await driver.click('#next')).toBe(false)
  })

  it('写入回读不一致 → value-mismatch', async () => {
    const { driver } = driverRaw({ probe: { ...SUCCESS_PROBE, editable: true }, read: { ok: false } })
    const r = await driver.typeReceipt('#email', 'a@example.invalid')
    expect(r.ok).toBe(false)
    expect(r.reason?.code).toBe('value-mismatch')
  })
})

describe('runActionDetailed / actWithConfirm — 失败码上浮', () => {
  it('covered 成为 status，reason 带遮挡元素', async () => {
    const { driver } = driverRaw({ hit: { ok: false, hasHit: true, hitDesc: '<div#consent-banner>', desc: '<button#next>' } })
    const r = await actWithConfirm(driver, { kind: 'click', domain: 'x.test', selector: '#next' })
    expect(r.status).toBe('covered')
    expect(r.reason).toContain('consent-banner')
    expect(r.result).toMatchObject({ ok: false })
  })

  it('成功但没观察到 click → status=done + delivery=unconfirmed', async () => {
    const { driver } = driverRaw({ tap: null })
    const r = await actWithConfirm(driver, { kind: 'click', domain: 'x.test', selector: '#go' }, { deadlineMs: 50 })
    expect(r.status).toBe('done')
    expect(r.delivery).toBe('unconfirmed')
  })

  it('没有回执动词的 driver 落回旧布尔路径', async () => {
    const click = vi.fn(async () => false)
    const r = await runActionDetailed({ click } as unknown as import('./page-driver.ts').PageDriver, {
      kind: 'click',
      domain: 'x.test',
      selector: '#gone',
    })
    expect(r).toEqual({ value: false })
  })
})
