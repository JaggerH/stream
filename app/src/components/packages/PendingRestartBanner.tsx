import { useState } from 'react'
import { RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PendingChange, RestartBackendResult } from '../../lib/types.ts'
import { Button } from '../acrylic/button.tsx'

/**
 * 「N 项变更等待重启生效」横幅 —— 包页顶部那一条。
 *
 * 纯展示 + 回调：取数（`/api/packages/pending`）与重启后的轮询都归页面，这里只管三件事：
 * 列出要重启的项、把「现在重启」发出去、409 时把正在跑的任务列出来并把按钮换成「强制重启」。
 *
 * 为什么 409 不是错误态：后端回 409 是在说「有任务正在跑，你确定吗」——那是一次二次确认，
 * 不是失败。它带来的 `running` 清单就是确认对话框的正文，所以 restart 的契约是「409 也正常
 * 返回」（见 api.restartBackend），横幅据此换文案，而不是 toast 一句红字然后什么都不变。
 *
 * 202 之后进入「后端重启中…」并把按钮锁住：这一刻后端已经在关，再点一次只会叠一次重启；
 * 横幅什么时候消失由页面决定（它轮 `/api/health.started_at`，变了就重新 load，pending 会随之清空）。
 */
export function PendingRestartBanner({
  pending, restart, onRestarted,
}: {
  pending: PendingChange[]
  restart: (force: boolean) => Promise<RestartBackendResult>
  onRestarted: () => void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<'idle' | 'sending' | 'restarting'>('idle')
  // 409 带回来的清单。有它 = 按钮变「强制重启」。再点一次 restart(false) 没意义——后端还是那句话。
  const [running, setRunning] = useState<{ id: string; label: string }[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const items = pending.filter((p) => p.needsRestart)
  if (!items.length) return null

  const fire = async (force: boolean) => {
    setPhase('sending')
    setFailure(null)
    try {
      const r = await restart(force)
      if (r.status === 409) {
        setRunning(r.running)
        setPhase('idle')
        return
      }
      setRunning(null)
      setPhase('restarting')
      onRestarted()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
      setPhase('idle')
    }
  }

  const force = running !== null
  return (
    <div
      role="status"
      data-testid="pending-restart-banner"
      className="flex flex-col gap-2 rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[12.5px]"
    >
      <div className="flex items-center gap-2.5">
        <RotateCwIcon className={`size-4 shrink-0 text-amber-600 dark:text-amber-400 ${phase === 'restarting' ? 'animate-spin' : ''}`} aria-hidden />
        <span className="font-semibold">
          {phase === 'restarting'
            ? t('packages.pendingRestart.restarting')
            : t('packages.pendingRestart.title', { count: items.length })}
        </span>
        {phase !== 'restarting' ? (
          <Button
            variant={force ? 'destructive' : 'default'}
            size="small"
            className="ml-auto shrink-0"
            disabled={phase === 'sending'}
            onClick={() => void fire(force)}
          >
            {force ? t('packages.pendingRestart.forceRestart') : t('packages.pendingRestart.restartNow')}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-0.5 pl-6 text-muted-foreground">
        {items.map((p) => (
          <li key={p.name} className="truncate">
            <span className="font-mono text-[11.5px] text-foreground">{p.name}</span>
            {' · '}
            {t(`packages.pendingRestart.kind.${p.kind}`)}
            {p.from && p.to ? ` ${p.from} → ${p.to}` : p.to ? ` ${p.to}` : p.from ? ` ${p.from}` : ''}
            {' — '}
            {p.why}
          </li>
        ))}
      </ul>
      {running ? (
        <p className="pl-6 text-amber-700 dark:text-amber-300">
          {t('packages.pendingRestart.running', { labels: running.map((r) => r.label).join('、') })}
        </p>
      ) : null}
      {failure ? (
        <p className="pl-6 text-destructive">{t('packages.pendingRestart.failed', { message: failure })}</p>
      ) : null}
    </div>
  )
}
