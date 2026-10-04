import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCAL } from '../lib/api.ts'
import { useEvents } from './EventsProvider.tsx'

/** One facility whose login has died (mirror of the backend `FacilityAuthNeed`). */
export interface FacilityNeed {
  facility: string
  label: string
  /** 后端 `PANEL_LOGIN_KINDS`：哪一支登录 provider 来接。`qr` 会推一张码来；`oauth` 不推码，
   *  只在中途需要人（通行密钥/二次验证）时发一条 `login-needsHuman` 引导语。 */
  login: 'qr' | 'oauth'
  since: string
  lastReason: string
}

export interface AuthPanelProps {
  initialNeeds: FacilityNeed[]
  send: (m: unknown) => void
  /** Subscribe to inbound WS frames; returns an unsubscribe. Typed loose because the
   *  auth/login frames are not in the app's `WsMessage` union. */
  subscribe: (cb: (msg: any) => void) => () => void
}

function upsert(list: FacilityNeed[], need: FacilityNeed): FacilityNeed[] {
  const rest = list.filter((n) => n.facility !== need.facility)
  return [...rest, need]
}

/** The QR re-login modal, and nothing else. It renders ONLY once something dispatches
 *  `open-auth-panel` — in production that is a click on the notification-centre row for the
 *  `auth.needed` event (see {@link NotificationBell}). This component used to also paint its own
 *  always-on-screen "登录已失效" badge; the event layer made that a third copy of one notification
 *  (toast + bell row + badge), so the badge is gone and the bell is the single entry point.
 *  Pure/injectable (initialNeeds + send + subscribe) so it unit-tests without a live socket.
 *  The production socket is wired by {@link AuthPanelHost}. */
