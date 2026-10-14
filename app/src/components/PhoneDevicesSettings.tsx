import { useCallback, useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection, type DeviceRow } from '../lib/api.ts'

/**
 * Phones paired with Stream, plus the host agents online right now.
 *
 * "添加手机" mints a one-time code (this machine only) and shows one QR code per LAN address. The
 * Stream app on the phone scans it and pairs. Revoking forgets the phone's token and drops its live
 * connection at once. Stream Desktop is listed but cannot be revoked, because it connects with the
 * machine's own secret rather than a paired token.
 */
export function PhoneDevicesSettings({ conn }: { conn: Connection }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; qr: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.devices.list(conn)
      .then((d) => { setDevices(d.devices); setError(null) })
      .catch((e) => setError(e instanceof ApiError ? e.message : '后端未响应'))
  }, [conn])
  useEffect(load, [load])

  // While a code is on screen, keep refreshing so a phone that just paired shows up.
  const pairingShown = pairing !== null
  useEffect(() => {
    if (!pairingShown) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [pairingShown, load])

  const startPairing = async () => {
    try {
      setPairing(await api.devices.pairingCode(conn))
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
              const backend = (JSON.parse(payload) as { backend: string }).backend
              return (
                <div key={payload} className="space-y-1">
                  <div
                    className="w-40 rounded bg-white p-2"
                    // renderSVG returns a self-contained <svg>; tag it so tests can count codes.
                    dangerouslySetInnerHTML={{ __html: renderSVG(payload).replace('<svg', '<svg data-pair-qr') }}
                  />
                  <div className="font-mono text-[11px] text-muted-foreground">{backend}</div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
