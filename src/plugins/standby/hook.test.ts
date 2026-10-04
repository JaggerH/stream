import { afterEach, describe, expect, it } from 'vitest'
import { setStandbyManager, standbyOrigin, standbyManaged, standbyDiagnose } from './hook.ts'
import type { StandbyDiagnosis, StandbyManager } from './manager.ts'

describe('standbyOrigin', () => {
  afterEach(() => setStandbyManager(null)) // 断言抛出时也要还原,别把 fake 泄漏给别的测试(终审 Minor 5)

  it('未接线 → null;接线后透传 manager.origin', () => {
    expect(standbyOrigin('asr')).toBeNull()
    const fake = { origin: (s: string) => (s === 'asr' ? 'http://127.0.0.1:44728' : null) } as unknown as StandbyManager
    setStandbyManager(fake)
    expect(standbyOrigin('asr')).toBe('http://127.0.0.1:44728')
    expect(standbyOrigin('nope')).toBeNull()
  })
})

describe('standbyManaged', () => {
  afterEach(() => setStandbyManager(null))

  it('未接线 → false', () => {
    expect(standbyManaged('voiceprint')).toBe(false)
  })

  it('接线后透传 manager.managed(含别名命中)', () => {
    const fake = { managed: (s: string) => s === 'voiceprint' || s === 'sherpa' } as unknown as StandbyManager
    setStandbyManager(fake)
    expect(standbyManaged('voiceprint')).toBe(true)
    expect(standbyManaged('sherpa')).toBe(true)
    expect(standbyManaged('nope')).toBe(false)
  })
})

describe('standbyDiagnose', () => {
  afterEach(() => setStandbyManager(null))

  it('未接线 → null（"standby 根本没接线"和"接了但查不到"是两回事，调用方要分得开）', async () => {
    await expect(standbyDiagnose('asr')).resolves.toBeNull()
  })

  it('接线后透传 manager.diagnose', async () => {
    const d: StandbyDiagnosis = {
      service: 'asr', managed: true, state: 'asleep', cachedOrigin: null,
      container: 'running', containerId: 'c1', hostPort: 46192,
    }
    setStandbyManager({ diagnose: async () => d } as unknown as StandbyManager)
    await expect(standbyDiagnose('asr')).resolves.toEqual(d)
  })
})
