import { useState, type ReactNode } from 'react'
import { ChevronDownIcon, ArrowLeftIcon } from 'lucide-react'
import { NetdiskBindings } from './netdisk/NetdiskBindings.tsx'
import { Button } from './acrylic/button.tsx'
import { Field, FieldLabel, FieldDescription } from './acrylic/field.tsx'
import { Input } from './acrylic/input.tsx'
import { InputGroup, InputGroupTextarea } from './acrylic/input-group.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './acrylic/select.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.tsx'
import { ShellContent, ShellNavbar, ShellPanel } from './acrylic/shell.tsx'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './acrylic/breadcrumb.tsx'
import { DEFAULT_HARVEST } from '@subscribe/subscribe.ts'
import type { Connection } from '../lib/api.ts'
import { api } from '../lib/api.ts'
import type { ChannelStream } from '../lib/types.ts'

type CadenceUnit = 's' | 'm' | 'h' | 'd'
const UNIT_SECONDS: Record<CadenceUnit, number> = { s: 1, m: 60, h: 3600, d: 86400 }

// Present cadence_seconds as the coarsest whole value+unit so a 1800s stream shows "30 分钟",
// not "1800 秒". Non-round values fall back to seconds.
function splitCadence(seconds: number): { value: number; unit: CadenceUnit } {
  if (seconds > 0 && seconds % 86400 === 0) return { value: seconds / 86400, unit: 'd' }
  if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: 'h' }
  if (seconds > 0 && seconds % 60 === 0) return { value: seconds / 60, unit: 'm' }
  return { value: seconds, unit: 's' }
}

function parseLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Collapsible section — same framing as BackendSettings so the sheet stays scannable
 *  (bordered box, title + chevron, body collapses). Each section keeps its own open state. */
function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-[var(--acr-border-soft)] bg-[var(--acr-card-nested)]">
      <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2.5 text-[13px] font-medium text-foreground">
        {title}
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t border-[var(--acr-border-soft)] px-3 py-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Edit a Stream's schedule (抓取方式 strategy + 抓取时间 cadence) and its per-stream
 *  过滤规则 (ad_filter) — now rendered as a secondary page view instead of a sliding Sheet drawer. */
