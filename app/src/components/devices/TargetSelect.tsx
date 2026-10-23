import type { DeviceRow, IdentityRow, RunTarget } from '../../lib/api.ts'
import { groupIdentities } from './identities.ts'

/** 身份下拉的一项：身份表里该 facility 出现过的账号（D12：只列表里有的）。 */
export interface IdentityChoice {
  accountId: string
  name: string
  signedIn: boolean
}

/** 身份表 → 某个 facility 的可选身份。登出且从没见过账号的行不算身份（没有 id 可指）。 */
export function identityChoices(rows: IdentityRow[], facility: string | undefined): IdentityChoice[] {
  if (!facility) return []
  return groupIdentities(rows.filter((r) => r.facility === facility))
    .filter((g) => g.accountId !== undefined)
    .map((g) => ({ accountId: g.accountId!, name: g.name, signedIn: g.signedIn }))
}

/** 节点上标过的环境，去重排好。 */
export function environmentsInUse(nodes: Array<{ environment?: string }>): string[] {
  return [...new Set(nodes.flatMap((n) => (n.environment ? [n.environment] : [])))].sort()
}

const encode = (t: RunTarget | null): string =>
  t === null ? '' : t.kind === 'device' ? `d:${t.deviceId}` : t.kind === 'identity' ? `i:${t.accountId}` : `e:${t.environment}`

const decode = (v: string): RunTarget | null => {
  if (v.startsWith('d:')) return { kind: 'device', deviceId: v.slice(2) }
  if (v.startsWith('i:')) return { kind: 'identity', accountId: v.slice(2) }
  if (v.startsWith('e:')) return { kind: 'environment', environment: v.slice(2) }
  return null
}

/**
 * 「在哪里执行」的下拉（browser-identity D7、D12）：设备 / 身份 / 环境三组，选一个。
 *
 * - 设备：本机 + 各设备（离线的也列、标出来）。设备上有多个 profile 时按「默认 → 最近连上」选，不看身份。
 * - 身份：只列身份表里这个账号体系出现过的账号；一个都没有时整组不出现（不画选了也没用的项）。
 * - 环境：节点上标过的环境；同样，没有就不出现。
 *
 * 当前值指着一个已经不在列表里的东西（设备撤销了、身份表清了）时照样显示出来，否则下拉会默默跳到别的值。
 * `emptyLabel` 给了就多一个空选项（任务编辑器的「跟随账号的默认」、添加行的「选位置」），选它回 `null`。
 */
export function TargetSelect({ value, onChange, devices, identities, environments, emptyLabel, className, ...rest }: {
  value: RunTarget | null
  onChange: (t: RunTarget | null) => void
  devices: DeviceRow[]
  identities: IdentityChoice[]
  environments: string[]
  emptyLabel?: string
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}) {
  const v = encode(value)
  const known = new Set([
    'd:local',
    ...devices.map((d) => `d:${d.deviceId}`),
    ...identities.map((i) => `i:${i.accountId}`),
    ...environments.map((e) => `e:${e}`),
  ])
  const stale = value !== null && !known.has(v)
  return (
    <select {...rest} className={className} value={v} onChange={(e) => onChange(decode(e.target.value))}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {stale && <option value={v}>{value.kind === 'device' ? value.deviceId : value.kind === 'identity' ? `身份 ${value.accountId}` : `环境「${value.environment}」`}</option>}
      <optgroup label="设备">
        <option value="d:local">本机</option>
        {devices.map((d) => <option key={d.deviceId} value={`d:${d.deviceId}`}>{d.online ? d.name : `${d.name}（离线）`}</option>)}
      </optgroup>
      {identities.length > 0 && (
        <optgroup label="身份">
          {identities.map((i) => <option key={i.accountId} value={`i:${i.accountId}`}>{i.signedIn ? i.name : `${i.name}（已登出）`}</option>)}
        </optgroup>
      )}
      {environments.length > 0 && (
        <optgroup label="环境">
          {environments.map((e) => <option key={e} value={`e:${e}`}>环境「{e}」</option>)}
        </optgroup>
      )}
    </select>
  )
}

/** facility 行 / 任务行上的三格 → 目标。三格都没有 = null。 */
export function targetOf(r: { deviceId?: string; device?: string; accountId?: string; identity?: string; environment?: string }): RunTarget | null {
  const accountId = r.accountId ?? r.identity
  if (accountId) return { kind: 'identity', accountId }
  if (r.environment) return { kind: 'environment', environment: r.environment }
  const deviceId = r.deviceId ?? r.device
  return deviceId ? { kind: 'device', deviceId } : null
}
