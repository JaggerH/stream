import type { ReactNode } from 'react'
import { AtSignIcon } from 'lucide-react'

import { referenceSubscription } from '../../lib/askExtract.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu.tsx'

/**
 * 一条**订阅**（歌单 / 播客 / 频道里的一条流）的右键菜单。今天只有一项：在对话中引用。
 *
 * 和 `ItemContextMenu` 是同一条设计线（spec 2026-08-25-reconcile-as-conversation §5）：
 * 引用的入口是**指着说**，不是在对话输入框的 `@` 菜单里翻找。订阅本身是可枚举的，所以它
 * 在 `@` 菜单里**也**有一组；内容不是，内容只有右键这一个入口。
 *
 * 引用**塞进输入框、不发送**——引完用户还要接着说下一句（"这个 @春典JARGON 跟 @/quark/… 对一下"）。
 *
 * 往这里加第二项之前先问一句：它是不是"对这条订阅本身"的动作。改名/删除那些今天住在各频道
 * 自己的菜单里（它们要弹自己的确认框），别顺手搬过来——那会让同一个右键在两个地方各有一份。
 */
export function SubscriptionContextMenu({
  id,
  label,
  children,
}: {
  /** stream id——引用里带出去的就是它（模型靠它寻址，认错一条流动的是真文件）。 */
  id: string
  /** 显示名。 */
  label: string
  children: ReactNode
}) {
  return (
    <ContextMenu>
      {/* `asChild`：不自己造节点，把 contextmenu 事件透给被包住的那张卡。 */}
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent size="sm">
        <ContextMenuItem onSelect={() => void referenceSubscription(id, label)}>
          <AtSignIcon />
          在对话中引用
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
