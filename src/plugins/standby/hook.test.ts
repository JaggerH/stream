import { describe, expect, it } from 'vitest'
import { StandbyHooks } from './hook.ts'
import type { StandbyManager } from './manager.ts'

describe('StandbyHooks.origin', () => {
  it('未接线 → null;接线后透传 manager.origin', () => {
    const h = new StandbyHooks()
    expect(h.origin('asr')).toBeNull()
    const fake = { origin: (s: string) => (s === 'asr' ? 'http://127.0.0.1:44728' : null) } as unknown as StandbyManager
    h.bind(fake)
    expect(h.origin('asr')).toBe('http://127.0.0.1:44728')
    expect(h.origin('nope')).toBeNull()
  })
})

describe('StandbyHooks.managed', () => {
  it('未接线 → false', () => {
    expect(new StandbyHooks().managed('asr')).toBe(false)
  })
})

describe('StandbyHooks.diagnose', () => {
  it('未接线 → null（不是一份空 diagnosis）', async () => {
    expect(await new StandbyHooks().diagnose('asr')).toBeNull()
  })
})

describe('一个实例一份', () => {
  it('A 接了 manager，B 仍全空', () => {
    const a = new StandbyHooks()
    const b = new StandbyHooks()
    a.bind({ origin: () => 'http://a', managed: () => true, snapshot: () => [] } as unknown as StandbyManager)
    expect(a.managed('x')).toBe(true)
    expect(b.managed('x')).toBe(false)
    expect(b.origin('x')).toBeNull()
  })
})
