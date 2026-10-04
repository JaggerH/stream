import { useState } from 'react'
import { cn } from '../lib/utils.ts'

/**
 * 压在媒体画面上的简介条：默认两行截断，点一下展开（限高内滚），再点收回。
 *
 * **点击必须吞掉**：它坐在媒体台上，而媒体台的点击语义是「关详情页」——不吞的话展开简介
 * 会顺手把页面关了，且没有任何报错。
 *
 * 显隐不归它管：视频那一档由 ArtPlayer 的 hover 态用 CSS 驱动（跟控制条同生共死），
 * 播客/图集那一档常驻。组件自己不存"控制条现在显不显"——那会是第二份真相。
 */
export function BlurbOverlay({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  return (
    <div
      data-testid="blurb-overlay"
      data-slot="blurb-overlay"
      data-expanded={expanded ? 'true' : 'false'}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'pointer-events-auto w-full bg-gradient-to-t from-black/75 via-black/55 to-transparent px-4 pb-3 pt-6',
        className
      )}
    >
      <button
        type="button"
        aria-label={expanded ? '收起简介' : '展开简介'}
        onClick={() => setExpanded((v) => !v)}
        className="block w-full cursor-pointer text-left"
      >
        <span
          className={cn(
            'block whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/90',
            expanded ? 'max-h-[40vh] overflow-y-auto scrollbar-mac' : 'line-clamp-2'
          )}
        >
          {text}
        </span>
      </button>
    </div>
  )
}
