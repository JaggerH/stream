import type { Outbox, OutboxEvent } from '../outbox.ts'
import type { EventSource } from './source.ts'
import { decodeFrame, encodeFrame } from '../protocol.ts'

export interface WsLike {
  send(raw: string): void
  onMessage(cb: (raw: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface ClientDeps {
  connect(): Promise<WsLike | null>
  now(): number
  sleep(ms: number): Promise<void>
  /** 孤儿窗口耗尽时调用——子进程据此放掉外连与锁并退出。 */
  onOrphanExit(): void
}

const defaultBackoff = (n: number) => Math.min(500 * 2 ** Math.min(n, 5), 10_000)

export function runClient(
  outbox: Outbox,
  source: EventSource,
  deps: ClientDeps,
  opts: { orphanTtlMs: number; backoffMs?: (n: number) => number },
): { stop(): void } {
  const backoff = opts.backoffMs ?? defaultBackoff
  let stopped = false
  let cookies = ''
  let lastConnected = deps.now()
  let currentWs: WsLike | undefined

  // 源产出 → 先落盘（唯一副作用），推送由主循环负责。
  void source.start(
    (e: OutboxEvent) => {
      if (!stopped) outbox.append(e)
    },
    () => cookies,
  )

  async function loop() {
    let attempt = 0
    while (!stopped) {
      const ws = await deps.connect()
      if (!ws) {
        // 连不上：累计缺席，超窗自杀
        if (deps.now() - lastConnected >= opts.orphanTtlMs) {
          deps.onOrphanExit()
          return
        }
        await deps.sleep(backoff(attempt++))
        continue
      }
      if (stopped) {
        ws.close()
        return
      }
      lastConnected = deps.now()
      attempt = 0
      currentWs = ws
      let alive = true
      ws.onClose(() => {
        alive = false
        lastConnected = deps.now()
        currentWs = undefined
      })
      ws.onMessage((raw) => {
        let f
        try {
          f = decodeFrame(raw)
        } catch {
          return
        }
        if (f.t === 'ack') outbox.ackDone(f.ids, deps.now())
        else if (f.t === 'cookies') cookies = f.pairs
      })
      // 连上：报到 + 把积压 pending 全推出去
      ws.send(encodeFrame({ t: 'hello', source: source.name, domains: source.domains }))
      for (const e of outbox.pending()) {
        ws.send(encodeFrame({ t: 'event', id: e.id, source: e.source, receivedAt: e.receivedAt, payload: e.payload }))
      }
      // 停在这条连接上，直到它断——期间新事件由 append 落盘、靠下一轮 pending 推
      while (alive && !stopped) {
        for (const e of outbox.pending()) {
          ws.send(encodeFrame({ t: 'event', id: e.id, source: e.source, receivedAt: e.receivedAt, payload: e.payload }))
        }
        await deps.sleep(200) // 本地节拍，不打外部
      }
    }
  }
  void loop()

  return {
    stop() {
      stopped = true
      currentWs?.close()
      source.stop()
    },
  }
}
