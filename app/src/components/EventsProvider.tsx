import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
// 用 vendored acrylic 包装的 toast（icon/img 变体的 padding、gap、图标尺寸规范化），
// 不要裸 import 'sonner'——status 图标会掉进 32px img 档 fallback（acrylic-ui skill 规范）。
import { toast } from './acrylic/sonner.tsx'
import { useWs } from '../hooks/useWs.ts'
import { api, LOCAL } from '../lib/api.ts'

/** Mirror of the backend StreamEvent (src/events/store.ts). */
export interface UiEvent {
  id: number
  type: string
  at: number
  title: string
  body?: string
  /** 技术现场，**只参与复制、不在 UI 上显示**（后端 StreamEvent.detail 的头注是真相源）。 */
  detail?: string
  severity: 'info' | 'warn' | 'error'
  ref?: { kind: 'item' | 'facility' | 'stream'; id: string }
  readAt?: number
}

/** newest first; a refreshed duplicate replaces its old row and moves to the top */
export function applyEvent(list: UiEvent[], e: UiEvent): UiEvent[] {
  return [e, ...list.filter((x) => x.id !== e.id)].slice(0, 200)
}

interface EventsCtx {
  events: UiEvent[]
  unread: number
  markAllRead: () => void
  send: (m: unknown) => void
  /** all inbound WS frames + dispatchLocal synthetics — AuthPanel 等订阅这里 */
  subscribe: (cb: (msg: any) => void) => () => void
  /** push a synthetic frame to subscribers — the bell's type→action channel */
  dispatchLocal: (msg: unknown) => void
}

const Ctx = createContext<EventsCtx | null>(null)

export function useEvents(): EventsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useEvents outside EventsProvider')
  return v
}

/** 测试用：喂一份固定的事件表，不起 WS。只覆盖用得上的那几格，其余给空实现。 */
export function EventsTestProvider({ value, children }: { value: Partial<EventsCtx>; children: ReactNode }) {
  return (
    <Ctx.Provider
      value={{
        events: [], unread: 0, markAllRead: () => {}, send: () => {},
        subscribe: () => () => {}, dispatchLocal: () => {}, ...value,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

function toastFor(e: UiEvent): void {
  if (e.severity === 'error') toast.error(e.title, { description: e.body })
  else if (e.severity === 'warn') toast.warning(e.title, { description: e.body })
  else toast.success(e.title, { description: e.body })
}

/** Owns THE app-level WS connection (formerly AuthPanelHost's), projecting event frames
 *  into toast (immediate) + bell log (reviewable) and fanning every frame out to
 *  subscribers. Backlog loads off the critical first paint via requestIdleCallback. */
export function EventsProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<UiEvent[]>([])
  const listeners = useRef(new Set<(m: unknown) => void>())

  const onMessage = useCallback((m: any) => {
    if (m?.type === 'event' && m.event) {
      const evt = m.event as UiEvent
      setEvents((prev) => applyEvent(prev, evt))
      // 转成文字已经是对话框里同步的工具调用，用户全程在场看着 ToolCard 出结果，toast 是噪音；
      // 仍然落进 bell（上面这行），只是不弹。
      const isTranscribeToast = evt.type === 'transcribe.done' || evt.type === 'transcribe.error'
      if (!m.refreshed && !isTranscribeToast) toastFor(evt) // refreshed = 未读去重刷新，别重复弹
    }
    for (const cb of listeners.current) cb(m)
  }, [])
  const send = useWs(api.wsUrl(LOCAL), onMessage)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch(LOCAL.baseUrl + '/api/events')
        .then((r) => (r.ok ? (r.json() as Promise<UiEvent[]>) : []))
        .then((data) => { if (alive && Array.isArray(data)) setEvents(data) })
        .catch(() => {})
    }
    const w = window as any
    const handle = w.requestIdleCallback ? w.requestIdleCallback(load) : setTimeout(load, 1500)
    return () => {
      alive = false
      if (w.requestIdleCallback) w.cancelIdleCallback?.(handle)
      else clearTimeout(handle)
    }
  }, [])

  const subscribe = useCallback((cb: (msg: any) => void) => {
    listeners.current.add(cb)
    return () => { listeners.current.delete(cb) }
  }, [])

  const dispatchLocal = useCallback((msg: unknown) => {
    for (const cb of listeners.current) cb(msg)
  }, [])

  const markAllRead = useCallback(() => {
    setEvents((prev) => prev.map((e) => (e.readAt === undefined ? { ...e, readAt: Date.now() } : e)))
    void fetch(LOCAL.baseUrl + '/api/events/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).catch(() => {})
  }, [])

  const unread = events.filter((e) => e.readAt === undefined).length

  return (
    <Ctx.Provider value={{ events, unread, markAllRead, send, subscribe, dispatchLocal }}>
      {children}
    </Ctx.Provider>
  )
}
