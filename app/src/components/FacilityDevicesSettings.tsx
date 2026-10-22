import { useCallback, useEffect, useId, useState } from 'react'
import { api, ApiError, type Connection, type DeviceRow, type FacilityDeviceRow } from '../lib/api.ts'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

/**
 * Which device each account (facility) runs on (design D2). Runs of that facility's actions and
 * recipe sources go to that device; a task can still override it in its own editor.
 *
 * Only facilities bound off this machine are listed: every installed package claims one, so the
 * full list (51 on a stock install, host pseudo-packages included) would bury the few that matter.
 * The rest are added through the picker. Moving a facility back to this machine deletes the binding.
 */
export function FacilityDevicesSettings({ conn }: { conn: Connection }) {
  const [facilities, setFacilities] = useState<FacilityDeviceRow[] | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [adding, setAdding] = useState({ facility: '', deviceId: '' })
  const [note, setNote] = useState<string | null>(null)
  const listId = useId()

  const load = useCallback(() => {
    api.devices.facilities(conn)
      .then((r) => setFacilities(r.facilities))
      .catch((e) => { setFacilities([]); setNote(errText(e)) })
    api.devices.list(conn).then((r) => setDevices(r.devices)).catch(() => setDevices([]))
  }, [conn])
  useEffect(load, [load])

  // 失败时重新读一遍而不是本地回滚：后端说了算，下拉回到它此刻真实的值。
  const assign = async (facility: string, deviceId: string) => {
    setNote(null)
    try {
      if (deviceId === 'local') await api.devices.clearFacilityDevice(conn, facility)
      else await api.devices.setFacilityDevice(conn, facility, deviceId)
    } catch (e) {
      setNote(errText(e))
    }
    load()
  }

  if (!facilities) return <div className="text-[12px] text-muted-foreground">读取中…</div>

  const bound = facilities.filter((f) => f.deviceId !== 'local')
  const unbound = facilities.filter((f) => f.deviceId === 'local')
  const deviceOptions = devices.map((d) => (
    <option key={d.deviceId} value={d.deviceId}>{d.online ? d.name : `${d.name}（离线）`}</option>
  ))
  const canAdd = unbound.some((f) => f.facility === adding.facility.trim()) && adding.deviceId !== ''

  return (
    <div className="space-y-2.5">
      {bound.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">所有账号都在本机执行。</p>
      ) : (
        <ul className="space-y-1.5">
          {bound.map((f) => (
            <li key={f.facility} className="flex items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]">{f.facility}</span>
              <select
                aria-label={`${f.facility} 在哪台设备上执行`}
                value={f.deviceId}
                onChange={(e) => void assign(f.facility, e.target.value)}
                className="rounded border border-[var(--acr-border-soft)] bg-transparent px-1.5 py-0.5 text-[12px]"
              >
                <option value="local">本机</option>
                {/* 绑着一台已经不在列表里的设备（被撤销了）也要显示出来，否则下拉会默默跳到别的值。 */}
                {!devices.some((d) => d.deviceId === f.deviceId) && <option value={f.deviceId}>{f.deviceId}</option>}
                {deviceOptions}
              </select>
            </li>
          ))}
        </ul>
      )}

      {devices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="账号"
            list={listId}
            value={adding.facility}
            onChange={(e) => setAdding((a) => ({ ...a, facility: e.target.value }))}
            placeholder="账号，如 eastmoney"
            className="w-40 rounded border border-[var(--acr-border-soft)] bg-transparent px-1.5 py-0.5 text-[12px]"
          />
          <datalist id={listId}>
            {unbound.map((f) => <option key={f.facility} value={f.facility} />)}
          </datalist>
          <select
            aria-label="设备"
            value={adding.deviceId}
            onChange={(e) => setAdding((a) => ({ ...a, deviceId: e.target.value }))}
            className="rounded border border-[var(--acr-border-soft)] bg-transparent px-1.5 py-0.5 text-[12px]"
          >
            <option value="">选设备</option>
            {deviceOptions}
          </select>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => {
              void assign(adding.facility.trim(), adding.deviceId)
              setAdding({ facility: '', deviceId: '' })
            }}
            className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1 text-[12px] hover:border-foreground/40 disabled:opacity-40"
          >
            指定
          </button>
        </div>
      )}

      {note && <p className="text-[12px] text-amber-300">{note}</p>}
    </div>
  )
}
