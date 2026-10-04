import { describe, it, expect } from 'vitest'
import { RunProbe } from './recipe-probe.ts'

describe('RunProbe', () => {
  it('records per-phase wall-clock elapsed from an injected clock', () => {
    let t = 1000
    const probe = new RunProbe('xhs-home', false, { now: () => t })
    t = 1500; probe.mark('entry')     // 500ms
    t = 1560; probe.mark('login')     // 60ms
    t = 4560; probe.mark('step#0 scroll') // 3000ms
    expect(probe.timings()).toEqual([
      { phase: 'entry', ms: 500 },
      { phase: 'login', ms: 60 },
      { phase: 'step#0 scroll', ms: 3000 },
    ])
  })

  it('when disabled: timing still collected, no log line', () => {
    const logs: string[] = []
    const probe = new RunProbe('s', false, { now: () => 0, log: (l) => logs.push(l) })
    probe.mark('entry')
    expect(probe.timings()).toHaveLength(1)
    expect(logs).toEqual([])
  })

  it('when enabled: logs each phase + a summary', () => {
    const logs: string[] = []
    let t = 0
    const probe = new RunProbe('xhs-home', true, { now: () => (t += 100), log: (l) => logs.push(l) })
    probe.mark('entry')
    probe.mark('step#0 scroll')
    probe.mark('harvest')
    probe.summary(47)
    expect(logs).toHaveLength(4) // 3 phases + summary
    expect(logs[3]).toContain('TOTAL')
    expect(logs[3]).toContain('items 47')
  })

  it('summary is silent when disabled', () => {
    const logs: string[] = []
    const probe = new RunProbe('s', false, { now: () => 0, log: (l) => logs.push(l) })
    probe.summary(3)
    expect(logs).toEqual([])
  })
})