export function AuthPanel({ initialNeeds, send, subscribe }: AuthPanelProps) {
  const [needs, setNeeds] = useState<FacilityNeed[]>(initialNeeds)
  const [selected, setSelected] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  // 这张码是不是"又来一张"。平台在第一次扫码之后再压一张（xhs 的设备/异地验证会这样）时，
  // 用户最需要知道的是**不是他扫错了**——不说这一句，他只会对着一张看起来一样的图重复扫。
  const [again, setAgain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // OAuth provider 中途需要人（passkey/二次验证）时的引导语——不是错误，别塞进 setError，
  // 那会让一句正常的"该你了"长得像失败。
  const [hint, setHint] = useState<string | null>(null)

  // Read the currently-open facility inside the subscribe closure without re-subscribing.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const close = useCallback(() => {
    setSelected(null)
    setQr(null)
    setAgain(false)
    setError(null)
    setHint(null)
  }, [])

  useEffect(() => {
    return subscribe((msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg?.type === 'open-auth-panel' && typeof msg.facility === 'string') {
        setSelected(msg.facility)
        return
      }
      switch (msg.type) {
        case 'auth-needed':
          if (msg.need) setNeeds((prev) => upsert(prev, msg.need as FacilityNeed))
          break
        case 'login-challenge':
          if (msg.facility === selectedRef.current) {
            setQr(msg.qr as string)
            setAgain(msg.again === true)
            setError(null)
          }
          break
        case 'login-needsHuman':
          // OAuth provider 掀了 tab、等着用户在浏览器里做完 passkey/二次验证之类的一步——
          // 只对当前打开的 facility 生效，别把别的 facility 的提示画到这个面板上。
          if (msg.facility === selectedRef.current) setHint((msg.hint as string) ?? '浏览器里似乎在等你操作一下')
          break
        case 'login-success':
          setNeeds((prev) => prev.filter((n) => n.facility !== msg.facility))
          if (msg.facility === selectedRef.current) close()
          break
        case 'login-failed':
          if (msg.facility === selectedRef.current) {
            setError((msg.reason as string) ?? '登录失败')
            setHint(null)
          }
          break
      }
    })
  }, [subscribe, close])

  const openInBrowser = (facility: string) => {
    setError(null)
    fetch(`${LOCAL.baseUrl}/api/auth/facilities/${encodeURIComponent(facility)}/focus`, { method: 'POST' })
      .then((r) => {
        // 409 = 还没有打开的登录标签。明确说出来，别让用户以为点了没反应。
        if (!r.ok) setError('还没有打开的登录标签，先点「重新登录」')
      })
      .catch(() => setError('打不开浏览器标签，检查扩展是不是连着'))
  }

  const start = (facility: string) => {
    setQr(null)
    setAgain(false)
    setError(null)
    setHint(null)
    send({ type: 'login-start', facility })
  }

  // Nothing is drawn until the user asks for it. `needs` is tracked (not rendered) purely so the
  // modal can title itself with the site's display name rather than its bare facility key — the `open-auth-panel` dispatch carries only
  // the facility key.
  if (!selected) return null

  const active = needs.find((n) => n.facility === selected) ?? null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="重新登录"
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          maxWidth: 'calc(100vw - 32px)',
          padding: 20,
          borderRadius: 14,
          background: '#ffffff',
          color: '#111827',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong style={{ font: '600 14px/1.4 system-ui, sans-serif' }}>
            {active?.label ?? selected} · 重新登录
          </strong>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#6b7280' }}
          >
            ×
          </button>
        </div>

        {qr ? (
          <img
            src={qr}
            alt="登录二维码"
            width={200}
            height={200}
            style={{ width: 200, height: 200, objectFit: 'contain', borderRadius: 8, background: '#f3f4f6' }}
          />
        ) : (
          <p style={{ font: '400 12px/1.5 system-ui, sans-serif', color: '#6b7280', margin: 0 }}>
            点击「重新登录」生成二维码，用手机 App 扫码。
          </p>
        )}

        {again ? (
          <p style={{ font: '500 12px/1.5 system-ui, sans-serif', color: '#b45309', margin: 0 }}>
            平台又要了一张新的二维码，请再扫一次（不是你扫错了）。
          </p>
        ) : null}

        {hint ? (
          <p style={{ font: '500 12px/1.5 system-ui, sans-serif', color: '#b45309', margin: 0 }}>{hint}</p>
        ) : null}

        {error ? (
          <p style={{ font: '400 12px/1.5 system-ui, sans-serif', color: '#dc2626', margin: 0 }}>{error}</p>
        ) : null}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => start(selected)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              font: '500 13px/1.4 system-ui, sans-serif',
              cursor: 'pointer',
            }}
          >
            重新登录
          </button>

          {/*
            兜底出口：平台加了一步 Stream 渲染不了的验证（滑块 / 短信 / 二次扫码）时，把那个
            标签放到用户面前，让他自己做完。我们不去理解那一步是什么——追它等于追平台的实现，
            而那正是它改得最勤、盯得最紧的一段。登录成没成由采集侧的判定和对账器负责，
            所以中间他做了什么我们不需要知道。
          */}
          <button
            type="button"
            onClick={() => openInBrowser(selected)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              background: 'transparent',
              color: '#374151',
              font: '500 13px/1.4 system-ui, sans-serif',
              cursor: 'pointer',
            }}
          >
            在浏览器里完成
          </button>
        </div>
      </div>
    </div>
  )
}

/** Production wiring: rides {@link EventsProvider}'s shared WS connection for `send` /
 *  `subscribe`, and seeds `initialNeeds` from `GET /api/auth/facilities` (idle-deferred so
 *  it doesn't contend with first paint). Mounted as a global overlay in {@link App}. */
export function AuthPanelHost() {
  const [needs, setNeeds] = useState<FacilityNeed[]>([])
  const { send, subscribe } = useEvents()

  // 首屏错峰：这个 fetch 不抢关键路径（TODO 里记的 AuthPanelHost 挂载时机问题在此落地）
  useEffect(() => {
    let alive = true
    const load = () => {
      fetch(LOCAL.baseUrl + '/api/auth/facilities')
        .then((r) => (r.ok ? (r.json() as Promise<FacilityNeed[]>) : []))
        .then((data) => { if (alive) setNeeds(Array.isArray(data) ? data : []) })
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

  // Mounted unconditionally — NOT gated on the fetch above. The panel draws nothing until an
  // `open-auth-panel` dispatch arrives, but it must be subscribed to receive one; gating on the
  // idle-deferred fetch left a window where clicking the bell row silently did nothing. `needs`
  // only supplies the modal's facility label, and arrives late-or-never without breaking that.
  return <AuthPanel initialNeeds={needs} send={send} subscribe={subscribe} />
}
