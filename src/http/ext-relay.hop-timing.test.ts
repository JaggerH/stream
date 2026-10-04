import { describe, it, expect, vi } from 'vitest'
import { ExtRelay, type ExtSocket } from './ext-relay.ts'
import type { DebugEntry } from '../debug.ts'

// ── 慢命令的分段时间戳：后端这一半 ─────────────────────────────────────────────
// `Page.navigate` 偶发挂满 30s，而后端此前对这条链路一个字都不记：超时只抛
// ExtRelayTimeout（只知道"没回"），慢但回来了则完全无声。这组测试钉住后端侧的账本。
//
// **时钟**：后端和 SW 是两个钟（WSL 墙钟还会偶发回退），所以这里报出去的每个时长都必须是
// 同一侧两个时间戳之差。`wireMs` 是唯一跨侧的量，它由**两个同侧时长相减**得到
// （backendTotalMs - swMs），不做跨钟减法。设计见
// docs/superpowers/specs/2026-08-19-ext-cdp-slow-command-hop-timing-design.md §2。

function harness() {
  const sent: any[] = []
  const entries: DebugEntry[] = []
  const sock: ExtSocket = { send: (d) => sent.push(JSON.parse(d)) }
  const relay = new ExtRelay({ onDebug: (e) => entries.push(e) })
  relay.connect(sock)
  return { relay, sent, entries }
}

const field = (e: DebugEntry, label: string) => e.fields.find((f) => f.label === label)?.value

describe('后端侧慢命令账本', () => {
  it('快命令不记账 —— 这条通道是 200 条的环，高频路径打进去等于把它冲干净', async () => {
    const { relay, sent, entries } = harness()
    const p = relay.sendCommand(7, 'Page.navigate', { url: 'https://a.example' })
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {}, swMs: 3 }))
    await p
    expect(entries).toHaveLength(0)
  })

  it('慢但回来了：记下后端总耗时、SW 自报耗时、以及两者之差（WS 那两段）', async () => {
    vi.useFakeTimers()
    try {
      const { relay, sent, entries } = harness()
      const p = relay.sendCommand(7, 'Page.navigate', { url: 'https://a.example' })
      // 后端钟走了 29927ms（活体撞到的那个数），SW 自报它这一侧只用了 120ms
      // → 剩下的 29807ms 全在 WS 上（去程+回程，本设计不区分）。
      vi.advanceTimersByTime(29_927)
      relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {}, swMs: 120 }))
      await p

      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.channel).toBe('ext-cdp')
      expect(e.key).toBe('relay-slow')
      expect(e.ok).toBe(false)
      expect(field(e, 'command')).toBe('Page.navigate')
      expect(field(e, 'tabId')).toBe('7')
      expect(field(e, 'backendTotalMs')).toBe('29927')
      expect(field(e, 'swMs')).toBe('120')
      expect(field(e, 'wireMs')).toBe('29807')
    } finally {
      vi.useRealTimers()
    }
  })

  it('老版本扩展不带 swMs → wireMs 报 unknown，绝不用 0 顶替', async () => {
    vi.useFakeTimers()
    try {
      const { relay, sent, entries } = harness()
      const p = relay.sendCommand(7, 'Page.navigate', {})
      vi.advanceTimersByTime(9_000)
      relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {} }))
      await p

      const e = entries[0]
      expect(field(e, 'backendTotalMs')).toBe('9000')
      // 0 会把整段时间栽给 SW —— 那是一个读起来毫无破绽的错误结论
      expect(field(e, 'swMs')).toBe('unknown')
      expect(field(e, 'wireMs')).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('wireMs 可以是负数，原样报出去不 clamp —— clamp 会把噪声藏起来', async () => {
    vi.useFakeTimers()
    try {
      const { relay, sent, entries } = harness()
      const p = relay.sendCommand(7, 'Page.navigate', {})
      vi.advanceTimersByTime(6_000)
      relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {}, swMs: 6_003 }))
      await p
      expect(field(entries[0], 'wireMs')).toBe('-3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('30s 闸门到点、命令根本没回：单独一条 relay-timeout，并写清怎么判"送到没送到"', async () => {
    vi.useFakeTimers()
    try {
      const { relay, entries } = harness()
      const p = relay.sendCommand(7, 'Page.navigate', {}).catch((e) => e)
      vi.advanceTimersByTime(30_000)
      await p

      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.key).toBe('relay-timeout')
      expect(e.ok).toBe(false)
      expect(field(e, 'command')).toBe('Page.navigate')
      expect(field(e, 'tabId')).toBe('7')
      expect(field(e, 'waitedMs')).toBe('30000')
      // 判据必须写在记录里 —— 半夜看这条的人手里只有它
      expect(e.summary).toMatch(/slow-command/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没接 onDebug 也照常工作 —— 记账通道没资格掀翻一条能用的 relay', async () => {
    const sent: any[] = []
    const relay = new ExtRelay()
    relay.connect({ send: (d) => sent.push(JSON.parse(d)) })
    const p = relay.sendCommand(7, 'Page.navigate', {})
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: { ok: 1 } }))
    await expect(p).resolves.toEqual({ ok: 1 })
  })

  it('回执里的 swMs 不污染 result —— 上层拿到的还是原样的 CDP 结果', async () => {
    const { relay, sent } = harness()
    const p = relay.sendCommand(7, 'Page.navigate', {})
    relay.handleMessage(JSON.stringify({ id: sent[0].id, result: { frameId: 'F' }, swMs: 42 }))
    await expect(p).resolves.toEqual({ frameId: 'F' })
  })
})

