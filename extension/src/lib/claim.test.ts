import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimProfile, handleClaimReply } from './claim.ts'

afterEach(() => { vi.useRealTimers() })

/** 几条假绑定：记下各自收到的帧。`live` 可以中途变（模拟之后才连上的绑定）。 */
function rig(ids: string[]) {
  const sent: string[] = []
  const live = [...ids]
  const sockets = () => live.map((id) => [id, {
    send: (raw: string) => {
      const m = JSON.parse(raw) as { type: string; nonce: string }
      sent.push(`${id}:${m.type}:${m.nonce}`)
    },
  }] as [string, { send(d: string): void }])
  const remembered: string[] = []
  const remember = async (dir: string, name: string) => { remembered.push(`${dir}|${name}`) }
  return { sent, live, sockets, remembered, remember }
}

describe('claimProfile', () => {
  it('经全部已连绑定各发一次；第一个 ok 记进存储并返回', async () => {
    vi.useFakeTimers()
    const r = rig(['local', 'ext:1'])
    const p = claimProfile('n1', { sockets: r.sockets, remember: r.remember })
    expect(r.sent).toEqual(['local:claim:n1', 'ext:1:claim:n1'])
    expect(handleClaimReply('ext:1', { type: 'claim-result', nonce: 'n1', ok: false, error: '认领码不认识或已经用过' })).toBe(true)
    handleClaimReply('local', { type: 'claim-result', nonce: 'n1', ok: true, profileDir: 'Profile 1', profileName: '个人' })
    await expect(p).resolves.toEqual({ profileDir: 'Profile 1', profileName: '个人' })
    expect(r.remembered).toEqual(['Profile 1|个人'])
    // 成了就不再轮询重发
    await vi.advanceTimersByTimeAsync(2000)
    expect(r.sent).toHaveLength(2)
  })

  it('之后才连上的绑定也补发一次，已发过的不重发', async () => {
    vi.useFakeTimers()
    const r = rig([])
    const p = claimProfile('n2', { sockets: r.sockets, remember: r.remember, pollMs: 100 })
    r.live.push('local')
    await vi.advanceTimersByTimeAsync(300)
    expect(r.sent).toEqual(['local:claim:n2'])
    handleClaimReply('local', { type: 'claim-result', nonce: 'n2', ok: true, profileDir: 'Default', profileName: '工作' })
    await expect(p).resolves.toMatchObject({ profileDir: 'Default' })
  })

  it('连着的都拒了：立刻带着原因失败，不记任何东西', async () => {
    vi.useFakeTimers()
    const r = rig(['local'])
    const p = claimProfile('n3', { sockets: r.sockets, remember: r.remember })
    handleClaimReply('local', { type: 'claim-result', nonce: 'n3', ok: false, error: '这个认领码不是给这台机器的' })
    await expect(p).rejects.toThrow('不是给这台机器的')
    expect(r.remembered).toEqual([])
  })

  it('一条都没连上：超时说清楚；连着但没人回（老后端）：超时', async () => {
    vi.useFakeTimers()
    const none = claimProfile('n4', { sockets: rig([]).sockets, timeoutMs: 1000 })
    const silent = claimProfile('n5', { sockets: rig(['local']).sockets, timeoutMs: 1000 })
    const a = expect(none).rejects.toThrow('没有连上任何 Stream')
    const b = expect(silent).rejects.toThrow('没有回应')
    await vi.advanceTimersByTimeAsync(1000)
    await a
    await b
  })

  it('别的帧不是认领回话', () => {
    expect(handleClaimReply('local', { id: 1, op: 'list' })).toBe(false)
    expect(handleClaimReply('local', null)).toBe(false)
  })
})
