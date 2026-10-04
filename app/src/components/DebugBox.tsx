import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bug, Check, ChevronDown, ChevronRight, Copy, Minus, Trash2, X } from 'lucide-react'
import { useWs } from '../hooks/useWs.ts'
import { setDebugEnabled } from '../lib/debugFlag.ts'
import type { DebugEntry } from '../lib/types.ts'
import { Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemRow, ItemTitle } from './acrylic/item.tsx'
import { Badge } from './acrylic/badge.tsx'
import { Button } from './acrylic/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './acrylic/select.tsx'
import { DebugTable, type DebugColumn } from './debug/DebugTable.tsx'
import { useDraggableBox } from './debug/useDraggableBox.ts'

const TONE: Record<string, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-rose-400',
  muted: 'text-foreground/40',
}

function isUrl(str: string): boolean {
  try {
    return /^(https?|file):\/\//i.test(str.trim())
  } catch {
    return false
  }
}

const CHANNEL_LABEL: Record<string, string> = {
  'audio-resolve': '播放解析',
  download: '下载',
  'video-resolve': '视频解析',
  plugins: '插件探测',
  'plugin-target': '插件取址',
  discover: '平台推荐',
  drive: '页面驱动',
}

function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel
}

/** 「全部频道」在 Select 里的占位值。内部状态仍用空串表示不筛选，只是不能直接喂给 Radix。 */
const ALL = '__all__'

/** one entry, flattened for the clipboard */
function entryText(e: DebugEntry): string {
  const head = `[${channelLabel(e.channel)}] ${e.title}\n${e.ok ? '' : '✗ '}${e.summary}`
  return `${head}\n${e.fields.map((f) => `  ${f.label}: ${f.value}`).join('\n')}`
}

interface StackFrame {
  fn: string
  loc: string
}

function parseStackTrace(stack: string): StackFrame[] {
  const lines = stack.split('\n')
  const frames: StackFrame[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('at ')) {
      continue
    }
    const match = trimmed.match(/^at\s+(.+?)\s*\((.+?)\)$/) || trimmed.match(/^at\s+(.+)$/)
    if (match) {
      if (match[2]) {
        frames.push({ fn: match[1], loc: match[2] })
      } else {
        frames.push({ fn: '', loc: match[1] })
      }
    }
  }
  return frames
}

const STACK_COLUMNS: DebugColumn<StackFrame>[] = [
  { header: '方法 / 函数', width: '45%', className: 'font-medium text-foreground', cell: (f) => <span title={f.fn}>{f.fn || '<anonymous>'}</span> },
  { header: '位置', width: '55%', className: 'text-muted-foreground', cell: (f) => <span title={f.loc}>{f.loc}</span> },
]

function StackTraceTable({ stack }: { stack: string }) {
  const frames = parseStackTrace(stack)
  if (frames.length === 0) {
    return <span className="whitespace-pre-wrap break-all">{stack}</span>
  }
  return <DebugTable columns={STACK_COLUMNS} rows={frames} scroll />
}

type DebugField = { label: string; value: string; tone?: string }

function parsePluginStatus(value: string) {
  const parts = value.split(/\s+/)
  return { health: parts[0] || 'unknown', ms: parts[1] || '', url: parts[2] || '' }
}

