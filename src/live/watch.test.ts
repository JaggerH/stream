import { describe, it, expect, vi } from 'vitest'
import { watchArtifactsDir } from './watch.ts'

function fakeWatch() {
  const handlers: Array<(e: string, f: string) => void> = []
  const watch = ((_dir: unknown, _opts: unknown, cb: (e: string, f: string) => void) => {
    handlers.push(cb)
    return { close: () => {} }
  }) as never
  return { watch, fire: (f: string) => handlers.forEach((h) => h('change', f)) }
}

describe('watchArtifactsDir', () => {
  it('一个 run 连写多个文件只推一次(去抖)', async () => {
    vi.useFakeTimers()
    const { watch, fire } = fakeWatch()
    const onChanged = vi.fn()
    watchArtifactsDir({ dir: '/d', streamId: 's1', debounceMs: 50, onChanged, onNewRun: () => {}, watch, listRuns: () => [] })
    fire('r1/run.json'); fire('r1/a.json'); fire('r1/b.json')
    await vi.advanceTimersByTimeAsync(60)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledWith('s1')
    vi.useRealTimers()
  })

  it('出现没见过的 run id 时报一条新 run', async () => {
    vi.useFakeTimers()
    const { watch, fire } = fakeWatch()
    let runs = ['r1']
    const onNewRun = vi.fn()
    watchArtifactsDir({ dir: '/d', streamId: 's1', debounceMs: 10, onChanged: () => {}, onNewRun, watch, listRuns: () => runs })
    await vi.advanceTimersByTimeAsync(20)
    runs = ['r1', 'r2']
    fire('r2/run.json')
    await vi.advanceTimersByTimeAsync(20)
    expect(onNewRun).toHaveBeenCalledWith('r2')
    expect(onNewRun).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('返回的函数能停掉监听', () => {
    const { watch } = fakeWatch()
    const stop = watchArtifactsDir({ dir: '/d', streamId: 's1', onChanged: () => {}, onNewRun: () => {}, watch, listRuns: () => [] })
    expect(() => stop()).not.toThrow()
  })
})
