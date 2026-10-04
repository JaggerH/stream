/**
 * 频道标题栏底下那条「内容 | 配置」分页。
 *
 * **为什么每个 Present 各画一条、而不是外壳统一画一条**：这条分页说的是「**这个频道**的内容 /
 * 这个频道的配置」，它归频道，不归工作台面板。摆在各自标题栏正下方，指向才明确——外壳统一画
 * 在最顶上时，它和下面那条频道标题栏之间隔着一层，读起来像是在切「面板」的两个页。
 *
 * 配置从抽屉（齿轮 → Sheet）改成分页的理由：抽屉盖在内容上、一次只能看一样，而「改完配置看
 * 效果」是这里最常见的一次来回。分页切回去内容还在原位。
 *
 * **数值逐条抄自 DSH 对话页那条「对话 | 轨迹」**（实测取自活体 `wSkVaW_tabs`/`wSkVaW_tab`）：
 * 字号 13px / 字重 500、项间距 36px、下内边距 11px，选中指示线 2px 高、贴底 1px、圆角 2px。
 *
 * **标题与分页之间没有线，整条 navbar 底下有一条**：DSH 的 `header::after` 是一条贴在
 * `bottom:1px` 的 1px 细线（`--dsw-alias-border-l2`），`z-index:0`；分页那层 `z-index:1`，
 * 于是选中指示线**压在细线上面**——两者在同一条基线上，指示线看起来是把细线的那一段染了色。
 * 少了这条细线，navbar 和下面的内容就没有边界；把线画在标题和分页之间则会把本是一块的
 * navbar 劈成两块。
 *
 * **分页文字与标题文字左对齐**：DSH 那边 header 左内边距 20 + 标题按钮自带 8 = 28，分页
 * 左内边距 8 → 也是 28（实测两者 left 同为 1207px）。本仓照同一套：header `px-4` + 标题按钮
 * `px-2`，分页 `pl-6`（16+8）。**改了标题按钮的内边距就要同步改这里**，否则两行文字错开，
 * 而这不会有任何一处报错。
 *
 * 抄的是数值不是类名：DSH 的类名带每次构建都会变的哈希前缀，引用它下一次升级就静默失效。
 *
 * 颜色用的是本仓自己的 token（`primary` / `muted-foreground`），不是 DSH 的 `--dsw-*`：这几个
 * 组件老版 UI 也在用，那里没有 DSH 的变量。
 */
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

export type ChannelTab = 'content' | 'config'

const TABS: Array<{ id: ChannelTab; label: string }> = [
  { id: 'content', label: '内容' },
  { id: 'config', label: '配置' },
]

export function ChannelTabs({ value, onChange, className }: {
  value: ChannelTab
  onChange: (tab: ChannelTab) => void
  className?: string
}): ReactNode {
  return (
    <div
      data-testid="channel-tabs"
      role="tablist"
      aria-label="频道视图"
      // `isolate`（= `isolation:isolate`）**不能删**：下面选中态那根指示线要压在细线上面，
      // 靠的是按钮上的 `z-10`。少了这一层，`z-10` 是相对**整棵面板树**算的，于是详情那种
      // `absolute inset-0`（z 自动）的覆盖层盖不住这条分页——详情开着，分页还浮在上面。
      // 加了它，`z-10` 只在这条分页内部有效。
      className={cn('relative isolate flex shrink-0 items-end gap-9 px-4 pl-6', className)}
    >
      {/* 整条 navbar 的下边线。画在这一层而不是给容器加 `border-b`：它得铺满整宽（跨过左右
          内边距），而且要待在选中指示线**下面**——两者同在 bottom:1px，指示线压上去才是
          DSH 那个「细线被染色的一段」的样子。 */}
      <span aria-hidden className="absolute inset-x-0 bottom-px z-0 h-px bg-border" />
      {TABS.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => { if (!active) onChange(t.id) }}
            className={cn(
              'relative z-10 pb-[11px] text-[13px] font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {/* 指示线贴底 1px（DSH 同一个数），正好盖住上面那条细线的这一段。 */}
            {active ? <span aria-hidden className="absolute inset-x-0 bottom-px h-0.5 rounded-sm bg-primary" /> : null}
          </button>
        )
      })}
    </div>
  )
}
