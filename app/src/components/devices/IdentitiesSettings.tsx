import { useCallback, useEffect, useState } from 'react'
import { toast } from '../acrylic/sonner.tsx'
import { api, ApiError, type Connection, type IdentityRow, type NodeRow } from '../../lib/api.ts'
import { nodeTitle } from './NodeRow.tsx'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

/** 「3 分钟前」。身份表的新鲜度决定执行前要不要再核对（采集 10 分钟、动作 60 秒），所以给相对时间。 */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export interface IdentityGroup {
  facility: string
  accountId?: string
  name: string
  signedIn: boolean
  verifiedAt: number
  nodes: Array<{ nodeId: string; name: string; online: boolean; signedIn: boolean }>
}

/**
 * 身份表的行是（facility，节点）；给人看的是（facility，账号）——同一个账号可以登在好几个 profile 里
 * （D6：身份 = facility + 账号，出现在多个节点上）。登出且从没见过账号的行各自成组。
 */
export function groupIdentities(rows: IdentityRow[], nodes: NodeRow[] = []): IdentityGroup[] {
  const byNode = new Map(nodes.map((n) => [n.nodeId, n]))
  const groups = new Map<string, IdentityGroup>()
  for (const r of rows) {
    const key = `${r.facility}\u0000${r.accountId ?? `-${r.nodeId}`}`
    const g = groups.get(key) ?? {
      facility: r.facility,
      ...(r.accountId ? { accountId: r.accountId } : {}),
      name: r.displayName ?? r.accountId ?? '（已登出）',
      signedIn: false,
      verifiedAt: 0,
      nodes: [],
    }
    const n = byNode.get(r.nodeId)
    g.nodes.push({ nodeId: r.nodeId, name: n ? nodeTitle(n) : r.profileName ?? r.nodeId, online: r.online, signedIn: r.state === 'signed-in' })
    g.signedIn ||= r.state === 'signed-in'
    g.verifiedAt = Math.max(g.verifiedAt, r.verifiedAt)
    // 显示名以登着的那一行为准（登出的行保留的是上次的名字）。
    if (r.state === 'signed-in' && r.displayName) g.name = r.displayName
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.facility.localeCompare(b.facility) || a.name.localeCompare(b.name))
}

/**
 * 站点身份表（browser-identity D6、D12）：每个账号（facility）在哪些 profile 里登着谁、上次核对是什么时候。
 *
 * 表由 Stream 自己维护：节点连上、会话 cookie 变了、登录之后都会去问。「刷新」是手动再问一遍此刻在线的
 * 浏览器——离线的问不着，结果里没问着的单独说出来，表照旧（`unknown` 不写表）。身份服务不可用（stream.db
 * 打不开，503）时只显示原因，不画刷新键。
 */
export function IdentitiesSettings({ conn }: { conn: Connection }) {
  const [rows, setRows] = useState<IdentityRow[] | null>(null)
  const [nodes, setNodes] = useState<NodeRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.identities.list(conn)
      .then((r) => { setRows(r.identities ?? []); setError(null) })
      .catch((e) => setError(errText(e)))
    api.nodes.list(conn).then((r) => setNodes(r.nodes ?? [])).catch(() => setNodes([]))
  }, [conn])
  useEffect(load, [load])

  const refresh = async () => {
    setBusy(true)
    try {
      const r = await api.identities.refresh(conn)
      setRows(r.identities ?? [])
      const unknown = r.results.filter((x) => x.result.state === 'unknown').length
      if (r.results.length === 0) toast.info('没有在线的浏览器可问')
      else if (unknown > 0) toast.warning(`问了 ${r.results.length} 处，${unknown} 处没问着`, { description: '没问着的保持原样，下次连上时再问。' })
      else toast.success(`问了 ${r.results.length} 处`)
    } catch (e) {
      toast.error('刷新失败', { description: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="text-[12px] text-muted-foreground">{error}</p>
  if (!rows) return <p className="text-[12px] text-muted-foreground">读取中…</p>
  const groups = groupIdentities(rows, nodes)

  return (
    <div className="space-y-2">
      {groups.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">还没有记下任何登录。浏览器连上之后，Stream 会去问各站点登着谁。</p>
      ) : (
        <table className="w-full text-left text-[12px]">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-normal">账号体系</th>
              <th className="py-1 pr-2 font-normal">账号</th>
              <th className="py-1 pr-2 font-normal">在哪些 profile 里</th>
              <th className="py-1 font-normal">上次核对</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.facility}-${g.accountId ?? g.nodes[0]?.nodeId}`} className="border-t border-[var(--acr-border-soft)] align-top">
                <td className="py-1 pr-2">{g.facility}</td>
                <td className="py-1 pr-2">
                  {g.name}
                  {!g.signedIn && <span className="ml-1.5 rounded bg-amber-400/10 px-1.5 text-[11px] text-amber-300">已登出</span>}
                </td>
                <td className="py-1 pr-2">
                  {g.nodes.map((n) => (
                    <span key={n.nodeId} className="mr-2 inline-flex items-center gap-1 whitespace-nowrap">
                      <span className={`size-1.5 rounded-full ${n.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                      <span className={n.signedIn ? '' : 'text-muted-foreground line-through'}>{n.name}</span>
                    </span>
                  ))}
                </td>
                <td className="py-1 text-[11px] text-muted-foreground" title={new Date(g.verifiedAt).toLocaleString()}>{ago(g.verifiedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1 text-[12px] hover:border-foreground/40 disabled:opacity-40"
      >
        {busy ? '正在问…' : '刷新'}
      </button>
    </div>
  )
}
