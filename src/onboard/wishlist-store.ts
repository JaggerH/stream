import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 一条「想接进来、但现在接不上」的记录。
 *
 *  它的读者是**以后要把这个站接进来的那个人**（写 RSSHub 路由或 recipe 的时候）。所以最有价值
 *  的字段是 `goal`——当时在找什么。光有 URL 的清单没人看得懂，也就没人会去消化它。
 *
 *  **这份清单不保证完整**：写它的是对话里的模型（见 `note_unonboardable` 工具），漏记不会有
 *  任何一处报错。别在它上面建任何依赖「清单是全集」的功能。 */
export interface WishlistEntry {
  id: string
  url: string
  /** 当时在找什么（用户原话或模型的转述） */
  goal: string
  /** 可选：为什么值得接 */
  note?: string
  /** ISO 时间 */
  at: string
}

/** 本机私有的小账本：JSON、tmp+rename 原子写、坏文件冷启动按空表处理
 *  （照 `src/sharing/import-run-store.ts` 的模式）。 */
export class WishlistStore {
  private entries: WishlistEntry[]
  private readonly now: () => string
  private readonly newId: () => string
  constructor(
    private readonly path: string,
    opts?: { now?: () => string; newId?: () => string }
  ) {
    this.now = opts?.now ?? (() => new Date().toISOString())
    this.newId = opts?.newId ?? (() => `wl_${randomUUID().slice(0, 8)}`)
    this.entries = this.load()
  }

  private load(): WishlistEntry[] {
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return Array.isArray(parsed) ? (parsed as WishlistEntry[]) : []
    } catch {
      return []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.onboard-wishlist.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2))
    renameSync(tmp, this.path)
  }

  /** 最新在前——这份清单是给人扫一眼的，最近撞上的那个最可能还记得上下文。 */
  list(): WishlistEntry[] {
    return [...this.entries].reverse()
  }

  add(e: { url: string; goal: string; note?: string }): WishlistEntry {
    const entry: WishlistEntry = {
      id: this.newId(),
      url: e.url,
      goal: e.goal,
      ...(e.note ? { note: e.note } : {}),
      at: this.now(),
    }
    this.entries.push(entry)
    this.persist()
    return entry
  }

  remove(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    this.persist()
    return true
  }
}
