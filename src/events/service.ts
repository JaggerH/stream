import type { EventInput, EventStore, StreamEvent } from './store.ts'

/**
 * The one door for publishing an event: persist + WS-broadcast in a single call, with a
 * floor-level dedupe — an UNREAD event with the same dedupeKey is refreshed in place
 * (timestamp bump, `refreshed: true` on the frame so the UI skips the toast) instead of
 * stacking a duplicate row per probe cycle. Once read, the same key notifies anew.
 */
export class EventsService {
  constructor(
    private readonly store: EventStore,
    private readonly broadcast: (msg: unknown) => void,
  ) {}

  emit(input: EventInput): StreamEvent {
    const dup = input.dedupeKey ? this.store.findUnreadByDedupeKey(input.dedupeKey) : undefined
    if (dup) {
      const e = this.store.touch(dup.id, input.at)!
      this.broadcast({ type: 'event', event: e, refreshed: true })
      return e
    }
    const e = this.store.append(input)
    this.broadcast({ type: 'event', event: e })
    return e
  }

  list(opts?: { since?: number; types?: string[] }): StreamEvent[] {
    return this.store.list(opts)
  }

  markRead(sel: { ids?: number[]; all?: boolean }): void {
    this.store.markRead(sel)
  }
}

/**
 * 给「比事件层**先**装配起来的那些域」用的发布入口：**调用时才去取服务**。
 *
 * 为什么必须是 thunk：bootstrap 的顺序是 packages → harvest → **events**，所以 target-miss
 * 的 reporter、ExtRelay 拿到通知回调那一刻 `ctx.streamEvents` 还是 undefined。把服务在装配期
 * 取成一个字段，这两条通知就永远发不出去——**而且一个字都不报**，那个能力只是"不在"
 * （AGENTS.md「装配期取的值 = 冻住的答案」，两天内三种写法各栽一次）。
 *
 * 两条吞掉：服务还没挂（此刻没有用户在看，也没有前端连着）、emit 自己抛。通知通道和 debug
 * 通道一样，没有资格掀翻正在跑的主链路。
 */
export function lazyNotify(get: () => EventsService | undefined): (input: EventInput) => void {
  return (input) => {
    try {
      get()?.emit(input)
    } catch {
      /* 通知发不出去不该反过来打死调用方 */
    }
  }
}
