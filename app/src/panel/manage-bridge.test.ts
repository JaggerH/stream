import { describe, it, expect, vi } from 'vitest'
import { manageBridge } from './manage-bridge.ts'

describe('manageBridge', () => {
  it('没有宿主登记时 open 回 false 且不抛；登记后转发；退订后又回 false', () => {
    expect(manageBridge.available()).toBe(false)
    expect(manageBridge.open({ view: 'source-health', sourceId: 'a' })).toBe(false)
    const fn = vi.fn()
    const off = manageBridge.register(fn)
    expect(manageBridge.available()).toBe(true)
    expect(manageBridge.open({ view: 'source-health', sourceId: 'a' })).toBe(true)
    expect(fn).toHaveBeenCalledWith({ view: 'source-health', sourceId: 'a' })
    off()
    expect(manageBridge.open()).toBe(false)
  })
})
