import { useEffect, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api } from '../lib/api.ts'
import type { Connection } from '../lib/api.ts'
import { Button } from './acrylic/button.tsx'

interface Entry {
  id: string
  url: string
  goal: string
  note?: string
  at: string
}

/**
 * 对话里撞上的「想接、但现在接不进来」的站——住在库存页的「抓取配方」那一段底下。
 *
 * **放在那儿不是排版偏好**：这份清单唯一的出口就是「给它写一份 recipe」，所以它得和 recipe
 * 待在同一屏里。单开一个面板等于开第二个收件箱，而收件箱只要超过一个就一定有一个没人清。
 *
 * 写入口只有一个：对话里的 `note_unonboardable` 工具。这一块只读 + 删——它的读者是**以后要把
 * 这个站接进来的那个人**，所以每条最显眼的是 `goal`（当时在找什么），地址反而是副的。
 *
 * 清单为空时整块不渲染：没有接不上的站，就不该在「配方」底下留一个空标题。
 */
export function OnboardWishlist({ conn }: { conn: Connection }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<Entry[]>([])
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    // try/catch 包着调用本身，不只是 .catch 挂在 Promise 上：**这一块是库存页里的一个附属小段，
    // 它取不到数最多是自己不显示，绝不能把整页带崩**。同步抛（比如接口那一格根本不在）走不到
    // .catch，会直接冒出 useEffect。
    try {
      api
        .onboardWishlist(conn)
        .then((r) => { if (aliveRef.current) setEntries(r.entries) })
        .catch(() => { /* 清单取不到不该拦住整个库存页 */ })
    } catch { /* 同上 */ }
    return () => { aliveRef.current = false }
  }, [conn])

  if (entries.length === 0) return null

  const remove = async (id: string) => {
    try {
      await api.deleteWishlistEntry(conn, id)
    } catch {
      // 删失败：条目留在原地——UI 不能骗用户说删掉了，下次点还能再试。
      return
    }
    if (aliveRef.current) setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  return (
    <section className="mt-4 border-t border-border/50 pt-4" aria-label={t('packages.wishlistTitle')}>
      <h3 className="mb-1 text-[12.5px] font-medium text-foreground">{t('packages.wishlistTitle')}</h3>
      <p className="mb-3 text-[12px] text-muted-foreground">{t('packages.wishlistWhy')}</p>
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground">{e.goal}</div>
              <a href={e.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground hover:underline">
                {e.url}
              </a>
              {e.note ? <div className="mt-1 text-xs text-muted-foreground">{e.note}</div> : null}
            </div>
            <Button type="button" variant="ghost" size="small" icon aria-label={t('packages.wishlistDrop')} onClick={() => void remove(e.id)}>
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
