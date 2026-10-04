import { describe, it, expect, vi } from 'vitest'
import { findPairedPeer } from './pairing.ts'

const TOKEN = 'tok-abc'

describe('findPairedPeer', () => {
  it('选中第一个算得出 proof 的候选', async () => {
    const verify = vi.fn(async (base: string) => {
      if (base !== 'http://b') throw new Error('not ours')
    })
    const got = await findPairedPeer(['http://a', 'http://b', 'http://c'], {
      token: async () => TOKEN,
      verify,
    })
    expect(got).toEqual({ baseUrl: 'http://b', token: TOKEN })
    // c 不该被问——第一个证明成功就停
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('【核心】答得出话但证明不了的候选一律跳过——选择判据是证明，不是"谁先应答"', async () => {
    // 抢到端口的本机进程会照常应答，但它不知道 token，算不出 proof。
    const verify = vi.fn(async (base: string) => {
      if (base === 'http://impostor') throw new Error('bad proof')
      if (base !== 'http://real') throw new Error('unreachable')
    })
    const got = await findPairedPeer(['http://impostor', 'http://real'], {
      token: async () => TOKEN,
      verify,
    })
    expect(got?.baseUrl).toBe('http://real')
  })

  it('【核心】一个都证明不了就回 null——绝不回落到"连第一个答话的"', async () => {
    const got = await findPairedPeer(['http://a', 'http://b'], {
      token: async () => TOKEN,
      verify: async () => { throw new Error('bad proof') },
    })
    expect(got).toBeNull()
  })

  it('取不到 token 就直接回 null，一个候选都不问', async () => {
    const verify = vi.fn()
    const got = await findPairedPeer(['http://a'], {
      token: async () => { throw new Error('native host 没登记') },
      verify,
    })
    expect(got).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })

  it('候选表为空回 null', async () => {
    expect(await findPairedPeer([], { token: async () => TOKEN, verify: async () => {} })).toBeNull()
  })
})
