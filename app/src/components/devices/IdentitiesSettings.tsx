import { useCallback, useEffect, useState } from 'react'
import { toast } from '../acrylic/sonner.tsx'
import { api, ApiError, type Connection, type IdentityRow, type NodeRow } from '../../lib/api.ts'
import { ago, groupIdentities } from './identities.ts'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

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
