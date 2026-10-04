import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './acrylic/dropdown-menu.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from './acrylic/dialog.tsx'
import { BundleShareDialog } from './BundleShareDialog.tsx'
import type { Connection } from '../lib/api.ts'
import { cn } from '../lib/utils.ts'

/**
 * 频道标题本身就是触发器——点标题弹一个下拉：「重新抓取」，以及（给了 `exportChannel` 时）
 * 「导出为分享包」。
 *
 * **导出的对话框由本组件自己持有**，而不是让四个宿主（时间线 / 音乐 / 影视 / 研究）各接一遍：
 * 那四处只是同一条菜单的四个渲染点，让它们各自养一份 open 状态和一个 Dialog，就是四份会各自
 * 漂移的实现。宿主只需要回答「导出哪一个频道」。
 *
 * 面板**只在打开时挂**：它一挂载就去拉可搭车的 Provider 和网盘绑定，常驻等于每开一个频道就
 * 白打两个请求。
 *
 * 不做逐源子菜单：后端 `refreshChannel` 本来就会扇出到频道下挂的每一个源，而有的频道
 * 订阅数上百，把它们列成菜单项没法看。要刷新的目标是「频道」还是「某一条订阅」，
 * 由调用方传进来的 `onRefresh` 自己决定（通常就是已有的 `onReload`/`triggerHarvest`，
 * 它会看当前选中的是频道还是单条订阅）——这个组件不关心，只管展示。
 *
 * 刻意不画 chevron 提示图标：标题本身就是触发器，加图标会破坏标题形态（影视/音乐频道
 * 里按钮拉满整行时图标被顶到最右，与 Timeline 里贴标题的观感不一致），所以标题就是
 * 一个干净的文字触发器。
 *
 * **字形照 DSH 对话页那个会话标题**（活体 `.wSkVaW_crumb.wSkVaW_crumbCurrent`）：14px/20px、
 * 字重 500、主文字色，内边距 4px 8px、圆角 12px，hover 才给一块底色。它同样是"看着像标题"
 * 的一块文字——长得一样这件事本身就是提示；更大更粗的字在说"这是标题栏"，而它其实是个控件。
 *
 * 与 DSH 的一处**有意偏差**：那边当前这一层面包屑是 `disabled` 的（不可点，`cursor:default`），
 * 我们这个点开有菜单，所以 hover 底色和手型都留着——控件得让人看得出能点。
 *
 * 那 8px 左内边距不是装饰：底下那条分页也缩进 8px，两行**文字**因此左对齐（见 ChannelTabs
 * 头注；DSH 那边对齐的是"标题的框"和"分页的字"，我们对齐的是两行字）。
 */
export function ChannelTitleMenu({
  title,
  onRefresh,
  refreshLabel,
  exportChannel,
  className,
}: {
  title: React.ReactNode
  onRefresh: () => void
  /** 菜单项的文案。默认「重新抓取」——那是采集档（`data: 'collected'`）的动作。live 档
   *  （现读不入库）没有"抓取"这回事，传「重新读取」，别让菜单说一件不会发生的事。 */
  refreshLabel?: string
  /** 要导出的那个频道。**不给就不画这一项**——比如影视那档同时挂着多个频道时，"导出哪一个"
   *  没有答案，画一个点了不知道会导出谁的菜单项比没有更坏。 */
  exportChannel?: { conn: Connection; id: string }
  className?: string
}) {
  const { t } = useTranslation()
  const [shareOpen, setShareOpen] = useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 items-center rounded-xl px-2 py-1 text-left text-[14px]/[20px] font-medium text-foreground outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-ring/50',
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onRefresh}>{refreshLabel ?? t('timeline.reharvest')}</DropdownMenuItem>
        {exportChannel ? (
          <DropdownMenuItem onSelect={() => setShareOpen(true)}>导出为分享包</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
      {exportChannel ? (
        <Dialog open={shareOpen} onOpenChange={setShareOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>导出为分享包</DialogTitle>
              <DialogDescription>单个 JSON，凭证永不进包；可发到 gist / 任意 git 让别人导入。</DialogDescription>
            </DialogHeader>
            {shareOpen ? (
              <BundleShareDialog conn={exportChannel.conn} mode="export" root={{ kind: 'channel', id: exportChannel.id }} />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </DropdownMenu>
  )
}
