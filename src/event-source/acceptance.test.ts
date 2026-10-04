import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox } from './outbox.ts'
import { makeDrain, type EventSourceSocket } from './drain.ts'
import { EventSourceRelay } from './relay.ts'
import { encodeFrame } from './protocol.ts'
import { runClient, type WsLike } from './worker/client.ts'
import { fakeSource } from './worker/source.ts'

const newOutbox = () => new Outbox(join(mkdtempSync(join(tmpdir(), 'acc-')), 'o.db'), Database)

/** 净跑 n 轮微任务，让已排好队的 then/await 链跑到稳定态。全程无真实定时器，轮数留足即可。 */
async function tick(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** 把「后端 relay」和「子进程 ws」用内存管道对接：send 直接互调，无真 WS。 */
function wire(relay: EventSourceRelay) {
  let toClient: (r: string) => void = () => {}
  let onClientClose: () => void = () => {}
  const backendSock: EventSourceSocket = { send: (r) => toClient(r) }
  relay.connect(backendSock)
  const ws: WsLike = {
    send: (r) => relay.handleMessage(r, backendSock),
    onMessage: (cb) => (toClient = cb),
    onClose: (cb) => (onClientClose = cb),
    close: () => {
      relay.disconnect(backendSock)
      onClientClose()
    },
  }
  return { ws, backendSock }
}

/**
 * 用来顶替 `ClientDeps.sleep`：真实实现里子进程每轮扫描 pending 之间靠 `sleep(200)` 隔开，
 * 但内存管道没有真实网络延迟，`sleep` 一旦立即 resolve，连接建立后的两次空扫描
 * （报到时的首扫 + while 循环第一轮）会在同一个微任务窗口里背靠背打完，"仍 pending" 这个
 * 断言窗口就变得不可控。改成手动 gate：只有测试显式 release() 才放行下一轮扫描，
 * 这样每次 release 精确对应一次 pending 扫描，用于人为控制"崩溃—重推"两轮的先后。
 */
function makeSleepGate() {
  const waiters: Array<() => void> = []
  return {
    sleep: (_ms: number) => new Promise<void>((resolve) => waiters.push(resolve)),
    release() {
      waiters.shift()?.()
    },
  }
}

describe('event-source 基建三性（验收）', () => {
  it('不丢 + 幂等：runTaskNow 首次失败不 ack、事件仍 pending；重推后成功且只入队一次', async () => {
    const outbox = newOutbox()
    const enqueued: string[] = []
    let failedOnce = false
    let runTaskNowCalls = 0
    const seen = new Set<string>()
    const drain = makeDrain({
      mapToTask: () => 'deliver',
      runTaskNow: async (id) => {
        runTaskNowCalls++
        if (!failedOnce) {
          failedOnce = true
          return false // 模拟「处理到一半、主进程崩了」——不 ack，事件留在 outbox 里等重推
        }
        if (seen.has(id)) return true // 下游幂等：已经处理过的重复投递，直接确认，不重复入队
        seen.add(id)
        enqueued.push(id)
        return true
      },
    })
    const relay = new EventSourceRelay((f, s) => void drain(f, s))
    const { ws, backendSock } = wire(relay)

    const gate = makeSleepGate()
    const c = runClient(
      outbox,
      fakeSource(),
      { connect: async () => ws, now: () => 0, sleep: gate.sleep, onOrphanExit: vi.fn() },
      { orphanTtlMs: 1e9 },
    )

    // 等它连上、报到时的首扫与 while 循环第一轮扫描都跑完（此时 outbox 还是空的，两次都是空扫），
    // 稳定停在下一次 sleep() 上。
    await tick()
    outbox.append({ id: 'o1', source: 'fake', receivedAt: 1, payload: '{}' })

    gate.release() // 放行一轮扫描：发出 o1 → runTaskNow 第一次调用 → false → 不 ack
    await tick()
    expect(outbox.pending().map((e) => e.id)).toEqual(['o1'])
    expect(enqueued).toEqual([])

    gate.release() // 仍 pending，下一轮重扫重发 → runTaskNow 第二次调用 → true → ack
    await tick()
    expect(enqueued).toEqual(['deliver']) // mapToTask 把 o1 映射到的任务 id，只入队一次
    expect(outbox.pending().length).toBe(0)
    expect(runTaskNowCalls).toBeGreaterThan(1) // 崩溃后确有一次真实重推，不是只调用了一次

    // o1 此时已经完全处理完（ack、pending 清空）。显式模拟一次重复的网络帧：
    // 同一个已完成事件被再投递一次（例如子进程重连后重放了未确认过的旧帧，或网络层重复）。
    // 这一断言是本用例唯一真正压中下游 `seen.has(id)` 去重分支的地方——
    // 如果把 runTaskNow 里的幂等判断去掉，这里 enqueued 会变成长度 2，断言必然变红。
    relay.handleMessage(
      encodeFrame({ t: 'event', id: 'o1', source: 'fake', receivedAt: 1, payload: '{}' }),
      backendSock,
    )
    await tick()
    expect(enqueued).toEqual(['deliver']) // 长度仍是 1：下游幂等吸收了这次重复投递

    c.stop()
    gate.release()
    await tick()
  })

  it('孤儿无损：主进程一直缺席，累计超窗后子进程自杀；pending 仍在盘上，重开可续', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-'))
    const dbPath = join(dir, 'o.db')
    const o1 = new Outbox(dbPath, Database)
    o1.append({ id: 'o9', source: 'fake', receivedAt: 1, payload: '{}' })

    let t = 0
    const exit = vi.fn()
    runClient(
      o1,
      fakeSource(),
      {
        connect: async () => null, // 主进程一直连不上
        now: () => t,
        sleep: async (ms: number) => {
          t += ms
        },
        onOrphanExit: exit,
      },
      { orphanTtlMs: 5_000, backoffMs: () => 1_000 },
    )
    await tick(40)

    expect(exit).toHaveBeenCalledTimes(1)
    o1.close()

    // 重开库（模拟后端将来 respawn 出的新子进程接手）——积压事件仍在盘上，没有随进程退出丢掉。
    const o2 = new Outbox(dbPath, Database)
    expect(o2.pending().map((e) => e.id)).toEqual(['o9'])
    o2.close()
  })
})
