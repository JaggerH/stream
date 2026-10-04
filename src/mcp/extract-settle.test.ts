import { describe, it, expect, vi } from 'vitest'
import { settleWithin, EXTRACT_SETTLE_POLL_MS } from './extract-settle.ts'

/** 假时钟：`sleep` 不真睡，只把时间往前拨——测试必须秒回，否则这几条就要真等 20 秒。 */
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => { t += ms }),
    advance: (ms: number) => { t += ms },
  }
}

describe('settleWithin', () => {
  it('已经落定 → 一次都不睡（绝大多数调用是命中缓存，一秒都不该等）', async () => {
    const clock = fakeClock()
    expect(await settleWithin({ pending: () => false, sleep: clock.sleep, now: clock.now })).toBe(true)
    expect(clock.sleep).not.toHaveBeenCalled()
  })

  it('跑着 → 睡着等，落定就立刻回 true', async () => {
    const clock = fakeClock()
    let left = 3
    const pending = () => (left-- > 0)
    expect(await settleWithin({ pending, sleep: clock.sleep, now: clock.now }, 10_000)).toBe(true)
    expect(clock.sleep).toHaveBeenCalledTimes(3)
    expect(clock.sleep).toHaveBeenCalledWith(EXTRACT_SETTLE_POLL_MS)
  })

  it('预算花光还没好 → false（照常回 running 让模型再调一次，那次重试才有意义）', async () => {
    const clock = fakeClock()
    expect(await settleWithin({ pending: () => true, sleep: clock.sleep, now: clock.now }, 2_000)).toBe(false)
    // 2000ms / 400ms = 5 次；**不许无限等**——转写一小时的播客要几分钟，等到好为止就是挂住调用方。
    expect(clock.sleep).toHaveBeenCalledTimes(5)
  })

  it('预算为 0 → 只问一次，不睡', async () => {
    const clock = fakeClock()
    expect(await settleWithin({ pending: () => true, sleep: clock.sleep, now: clock.now }, 0)).toBe(false)
    expect(clock.sleep).not.toHaveBeenCalled()
  })
})
