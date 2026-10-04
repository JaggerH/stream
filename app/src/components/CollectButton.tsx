import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Heart, Loader2, Plus } from 'lucide-react'
import { api, collectedItemKey, type CollectedItemKeyInput, type Connection } from '../lib/api.ts'
import type { Collection, CollectionDomain } from '../lib/types.ts'
import { Button } from './acrylic/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './acrylic/popover.tsx'
import { Input } from './acrylic/input.tsx'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from './acrylic/command.tsx'
import { cn } from '../lib/utils.ts'

/**
 * 收藏面板——统一收藏系统(collections/store.ts)的唯一前端入口,video/audio 两个频道共用。
 * 打开时才拉「用户在这个域下的所有列表」+「这个东西现在在哪些列表里」,不是每张卡片常驻订阅——
 * 量级(几个到几十个列表)决定了懒加载够用,不必上下文/全局缓存。
 *
 * `variant='default'`:详情页头图那种图标+文字按钮(WorkDetail/RankingDetail/TmdbWorkDetail)。
 * `variant='icon'`:纯图标,同 Music 频道行内心形按钮的尺寸/交互(size-6 圆形、无边框)。
 */
export function CollectButton({ conn, domain, itemKey, meta, variant = 'default', onChanged }: {
  conn: Connection
  domain: CollectionDomain
  itemKey: CollectedItemKeyInput
  meta: { title: string; poster?: string; artist?: string; album?: string; durationS?: number; sourceUrl?: string }
  variant?: 'default' | 'icon'
  /** fires after a successful add/remove(/create, which is add-into-a-new-list) with the specific
   *  collectionId that changed and whether the item is now a member — callers whose own list
   *  rendering depends on ONE system collection's membership (正在追的 grid, 我的喜欢 playlist)
   *  patch their local state directly instead of refetching. */
  onChanged?: (collectionId: string, member: boolean) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  const collected = memberOf.size > 0
  // itemKey 是个 union——直接摆对象引用当依赖,每次渲染都是新对象会导致 effect 无限重跑;
  // 摊平成一个稳定的字符串键。
  const flatKey = collectedItemKey(itemKey)
  // video 域撤掉了自建列表(产品判断——影视不需要自建片单):不给「新建列表」入口,面板只展示
  // 系统列表(如「正在追的」)。domain 本就是入参,不新增 prop。
  const allowCreate = domain !== 'video'
  const visibleCollections = allowCreate ? collections : collections.filter((c) => c.system)

  // 急切拉一次归属——不然按钮初始状态永远显示"未收藏",非要用户先点开面板才知道真相。轻量(单个
  // key 查一次),值得常驻订阅而不是等 open。
  useEffect(() => {
    let live = true
    api.whereCollected(conn, itemKey).then((where) => { if (live) setMemberOf(new Set(where.collectionIds)) }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, flatKey])

  // 面板打开才需要「这个域下都有哪些列表」——顺带再核一次归属(组件挂载期间可能在别处被改过)。
  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    Promise.all([api.collections(conn, domain), api.whereCollected(conn, itemKey)])
      .then(([cols, where]) => {
        if (!live) return
        setCollections(cols)
        setMemberOf(new Set(where.collectionIds))
      })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conn, domain, flatKey])

  const toggle = async (collectionId: string) => {
    const was = memberOf.has(collectionId)
    setMemberOf((prev) => {
      const next = new Set(prev)
      was ? next.delete(collectionId) : next.add(collectionId)
      return next
    })
    try {
      if (was) await api.removeFromCollection(conn, collectionId, itemKey)
      else await api.addToCollection(conn, collectionId, itemKey, meta)
      onChanged?.(collectionId, !was)
    } catch {
      setMemberOf((prev) => {
        const next = new Set(prev)
        was ? next.add(collectionId) : next.delete(collectionId)
        return next
      })
    }
  }

  const createAndAdd = async () => {
    const label = newLabel.trim()
    if (!label || creating) return
    setCreating(true)
    try {
      const col = await api.createCollection(conn, domain, label)
      setCollections((prev) => [...prev, col])
      setNewLabel('')
      await toggle(col.id) // 新列表直接把当前项加进去——省得建完还要再点一次
    } catch {
      // best-effort；输入框内容留着方便重试
    } finally {
      setCreating(false)
    }
  }

  const trigger = variant === 'icon' ? (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      className="mx-auto inline-flex size-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground"
      title={collected ? t('collect.collected') : t('collect.collect')}
    >
      <Heart className={cn('size-4', collected && 'fill-primary text-primary')} />
    </button>
  ) : (
    <Button type="button" variant={collected ? 'default' : 'neutral'} size="small" onClick={(e) => e.stopPropagation()}>
      <Heart className={cn('size-4', collected && 'fill-current')} />
      {collected ? t('collect.collected') : t('collect.collect')}
    </Button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="px-1 pb-2 text-[12px] font-medium text-muted-foreground">{t('collect.addTo')}</div>
        {loading ? (
          <div className="flex items-center justify-center py-4"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <Command>
            <CommandList>
              <CommandEmpty>{t('collect.noLists')}</CommandEmpty>
              <CommandGroup>
                {visibleCollections.map((col) => (
                  <CommandItem key={col.id} value={col.label} onSelect={() => void toggle(col.id)}>
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {memberOf.has(col.id) && <Check className="size-3.5 text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{col.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
        {allowCreate && (
          <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createAndAdd() }}
              placeholder={t('collect.newListPlaceholder')}
              size="small"
              className="flex-1"
            />
            <Button type="button" variant="ghost" size="mini" icon onClick={() => void createAndAdd()} disabled={!newLabel.trim() || creating}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
