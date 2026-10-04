/**
 * `@` 候选的取数：订阅名册 / 网盘子目录。
 *
 * 和 `reconcile-ref-sources.ts` 分开，是为了让那一份**完全不认识 fetch**——候选怎么排、
 * 插进去的那串字长什么样，是可以纯函数测的；这一份只管把两个后端形状读成它要的样子。
 *
 * 后端形状照 `src/http/app.ts`（`/api/streams`）与 `src/http/netdisk-routes.ts`
 * （`/api/netdisk/fs`）**重新声明**，不 import 后端模块——同 `boards/api.ts` 的约定
 * （契约共享而非源码共享）。
 */
import type { RefStream } from './reconcile-ref-sources.ts'

interface StreamRow {
  id: string
  label?: string
  description?: string
}

interface FsRow {
  name: string
  isDir: boolean
}

const base = (backend: string): string => backend.replace(/\/+$/, '')

/**
 * 订阅名册。
 * @param backend - Stream 后端基址。
 * @param signal - 菜单换词/关闭时管线会 abort 它。
 */
export async function fetchRefStreams(backend: string, signal: AbortSignal): Promise<RefStream[]> {
  const res = await fetch(`${base(backend)}/api/streams`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rows = await res.json() as StreamRow[]
  // 显示名三级回落到 id：名册里偶有只剩 id 的行（刚建、还没采过），**不许因此从菜单里消失**
  // ——那会表现成"我明明订了这条，@ 却找不到"。
  return rows.map((r) => ({ id: r.id, label: r.label ?? r.description ?? r.id }))
}

/**
 * 一个目录下的子目录名（只要目录）。
 * @param backend - Stream 后端基址。
 * @param dir - 绝对 AList 路径。
 * @param signal - 同上。
 */
export async function fetchRefDirs(backend: string, dir: string, signal: AbortSignal): Promise<string[]> {
  // 单层、不递归、吃 AList 的目录缓存——这是随手浏览，不是对账（整理自己的扫描才强制回源）。
  const res = await fetch(`${base(backend)}/api/netdisk/fs?path=${encodeURIComponent(dir)}`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json() as { files?: FsRow[] }
  return (body.files ?? []).filter((f) => f.isDir).map((f) => f.name)
}
