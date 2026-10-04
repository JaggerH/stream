import { useEffect, useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, type Connection } from '../../lib/api.ts'
import { Button } from '../acrylic/button.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../acrylic/sheet.tsx'

/**
 * 一个容器的最后几百行日志。
 *
 * 这是「起不来」这条异常唯一说得出原因的地方 —— `/api/packages` 不带错误文本（`PluginStatus`
 * 根本没有那个字段，硬凑一个就得新起一套探活）。所以这个抽屉不是锦上添花，是那条异常条的
 * 后半句。
 *
 * 三种失败**分别说**，因为处置完全不同：
 *  - 404 这个包没有容器 / 容器从没建起来 → 没什么可看的，去建它
 *  - 503 够不着 docker → 不是这个包的问题
 *  - 其余 → 原话照抄
 */
export function LogsSheet({
  pkgId,
  name,
  conn,
  onOpenChange,
}: {
  /** null = 关闭。用「哪个包」而不是一个 open 布尔，省掉一个会和它打架的第二状态。 */
  pkgId: string | null
  name: string
  conn: Connection
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 「刷新」= 把 nonce 加一，走同一条取数路径。另写一个刷新分支就会出现两份错误映射，
  // 而漂移的那一份只在刷新时才看得见。
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!pkgId) return
    let alive = true
    setLoading(true)
    setError(null)
    void api.packageLogs(conn, pkgId)
      .then((r) => { if (alive) { setLines(r.lines); setTruncated(r.truncated) } })
      .catch((err: unknown) => {
        if (!alive) return
        setLines([])
        // 三种失败的处置完全不同：没容器 → 去建它；够不着 docker → 不是这个包的问题。
        if (err instanceof ApiError && err.status === 404) setError(t('packages.logsNoContainer'))
        else if (err instanceof ApiError && err.status === 503) setError(t('packages.logsNoDocker'))
        else setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [pkgId, nonce, conn, t])

  return (
    <Sheet open={pkgId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[min(760px,94vw)] flex-col sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t('packages.logsTitle', { name })}</SheetTitle>
          <SheetDescription>{t('packages.logsBody')}</SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 px-4 pb-2">
          <Button variant="neutral" size="small" disabled={loading} onClick={() => setNonce((n) => n + 1)}>
            <RefreshCwIcon />{t('packages.logsRefresh')}
          </Button>
          {truncated ? (
            <span className="text-[11.5px] text-muted-foreground">{t('packages.logsTruncated')}</span>
          ) : null}
        </div>

        <div className="scrollbar-mac mx-4 mb-4 flex-1 overflow-auto rounded-[10px] bg-[var(--acr-card-nested)] p-3">
          {error ? (
            <p className="text-[12.5px] text-destructive">{error}</p>
          ) : loading && !lines.length ? (
            <p className="text-[12.5px] text-muted-foreground">{t('packages.logsLoading')}</p>
          ) : lines.length ? (
            // 日志是**等宽 + 不换行 + 横向滚动**：一行日志被折行会把时间戳和内容错开，
            // 扫的时候完全读不动。
            <pre className="whitespace-pre font-mono text-[11.5px] leading-[1.6]">{lines.join('\n')}</pre>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">{t('packages.logsEmpty')}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
