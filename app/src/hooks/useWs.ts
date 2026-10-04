import { useEffect, useRef } from 'react'
import type { WsMessage } from '../lib/types.ts'
import { selectTransport, type SocketHandle } from '../lib/transport.ts'

/** Subscribe to the backend WS with auto-reconnect (exponential backoff). The
 *  transport comes from selectTransport (native WebSocket). */
export function useWs(wsUrl: string, onMessage: (m: WsMessage) => void, enabled = true) {
  const cb = useRef(onMessage)
  cb.current = onMessage
  const handleRef = useRef<SocketHandle | null>(null)
  const queueRef = useRef<string[]>([])

  useEffect(() => {
    if (!enabled) return
    const transport = selectTransport()
    let handle: SocketHandle | null = null
    let closed = false
    let retry = 1000
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      handle = transport.openSocket(wsUrl, {
        onOpen: () => {
          retry = 1000
          handleRef.current = handle
          for (const payload of queueRef.current.splice(0)) handle?.send(payload)
        },
        onMessage: (data) => {
          try {
            cb.current(JSON.parse(data) as WsMessage)
          } catch {
            /* ignore malformed frames */
          }
        },
        onClose: () => {
          if (handleRef.current === handle) handleRef.current = null
          if (!closed) {
            timer = setTimeout(connect, retry)
            retry = Math.min(retry * 2, 15000)
          }
        },
      })
    }
    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      handle?.close()
      handleRef.current = null
      queueRef.current = []
    }
  }, [wsUrl, enabled])

  return (message: unknown) => {
    const payload = JSON.stringify(message)
    const handle = handleRef.current
    if (handle) handle.send(payload)
    else queueRef.current.push(payload)
  }
}
