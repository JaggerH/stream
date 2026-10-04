import type { OutboxEvent } from '../outbox.ts'

export interface EventSource {
  name: string
  domains: string[]
  /** 连外部、把事件经 emit 交出去。cookies() 取当前 cookie 串（后端推来的）。 */
  start(emit: (e: OutboxEvent) => void, cookies: () => string): Promise<void>
  stop(): void
}

/** 测试/占位源：手动 push 事件。闲鱼真源在 Spec 2。 */
export function fakeSource(): EventSource & { push(e: OutboxEvent): void } {
  let emit: (e: OutboxEvent) => void = () => {}
  return {
    name: 'fake',
    domains: [],
    async start(e) {
      emit = e
    },
    stop() {},
    push(e) {
      emit(e)
    },
  }
}