// ── 通知中心：只有「挂满闸门」那一档配打扰用户 ────────────────────────────────
// debug bus 是 200 条的内存 ring，重启即失；用户感知到「内容刷不出来」时现场早没了。
// 慢命令**不**通知：5s 门槛在活体上频繁越线，通知它等于把铃铛按住不放。
// 设计见 docs/superpowers/specs/2026-08-19-silent-failure-notifications-design.md §2.2。
describe('中继超时进通知中心', () => {
  function notifyHarness(timeoutMs = 30_000) {
    const notified: any[] = []
    const entries: DebugEntry[] = []
    const relay = new ExtRelay({ timeoutMs, onDebug: (e) => entries.push(e), onNotify: (n) => notified.push(n) })
    const sent: any[] = []
    relay.connect({ send: (d) => sent.push(JSON.parse(d)) })
    return { relay, sent, entries, notified }
  }

  it('等满闸门没回执 → 通知一条，正文说人话、指向 ext-cdp 频道', async () => {
    vi.useFakeTimers()
    try {
      const { relay, notified } = notifyHarness()
      const p = relay.sendCommand(7, 'Page.navigate', {}).catch((e) => e)
      vi.advanceTimersByTime(30_000)
      await p
      expect(notified).toHaveLength(1)
      const n = notified[0]
      expect(n.type).toBe('ext-cdp.timeout')
      expect(n.severity).toBe('warn')
      expect(n.title).toBe('浏览器没有回应，这一轮采集中断')
      expect(n.body).toMatch(/30 秒/)
      expect(n.body).toMatch(/ext-cdp 频道/)
      // tabId 不进 key：tab id 每次运行都变，编进去等于关掉去重
      expect(n.dedupeKey).toBe('ext-relay-timeout:Page.navigate')
    } finally {
      vi.useRealTimers()
    }
  })

  // 正文是写给用户的白话；他复制这条是为了贴给 AI，所以还得带一份诊断现场。
  // **五个分跳数字在超时这一刻后端一个都没有**（它们只在扩展侧产生），如实写 unknown：
  // 「扩展还没重载 / 根本没走到 SW」和「真的 0ms」是两码事，填 0 就把这个分界抹平了。
  it('超时通知带 detail：command/tabId/闸门时长 + 五个分跳一律 unknown 而不是 0', async () => {
    vi.useFakeTimers()
    try {
      const { relay, notified } = notifyHarness()
      const p = relay.sendCommand(7, 'Page.navigate', {}).catch((e) => e)
      vi.advanceTimersByTime(30_000)
      await p
      const d = notified[0].detail as string
      expect(d).toContain('command=Page.navigate')
      expect(d).toContain('tabId=7')
      expect(d).toContain('waitedMs=30000')
      for (const k of ['cdpIssued', 'preCdpMs', 'cdpMs', 'swMs', 'wireMs']) {
        expect(d).toContain(`${k}=unknown`)
      }
      expect(d).not.toMatch(/(cdpIssued|preCdpMs|cdpMs|swMs|wireMs)=0\b/)
      expect(d).toContain('扩展连接=') // 「命令有没有可能根本没送出去」的第一问
    } finally {
      vi.useRealTimers()
    }
  })

  it('慢但回来了 → 只记 debug bus，不通知', async () => {
    vi.useFakeTimers()
    try {
      const { relay, sent, entries, notified } = notifyHarness()
      const p = relay.sendCommand(7, 'Page.navigate', {})
      vi.advanceTimersByTime(9_000)
      relay.handleMessage(JSON.stringify({ id: sent[0].id, result: {}, swMs: 20 }))
      await p
      expect(entries).toHaveLength(1)
      expect(notified).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('notify 自己抛也吞掉 —— 通知通道没资格再补一刀', async () => {
    vi.useFakeTimers()
    try {
      const relay = new ExtRelay({ timeoutMs: 1_000, onNotify: () => { throw new Error('events exploded') } })
      relay.connect({ send: () => {} })
      const p = relay.sendCommand(7, 'Page.navigate', {}).catch((e) => e)
      vi.advanceTimersByTime(1_000)
      await expect(p).resolves.toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
  })
})
