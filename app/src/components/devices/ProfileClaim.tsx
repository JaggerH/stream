import { useEffect, useState } from 'react'
import { api, ApiError, type ClaimProfileRow, type ClaimSnapshot, type Connection } from '../../lib/api.ts'

/** 认领会话的轮询间隔。会话 20 秒内有结论（D3），1.5 秒一问足够跟上。 */
export const CLAIM_POLL_MS = 1500

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

function stateText(p: ClaimProfileRow): string {
  if (p.state === 'claimed') return '已识别'
  if (p.state === 'pending') return '等待中…'
  if (p.state === 'missing') return p.reason ?? '扩展未安装或未连上'
  return `失败：${p.reason ?? '未知原因'}`
}

/**
 * 「识别 profile」（browser-identity D3）：那台机器上的 Stream Desktop 列出 Chrome 的全部 profile，逐个用该
 * profile 打开扩展自己的认领页；页面里的扩展把一次性码交回，Stream 就知道这个扩展在哪个 profile 里。
 *
 * 会在那台机器上**每个 profile 开一扇窗**，所以只在用户点的时候做，按钮旁边说清楚。只有后端说这台设备能
 * 识别（`claimable`）时上层才画这个按钮；远处打开面板时后端 403，原话显示在下面。
 *
 * 20 秒没交回的 profile 标「扩展未安装或未连上」——那个 profile 里没装扩展，或者装了但没连上 Stream。
 */
export function ProfileClaim({ conn, deviceId, deviceName, onDone }: {
  conn: Connection
  /** 扩展设备 id：`local` = 本机。 */
  deviceId: string
  deviceName: string
  /** 一次认领有了结论（全部 profile 都不再等）。上层据此重读节点。 */
  onDone: () => void
}) {
  const [snap, setSnap] = useState<ClaimSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const claimId = snap && !snap.done ? snap.claimId : undefined
  useEffect(() => {
    if (!claimId) return
    const t = setInterval(() => {
      api.nodes.claim(conn, deviceId, claimId)
        .then((s) => {
          setSnap(s)
          if (s.done) onDone()
        })
        .catch((e) => {
          // 会话过期（2 分钟）或后端重启：停下，说一句，让用户重来。
          setSnap((cur) => (cur ? { ...cur, done: true } : cur))
          setNote(errText(e))
        })
    }, CLAIM_POLL_MS)
    return () => clearInterval(t)
  }, [conn, deviceId, claimId, onDone])

  const start = async () => {
    setBusy(true)
    setNote(null)
    try {
      const s = await api.nodes.startClaim(conn, deviceId)
      setSnap(s)
      if (s.done) onDone()
    } catch (e) {
      setSnap(null)
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const running = busy || (snap !== null && !snap.done)
  return (
    <div className="space-y-1 pl-3.5 text-[11px]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${deviceName} 识别 profile`}
          disabled={running}
          onClick={() => void start()}
          className="rounded border border-[var(--acr-border-soft)] px-1.5 py-0.5 hover:border-foreground/40 disabled:opacity-40"
        >
          {running ? '识别中…' : '识别 profile'}
        </button>
        <span className="text-muted-foreground">会在 {deviceName} 上为每个 Chrome profile 开一扇窗，认出来后可以关掉。</span>
      </div>
      {snap && snap.profiles.length === 0 && <p className="text-muted-foreground">这台机器上的 Chrome 没有 profile。</p>}
      {snap && snap.profiles.length > 0 && (
        <ul className="space-y-0.5">
          {snap.profiles.map((p) => (
            <li key={p.dir} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{p.name}<span className="text-muted-foreground">（{p.dir}）</span></span>
              <span className={p.state === 'claimed' ? 'text-emerald-400' : p.state === 'pending' ? 'text-muted-foreground' : 'text-amber-300'}>
                {stateText(p)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-amber-300">{note}</p>}
    </div>
  )
}
