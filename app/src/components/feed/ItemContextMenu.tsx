import type { ReactNode } from 'react'
import { AtSignIcon, DownloadIcon, ExternalLinkIcon, FileTextIcon } from 'lucide-react'

import { triggerDownload } from '../../lib/feedPresent.ts'
import { useCanExtract } from '../../lib/extractCaps.tsx'
import { askExtract, referenceItem } from '../../lib/askExtract.ts'
import { LOCAL } from '../../lib/api.ts'
import type { Item as StreamItem } from '../../lib/types.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu.tsx'

/**
 * 一条内容的**全部动作**——列表行和瀑布流卡片共用这一份，右键（触屏长按，Radix 自带）叫出来。
 *
 * **为什么动作全在这儿、不在常驻动作条上**：动作条一屏 118 行就是 118 排按钮，而其中「看详情」
 * 和「点这一行」本来就是同一件事。菜单只在被叫出来时才占地方，两种布局也因此长得一样——
 * 各写一份的失败方式是**两边单看都正常**（一处加了新项、另一处没加，谁都不会报错）。
 *
 * **收不进来的只有一类：带状态/带数字、需要一眼看见的东西。** 今天就一样——包声明的可点动作
 * （点赞 / 收藏这类 toggle，选中态是 `ItemActionButtons` 自己的 state，菜单里再放一份就是两个
 * 各自为政的状态，会静默分叉），它留在外面 hover 浮出。要往这里加新项之前，先问它是不是这一类。
 *
 * 「在对话中引用」是第一项，且**这里是它唯一的入口**：内容是无限的，摆进对话输入框的 `@`
 * 菜单就是让用户在一个选不完的列表里翻找（实测反馈"很乱"）。而右键是指着说的——他正看着
 * 这一条，引的是谁一目了然。所以 `@` 只留可枚举的东西（订阅、网盘目录），内容走这儿。
 * 它**塞进输入框、不发送**：引用之后用户还要接着说下一句。
 *
 * 「转成文字」的显隐吃 `useCanExtract()`（判定权威在 `shared/extract/plan.ts`，和后端选分支同一份）——
 * **别在这里自己判 archetype**；动作本身走 `askExtract`（和详情页动作行同一份，别另写）：
 * 它开一条对话让模型去取，结果落进对话里的 ExtractCard。
 */
export function ItemContextMenu({
  item,
  videoDl,
  children,
}: {
  item: StreamItem
  /** 视频直链（`usePostPresentation` 的 `videoDl`）。空 = 这条没什么可下的。 */
  videoDl?: string
  children: ReactNode
}) {
  const canExtract = useCanExtract()

  return (
    <ContextMenu>
      {/* `asChild`：触发器不自己造节点，把 contextmenu 事件透给被包住的那个行/卡片，
          它们的结构一个字都不用改。 */}
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent size="sm">
        <ContextMenuItem onSelect={() => void referenceItem(item)}>
          <AtSignIcon />
          在对话中引用
        </ContextMenuItem>
        {canExtract(item) ? (
          <ContextMenuItem onSelect={() => void askExtract(LOCAL, item)}>
            <FileTextIcon />
            转成文字
          </ContextMenuItem>
        ) : null}
        {item.url ? (
          // `asChild` 用真的 `<a>`：中键/「在新标签页打开」这些浏览器原生手势得留着，
          // 换成 onSelect + window.open 就全没了。
          <ContextMenuItem asChild>
            <a href={item.url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              打开原文
            </a>
          </ContextMenuItem>
        ) : null}
        {/* 这里曾经有一项「查看 N 条评论」。撤掉了：它点下去就是打开详情，而点这一行/这张卡片
            本来就是同一件事——菜单里多一格重复的动作，只为显示一个数字。 */}
        {videoDl ? (
          <ContextMenuItem onSelect={() => triggerDownload(videoDl)}>
            <DownloadIcon />
            下载视频
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
