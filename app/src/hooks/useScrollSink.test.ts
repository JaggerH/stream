import { describe, it, expect } from 'vitest'
import { canScrollY } from './useScrollSink.ts'

/** Build a div with controllable scroll metrics (jsdom doesn't lay out, so we define them). */
function mkEl(opts: { overflowY?: string; scrollHeight?: number; clientHeight?: number; scrollTop?: number }) {
  const el = document.createElement('div')
  if (opts.overflowY) el.style.overflowY = opts.overflowY
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight ?? 0, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight ?? 0, configurable: true })
  el.scrollTop = opts.scrollTop ?? 0
  return el
}

describe('canScrollY', () => {
  it('is false when overflow-y is not auto/scroll', () => {
    const el = mkEl({ overflowY: 'visible', scrollHeight: 1000, clientHeight: 100 })
    expect(canScrollY(el, 50)).toBe(false)
  })

  it('is false when content does not overflow', () => {
    const el = mkEl({ overflowY: 'auto', scrollHeight: 100, clientHeight: 100 })
    expect(canScrollY(el, 50)).toBe(false)
  })

  it('scrolling down: true only when not pinned at the bottom', () => {
    const atTop = mkEl({ overflowY: 'auto', scrollHeight: 1000, clientHeight: 100, scrollTop: 0 })
    expect(canScrollY(atTop, 50)).toBe(true)
    const atBottom = mkEl({ overflowY: 'auto', scrollHeight: 1000, clientHeight: 100, scrollTop: 900 })
    expect(canScrollY(atBottom, 50)).toBe(false)
  })

  it('scrolling up: true only when not pinned at the top', () => {
    const atTop = mkEl({ overflowY: 'scroll', scrollHeight: 1000, clientHeight: 100, scrollTop: 0 })
    expect(canScrollY(atTop, -50)).toBe(false)
    const scrolled = mkEl({ overflowY: 'scroll', scrollHeight: 1000, clientHeight: 100, scrollTop: 300 })
    expect(canScrollY(scrolled, -50)).toBe(true)
  })
})
