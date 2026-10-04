/**
 * 频道配置面的右侧抽屉外壳。
 *
 * **正文一行都不在这里**——它就是 `ChannelConfigPanel`（各 Present 顶栏下的「配置」分页用的
 * 同一份）。这层只负责「以抽屉形态唤起」：老版 UI 里从别处点开的那条路还走它。
 *
 * 频道被删掉时要自己关上：删完之后这张面板指着一个不存在的频道，留在屏幕上只会显示
 * 「这个频道已不存在」。
 */
import type { ReactElement } from 'react'
import type { Connection } from '../../lib/api.ts'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../acrylic/sheet.tsx'
import { ChannelConfigPanel } from './ChannelConfigPanel.tsx'

export { PRESENT_EXTRAS } from './ChannelConfigPanel.tsx'

export function ChannelManageSheet({ open, onOpenChange, conn, channelId, onChanged }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conn: Connection
  channelId: string
  onChanged?: () => void
}): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[26rem] flex-col gap-0 overflow-y-auto p-0 scrollbar-mac sm:max-w-[26rem]">
        <SheetHeader className="sr-only">
          <SheetTitle>频道配置</SheetTitle>
          <SheetDescription>频道管理</SheetDescription>
        </SheetHeader>
        {open ? (
          <ChannelConfigPanel
            conn={conn}
            channelId={channelId}
            onChanged={onChanged}
            onDeleted={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
