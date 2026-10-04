/**
 * Transport abstraction — how the frontend reaches the backend.
 *
 * There is one implementation today (native `fetch` + native `WebSocket`); the
 * seam stays because the connection base (`Connection.baseUrl` / `wsBase`) is the
 * single switch point — swapping it re-routes every call site, media included,
 * with no per-call change.
 */
export interface SocketHandlers {
  onOpen?: () => void
  onMessage: (data: string) => void
  onClose?: () => void
}
export interface SocketHandle {
  send(data: string): void
  close(): void
}
export interface Transport {
  fetch(input: string, init?: RequestInit): Promise<Response>
  openSocket(url: string, handlers: SocketHandlers): SocketHandle
}

/** Web / same-origin (场景3) + dev：原生 fetch + 原生 WebSocket。 */
export const webTransport: Transport = {
  fetch: (input, init) => globalThis.fetch(input, init),
  openSocket(url, handlers) {
    const ws = new WebSocket(url)
    ws.onopen = () => handlers.onOpen?.()
    ws.onmessage = (e) => handlers.onMessage(String(e.data))
    ws.onclose = () => handlers.onClose?.()
    ws.onerror = () => ws.close()
    return {
      send(data) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('socket is not open')
        ws.send(data)
      },
      close() {
        // Closing a still-CONNECTING socket logs "closed before established";
        // wait for open then close cleanly (matches the old useWs behaviour).
        if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
        else ws.close()
      },
    }
  },
}

export function selectTransport(): Transport {
  return webTransport
}
