import { useEffect, useState } from 'react'
import type { AuthorEnrichView } from '@item/actions.ts'
import { Avatar, AvatarFallback, AvatarImage } from './acrylic/avatar.tsx'
import { api, type Connection } from '../lib/api.ts'

/**
 * 作者位：先画名字，再按条目上的 `author_enrich`（包声明、后端投影）现取头像与主页。
 * 取什么、链到哪由包的 enricher 回的 `{ face, url }` 决定——宿主不认识任何站，也不拼任何站点地址。
 * 现取失败 / 没有 url → 停在纯名字。
 */
export function AuthorChip({ name, enrich, conn }: { name: string; enrich: AuthorEnrichView; conn: Connection }) {
  const [u, setU] = useState<{ face?: string; url?: string } | null>(null)
  const paramsKey = JSON.stringify(enrich.params)
  useEffect(() => {
    let live = true
    setU(null)
    api
      .enrichAuthor(conn, enrich.source, enrich.params)
      .then((r) => { if (live && r) setU(r) })
      .catch(() => {})
    return () => {
      live = false
    }
    // params 按值比较：父组件每次渲染都给一个新对象，按引用会反复现取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich.source, paramsKey, conn])
  if (!u?.url) return <span>{name}</span>
  return (
    <a href={u.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-foreground">
      <Avatar className="size-5">
        {u.face ? <AvatarImage src={u.face} referrerPolicy="no-referrer" alt={name} /> : null}
        <AvatarFallback>{name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span>{name}</span>
    </a>
  )
}
