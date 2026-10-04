import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from './store.ts'
import { EventsService, lazyNotify } from './service.ts'

const makeSvc = () => {
  const frames: any[] = []
  const store = new EventStore(join(mkdtempSync(join(tmpdir(), 'evsvc-')), 'e.json'))
  return { svc: new EventsService(store, (m) => frames.push(m)), frames }
}

describe('EventsService', () => {
  it('emit appends, broadcasts { type: event, event } and lists newest first', () => {
    const { svc, frames } = makeSvc()
    svc.emit({ type: 'transcribe.done', title: 'A', severity: 'info' })
    svc.emit({ type: 'harvest.error', title: 'B', severity: 'error' })
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ type: 'event', event: { title: 'A' } })
    expect(frames[0].refreshed).toBeUndefined()
    expect(svc.list().map((e) => e.title)).toEqual(['B', 'A'])
  })

  it('same dedupeKey while unread → refreshes in place, broadcasts refreshed: true', () => {
    const { svc, frames } = makeSvc()
    const a = svc.emit({ type: 'auth.needed', title: 'A', severity: 'warn', dedupeKey: 'auth:xhs' })
    const b = svc.emit({ type: 'auth.needed', title: 'A2', severity: 'warn', dedupeKey: 'auth:xhs' })
    expect(b.id).toBe(a.id) // refreshed, not appended
    expect(svc.list()).toHaveLength(1)
    expect(frames[1]).toMatchObject({ type: 'event', refreshed: true })
  })

  it('same dedupeKey after read → a NEW event (the user should be notified again)', () => {
    const { svc } = makeSvc()
    const a = svc.emit({ type: 'auth.needed', title: 'A', severity: 'warn', dedupeKey: 'auth:xhs' })
    svc.markRead({ ids: [a.id] })
    const b = svc.emit({ type: 'auth.needed', title: 'A', severity: 'warn', dedupeKey: 'auth:xhs' })
    expect(b.id).not.toBe(a.id)
    expect(svc.list()).toHaveLength(2)
  })

  it('status-qualified transcribe dedupeKey: an unread error does not absorb a later done', () => {
    // Regression for bootstrap.ts's transcribe onSettled: done and error used to share
    // `transcribe:${itemId}`, so a retry's success got folded into the unread error row
    // (refreshed frames skip the toast) and the user never saw the success notification.
    const { svc, frames } = makeSvc()
    const err = svc.emit({
      type: 'transcribe.error',
      title: '转写失败：i1',
      severity: 'error',
      dedupeKey: 'transcribe:i1:error',
    })
    const done = svc.emit({
      type: 'transcribe.done',
      title: '转写完成：i1',
      severity: 'info',
      dedupeKey: 'transcribe:i1:done',
    })
    expect(done.id).not.toBe(err.id)
    expect(svc.list()).toHaveLength(2)
    expect(frames[1]).toMatchObject({ type: 'event' })
    expect(frames[1].refreshed).toBeUndefined()
  })
})

// ── lazyNotify：接线的时候通知中心还不存在 ────────────────────────────────────
// bootstrap 的装配序是 packages → harvest → **events**，也就是说 target-miss 的 reporter 和
// ExtRelay 拿到 notify 回调那一刻 `ctx.streamEvents` 还是 undefined。把服务在装配期取成一个
// 字段 = 两条通知永远发不出去，且**一个字都不报**（AGENTS.md「装配期取的值 = 冻住的答案」）。
//
// 这条测试天然容易假绿：thunk 写法和快照写法在「一直可用」的路径上表现一模一样。所以它必须
// 走「先没有、后来才有」这条时序，改回 `const svc = get()` 时会当场变红。
describe('lazyNotify', () => {
  it('接线时还没有 events → 丢掉且不抛；后来有了 → 跟得上', () => {
    let svc: EventsService | undefined
    const notify = lazyNotify(() => svc)

    // 接线那一刻服务还没挂：不能抛，也不能记住这个 undefined
    expect(() => notify({ type: 'plugin.target-miss', title: '早到的那条', severity: 'error' })).not.toThrow()

    const built = makeSvc()
    svc = built.svc
    notify({ type: 'plugin.target-miss', title: '后到的那条', severity: 'error' })
    expect(built.svc.list().map((e) => e.title)).toEqual(['后到的那条'])
  })

  it('emit 自己抛也吞掉 —— 通知通道没资格掀翻主链路', () => {
    const notify = lazyNotify(() => ({ emit: () => { throw new Error('boom') } }) as unknown as EventsService)
    expect(() => notify({ type: 'x', title: 'y', severity: 'info' })).not.toThrow()
  })
})
