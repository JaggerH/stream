import { describe, expect, it } from 'vitest'
import {
  ANDROID_OP_NAMES,
  AndroidUnsupportedCapabilityError,
  AndroidUnsupportedOpError,
  makeAndroidDriver,
  type AndroidOps,
} from './android-driver.ts'

function recorder(replies: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; args?: Record<string, unknown> }> = []
  const ops: AndroidOps = async (op, args) => {
    calls.push({ op, args })
    return replies[op]
  }
  return { calls, ops }
}

const RECT = { x: 100, y: 200, w: 40, h: 30 }

describe('android remote driver', () => {
  it('declares the normalized device actions', () => {
    expect([...ANDROID_OP_NAMES]).toEqual(
      expect.arrayContaining([
        'tap', 'longPress', 'swipe', 'scroll', 'type', 'setText', 'press', 'screenshot',
        'find', 'windows', 'openApp', 'sleep', 'url',
      ]),
    )
  })

  it('maps tap / longPress / swipe to the wire ops and keeps their receipts', async () => {
    const { calls, ops } = recorder({ click: { via: 'coords' }, longPress: { via: 'coords' }, swipe: { via: 'coords' } })
    const d = makeAndroidDriver(ops)
    expect(await d.tap(RECT)).toEqual({ via: 'coords' })
    expect(await d.longPress(RECT, 900)).toEqual({ via: 'coords' })
    expect(await d.swipe({ x: 10, y: 20 }, { x: 30, y: 40 }, 300)).toEqual({ via: 'coords' })
    expect(calls).toEqual([
      { op: 'click', args: { rect: RECT, button: 'left' } },
      { op: 'longPress', args: { rect: RECT, durationMs: 900 } },
      { op: 'swipe', args: { from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, durationMs: 300 } },
    ])
  })

  it('refuses an op the device did not declare, before sending anything', async () => {
    const { calls, ops } = recorder()
    const d = makeAndroidDriver(ops, { ops: new Set(['windows', 'find', 'click']) })
    await expect(d.swipe({ x: 0, y: 0 }, { x: 1, y: 1 }, 200)).rejects.toBeInstanceOf(AndroidUnsupportedOpError)
    expect(calls).toEqual([])
  })

  it('refuses long press / swipe below ui.act v2', async () => {
    const { calls, ops } = recorder()
    const d = makeAndroidDriver(ops, { caps: { 'ui.act': { v: 1 }, 'ui.tree': { v: 7 } } })
    await expect(d.longPress(RECT, 600)).rejects.toBeInstanceOf(AndroidUnsupportedCapabilityError)
    await expect(d.swipe({ x: 0, y: 0 }, { x: 1, y: 1 }, 200)).rejects.toBeInstanceOf(AndroidUnsupportedCapabilityError)
    expect(calls).toEqual([])
  })

  it('refuses a viewId query below ui.tree v7', async () => {
    const { calls, ops } = recorder({ find: { elements: [] } })
    const d = makeAndroidDriver(ops, { caps: { 'ui.tree': { v: 6 } } })
    await expect(d.find({ viewId: 'com.example:id/search' })).rejects.toBeInstanceOf(AndroidUnsupportedCapabilityError)
    expect(calls).toEqual([])
  })

  it('parses a find reply and forwards the OCR mode', async () => {
    const reply = {
      elements: [{ ref: 'n1', role: 'Button', name: '搜索', className: 'android.widget.Button', viewId: 'com.example:id/search', rect: RECT }],
      viewport: { width: 1080, height: 2400 },
      ocr: { ran: true, cached: false, texts: 2 },
      timing: { ocrMs: 120 },
    }
    const { calls, ops } = recorder({ find: reply })
    const d = makeAndroidDriver(ops)
    const found = await d.find({ role: 'Button', nameContains: '搜' }, { ocr: 'on' })
    expect(found.elements[0]).toMatchObject({ ref: 'n1', viewId: 'com.example:id/search' })
    expect(found.viewport).toEqual({ width: 1080, height: 2400 })
    expect(found.ocr).toEqual({ ran: true, cached: false, texts: 2 })
    expect(found.timing).toEqual({ ocrMs: 120 })
    expect(calls[0]).toEqual({ op: 'find', args: { query: { role: 'Button', nameContains: '搜' }, ocr: 'on' } })
  })

  it('openApp forwards the package and fresh flag', async () => {
    const { calls, ops } = recorder({ focusApp: { ok: true, fresh: true } })
    const d = makeAndroidDriver(ops)
    expect(await d.openApp('com.example.app', true)).toBe(true)
    expect(calls[0]).toEqual({ op: 'focusApp', args: { match: { process: 'com.example.app' }, fresh: true } })
  })

  it('returns a screenshot buffer or null', async () => {
    const { ops } = recorder({ screenshot: { base64: Buffer.from('jpeg').toString('base64') } })
    const d = makeAndroidDriver(ops)
    expect((await d.screenshot())?.toString()).toBe('jpeg')
    const empty = makeAndroidDriver(recorder({ screenshot: {} }).ops)
    expect(await empty.screenshot()).toBeNull()
  })
})
