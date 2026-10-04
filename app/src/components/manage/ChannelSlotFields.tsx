import { useState } from 'react'
import { Field, FieldGroup, FieldLabel } from '../acrylic/field.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'
import type { ChannelView, PresentSlotView, ProviderView } from '../../lib/types.ts'
import { useChannels } from '../../lib/channels.tsx'
import { nextSlotsFor, SLOT_DEFAULT } from './slots.ts'

/** 能力槽位编辑——频道配置面（`ChannelConfigPanel`：Present 的「配置」分页 /
 *  `ChannelManageSheet`）共用同一份，两处宿主显示/行为永远一致。改一个槽位即保存。
 *  `channel` 由宿主从共享状态里取（见 lib/channels.tsx），写也走它——两处宿主看到的
 *  永远是同一条记录，谁改都不会覆盖对方。 */
export function ChannelSlotFields({ channel, slots, providers, onSaved, columns = 1 }: {
  channel: ChannelView
  slots: PresentSlotView[]
  providers: ProviderView[]
  onSaved: () => void
  /** 一行排几组「标签 + 下拉」。**是上限不是定值**：真实列数按容器宽度收（`@container`）。 */
  columns?: 1 | 2
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { patchChannel } = useChannels()

  const setSlot = async (callsiteId: string, uiValue: string) => {
    setSaving(true)
    setErr(null)
    try {
      await patchChannel(channel.id, {
        options: { ...channel.options, slots: nextSlotsFor(channel, callsiteId, uiValue) },
      })
      onSaved()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    // 两列档用的是同一套 subgrid：外层多铺一组 `[max-content_1fr]`，每个 Field 仍旧 span 2，
    // 于是**所有列的标签宽度对齐成一条**——各列各排各的就会左右两边标签宽度不一，看着像抖。
    <FieldGroup className={`grid items-center gap-x-4 gap-y-3 [&>[data-slot=field]]:col-span-2 [&>[data-slot=field]]:grid [&>[data-slot=field]]:grid-cols-subgrid [&>[data-slot=field]]:items-center ${
      columns === 2
        ? 'grid-cols-[max-content_1fr] @xl:grid-cols-[max-content_1fr_max-content_1fr]'
        : 'grid-cols-[max-content_1fr]'
    }`}>
      {slots.map((slot) => {
        const candidates = providers.filter((p) => p.category === slot.category && !p.parked)
        const current = (channel.options?.slots as Record<string, string[]> | undefined)?.[slot.callsiteId]?.[0] ?? ''
        return (
          // Field 不再声明 size：SelectTrigger 的文字恒定 13px（size 只影响高度），
          // 而 Field 的 size 轴会把 Label 顶到 17px——label 反而比旁边的值大 4px。
          // 去掉后 Label 回到默认 13px，与 Select 值对齐（18b2a363 的后遗症）。
          <Field key={slot.callsiteId}>
            <FieldLabel>{slot.label}</FieldLabel>
            <Select
              value={current || SLOT_DEFAULT}
              disabled={saving}
              onValueChange={(value) => void setSlot(slot.callsiteId, value)}
            >
              <SelectTrigger size="xl" className="w-full" aria-label={slot.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SLOT_DEFAULT}>默认（跟随全局）</SelectItem>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )
      })}
      {err ? <p className="col-span-full text-[12px] text-destructive">{err}</p> : null}
    </FieldGroup>
  )
}
