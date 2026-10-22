import { useCallback, useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection, type DeviceRow, type ExtBindingRow } from '../lib/api.ts'

/** A one-time code for pairing a Chrome extension onto one device (design D7). */
interface BrowserPairing {
  deviceId: string
  code: string
  expiresAt: number
  backends: string[]
  knownIds: Set<string>
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

/**
 * Devices paired with Stream (phones, Linux agents), plus the host agents online right now, each with
 * the Chrome extensions paired onto it.
 *
 * "添加手机" mints a one-time code (this machine only) and shows one QR code carrying every address
 * of this machine (listed under it for typing in by hand). The Stream app on the phone scans it,
 * asks which address to use when there are several, and pairs. Revoking forgets the phone's token and drops its live
 * connection at once. Stream Desktop is listed but cannot be revoked, because it connects with the
 * machine's own secret rather than a paired token.
 *
 * "添加浏览器" on a paired computer mints a code for that device: typed into the extension's Streams tab
 * on that machine, it makes that Chrome the device's browser. A device can hold several; runs use the
 * default one while it is online, otherwise the one that connected last.
 */
export function DevicesSettings({ conn }: { conn: Connection }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [browsers, setBrowsers] = useState<ExtBindingRow[]>([])
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; qr: string[]; knownIds: Set<string> } | null>(null)
  const [expired, setExpired] = useState(false)
  const [browserPairing, setBrowserPairing] = useState<BrowserPairing | null>(null)
  // 每台设备一行提示：码过期了，或者后端不肯签（远处打开面板时 403）——后端的原话。
  const [browserNote, setBrowserNote] = useState<{ deviceId: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.devices.list(conn)
      .then((d) => { setDevices(d.devices); setError(null) })
      .catch((e) => setError(errText(e)))
    // 老后端没有这一口：没有浏览器列表照样能管设备。
    api.extBindings.list(conn)
      .then((b) => setBrowsers(b.bindings ?? []))
      .catch(() => setBrowsers([]))
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

  // 浏览器配对码在屏时同理轮询：扩展那边一 Pair，这边就能看见并收起码。
  const browserExpiresAt = browserPairing?.expiresAt
  useEffect(() => {
    if (browserExpiresAt === undefined) return
    const t = setInterval(() => {
      if (Date.now() >= browserExpiresAt) {
        clearInterval(t)
        setBrowserPairing((p) => {
          if (p) setBrowserNote({ deviceId: p.deviceId, text: '配对码已过期，点「添加浏览器」重新生成' })
          return null
        })
        return
      }
      load()
    }, 3000)
    return () => clearInterval(t)
  }, [browserExpiresAt, load])

  useEffect(() => {
    if (!browserPairing) return
    const fresh = browsers.find((b) => b.deviceId === browserPairing.deviceId && !browserPairing.knownIds.has(b.bindingId))
    if (!fresh) return
    toast.success(`已添加浏览器 ${fresh.name}`)
    setBrowserPairing(null)
  }, [browsers, browserPairing])

  const startBrowserPairing = async (d: DeviceRow) => {
    setBrowserNote(null)
    try {
      const p = await api.devices.extPairingCode(conn, d.deviceId)
      setBrowserPairing({ deviceId: d.deviceId, ...p, backends: p.backends ?? [], knownIds: new Set(browsers.map((b) => b.bindingId)) })
    } catch (e) {
      setBrowserPairing(null)
      setBrowserNote({ deviceId: d.deviceId, text: errText(e) })
    }
  }

  const browserAction = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run()
      load()
    } catch (e) {
      toast.error(`${what}失败`, { description: errText(e) })
    }
  }

  const startPairing = async () => {
    try {
      const p = await api.devices.pairingCode(conn)
      setExpired(false)
      setPairing({ ...p, knownIds: new Set((devices ?? []).map((d) => d.deviceId)) })
    } catch (e) {
      toast.error('生成配对码失败', { description: errText(e) })
    }
  }

  const revoke = async (d: DeviceRow) => {
    try {
      await api.devices.revoke(conn, d.deviceId)
      load()
    } catch (e) {
      toast.error('撤销失败', { description: errText(e) })
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
          {devices.map((d) => {
            const own = browsers.filter((b) => b.deviceId === d.deviceId)
            // 手机上没有 Chrome 扩展；后端也只给已配对的设备签码（Stream Desktop 不在配对表里）。
            const canAddBrowser = d.paired && d.platform !== 'android'
            const code = browserPairing?.deviceId === d.deviceId ? browserPairing : null
            const note = browserNote?.deviceId === d.deviceId ? browserNote.text : null
            return (
              <li key={d.deviceId} className="space-y-1.5 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span className={`size-1.5 shrink-0 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                  <span className="min-w-0 flex-1 truncate text-[12px]">{d.name}</span>
                  {d.online && d.state?.a11yEnabled === false && (
                    <span className="rounded bg-amber-400/10 px-1.5 text-[11px] text-amber-300">无障碍已关</span>
                  )}
                  <span className="text-[11px] text-muted-foreground">{platformLabel(d.platform)}</span>
                  {canAddBrowser && (
                    <button
                      type="button"
                      aria-label={`${d.name} 添加浏览器`}
                      onClick={() => startBrowserPairing(d)}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      添加浏览器
                    </button>
                  )}
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
                </div>

                {own.length > 0 && (
                  <ul className="space-y-1 pl-3.5">
                    {own.map((b) => (
                      <li key={b.bindingId} className="flex items-center gap-2 text-[11px]">
                        <span className={`size-1.5 shrink-0 rounded-full ${b.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                        <span className="min-w-0 flex-1 truncate">{b.name}</span>
                        {b.default && <span className="rounded bg-foreground/10 px-1.5">默认</span>}
                        {b.platform && <span className="text-muted-foreground">{b.platform}</span>}
                        <button
                          type="button"
                          aria-label={b.default ? `${b.name} 取消默认` : `${b.name} 设为默认`}
                          onClick={() => browserAction(
                            b.default ? '取消默认' : '设为默认',
                            () => (b.default ? api.extBindings.clearDefault(conn, b.bindingId) : api.extBindings.setDefault(conn, b.bindingId)),
                          )}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {b.default ? '取消默认' : '设为默认'}
                        </button>
                        <button
                          type="button"
                          aria-label={`撤销浏览器 ${b.name}`}
                          onClick={() => browserAction('撤销', () => api.extBindings.revoke(conn, b.bindingId))}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          撤销
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {note && <p className="pl-3.5 text-[11px] text-muted-foreground">{note}</p>}

                {code && (
                  <div className="space-y-1 pl-3.5">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      在 {d.name} 的 Chrome 里：扩展图标 → Streams → 填下面任一个地址和配对码 → Pair。配对码 5 分钟内有效，只能用一次。
                    </p>
                    <div className="font-mono text-[18px] tracking-[0.3em]">{code.code}</div>
                    {code.backends.length === 0
                      ? <p className="text-[11px] text-muted-foreground">这台机器现在没有局域网地址，扩展里填你打开这个面板用的地址。</p>
                      : code.backends.map((u) => <div key={u} className="font-mono text-[11px] text-muted-foreground">{u}</div>)}
                  </div>
                )}
              </li>
            )
          })}
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

function platformLabel(p: DeviceRow['platform']): string {
  if (p === 'android') return '安卓'
  if (p === 'linux') return 'Linux'
  return '电脑'
}
