import { useEffect, useState } from 'react'
import { api, ApiError, type ClaimProfileRow, type ClaimSnapshot, type Connection, type DiscoveredProfile } from '../../lib/api.ts'

/** 认领会话的轮询间隔。会话 20 秒内有结论（D3），1.5 秒一问足够跟上。 */
export const CLAIM_POLL_MS = 1500

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '后端未响应')

function stateText(p: ClaimProfileRow): string {
  if (p.state === 'claimed') return '已识别'
  if (p.state === 'pending') return '等待中…'
  if (p.state === 'missing') return p.reason ?? '扩展未安装或未连上'
  return `失败：${p.reason ?? '未知原因'}`
}

/** 默认勾上哪些：装着扩展（或说不清）且还没认领的。没装的开出认领页只是一扇打不开的窗。 */
export function preselect(profiles: DiscoveredProfile[]): Set<string> {
  return new Set(profiles.filter((p) => p.hasExtension !== false && !p.nodeId).map((p) => p.dir))
}

/**
 * 「识别 profile」（browser-identity D3）：先列出那台机器上 Chrome 的 profile（只读，不开窗），用户勾选要认领
 * 的；再用每个勾中的 profile 打开扩展自己的认领页，页面里的扩展把一次性码交回，Stream 就知道这个扩展在哪个
 * profile 里。
 *
 * 认领会在那台机器上**为每个勾中的 profile 开一扇窗**，所以先挑再开。默认勾上装着扩展且没认领过的；没装的
 * 列出来、不勾，提示先去装。只有后端说这台设备能识别（`claimable`）时上层才画这个按钮；远处打开面板时后端
 * 403，原话显示在下面。
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
  /** 列出来、等用户挑的 profile。null = 没在挑。 */
  const [found, setFound] = useState<DiscoveredProfile[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
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

  const discover = async () => {
    setBusy(true)
    setNote(null)
    setSnap(null)
    try {
      const d = await api.nodes.profiles(conn, deviceId)
      setFound(d.profiles)
      setPicked(preselect(d.profiles))
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    // 按列出来的顺序交，和 Chrome 的 profile 选单一致。
    const dirs = (found ?? []).map((p) => p.dir).filter((d) => picked.has(d))
    setBusy(true)
    setNote(null)
    try {
      const s = await api.nodes.startClaim(conn, deviceId, dirs)
      setFound(null)
      setSnap(s)
      if (s.done) onDone()
    } catch (e) {
      setSnap(null)
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (dir: string) => setPicked((cur) => {
    const next = new Set(cur)
    if (next.has(dir)) next.delete(dir)
    else next.add(dir)
    return next
  })

  const running = busy || (snap !== null && !snap.done)
  return (
    <div className="space-y-1 pl-3.5 text-[11px]">
      <div className="flex items-center gap-2">
        {found ? (
          <>
            <button
              type="button"
              disabled={busy || picked.size === 0}
              onClick={() => void start()}
              className="rounded border border-[var(--acr-border-soft)] px-1.5 py-0.5 hover:border-foreground/40 disabled:opacity-40"
            >
              为 {picked.size} 个 profile 打开认领页
            </button>
            <button type="button" onClick={() => setFound(null)} className="text-muted-foreground hover:text-foreground">取消</button>
            <span className="text-muted-foreground">会在 {deviceName} 上为勾中的 profile 各开一扇窗，认出来后可以关掉。</span>
          </>
        ) : (
          <>
            <button
              type="button"
              aria-label={`${deviceName} 识别 profile`}
              disabled={running}
              onClick={() => void discover()}
              className="rounded border border-[var(--acr-border-soft)] px-1.5 py-0.5 hover:border-foreground/40 disabled:opacity-40"
            >
              {running ? '识别中…' : '识别 profile'}
            </button>
            <span className="text-muted-foreground">先列出 {deviceName} 上的 Chrome profile，勾选后再开认领页。</span>
          </>
        )}
      </div>
      {found && found.length === 0 && <p className="text-muted-foreground">这台机器上的 Chrome 没有 profile。</p>}
      {found && found.length > 0 && (
        <ul className="space-y-0.5">
          {found.map((p) => (
            <li key={p.dir}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`${p.name}（${p.dir}）`}
                  checked={picked.has(p.dir)}
                  onChange={() => toggle(p.dir)}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}<span className="text-muted-foreground">（{p.dir}）</span></span>
                {p.hasExtension === false ? (
                  <span className="text-amber-300">没装 Stream 扩展——先在这个 profile 里装上，再来识别</span>
                ) : p.nodeId ? (
                  <span className="text-muted-foreground">已识别过</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      )}
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
