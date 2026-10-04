import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from '../outbox.ts'
import { fakeSource } from './source.ts'
import { runClient, type WsLike } from './client.ts'
import { encodeFrame, decodeFrame } from '../protocol.ts'

const mkOutbox = () => new Outbox(join(mkdtempSync(join(tmpdir(), 'esc-')), 'o.db'), Database)

/** 一个可编程的假 ws：记录 send、可手动投递 message、可手动 close。 */
function fakeWs() {
  let onMsg: (r: string) => void = () => {}
  let onClose: () => void = () => {}
  const sent: string[] = []
  const ws: WsLike = {
    send: (r) => sent.push(r),
    onMessage: (cb) => (onMsg = cb),
    onClose: (cb) => (onClose = cb),
    close: () => onClose(),
  }
  return { ws, sent, deliver: (r: string) => onMsg(r), drop: () => onClose() }
}

describe('runClient', () => {
  it('源产出 → 先落盘 → 连上后推成 event 帧；收 ack 清 pending', async () => {
    const outbox = mkOutbox()
    const src = fakeSource()
    const w = fakeWs()
    const deps = {
      connect: vi.fn().mockResolvedValue(w.ws),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onOrphanExit: vi.fn(),
    }
    const c = runClient(outbox, src, deps, { orphanTtlMs: 10_000 })
    await Promise.resolve() // 让连接与 hello 落地
    src.push({ id: 'o1', source: src.name, receivedAt: 1, payload: '{}' })
    await Promise.resolve()
    // 落盘了
    expect(outbox.pending().map((e) => e.id)).toEqual(['o1'])
    // 推成了 event 帧
    const evFrame = w.sent.map((r) => decodeFrame(r)).find((f) => f.t === 'event')
    expect(evFrame).toMatchObject({ t: 'event', id: 'o1' })
    // 后端 ack
    w.deliver(encodeFrame({ t: 'ack', ids: ['o1'] }))
    await Promise.resolve()
    expect(outbox.pending().length).toBe(0)
    c.stop()
  })

  it('主进程一直连不上，累计缺席恰好达到 orphanTtlMs 时自杀；已收事件不丢', async () => {
    const outbox = mkOutbox()
    // 自杀前已经落盘的一条事件——用来证明自杀不丢已收。
    outbox.append({ id: 'o1', source: 'fake', receivedAt: 1, payload: '{}' })
    let t = 0
    const orphanTtlMs = 5_000
    const backoffMs = 1_000
    let capturedNow: number | undefined
    const deps = {
      connect: vi.fn().mockResolvedValue(null), // 永远连不上
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      onOrphanExit: vi.fn(() => {
        capturedNow = t
      }),
    }
    runClient(outbox, fakeSource(), deps, { orphanTtlMs, backoffMs: () => backoffMs })
    // 固定退避、固定时钟步长：累计缺席在 t=5000 处恰好达到阈值。推进足够多轮微任务让它跑到。
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(deps.onOrphanExit).toHaveBeenCalledOnce()
    // 钉住边界：backoff 固定为 1000ms、阈值 5000ms，真实达阈时刻就是 t===5000。
    // 用 `>` 代替 `>=`（或反向的提前退出）都会让这个值偏离 5000，从而被这条断言抓到。
    expect(capturedNow).toBe(orphanTtlMs)
    // 自杀不丢已收：退出前落盘的事件仍在 pending 里。
    expect(outbox.pending().map((e) => e.id)).toEqual(['o1'])
  })

  it('stop() 落在 connect() 尚未返回期间：连上后拿到的 ws 被立即关闭，不会被用来发帧', async () => {
    const outbox = mkOutbox()
    const w = fakeWs()
    let resolveConnect: (ws: WsLike) => void = () => {}
    const connectPromise = new Promise<WsLike>((resolve) => {
      resolveConnect = resolve
    })
    const closeSpy = vi.spyOn(w.ws, 'close')
    const deps = {
      connect: vi.fn().mockReturnValue(connectPromise),
      now: () => 0,
      sleep: () => Promise.resolve(),
      onOrphanExit: vi.fn(),
    }
    const c = runClient(outbox, fakeSource(), deps, { orphanTtlMs: 10_000 })
    await Promise.resolve() // 让 loop 跑到 `await deps.connect()` 并挂起
    c.stop() // stop 落在 connect 仍在途时——currentWs 还是 undefined，close() 无从下手
    resolveConnect(w.ws) // 之后 connect 才交出活的 ws
    await Promise.resolve()
    await Promise.resolve()
    expect(closeSpy).toHaveBeenCalledOnce() // 被立即关闭
    expect(w.sent).toEqual([]) // 没有发过 hello/event——是被弃用，不是被用了再关
  })
})
