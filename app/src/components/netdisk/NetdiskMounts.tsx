import { useEffect, useRef, useState } from 'react'
import { RefreshCwIcon, HardDriveIcon, CheckIcon, CookieIcon, TriangleAlertIcon, InfoIcon } from 'lucide-react'
import { Button } from '../acrylic/button.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../acrylic/tooltip.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty.tsx'
import { api, type Connection } from '../../lib/api.ts'
import type { NetdiskMountPreset, NetdiskMountStatus, NetdiskMountsView } from '../../lib/types.ts'

/** 每个健康态的徽标文案 + 视觉。cookieReady 是过渡态（首屏会自动挂载）。 */
const STATUS_META: Record<NetdiskMountStatus, { label: string; variant: 'default' | 'outline' | 'destructive' }> = {
  mounted: { label: '已挂载', variant: 'default' },
  error: { label: '挂载失效', variant: 'destructive' },
  cookieReady: { label: '待挂载', variant: 'outline' },
  noCookie: { label: '待同步', variant: 'outline' },
}

/**
 * 挂载网盘（实时健康面板）——期望态在 Stream 侧，AList 只是执行器。
 * 只对「有 cookie / 已建 storage」的网盘显示为可用项，并打 Health 徽标区分
 * 已挂载 / 挂载失效 / 待挂载；没同步过任何 cookie 时给空态引导（用扩展同步即自动挂载）。
 * 首屏若发现可挂/失效项，静默 reconcile 一次（真·自动挂载）；「刷新」按钮手动重跑。
 */
export function NetdiskMounts({ apiBase = '', className }: { apiBase?: string; className?: string }) {
  const conn: Connection = { baseUrl: apiBase }
  const [view, setView] = useState<NetdiskMountsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 记录已对哪个 apiBase 自动挂载过——防首屏 reconcile 与后续刷新形成回环。 */
  const autoTriedRef = useRef<string | null>(null)

  const reconcile = async () => {
    setBusy(true); setError(null)
    try {
      await api.netdisk.reconcileMounts(conn)
      setView(await api.netdisk.mounts(conn))
    } catch (e) { setError(e instanceof Error ? e.message : '挂载失败') } finally { setBusy(false) }
  }

  const load = async () => {
    setLoading(true)
    try {
      const v = await api.netdisk.mounts(conn)
      setView(v); setError(null)
      // 首屏自动挂载：有 cookie 未挂 / 挂载失效 → 静默 reconcile 一次（每个 apiBase 只一次）。
      if (autoTriedRef.current !== apiBase && v.alistReachable && v.presets.some((p) => p.status === 'cookieReady' || p.status === 'error')) {
        autoTriedRef.current = apiBase
        void reconcile()
      }
    } catch (e) { setError(e instanceof Error ? e.message : '挂载配置不可用') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [apiBase])

  const presets = view?.presets ?? []
  const available = presets.filter((p) => p.status !== 'noCookie')

  return (
    <div data-slot="netdisk-mounts" className={`flex flex-col gap-2 ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <HardDriveIcon className="size-3.5" />
          挂载网盘
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="挂载说明" className="text-muted-foreground hover:text-foreground">
                <InfoIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>同步 cookie 后网盘可自动挂载，目前支持 115 / UC / 夸克。</TooltipContent>
          </Tooltip>
        </span>
        <Button variant="ghost" size="mini" disabled={busy || loading} onClick={() => void reconcile()}>
          <RefreshCwIcon />
          刷新
        </Button>
      </div>

      {error && <p className="text-[11px] text-destructive">{error}</p>}
      {view && !view.alistReachable && (
        <p className="flex items-center gap-1 text-[11px] text-destructive">
          <TriangleAlertIcon className="size-3 shrink-0" />
          AList 服务不可达，稍后点刷新重试。
        </p>
      )}

      {loading ? (
        <p className="px-2 py-3 text-[11px] text-muted-foreground">加载中…</p>
      ) : available.length === 0 ? (
        <Empty className="border border-dashed border-[var(--acr-border-soft)] py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CookieIcon /></EmptyMedia>
            <EmptyTitle>还没有可挂载的网盘</EmptyTitle>
            <EmptyDescription>
              用浏览器扩展同步下面任一网盘的 cookie，即可自动挂载：
              <span className="mt-1 block text-foreground">{presets.map((p) => p.label).join(' · ')}</span>
              同步后点上方「刷新」。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-1">
          {available.map((p) => (
            <MountRow key={p.id} preset={p} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** 单行网盘（缩窄版）：Health 徽标 + 名称 + 挂载点；失效时补一句自愈提示。 */
function MountRow({ preset }: { preset: NetdiskMountPreset }) {
  const meta = STATUS_META[preset.status]
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-[var(--acr-border-soft)] px-2 py-1">
      <div className="flex items-center gap-1.5 text-[12px] text-foreground">
        <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
        <span className="truncate">{preset.label}</span>
        <code className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">{preset.mountPath}</code>
        {preset.status === 'mounted' && <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
      {preset.status === 'error' && (
        <div className="flex items-center gap-1 text-[10.5px] text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="size-3 shrink-0" />
          cookie 可能已失效——用扩展重新同步后点「刷新」自愈。
        </div>
      )}
    </li>
  )
}
