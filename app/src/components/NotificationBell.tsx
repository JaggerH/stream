import { useState } from 'react'
import { Bell, Copy } from 'lucide-react'
import { Button } from './acrylic/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './acrylic/popover.tsx'
// 裸 import 'sonner' 是禁的：status 图标会掉进 32px img 档 fallback（acrylic-ui skill 规范）。
import { toast } from './acrylic/sonner.tsx'
import { useEvents, type UiEvent } from './EventsProvider.tsx'
import { notificationCopyText } from './notification-copy.ts'
import { cn } from '../lib/utils.ts'

/**
 * type→action 映射：事件层不知道动作，动作是消费端（这里）的注册表。
 *
 * `auth.needed` 与 `transcribe.*` 这两条走 `dispatchLocal`——它是面板那个 root 里 `AuthPanel` 等
 * 订阅的本地信号通道，**这棵铃自己不保证有人在听**。铃第一次挂进导航树（`NavTree` 的独立 root）
 * 之后，那个 root 里没有任何订阅者，两条继续当可点行渲染就是点了没反应。`legacyActions=false`
 * 时回 `null`：行渲染 disabled，跟「宿主没给开法就不可点」（intervention 那条）同一口径。
 */
function rowAction(
  e: UiEvent,
  dispatchLocal: (m: unknown) => void,
  onOpenSourceRepair: ((sourceId: string) => void) | undefined,
  legacyActions: boolean,
): (() => void) | null {
  // 修复那条线：ref 是源 id，落点是这个源的修复页（spec 2026-09-12 §4 入口 1）。宿主没给开法就不当可点行。
  if (e.type.startsWith('intervention.') && e.ref?.kind === 'stream' && onOpenSourceRepair) {
    return () => onOpenSourceRepair(e.ref!.id)
  }
  if (!legacyActions) return null
  if (e.type === 'auth.needed' && e.ref?.kind === 'facility') {
    return () => dispatchLocal({ type: 'open-auth-panel', facility: e.ref!.id })
  }
  if ((e.type === 'transcribe.done' || e.type === 'transcribe.error') && e.ref?.kind === 'item') {
    return () => dispatchLocal({ type: 'open-artifact', itemId: e.ref!.id })
  }
  return null
}

/**
 * 复制这条通知。**失败绝不静默**：`navigator.clipboard` 在非安全上下文（既不是 https 也不是
 * localhost）下整个是 `undefined`，写入也可能被权限挡下——两种都得说出来，不然用户以为复制成功了，
 * 粘出来却是上一次的内容，而他正拿着它去问 AI。
 */
function copyEvent(e: UiEvent): void {
  const fail = (description: string) => toast.error('复制失败', { description })
  const write = navigator.clipboard?.writeText(notificationCopyText(e))
  if (!write) {
    fail('浏览器不允许在当前上下文写剪贴板（需要 https 或 localhost）')
    return
  }
  write.then(
    () => toast.success('已复制这条通知'),
    (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
  )
}

const dotCls = (s: UiEvent['severity']) =>
  s === 'error' ? 'bg-destructive' : s === 'warn' ? 'bg-yellow-500' : 'bg-emerald-500'

export function NotificationBell({ onOpenSourceRepair, legacyActions = true }: {
  onOpenSourceRepair?: (sourceId: string) => void
  /** `auth.needed` / `transcribe.*` 两条 `dispatchLocal` 动作要不要当可点行画。默认 true（面板
   *  主 root 的旧行为）；`NavTree` 挂在自己的独立 root 里，没人订阅 `dispatchLocal`，传 false。 */
  legacyActions?: boolean
} = {}) {
  const { events, unread, markAllRead, dispatchLocal } = useEvents()
  const [open, setOpen] = useState(false)
  const onOpenChange = (v: boolean) => {
    setOpen(v)
    if (v && unread > 0) markAllRead() // 打开面板即全读（v1 不做逐条）
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {/* 与侧栏 footer 的对话/设置按钮同款（acrylic Button ghost/large/icon），角标叠在其上 */}
        <Button
          type="button"
          variant="ghost"
          size="large"
          icon
          aria-label="通知"
          className="relative text-muted-foreground hover:text-foreground"
        >
          <Bell />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b border-[var(--acr-border-soft)] px-3 py-2 text-sm font-medium">通知</div>
        <div className="max-h-96 overflow-y-auto">
          {events.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">暂无通知</div>
          )}
          {events.map((e) => {
            const act = rowAction(e, dispatchLocal, onOpenSourceRepair, legacyActions)
            return (
              // 复制键是整行 button 的**兄弟**而不是子节点：button 套 button 是非法 HTML。
              // 它悬浮在时间那一格上（hover 才出现，不常驻挤占这条只有 320px 的面板）。
              <div key={e.id} className="group relative">
                <button
                  disabled={!act}
                  onClick={() => { act?.(); setOpen(false) }}
                  className={cn('block w-full px-3 py-2 text-left hover:bg-secondary/40', !act && 'cursor-default')}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('size-1.5 shrink-0 rounded-full', dotCls(e.severity))} />
                    <span className="truncate text-[13px] text-foreground/90">{e.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground group-hover:invisible">
                      {new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {e.body && <div className="mt-0.5 truncate pl-3.5 text-xs text-muted-foreground">{e.body}</div>}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="mini"
                  icon
                  aria-label="复制这条通知"
                  // 兄弟节点本来就不会冒泡到那个 button，但这一行是**契约**：日后谁把它挪成
                  // 子节点，点复制就会顺带触发跳转 + 关掉面板，而复制本身还成功了 —— 不会有人报错。
                  onClick={(ev) => { ev.stopPropagation(); copyEvent(e) }}
                  className="absolute right-2 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Copy />
                </Button>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
