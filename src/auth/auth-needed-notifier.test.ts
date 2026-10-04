import { describe, it, expect, vi } from 'vitest'
import { AuthNeededNotifier } from './auth-needed-notifier.ts'

const need = (facility: string) => ({ facility, label: facility, login: 'qr' as const, since: 't', lastReason: 'r' })

describe('AuthNeededNotifier', () => {
  it('broadcasts once on the not-needing → needing transition, not on repeats', () => {
    const bc = vi.fn()
    const n = new AuthNeededNotifier(bc)
    n.sync([])                 // nothing
    n.sync([need('xhs')])      // flip → 1 broadcast
    n.sync([need('xhs')])      // still needing → no new broadcast
    expect(bc).toHaveBeenCalledTimes(1)
    expect(bc).toHaveBeenCalledWith({ type: 'auth-needed', facility: 'xhs', need: need('xhs') })
  })
  it('re-broadcasts if a facility clears then flips again', () => {
    const bc = vi.fn()
    const n = new AuthNeededNotifier(bc)
    n.sync([need('xhs')])      // flip → broadcast 1
    n.sync([])                 // cleared
    n.sync([need('xhs')])      // flip again → broadcast 2
    expect(bc).toHaveBeenCalledTimes(2)
  })
})
