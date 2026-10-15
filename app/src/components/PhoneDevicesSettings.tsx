import { useCallback, useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection, type DeviceRow } from '../lib/api.ts'

/**
 * Phones paired with Stream, plus the host agents online right now.
 *
 * "添加手机" mints a one-time code (this machine only) and shows one QR code carrying every address
 * of this machine (listed under it for typing in by hand). The Stream app on the phone scans it,
 * asks which address to use when there are several, and pairs. Revoking forgets the phone's token and drops its live
 * connection at once. Stream Desktop is listed but cannot be revoked, because it connects with the
 * machine's own secret rather than a paired token.
 */
export function PhoneDevicesSettings({ conn }: { conn: Connection }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; qr: string[]; knownIds: Set<string> } | null>(null)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.devices.list(conn)
      .then((d) => { setDevices(d.devices); setError(null) })
      .catch((e) => setError(e instanceof ApiError ? e.message : '后端未响应'))
  }, [conn])
  useEffect(load, [load])

  // While a code is on screen, keep refreshing so a phone that just paired shows up.
  // Polling stops (and the code is cleared) once the code expires or a new paired device shows up.
  const expiresAt = pairing?.expiresAt
  useEffect(() => {
    if (expiresAt === undefined) return
    const t = setInterval(() => {
      if (Date.now() >= expiresAt) {
        clearInterval(t)
        setExpired(true)
        setPairing(null)
        return
      }
      load()
    }, 3000)
    return () => clearInterval(t)
  }, [expiresAt, load])

  useEffect(() => {
    if (!pairing || !devices) return
    const fresh = devices.find((d) => d.paired && !pairing.knownIds.has(d.deviceId))
    if (!fresh) return
    toast.success(`已配对 ${fresh.name}`)
    setPairing(null)
  }, [devices, pairing])

  const startPairing = async () => {
    try {
      const p = await api.devices.pairingCode(conn)
      setExpired(false)
      setPairing({ ...p, knownIds: new Set((devices ?? []).map((d) => d.deviceId)) })
    } catch (e) {
      toast.error('生成配对码失败', { description: e instanceof ApiError ? e.message : '后端未响应' })
    }
  }

  const revoke = async (d: DeviceRow) => {
    try {
      await api.devices.revoke(conn, d.deviceId)
      load()
    } catch (e) {
      toast.error('撤销失败', { description: e instanceof ApiError ? e.message : '后端未响应' })
    }
  }

  if (error) return <div className="text-[12px] text-muted-foreground">{error}</div>
  if (!devices) return <div className="text-[12px] text-muted-foreground">读取中…</div>

  return (
    <div className="space-y-2.5">
      {devices.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">还没有设备。</p>
      ) : (
        <ul className="space-y-1.5">
          {devices.map((d) => (
            <li key={d.deviceId} className="flex items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5">
              <span className={`size-1.5 shrink-0 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1 truncate text-[12px]">{d.name}</span>
              {d.online && d.state?.a11yEnabled === false && (
                <span className="rounded bg-amber-400/10 px-1.5 text-[11px] text-amber-300">无障碍已关</span>
              )}
              <span className="text-[11px] text-muted-foreground">{d.platform === 'android' ? '安卓' : '电脑'}</span>
              {d.paired && (
                <button
                  type="button"
                  aria-label={`撤销 ${d.name}`}
                  onClick={() => revoke(d)}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  撤销
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={startPairing}
        className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-[12px] hover:border-foreground/40"
      >
        添加手机
      </button>
      <a
        href={`${conn.baseUrl}/panel/android/stream.apk`}
        className="ml-3 text-[12px] text-muted-foreground underline hover:text-foreground"
      >
        下载安卓 App
      </a>

      {expired && !pairing && (
        <p className="text-[12px] text-muted-foreground">配对码已过期，点「添加手机」重新生成</p>
      )}

      {pairing && (
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            用手机上的 Stream 扫码，或手动输入地址和配对码。配对码 5 分钟内有效，只能用一次。
          </p>
          <div className="font-mono text-[20px] tracking-[0.3em]">{pairing.code}</div>
          {pairing.qr.length === 0 ? (
            <p className="rounded-md bg-amber-400/10 px-2.5 py-2 text-[12px] text-amber-300">
              这台机器现在没有局域网地址，手机够不着它。
            </p>
          ) : (
            pairing.qr.map((payload) => {
              // `backends` carries every address; the phone asks which one to use. They are listed
              // here too, for typing one in by hand.
              const p = JSON.parse(payload) as { backends?: string[]; backend?: string }
              const backends = p.backends ?? (p.backend ? [p.backend] : [])
              return (
                <div key={payload} className="space-y-1">
                  <div
                    className="w-40 rounded bg-white p-2"
                    // renderSVG returns a self-contained <svg>; tag it so tests can count codes.
                    dangerouslySetInnerHTML={{ __html: renderSVG(payload).replace('<svg', '<svg data-pair-qr') }}
                  />
                  {backends.map((b) => <div key={b} className="font-mono text-[11px] text-muted-foreground">{b}</div>)}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
