import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PlugZap, TriangleAlert } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'
import { api, type Connection } from '../../lib/api.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import type { ProviderCallsiteView } from '../../lib/types.ts'
import { useChannels } from '../../lib/channels.tsx'
import { nextSlotsFor, SLOT_DEFAULT } from './slots.ts'

/** chip 文案：频道覆盖优先，否则全局 binding 首行；覆盖指向已消失的行时原样露 id
 *  （这正是 slot_broken 的形态——别替它编一个名字）。连全局 binding 都没有时用调用方给的
 *  `defaultLabel`（来自 i18n）——纯函数不自己碰 t()，也不留中文硬编码。 */
export function slotChipLabel(callsite: ProviderCallsiteView, overrideId: string | undefined, defaultLabel: string): { name: string; isOverride: boolean } {
  if (overrideId) {
    return { name: callsite.providers.find((p) => p.id === overrideId)?.label ?? overrideId, isOverride: true }
  }
  const globalId = callsite.binding?.providerIds[0]
  return { name: globalId ? callsite.providers.find((p) => p.id === globalId)?.label ?? globalId : defaultLabel, isOverride: false }
}

/** 调用点就地换 Provider 的小标签——「由 ○○ 提供」，点开选兼容候选或清除覆盖。
 *  与 ChannelManageSheet 的槽位区写同一份数据（频道 options.slots）。
 *  broken = 宿主上一次调用踩到 422 slot_broken → 警示态，报错与修复同一位置闭环。 */
export function SlotSwitcher({ conn, channelId, callsiteId, broken, onChanged }: {
  conn: Connection
  channelId: string
  callsiteId: string
  broken?: boolean
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [callsite, setCallsite] = useState<ProviderCallsiteView | null>(null)
  const [saving, setSaving] = useState(false)
  // 频道记录来自共享状态，不是本组件挂载时拍下的私有快照——那份快照永不刷新，
  // 同屏的 ChannelManageSheet 一改槽位它就过时，而 pick() 又是「整份写回」。
  const { channels, patchChannel } = useChannels()
  const channel = channels.find((c) => c.id === channelId) ?? null

  useEffect(() => {
    let live = true
    void api.providerCallsites(conn).then((sites) => {
      if (!live) return
      setCallsite(sites.find((s) => s.id === callsiteId) ?? null)
    }).catch(() => {})
    return () => { live = false }
  }, [conn, callsiteId])

  if (!callsite || !channel) return null
  const overrideId = (channel.options?.slots as Record<string, string[]> | undefined)?.[callsiteId]?.[0]
  const { name, isOverride } = slotChipLabel(callsite, overrideId, t('slot.unset'))

  // 写失败必须说话：后端会拒绝指向 parked 行的槽位，静默失败时 chip 文案不变、下拉像没反应。
  // 姊妹组件 ChannelSlotFields 把错误内联在表单里；chip 是个小标签没地方放，改用 toast
  // （与 ChannelManageSheet 的加载失败同一条反馈通道）。失败时共享状态不动。
  const pick = async (uiValue: string) => {
    setSaving(true)
    try {
      await patchChannel(channel.id, {
        options: { ...channel.options, slots: nextSlotsFor(channel, callsiteId, uiValue) },
      })
      onChanged()
    } catch (e) {
      toast.error(t('slot.saveFailed', { message: (e as Error).message }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={broken ? t('slot.broken') : t('slot.providedBy', { name })}
          title={broken ? t('slot.broken') : t('slot.providedBy', { name })}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
            broken
              ? 'border-amber-500/60 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
              : 'border-border text-muted-foreground hover:bg-[var(--acr-chip-hover)] hover:text-foreground'
          }`}
        >
          {broken ? <TriangleAlert className="size-3" /> : <PlugZap className="size-3" />}
          <span className="max-w-40 truncate">{t('slot.providedBy', { name })}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => void pick(SLOT_DEFAULT)}>
          {t('slot.default')}{!isOverride ? ' ✓' : ''}
        </DropdownMenuItem>
        {callsite.providers.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => void pick(p.id)}>
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            {overrideId === p.id ? ' ✓' : ''}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