const PLUGIN_COLUMNS: DebugColumn<DebugField>[] = [
  { header: '插件', width: '25%', className: 'font-medium text-foreground', cell: (f) => <span title={f.label}>{f.label}</span> },
  {
    header: '状态',
    width: '15%',
    align: 'center',
    cell: (f) => {
      const { health } = parsePluginStatus(f.value)
      const isOk = health === 'ok'
      return (
        <span className={`inline-block rounded px-1 text-[9px] font-semibold leading-[1.3] ${isOk ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
          {health.toUpperCase()}
        </span>
      )
    },
  },
  { header: '耗时', width: '15%', align: 'right', className: 'font-mono text-foreground', cell: (f) => parsePluginStatus(f.value).ms },
  {
    header: '服务地址',
    width: '45%',
    className: 'font-mono text-muted-foreground',
    cell: (f) => {
      const { url } = parsePluginStatus(f.value)
      if (!url) return '-'
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="min-w-0 text-primary hover:underline">
          {url}
        </a>
      )
    },
  },
]

function parseRecipeTiming(value: string) {
  return { duration: value.split(' · ')[0] || '' }
}

const RECIPE_COLUMNS: DebugColumn<DebugField>[] = [
  { header: '运行阶段', width: '65%', className: 'font-medium text-foreground', cell: (f) => <span title={f.label}>{f.label}</span> },
  {
    header: '步骤耗时',
    width: '35%',
    align: 'right',
    cell: (f) => {
      const { duration } = parseRecipeTiming(f.value)
      const ms = parseInt(duration) || 0
      // 慢 / 中 / 快三档着色：一眼看出哪一阶段是瓶颈，不用逐行读数字。
      let tone = 'text-foreground opacity-75'
      if (ms >= 3000) tone = 'text-rose-400 font-semibold'
      else if (ms >= 1000) tone = 'text-amber-400'
      else if (f.tone === 'muted') tone = 'text-muted-foreground'
      return <span className={`font-mono ${tone}`}>{duration}</span>
    },
  },
]

/** Generic, floating, draggable debug console. Shows a reverse-chronological LOG of DebugEntry
 *  across every flow (audio/download/video), fed live over the WS ({type:'debug'}) with a
 *  one-shot /api/debug/log reconciliation on mount. Domain-agnostic: each entry renders as a
 *  summary line (color by health) that expands to its labelled fields. Gated by the global debug
 *  flag — mounted only when debug is on; its ✕ turns the flag off.
 *
 *  2026-07-22 的三处 UI 收敛：
 *   - 拖拽从「1:1 跟随、松手即停」补成完整手感（投掷 + 贴边 + 越界回弹 + 可打断），见 useDraggableBox。
 *   - 三张手抄的小表格合并成 DebugTable + 列规格。
 *   - 80 条混流不再只能靠眼睛找：加了频道筛选和「只看失败」，以及一个折叠成 pill 的收起态。 */
export function DebugBox({ baseUrl, wsUrl }: { baseUrl: string; wsUrl: string }) {
  const [entries, setEntries] = useState<DebugEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [channel, setChannel] = useState<string>('')      // '' = 全部
  const [failedOnly, setFailedOnly] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const { pos, dragHandlers } = useDraggableBox({ storageKey: 'stream.debugPos' })

  const push = useCallback((e: DebugEntry) => {
    setEntries((prev) => (prev[0]?.id === e.id ? prev : [e, ...prev].slice(0, 80)))
  }, [])

  // reconcile once (box opened mid-flow), then live updates arrive over the WS
  useEffect(() => {
    let stale = false
    fetch(`${baseUrl}/api/debug/log?limit=50`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: DebugEntry[] }>) : null))
      .then((d) => {
        // 真值判断在 d 是数组时会把 Array.prototype.entries（函数）当成"有值"，
        // 交给 setEntries 当 updater 执行——必须显式判数组形状，不能只判存在。
        if (!stale && Array.isArray(d?.entries)) setEntries(d.entries)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [baseUrl])

  useWs(
    wsUrl,
    useCallback((m) => {
      if (m.type === 'debug') push(m.entry)
    }, [push])
  )

  // 出现过的频道（按出现顺序），用来生成筛选下拉——写死一张表会漏掉后端新加的频道。
  const channels = useMemo(() => {
    const seen: string[] = []
    for (const e of entries) if (!seen.includes(e.channel)) seen.push(e.channel)
    return seen
  }, [entries])

  const shown = useMemo(
    () => entries.filter((e) => (!channel || e.channel === channel) && (!failedOnly || !e.ok)),
    [entries, channel, failedOnly]
  )
  const failedCount = useMemo(() => entries.filter((e) => !e.ok).length, [entries])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const onClear = async () => {
    setEntries([])
    setExpanded(new Set())
    // also wipe the backend ring, else the next reconciliation fetch brings them back
    try {
      await fetch(`${baseUrl}/api/debug/log`, { method: 'DELETE' })
    } catch {
      /* ignore */
    }
  }

  const onCopy = async (e: DebugEntry) => {
    try {
      await navigator.clipboard.writeText(entryText(e))
      setCopiedId(e.id)
      setTimeout(() => setCopiedId((id) => (id === e.id ? null : id)), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  const style = pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 96 }

  return (
    <div
      style={style}
      data-collapsed={collapsed || undefined}
      className={[
        'acr-frosted fixed z-50 flex flex-col overflow-hidden bg-[var(--acr-surface)] text-[11px] leading-relaxed text-card-foreground backdrop-blur-xl',
        // 大面 = 更厚的材质 + 更深的影；收起后是一枚 pill，影也跟着变轻。
        collapsed
          ? 'w-auto rounded-full shadow-[0_4px_14px_rgba(0,0,0,0.22)]'
          : 'max-h-[50vh] min-h-[33.3vh] w-[360px] min-w-[360px] max-w-[720px] resize rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.28)]',
      ].join(' ')}
    >
      {/* 标题栏兼拖拽把手。双击 = 收起/展开（macOS 窗口标题栏的既有习惯）。 */}
      <div
        {...dragHandlers}
        onDoubleClick={() => setCollapsed((v) => !v)}
        className={`flex cursor-move items-center gap-1.5 ${collapsed ? 'px-3 py-1.5' : 'border-b border-[var(--acr-border)] bg-[var(--acr-card-nested)] px-2.5 py-1.5'}`}
      >
        <Bug className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0 font-semibold">debug</span>
        <span className="text-foreground/40">{shown.length === entries.length ? entries.length : `${shown.length}/${entries.length}`}</span>
        {failedCount ? (
          <Badge variant="secondary" size="sm" className="shrink-0 text-rose-400">{failedCount}</Badge>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5" onPointerDown={(e) => e.stopPropagation()}>
          {!collapsed ? (
            <Button icon size="mini" variant="ghost" onClick={onClear} aria-label="清空历史" title="清空历史">
              <Trash2 />
            </Button>
          ) : null}
          <Button
            icon
            size="mini"
            variant="ghost"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? '展开调试面板' : '收起调试面板'}
            title={collapsed ? '展开' : '收起'}
          >
            {collapsed ? <ChevronDown /> : <Minus />}
          </Button>
          <Button
            icon
            size="mini"
            variant="ghost"
            onClick={() => setDebugEnabled(false)}
            aria-label="关闭调试"
            title="关闭调试（可在设置里重新开启）"
          >
            <X />
          </Button>
        </div>
      </div>

      {collapsed ? null : (
        <>
          {/* 筛选条：80 条混流时，「哪个环节」和「有没有炸」是唯二真正会问的问题。 */}
          <div className="flex items-center gap-1.5 border-b border-[var(--acr-border-soft)] px-2 py-1">
            {/* ALL 是空串——Radix Select 不接受空 value（空串是它内部的「清空」哨兵）。 */}
            <Select value={channel || ALL} onValueChange={(v) => setChannel(v === ALL ? '' : v)}>
              <SelectTrigger size="small" className="min-w-0 flex-1" aria-label="按频道筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部频道</SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c} value={c}>{channelLabel(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="small"
              variant={failedOnly ? 'secondary' : 'ghost'}
              onClick={() => setFailedOnly((v) => !v)}
              aria-pressed={failedOnly}
              className={failedOnly ? 'shrink-0 text-rose-400' : 'shrink-0 text-muted-foreground'}
            >
              只看失败
            </Button>
          </div>

          <div className="scrollbar-mac flex-1 overflow-y-auto p-1.5">
            {shown.length === 0 ? (
              <div className="px-2.5 py-3 text-foreground/30">
                {entries.length === 0 ? '还没有 debug 事件。播放 / 下载一首歌看看。' : '当前筛选下没有事件。'}
              </div>
            ) : (
              <ItemGroup className="gap-1">
                {shown.map((e) => {
                  const open = expanded.has(e.id)
                  return (
                    <Item
                      key={e.id}
                      size="sm"
                      variant="muted"
                      onClick={() => toggle(e.id)}
                      className="cursor-pointer items-start text-[11px] transition-colors hover:bg-[var(--acr-surface-hover)]"
                    >
                      <ItemContent className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <ItemRow className="items-center gap-1.5">
                          <ItemTitle title={e.title} className="min-w-0">
                            {e.title}
                          </ItemTitle>
                          <Badge variant="secondary" size="sm" className="shrink-0 font-normal text-foreground/60">
                            {channelLabel(e.channel)}
                          </Badge>
                        </ItemRow>
                        <ItemDescription className={`font-mono ${e.ok ? 'text-foreground opacity-85' : 'text-rose-400'}`}>
                          {e.summary}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation() // the row itself toggles; the icon only copies
                            void onCopy(e)
                          }}
                          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100"
                          title="复制这条"
                        >
                          {copiedId === e.id ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                        </button>
                        <div className="shrink-0 rounded p-0.5 text-muted-foreground">
                          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </div>
                      </ItemActions>
                      {open ? (
                        <ItemFooter className="w-full min-w-0 flex-col items-stretch gap-0.5 pl-1 font-mono text-[11px]">
                          {e.channel === 'plugins' ? (
                            <DebugTable columns={PLUGIN_COLUMNS} rows={e.fields} />
                          ) : e.channel === 'recipe' || e.channel === 'harvest' ? (
                            // 两个频道同一形状:每行 label=阶段名 / value=`<ms>ms[ · RSS <n>MB]`。
                            // recipe=拟人采集(RunProbe 带 RSS),harvest=普通采集(同一 RunProbe,无 RSS)。
                            <DebugTable columns={RECIPE_COLUMNS} rows={e.fields} />
                          ) : (
                            e.fields.map((f, i) => {
                              const isStack = f.label.includes('调用栈') || f.label.toLowerCase().includes('stack')
                              if (isStack) {
                                return (
                                  <div key={i} className="mt-1 flex w-full min-w-0 flex-col gap-1 border-t border-[var(--acr-border)]/45 pt-1.5 first:border-0 first:pt-0">
                                    <span className="font-semibold text-foreground/40">{f.label}</span>
                                    <StackTraceTable stack={f.value} />
                                  </div>
                                )
                              }
                              return (
                                <div key={i} className="flex w-full min-w-0 gap-1.5">
                                  <span className="shrink-0 text-foreground/40">{f.label}</span>
                                  {isUrl(f.value) ? (
                                    <a
                                      href={f.value}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="min-w-0 flex-1 truncate text-primary hover:underline"
                                      title={f.value}
                                    >
                                      {f.value}
                                    </a>
                                  ) : (
                                    <span className={`min-w-0 flex-1 break-all ${f.tone ? TONE[f.tone] : 'text-foreground/75'}`}>{f.value}</span>
                                  )}
                                </div>
                              )
                            })
                          )}
                        </ItemFooter>
                      ) : null}
                    </Item>
                  )
                })}
              </ItemGroup>
            )}
          </div>
        </>
      )}
    </div>
  )
}
