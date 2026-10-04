// Source 的统一渲染单元:名称 / 描述 / 插件名(Badge) + 图标 + 右侧动态槽。
// 数据契约 = 后端 publicSource() 吐出的展示字段;本组件零推导(不从 id 反猜名称)。
import type { ReactNode } from 'react'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemMeta,
  ItemTitle,
} from './acrylic/item.tsx'
import { Badge } from './acrylic/badge.tsx'
import { SourceIcon } from './SourceIcon.tsx'

export interface SourceItemData {
  id: string
  title: string
  description?: string
  pluginName?: string
  /** Platform grouping from the manifest — drives the brand icon (facility-first, so the
   *  icon doesn't depend on the id's namespace parsing correctly). */
  facility?: { key: string; label: string }
  /** 认领这条源的包说它是哪个站（后端 `publicSource` 的 `site`）——图标先用它的域名。 */
  site?: { name: string; domain: string }
}

export function SourceItem({
  source,
  status,
  meta,
  actions,
  onClick,
  htmlId,
  className,
  size = 'default',
  variant = 'outline',
  tooltip,
  muted = false,
}: {
  source: SourceItemData
  /** Small indicator rendered inline right after the name (e.g. a health dot). */
  status?: ReactNode
  /** Right-aligned muted metadata (e.g. call count), rendered before actions. */
  meta?: ReactNode
  actions?: ReactNode
  onClick?: () => void
  htmlId?: string
  className?: string
  /** Row density — cascades to the icon via the Item's group-data size. */
  size?: 'default' | 'sm' | 'xs'
  /** Item background variant. Orthogonal to `muted` (which only dims).
   *  `default` = 透明行，给「装在一张 inset 卡片里、行间只有 hairline」的长列表用——几百行各自
   *  frosted 会把材质叠成一片糊（acrylic 的规则：不要把半透明面叠在半透明面上）。 */
  variant?: 'default' | 'outline' | 'muted'
  /** Native hover title on the row (e.g. the binding key, which isn't a source field). */
  tooltip?: string
  muted?: boolean
}) {
  // Structure + spacing mirror the canonical acrylic `Item` image demo. `size` picks the
  // density (default 48px / p-3, xs 28px / px-2), and ItemMedia follows via group-data.
  const body = (
    <>
      <ItemMedia variant="icon" className={`overflow-hidden ${muted ? 'opacity-40' : ''}`}>
        <SourceIcon id={source.id} name={source.title} facilityKey={source.facility?.key} site={source.site} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className={`flex items-center gap-2 ${muted ? 'text-muted-foreground' : ''}`}>
          <span className="truncate font-extrabold">{source.title}</span>
          {status}
          {source.pluginName ? (
            <Badge variant="secondary" size="sm" className="shrink-0">{source.pluginName}</Badge>
          ) : null}
        </ItemTitle>
        {source.description && source.description !== source.title ? (
          <ItemDescription className="line-clamp-1">{source.description}</ItemDescription>
        ) : null}
      </ItemContent>
      {meta ? <ItemMeta>{meta}</ItemMeta> : null}
      {actions ? <ItemActions>{actions}</ItemActions> : null}
    </>
  )
  if (onClick) {
    return (
      <Item asChild variant={variant} size={size} title={tooltip} id={htmlId} className={`cursor-pointer transition-colors ${className ?? ''}`}>
        <button type="button" onClick={onClick} className="w-full">
          {body}
        </button>
      </Item>
    )
  }
  return (
    <Item variant={muted ? 'muted' : variant} size={size} title={tooltip} id={htmlId} className={className}>
      {body}
    </Item>
  )
}
