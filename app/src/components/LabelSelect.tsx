import { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './acrylic/select.tsx'
import { api, type Connection } from '../lib/api.ts'
import type { Item } from '../lib/types.ts'

/**
 * Read-time manual ad label. An explicit control (never a side effect of opening
 * an item): pick 广告/抽奖 to fold it into the 广告 channel, or 非广告 to clear a
 * false positive (which the backend also captures as a negative fixture).
 */
export function LabelSelect({
  item,
  conn,
  onChange,
}: {
  item: Item
  conn: Connection
  onChange?: (muted: Item['muted']) => void
}) {
  // controlled value mirrors the item's muted reason; re-seed when the item changes
  const [value, setValue] = useState<string | undefined>(item.muted?.reason)
  useEffect(() => setValue(item.muted?.reason), [item.id, item.muted?.reason])

  const onValueChange = (v: string) => {
    const reason = v as 'ad' | 'lottery' | 'not-ad'
    setValue(reason === 'not-ad' ? undefined : reason)
    void api.label(conn, item.id, reason)
    onChange?.(reason === 'not-ad' ? undefined : { reason, rule: 'manual', manual: true })
  }

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="标注" size="large" className="w-[88px]">
        <SelectValue placeholder="标注" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ad">广告</SelectItem>
        <SelectItem value="lottery">抽奖</SelectItem>
        <SelectItem value="not-ad">非广告</SelectItem>
      </SelectContent>
    </Select>
  )
}
