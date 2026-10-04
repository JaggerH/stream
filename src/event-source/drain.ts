import { encodeFrame, type EventFrame } from './protocol.ts'

export interface EventSourceSocket {
  send(raw: string): void
}

export interface DrainDeps {
  /** 事件 → 已注册任务 id；null = 无对应任务。 */
  mapToTask(ev: EventFrame): string | null
  runTaskNow(id: string): Promise<boolean>
  log?: (l: string) => void
}

export function makeDrain(deps: DrainDeps) {
  return async function drain(frame: EventFrame, sock: EventSourceSocket): Promise<void> {
    const taskId = deps.mapToTask(frame)
    if (taskId === null) {
      deps.log?.(`[event-source] 事件 ${frame.id} 无对应任务，直接 ack`)
      sock.send(encodeFrame({ t: 'ack', ids: [frame.id] }))
      return
    }
    const ok = await deps.runTaskNow(taskId)
    if (!ok) {
      deps.log?.(`[event-source] runTaskNow(${taskId}) 失败，不 ack，等重推`)
      return
    }
    sock.send(encodeFrame({ t: 'ack', ids: [frame.id] }))
  }
}