export function StreamSettingPage({
  conn, channelId, stream, onBack, onSaved,
  channelName,
  open: _open, onOpenChange // Backwards compatibility for testing
}: {
  conn: Connection
  channelId: string
  stream: ChannelStream
  onBack?: () => void
  onSaved?: () => void
  channelName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const initialCadence = splitCadence(stream.cadence_seconds)
  const [strategy, setStrategy] = useState<'fanout' | 'exclusive'>(stream.strategy ?? 'fanout')
  const [cadenceValue, setCadenceValue] = useState(String(initialCadence.value))
  const [cadenceUnit, setCadenceUnit] = useState<CadenceUnit>(initialCadence.unit)
  const [keywords, setKeywords] = useState((stream.ad_filter?.keywords ?? []).join('\n'))
  const [domains, setDomains] = useState((stream.ad_filter?.domains ?? []).join('\n'))
  const [includeKw, setIncludeKw] = useState((stream.title_include ?? []).join('\n'))
  // 抓取深度（初次回填 / 增量）——未设过时回落到后端默认；非默认才自动展开「更多设置」。
  const backfill0 = stream.harvest?.backfillLimit ?? DEFAULT_HARVEST.backfillLimit
  const incr0 = stream.harvest?.incrementalLimit ?? DEFAULT_HARVEST.incrementalLimit
  const harvestIsDefault = backfill0 === DEFAULT_HARVEST.backfillLimit && incr0 === DEFAULT_HARVEST.incrementalLimit
  const [backfillLimit, setBackfillLimit] = useState(String(backfill0))
  const [incrementalLimit, setIncrementalLimit] = useState(String(incr0))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reclassified, setReclassified] = useState<number | null>(null)

  const cadenceSeconds = Math.round(Number(cadenceValue) * UNIT_SECONDS[cadenceUnit])
  const backfillNum = Math.round(Number(backfillLimit))
  const incrementalNum = Math.round(Number(incrementalLimit))

  const goBack = () => {
    if (onBack) onBack()
    if (onOpenChange) onOpenChange(false)
  }

  // Persist schedule (strategy/cadence + harvest policy) + ad-filter. Returns false on validation failure.
  async function persist(): Promise<boolean> {
    if (!Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) {
      setErr('抓取时间必须大于 0')
      return false
    }
    if (!(backfillNum > 0) || !(incrementalNum > 0)) {
      setErr('抓取条数必须大于 0')
      return false
    }
    setErr(null)
    await api.updateStream(conn, stream.id, {
      strategy,
      cadence_seconds: cadenceSeconds,
      options: { harvest: { backfillLimit: backfillNum, incrementalLimit: incrementalNum } },
    })
    await api.setStreamAdFilter(conn, channelId, stream.id, {
      keywords: parseLines(keywords),
      domains: parseLines(domains),
    })
    await api.setStreamTitleFilter(conn, channelId, stream.id, parseLines(includeKw))
    return true
  }

  async function onSave() {
    setBusy(true)
    try {
      if (!(await persist())) return
      onSaved?.()
      goBack()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Save current rules, then re-classify already-stored items against them.
  async function onApplyToHistory() {
    setBusy(true)
    try {
      if (!(await persist())) return
      const { changed } = await api.reclassifyStreamAdFilter(conn, channelId, stream.id)
      setReclassified(changed)
      onSaved?.()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-[var(--acr-bg)]" data-slot="stream-setting-page">
      {/* 头部导航条 */}
      <ShellNavbar className="h-[49px] border-b border-[var(--acr-border-soft)] px-4 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="large" icon onClick={goBack} aria-label="返回">
            <ArrowLeftIcon />
          </Button>
          <Breadcrumb className="select-none">
            <BreadcrumbList className="text-[12.5px] gap-1 sm:gap-1.5">
              <BreadcrumbItem>
                <BreadcrumbLink onClick={goBack} className="cursor-pointer">
                  频道
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <span className="text-muted-foreground">{channelName || channelId}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
              <BreadcrumbItem>
                <BreadcrumbPage className="font-semibold text-foreground">
                  {stream.description || stream.id}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => void onSave()} disabled={busy} size="small">
            {busy ? '保存中…' : '保存并返回'}
          </Button>
        </div>
      </ShellNavbar>

      {/* 主体两栏布局 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左栏：Stream 配置表单 */}
        <ShellPanel className="w-80 flex-none border-r border-[var(--acr-border-soft)] overflow-y-auto p-6 space-y-4">
          <div className="text-[12.5px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">
            配置与过滤规则
          </div>

          <Field orientation="vertical">
            <FieldLabel>抓取方式</FieldLabel>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as 'fanout' | 'exclusive')}>
              <SelectTrigger size="medium" className="w-full" aria-label="抓取方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fanout">聚合（全部抓取后合并）</SelectItem>
                <SelectItem value="exclusive">互斥·优先级（首个健康来源生效）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field orientation="vertical">
            <FieldLabel>抓取间隔</FieldLabel>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                size="medium"
                className="w-16"
                value={cadenceValue}
                onChange={(e) => setCadenceValue(e.target.value)}
                aria-label="抓取间隔数值"
              />
              <Select value={cadenceUnit} onValueChange={(v) => setCadenceUnit(v as CadenceUnit)}>
                <SelectTrigger size="medium" className="w-20" aria-label="抓取间隔单位">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="s">秒</SelectItem>
                  <SelectItem value="m">分钟</SelectItem>
                  <SelectItem value="h">小时</SelectItem>
                  <SelectItem value="d">天</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Field>

          <Section title={`更多设置 · 抓取深度${harvestIsDefault ? '（默认）' : ''}`} defaultOpen={!harvestIsDefault}>
            <Field orientation="vertical">
              <FieldLabel htmlFor={`ss-bf-${stream.id}`}>回填深度</FieldLabel>
              <FieldDescription>首次订阅时拉取的条数</FieldDescription>
              <Input
                id={`ss-bf-${stream.id}`}
                type="number"
                min={1}
                size="medium"
                className="w-20"
                value={backfillLimit}
                onChange={(e) => setBackfillLimit(e.target.value)}
                aria-label="回填深度"
              />
            </Field>
            <Field orientation="vertical">
              <FieldLabel htmlFor={`ss-inc-${stream.id}`}>增量条数</FieldLabel>
              <FieldDescription>每次刷新拉取的条数</FieldDescription>
              <Input
                id={`ss-inc-${stream.id}`}
                type="number"
                min={1}
                size="medium"
                className="w-20"
                value={incrementalLimit}
                onChange={(e) => setIncrementalLimit(e.target.value)}
                aria-label="增量条数"
              />
            </Field>
          </Section>

          <Section title="过滤条件">
            <Field orientation="vertical">
              <FieldLabel htmlFor={`ss-include-${stream.id}`}>只看包含</FieldLabel>
              <FieldDescription>标题命中才保留 · 每行一个</FieldDescription>
              <InputGroup>
                <InputGroupTextarea
                  id={`ss-include-${stream.id}`}
                  aria-label="只看包含标题关键词（每行一个）"
                  placeholder="留空 = 不限"
                  autoResize
                  maxRows={5}
                  value={includeKw}
                  onChange={(e) => setIncludeKw(e.target.value)}
                />
              </InputGroup>
            </Field>

            <Field orientation="vertical">
              <FieldLabel htmlFor={`ss-kw-${stream.id}`}>屏蔽关键词</FieldLabel>
              <FieldDescription>命中即折叠 · 每行一个</FieldDescription>
              <InputGroup>
                <InputGroupTextarea
                  id={`ss-kw-${stream.id}`}
                  aria-label="过滤关键词（每行一个）"
                  autoResize
                  maxRows={6}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                />
              </InputGroup>
            </Field>

            <Field orientation="vertical">
              <FieldLabel htmlFor={`ss-dm-${stream.id}`}>屏蔽域名</FieldLabel>
              <FieldDescription>每行一个</FieldDescription>
              <InputGroup>
                <InputGroupTextarea
                  id={`ss-dm-${stream.id}`}
                  aria-label="过滤域名（每行一个）"
                  autoResize
                  maxRows={5}
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                />
              </InputGroup>
            </Field>

            <div className="space-y-1.5 pt-1">
              <p className="text-[11px] leading-snug text-muted-foreground">
                规则对之后抓取的内容自动生效；已入库的旧内容点下方按钮重算。
              </p>
              <Button variant="neutral" size="medium" disabled={busy} className="w-full" onClick={() => void onApplyToHistory()}>
                应用到历史内容
              </Button>
              {reclassified !== null && (
                <span className="block text-center text-[11px] text-muted-foreground">已更新 {reclassified} 条</span>
              )}
            </div>
          </Section>

          {err ? <div className="rounded bg-destructive/60 px-2 py-1 text-xs text-destructive-foreground">{err}</div> : null}
        </ShellPanel>

        {/* 右栏：网盘绑定对照表 */}
        <ShellContent className="flex-1 overflow-y-auto p-6">
          <div className="text-[12.5px] font-semibold text-muted-foreground tracking-wider uppercase mb-4">
            AList 网盘对照绑定
          </div>
          <NetdiskBindings streamId={stream.id} apiBase={conn.baseUrl} />
        </ShellContent>
      </div>
    </div>
  )
}
