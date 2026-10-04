import { useEffect, useState } from 'react'
import { RefreshCw, Plus, X, Check } from 'lucide-react'
import { parseDomainInput, type Config } from '../../lib/config.ts'
import type { SyncReason, SyncResult } from '../../lib/sync.ts'
import { cn } from '@/lib/utils.ts'
import { Button } from '@/components/acrylic/button.tsx'
import { Separator } from '@/components/acrylic/separator.tsx'
import { Item, ItemContent, ItemTitle, ItemActions } from '@/components/acrylic/item.tsx'
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from '@/components/acrylic/input-group.tsx'

const REASON_TEXT: Record<SyncReason, string> = {
  nudged: 'Stream notified — it pulls the cookies itself.',
  relay_down: 'Stream isn’t connected right now; it will pull as soon as it reconnects.',
  no_stream_url: 'Set your Stream URL first.',
  no_domains: 'No sync domains configured.',
  sync_config_unavailable: 'This Stream instance doesn’t report a sync scope — update it.',
}

/**
 * 这一轮算不算成功。**判据只有 reason**：扩展根本不推（登录态由 Stream 自己来取），
 * 所以 `SyncResult` 里没有、也不该有"推成功了吗"这种字段——照那种字段判，每一次正常同步
 * 都会显示成红色失败。
 */
const SUCCESS_REASONS: SyncReason[] = ['nudged']
function isSuccess(r: SyncResult | { error: string } | null): boolean {
  return !!r && !('error' in r) && SUCCESS_REASONS.includes(r.reason)
}

/** Only shown when something's wrong — one line saying which guard stopped this round.
 *  Success never reaches here; it's a tick beside the button. */
function failureText(r: SyncResult | { error: string }): string {
  if ('error' in r) return `Sync failed: ${r.error}`
  return REASON_TEXT[r.reason]
}

/** Cookie tab: manual sync, the auto-sync switch + interval presets, and the sync-domain list. */
export function CookiePanel({
  cfg,
  onConfig,
  syncing,
  onSyncNow,
  syncResult,
}: {
  cfg: Config
  onConfig: (patch: Partial<Config>) => void
  syncing: boolean
  onSyncNow: () => void
  syncResult: SyncResult | { error: string } | null
}) {
  const [draft, setDraft] = useState('')

  // Success is a transient tick: show it briefly after a good sync, then fall back to the "last"
  // time. Failures (below) are NOT auto-cleared, so a problem stays on screen until the next sync.
  const [showTick, setShowTick] = useState(false)
  useEffect(() => {
    if (!isSuccess(syncResult)) {
      setShowTick(false)
      return
    }
    setShowTick(true)
    const t = setTimeout(() => setShowTick(false), 2500)
    return () => clearTimeout(t)
  }, [syncResult])

  function addDomain() {
    const host = parseDomainInput(draft)
    setDraft('')
    if (!host || cfg.domains.includes(host)) return
    onConfig({ domains: [...cfg.domains, host] })
  }
  const removeDomain = (d: string) => onConfig({ domains: cfg.domains.filter((x) => x !== d) })
  /** Stream-required domains the user hasn't listed themselves — the part of the sync scope that
   *  would otherwise be invisible. Empty until the first sync caches it. */
  const extraRequired = (cfg.requiredDomains ?? []).filter((d) => !cfg.domains.includes(d))

  return (
    <div className="flex flex-col gap-3">
      {/* Manual sync — success is a tick + brief counts beside the button; a failure drops a full
          diagnostic below it (only when something's actually wrong). */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Button size="small" variant="neutral" onClick={onSyncNow} disabled={syncing}>
            <RefreshCw className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync cookies'}
          </Button>
          {showTick ? (
            <Check className="size-4 text-[var(--acr-green)] transition-opacity" />
          ) : cfg.lastSync ? (
            <span className="text-[11px] text-muted-foreground">last {new Date(cfg.lastSync).toLocaleTimeString()}</span>
          ) : null}
        </div>
        {syncResult && !isSuccess(syncResult) && (
          <p className="whitespace-pre-line break-all rounded-md border border-[var(--acr-red)]/30 bg-[var(--acr-red)]/10 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--acr-orange)]">
            {failureText(syncResult)}
          </p>
        )}
      </div>

      {/* 自动同步开关。**这里曾经还有一排「间隔 15/30/60/120 分钟」的预设，已经撤掉**——
          周期同步没了（登录态由 Stream 自己来取），留着那排按钮就是一个点了不起作用的控件，
          比没有更糟。开关本身还在：它控制的是"cookie 变了要不要自动叫 Stream 来取"。 */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>自动同步</span>
        <Button
          size="small"
          variant={cfg.autoSync ? 'default' : 'neutral'}
          onClick={() => onConfig({ autoSync: !cfg.autoSync })}
        >
          {cfg.autoSync ? '开' : '关'}
        </Button>
      </div>

      <Separator />

      {/* Sync domains — an editable item list (add / remove); replaces the old textarea.
          The remove control is hover-revealed per row so the resting list is a clean
          read-only view and nobody fat-fingers a delete; the list scrolls past ~5 rows
          while the add field below stays fixed and always reachable. */}
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">同步域名 ({cfg.domains.length})</div>
        {cfg.domains.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/70">还没有域名。加上你要同步 cookie 的站点。</p>
        ) : (
          <div className="scrollbar-mac -mr-1 flex max-h-[168px] flex-col gap-1.5 overflow-y-auto pr-1">
            {cfg.domains.map((d) => (
              <Item key={d} variant="muted" size="sm" className="items-center">
                <ItemContent>
                  <ItemTitle className="text-[13px]">{d}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    icon
                    size="small"
                    variant="ghost"
                    aria-label={`Remove ${d}`}
                    className="opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/item:opacity-100"
                    onClick={() => removeDomain(d)}
                  >
                    <X />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
        <InputGroup>
          <InputGroupInput
            value={draft}
            placeholder="添加域名，如 weibo.com"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addDomain()
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={addDomain} aria-label="Add domain">
              <Plus />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {/* Domains Stream asked for on its own (its installed sources declare them). Shown but not
            editable here — deleting one would just come back on the next sync, and hiding them
            entirely is what made a missing quark.cn look like "logged out" for days. */}
        {extraRequired.length > 0 && (
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            Stream 另外要求（自动同步）：{extraRequired.join('、')}
          </p>
        )}
      </div>
    </div>
  )
}
