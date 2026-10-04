import type { Context } from 'cordis'
import { EventStore } from '../../events/store.ts'
import { EventsService } from '../../events/service.ts'

declare module 'cordis' {
  interface Context {
    /**
     * 通知中心这一域（`src/kernel/plugins/events.ts`）：落盘 + WS 推送的统一发布门。
     *
     * **键名不是 `events`，也永远不能改回去**：`ctx.events` 是 cordis 本体的服务
     * （插件生命周期事件总线）。实测 `ctx.provide('events', …)` **不抛、不覆盖、静默无效**——
     * `ctx.events` 仍是上游那个 EventsService，而它恰好也有一个 `emit` 方法，于是
     * `events.emit({type:'harvest.error',…})` 会稳稳地调到上游总线上：一条事件都不落盘、
     * 一条都不推给前端，通知中心整个变成空的，而任何一处都不会报错。
     * 内核头注（`src/kernel/context.ts`）的「ctx key 一律带域前缀」讲的就是这个。
     */
    streamEvents: EventsService
  }
}

export interface EventsConfig {
  /** 事件账本的落盘位置（`<dataDir>/events.json`）。 */
  path: string
  /** 往所有连着的前端推一帧。缺席 = 只落盘不推（单测 / 无 WS 的档）。 */
  broadcast?: (msg: unknown) => void
}

/**
 * 通知中心这一域：`EventsService`（去重 + 落盘 + 推送）挂成 `ctx.streamEvents`。
 *
 * 域内没有活动部件，也没有句柄——`EventStore` 是一份 JSON，每次 append 自己写盘，
 * 没有 `close()` 可关，所以本域一个 `ctx.effect` 都不登记。
 *
 * **两批「先攒后发」的冲刷不在这里**（包激活失败 / 容器接管回执）：那是装配序上的动作
 * ——「事件层建好了，把之前攒着的那几条补发出去」——不是这一域的能力，留在 bootstrap。
 */
export function eventsPlugin(ctx: Context, config: EventsConfig): void {
  const store = new EventStore(config.path)
  ctx.provide('streamEvents', new EventsService(store, (msg) => config.broadcast?.(msg)))
}
