import { describe, it, expect } from 'vitest'
import { relayHealth, humanAgo, type CapabilitySnapshot } from './relay-health.ts'

const cap = (p: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  state: 'disconnected',
  connected: false,
  everSeen: true,
  ...p,
})

describe('relayHealth：把「没连上」拆成各自下一步不同的几种', () => {
  it('SW 连着 ⇒ ready，不说废话、不给按钮', () => {
    const h = relayHealth(true, null)
    expect(h.kind).toBe('ready')
    expect(h.tone).toBe('ok')
    expect(h.detail).toBe('')
    expect(h.canReconnect).toBe(false)
  })

  it('后端读不到 ⇒ backend-unreachable，不编病因', () => {
    const h = relayHealth(false, null)
    expect(h.kind).toBe('backend-unreachable')
    expect(h.canReconnect).toBe(false)
  })

  it('连过、现在断了 ⇒ offline + 可一键重连，并说明断了多久', () => {
    const h = relayHealth(false, cap({ lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
    expect(h.kind).toBe('offline')
    expect(h.canReconnect).toBe(true)
    expect(h.detail).toContain('5m ago')
  })

  it('lastSeenAt 缺失/不可解析时照样给出一句话，不吐 NaN', () => {
    expect(relayHealth(false, cap()).detail).not.toMatch(/NaN|Invalid/)
    expect(relayHealth(false, cap({ lastSeenAt: 'not-a-date' })).detail).not.toMatch(/NaN|Invalid/)
  })

  it('从没连上过 ⇒ never-seen，文案指向"换/装扩展"而不是"等重连"', () => {
    const h = relayHealth(false, cap({ everSeen: false, state: 'never-seen' }))
    expect(h.kind).toBe('never-seen')
    expect(h.tone).toBe('bad')
  })

  it('后端此刻连着别的浏览器 ⇒ other-browser，且**不给**重连按钮', () => {
    // 这一条是判定顺序的钉子：这种情形下 everSeen 必然为 true，若按 everSeen 先判就会
    // 报成 offline，给出一个在这个 Chrome 里永远点不好的按钮。
    const h = relayHealth(false, cap({ connected: true, everSeen: true, state: 'ready' }))
    expect(h.kind).toBe('other-browser')
    expect(h.canReconnect).toBe(false)
  })

  it('每一种非 ready 都有可显示的 detail —— 没有"坏了但不说为什么"的状态', () => {
    const cases: (CapabilitySnapshot | null)[] = [
      null,
      cap(),
      cap({ everSeen: false }),
      cap({ connected: true }),
    ]
    for (const c of cases) expect(relayHealth(false, c).detail.length).toBeGreaterThan(0)
  })
})

describe('humanAgo', () => {
  it.each([
    [1_000, '1s'],
    [90_000, '2m'],
    [3 * 3600_000, '3h'],
    [5 * 24 * 3600_000, '5d'],
  ])('%i ms → %s', (ms, want) => {
    expect(humanAgo(ms)).toBe(want)
  })
})
