import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import type { Connection } from '../../lib/api.ts'
import type { PickSurface, PluginSourcesSearchResponse, SourceSummary } from '../../lib/types.ts'
import { Dialog, DialogContent, DialogTitle } from '../acrylic/dialog.tsx'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../acrylic/command.tsx'
import { SourceIcon } from '../SourceIcon.tsx'

/**
 * ⌘K 跨插件源搜索。
 *
 * 为什么单独有它：插件页最多能挂几百上千个源，「浏览」和「找一个已知的源」是两件事，早先被压成
 * 了 navbar 里一个「本插件 / 全部插件」的模式开关——用户得先想清楚自己在哪个模式里。macOS 对
 * 「东西太多」的标准答案是一个随手唤起的搜索面板：页内搜索框只管当前插件，跨插件搜索归 ⌘K。
 *
 * 结果由后端过滤（api.searchAllPluginSources），所以 cmdk 的本地过滤必须关掉（shouldFilter=false），
 * 否则会在服务端结果上再筛一遍、把匹配了拼音/别名的条目吃掉。
 */
export function SourceCommandPalette({
  open,
  onOpenChange,
  conn,
  onPick,
  surface,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conn: Connection
  onPick: (s: SourceSummary) => void
  /** 见 `PickSurface`——跟唤起它的那个选择器同一个面。 */
  surface?: PickSurface
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<PluginSourcesSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    const mine = ++seq.current
    setLoading(true)
    // 输入防抖 160ms：够短，感觉不到延迟；够长，打字时不会每个字符打一次后端。
    const timer = setTimeout(() => {
      api.searchAllPluginSources(conn, { query, limit: query.trim() ? 100 : 60, surface })
        .then((r) => { if (seq.current === mine) setResult(r) })
        .catch(() => { if (seq.current === mine) setResult(null) })
        .finally(() => { if (seq.current === mine) setLoading(false) })
    }, 160)
    return () => clearTimeout(timer)
  }, [open, query, conn.baseUrl, surface])

  // 每次打开都从空查询起步——上一次搜过什么不该影响这一次。
  useEffect(() => { if (open) setQuery('') }, [open])

  const sources = result?.sources ?? []
  const plugins = result?.plugins ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">搜索全部插件源</DialogTitle>
        <Command shouldFilter={false} className="max-h-[60vh]">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="搜索全部插件的源…"
            autoFocus
          />
          <CommandList className="max-h-[52vh] p-1.5">
            {!loading && sources.length === 0 ? <CommandEmpty>没有匹配的源</CommandEmpty> : null}
            {plugins.map((pg) => {
              const rows = sources.filter((s) => s.pluginId === pg.id)
              if (!rows.length) return null
              return (
                <CommandGroup key={pg.id} heading={`${pg.name} · ${pg.count}`}>
                  {rows.map((s) => (
                    <CommandItem
                      key={`${s.pluginId}:${s.id}`}
                      value={`${s.pluginId}:${s.id}`}
                      onSelect={() => { onOpenChange(false); onPick(s) }}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-[var(--acr-card-nested)]">
                        <SourceIcon id={s.id} name={s.title} facilityKey={s.facility?.key} site={s.site} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      {s.description && s.description !== s.title ? (
                        <span className="hidden max-w-[45%] shrink truncate text-[11px] text-muted-foreground sm:block">
                          {s.description}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
