import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { applyBackend } from './api.ts'
import { resolveBackend, type ProbeFn } from './discovery.ts'

/**
 * Connection state machine. Runs the discovery
 * ladder on mount, aligns LOCAL to the winner (applyBackend), and drives the
 * app's connected / probing / disconnected UI. On failure (REST giving up or WS
 * dropping — reported via reportFailure) it re-runs the ladder in the
 * background, so the app auto-aligns when a backend appears or recovers.
 */
export type ConnStatus = 'probing' | 'connected' | 'disconnected'
export interface BackendCtx {
  status: ConnStatus
  upstream: string
  /** Bumped on every successful alignment — consumers key data reloads off it. */
  reloadToken: number
  /** Manual retry → back to probing, re-run the ladder now. */
  reconnect(): void
  /** REST gave up / WS dropped → disconnected + background re-probe. */
  reportFailure(): void
}

const noop = () => {}
/**
 * Default when no BackendProvider is above (e.g. isolated component tests, or any
 * host that doesn't run discovery): behave as already-connected with no-op
 * controls. The real app always mounts BackendProvider at the root (main.tsx),
 * so this fail-open default only affects presentational rendering, never the
 * live connection path.
 */
const DEFAULT_CTX: BackendCtx = {
  status: 'connected',
  upstream: '',
  reloadToken: 0,
  reconnect: noop,
  reportFailure: noop,
}

const Ctx = createContext<BackendCtx>(DEFAULT_CTX)
export function useBackend(): BackendCtx {
  return useContext(Ctx)
}

export function BackendProvider(props: {
  children: React.ReactNode
  probe: ProbeFn
  configuredUrl?: string
  backoffMs?: number
}) {
  const { probe, configuredUrl, backoffMs = 2000 } = props
  const [status, setStatus] = useState<ConnStatus>('probing')
  const [upstream, setUpstream] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const gen = useRef(0) // 抵消并发探测竞态：只认最新一代

  const runLadder = useCallback(async () => {
    const myGen = ++gen.current
    setStatus('probing')
    // Read the configured URL FRESH each run (not the captured prop): Settings
    // writes stream.backend_url then calls reconnect(), and the value must take
    // effect without an app restart. The `configuredUrl` prop is a test override.
    const cfg =
      configuredUrl ??
      (typeof window !== 'undefined'
        ? window.localStorage.getItem('stream.backend_url') || undefined
        : undefined)
    const found = await resolveBackend({ configuredUrl: cfg, probe })
    if (myGen !== gen.current) return // 被更晚的探测取代
    if (found) {
      applyBackend(found.httpBase, found.wsBase)
      setUpstream(found.upstream)
      setStatus('connected')
      setReloadToken((t) => t + 1)
    } else {
      setStatus('disconnected')
      timer.current = setTimeout(() => void runLadder(), backoffMs) // 后台重探
    }
  }, [configuredUrl, probe, backoffMs])

  useEffect(() => {
    void runLadder()
    return () => {
      gen.current++
      if (timer.current) clearTimeout(timer.current)
    }
  }, [runLadder])

  const reconnect = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    void runLadder()
  }, [runLadder])
  const reportFailure = useCallback(() => {
    setStatus((s) => (s === 'connected' ? 'disconnected' : s))
    if (timer.current) clearTimeout(timer.current)
    void runLadder()
  }, [runLadder])

  return (
    <Ctx.Provider value={{ status, upstream, reloadToken, reconnect, reportFailure }}>
      {props.children}
    </Ctx.Provider>
  )
}
