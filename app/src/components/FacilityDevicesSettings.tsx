import { useCallback, useEffect, useId, useState } from 'react'
import { api, ApiError, type Connection, type DeviceRow, type FacilityDeviceRow, type IdentityRow, type RunTarget } from '../lib/api.ts'
import { TargetSelect, environmentsInUse, identityChoices, targetOf } from './devices/TargetSelect.tsx'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

/** 这一行是不是还在本机（设备目标 `local`）。身份 / 环境目标的行没有 `deviceId`，不算本机。 */
const onThisMachine = (f: FacilityDeviceRow) => !f.accountId && !f.environment && (f.deviceId ?? 'local') === 'local'

/**
 * Where each account (facility) runs (design D2; browser-identity D7, D12): a device, an identity (one
 * account in the identity table, on whichever profile it is signed in), or an environment (whichever
 * profile is tagged with it). Runs of that facility's actions and recipe sources go there; a task can
 * still override it in its own editor. An identity or environment target never falls back to another
 * account or to this machine — the backend fails the run instead.
 *
 * Only facilities placed off this machine are listed: every installed package claims one, so the
 * full list (51 on a stock install, host pseudo-packages included) would bury the few that matter.
 * The rest are added through the picker. Moving a facility back to this machine deletes the binding.
 */
export function FacilityDevicesSettings({ conn }: { conn: Connection }) {
  const [facilities, setFacilities] = useState<FacilityDeviceRow[] | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [identities, setIdentities] = useState<IdentityRow[]>([])
  const [environments, setEnvironments] = useState<string[]>([])
  const [adding, setAdding] = useState<{ facility: string; target: RunTarget | null }>({ facility: '', target: null })
  const [note, setNote] = useState<string | null>(null)
  const listId = useId()

  const load = useCallback(() => {
    api.devices.facilities(conn)
      .then((r) => setFacilities(r.facilities))
      .catch((e) => { setFacilities([]); setNote(errText(e)) })
    api.devices.list(conn).then((r) => setDevices(r.devices ?? [])).catch(() => setDevices([]))
    // 老后端没有这两口：身份 / 环境两组就不出现，设备照旧能选。
    api.identities.list(conn).then((r) => setIdentities(r.identities ?? [])).catch(() => setIdentities([]))
    api.nodes.list(conn).then((r) => setEnvironments(environmentsInUse(r.nodes ?? []))).catch(() => setEnvironments([]))
  }, [conn])
  useEffect(load, [load])

  // 失败时重新读一遍而不是本地回滚：后端说了算，下拉回到它此刻真实的值。
  const assign = async (facility: string, t: RunTarget) => {
    setNote(null)
    try {
      if (t.kind === 'device' && t.deviceId === 'local') await api.devices.clearFacilityDevice(conn, facility)
      else await api.devices.setFacilityTarget(conn, facility, t)
    } catch (e) {
      setNote(errText(e))
    }
    load()
  }

  if (!facilities) return <div className="text-[12px] text-muted-foreground">读取中…</div>

  const bound = facilities.filter((f) => !onThisMachine(f))
  const unbound = facilities.filter(onThisMachine)
  const ctl = 'rounded border border-[var(--acr-border-soft)] bg-transparent px-1.5 py-0.5 text-[12px]'
  const addingFacility = adding.facility.trim()
  // 选「本机」等于什么都不改（没列出来的本来就在本机）：那样的「指定」是个点了没反应的键，不让按。
  const canAdd = unbound.some((f) => f.facility === addingFacility) && adding.target !== null
    && !(adding.target.kind === 'device' && adding.target.deviceId === 'local')
  // 除了本机无处可指（没有设备、身份表空、没标环境）时，整行不出现。
  const canPlaceElsewhere = devices.length > 0 || identities.some((i) => i.accountId) || environments.length > 0

  return (
    <div className="space-y-2.5">
      {bound.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">所有账号都在本机执行。</p>
      ) : (
        <ul className="space-y-1.5">
          {bound.map((f) => (
            <li key={f.facility} className="flex items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]">{f.facility}</span>
              <TargetSelect
                aria-label={`${f.facility} 在哪里执行`}
                value={targetOf(f)}
                onChange={(t) => { if (t) void assign(f.facility, t) }}
                devices={devices}
                identities={identityChoices(identities, f.facility)}
                environments={environments}
                className={ctl}
              />
            </li>
          ))}
        </ul>
      )}

      {canPlaceElsewhere && <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="账号"
          list={listId}
          value={adding.facility}
          // 换了账号，原先选的身份可能不属于它：清掉，免得把 A 站的账号指给 B 站（后端也会 400）。
          onChange={(e) => setAdding((a) => ({ facility: e.target.value, target: a.target?.kind === 'identity' ? null : a.target }))}
          placeholder="账号，如 eastmoney"
          className={`w-40 ${ctl}`}
        />
        <datalist id={listId}>
          {unbound.map((f) => <option key={f.facility} value={f.facility} />)}
        </datalist>
        <TargetSelect
          aria-label="在哪里执行"
          value={adding.target}
          onChange={(t) => setAdding((a) => ({ ...a, target: t }))}
          devices={devices}
          identities={identityChoices(identities, addingFacility)}
          environments={environments}
          emptyLabel="选位置"
          className={ctl}
        />
        <button
          type="button"
          disabled={!canAdd}
          onClick={() => {
            if (adding.target) void assign(addingFacility, adding.target)
            setAdding({ facility: '', target: null })
          }}
          className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1 text-[12px] hover:border-foreground/40 disabled:opacity-40"
        >
          指定
        </button>
      </div>}

      {note && <p className="text-[12px] text-amber-300">{note}</p>}
    </div>
  )
}
