// 设置面板的共用原语 —— macOS「分组内嵌列表」(grouped inset list) 的那套排版。
//
// 为什么要有这一层：BackendSettings / SourceConfigSheet / PluginConfigSheet 三处配置
// 各自手搓过一套分节和字阶（有的 `border` 描边框，有的 `border-t` 分节，有的裸 div），
// 结果同一个产品里「配置」长了三张脸。这里把 Apple 的做法固化成三件事：
//
//  1. 段头在卡片**外**（次级色、小号、加 tracking），卡片本身是 flat 的嵌套面（无描边、
//     无阴影）—— 深度来自嵌套层级而不是装饰线（acrylic 的材质规则）。
//  2. 组内每一行是「左标签 / 右控件」，行与行之间只有一条 hairline，不是各自成框。
//  3. 字阶只有三档，见下面 TYPE SCALE。三处配置面板一律引这里，别再就地写 text-[12px]。
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

// TYPE SCALE — 配置面板只许用这三档：
//  段头   11px / semibold / uppercase-ish tracking / tertiary 色
//  主文   13px / regular  / foreground
//  次文   11px / regular  / muted（说明、状态、脚注）
const SECTION_TITLE = 'text-[11px] font-semibold tracking-[0.06em] text-muted-foreground'
const ROW_LABEL = 'text-[13px] leading-snug text-foreground'
const ROW_NOTE = 'text-[11px] leading-snug text-muted-foreground'

/** 面板正文：若干 section 的纵向堆叠。 */
export function SettingsGroup({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col gap-5', className)}>{children}</div>
}

/**
 * 一组设置。`title` 渲染在卡片外上方；`footnote` 渲染在卡片外下方（iOS 设置里那条解释文字）。
 * `collapsible` 时段头变成可点的 disclosure 行——展开态由父级持有，好让多个 section 表现成
 * 手风琴（同时只开一个）。
 */
export function SettingsSection({
  title,
  footnote,
  collapsible = false,
  open,
  onOpenChange,
  actions,
  children,
}: {
  title?: string
  footnote?: ReactNode
  collapsible?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 段头右侧的附属控件（例如一个刷新按钮）。 */
  actions?: ReactNode
  children: ReactNode
}) {
  const expanded = !collapsible || !!open
  return (
    <section className="min-w-0">
      {title ? (
        collapsible ? (
          <button
            type="button"
            onClick={() => onOpenChange?.(!open)}
            aria-expanded={expanded}
            className="group flex w-full items-center gap-1 px-3 pb-1.5 text-left"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3 shrink-0 text-muted-foreground',
                // 展开/收起走 spring token，不自己挑 cubic-bezier
                'transition-transform duration-[var(--acr-spring-default-duration)] ease-[var(--acr-spring-default)]',
                expanded && 'rotate-90'
              )}
            />
            <span className={SECTION_TITLE}>{title}</span>
            {actions ? <span className="ml-auto">{actions}</span> : null}
          </button>
        ) : (
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <span className={SECTION_TITLE}>{title}</span>
            {actions ? <span className="ml-auto">{actions}</span> : null}
          </div>
        )
      ) : null}
      {expanded ? (
        <div className="overflow-hidden rounded-[10px] bg-[var(--acr-card-nested)] [&>*+*]:border-t [&>*+*]:border-[var(--acr-border-soft)]">
          {children}
        </div>
      ) : null}
      {expanded && footnote ? <p className={cn('mt-1.5 px-3', ROW_NOTE)}>{footnote}</p> : null}
    </section>
  )
}

/**
 * 一行设置。默认「左标签 / 右控件」；控件本身需要整行宽度（输入框、按钮组、说明块）时用
 * `layout="stacked"`，标签退到上方。
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  control,
  layout = 'inline',
  className,
  children,
}: {
  label?: ReactNode
  description?: ReactNode
  htmlFor?: string
  /** inline 布局下右侧的控件。 */
  control?: ReactNode
  layout?: 'inline' | 'stacked'
  className?: string
  /** stacked 布局下标签之下的整块内容。 */
  children?: ReactNode
}) {
  if (layout === 'stacked') {
    return (
      <div className={cn('flex flex-col gap-1.5 px-3 py-2.5', className)}>
        {label ? (
          <label htmlFor={htmlFor} className={ROW_LABEL}>
            {label}
          </label>
        ) : null}
        {children}
        {description ? <p className={ROW_NOTE}>{description}</p> : null}
      </div>
    )
  }
  return (
    <div className={cn('flex items-center justify-between gap-3 px-3 py-2.5', className)}>
      <div className="min-w-0">
        {label ? (
          <label htmlFor={htmlFor} className={cn('block', ROW_LABEL)}>
            {label}
          </label>
        ) : null}
        {description ? <p className={cn('mt-0.5', ROW_NOTE)}>{description}</p> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  )
}

/** 只读的说明/状态块，占满一行（AList 实例状态、插件来源说明这类）。 */
export function SettingsNote({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-3 py-2.5', ROW_NOTE, className)}>{children}</div>
}

/** 一整块自定义内容嵌进 section（网盘挂载/绑定这类自带排版的面板）。 */
export function SettingsBlock({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-3 py-3', className)}>{children}</div>
}

/** 便捷：受控的手风琴（同时只开一个 section）。返回 section 用的 open/onOpenChange 对。 */
export function useAccordion(initial = '') {
  const [openKey, setOpenKey] = useState(initial)
  return (key: string) => ({
    open: openKey === key,
    onOpenChange: (next: boolean) => setOpenKey(next ? key : ''),
  })
}

/** 稳定的 htmlFor id（配合 SettingsRow 的 label）。 */
export function useRowId(prefix: string) {
  const id = useId()
  return `${prefix}-${id}`
}

export const settingsType = { sectionTitle: SECTION_TITLE, rowLabel: ROW_LABEL, rowNote: ROW_NOTE }
