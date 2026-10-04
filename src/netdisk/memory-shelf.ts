import type { FileShelf, ShelfTraits } from './shelf.ts'

/**
 * 内存文件货架：**测试脚手架 + "最小合规实现"的范本**——不进生产接线。
 *
 * 它同时回答两个问题：契约用例有没有第二个实现来对照（一份实现自己跑契约 = 自己验自己），以及
 * 想加一种新来源（本地目录 / 另一家网盘）时"至少要实现成什么样"。所以这里刻意只用一个 `Map`，
 * 没有任何网络与缓存——剩下的复杂度都是来源自己的，不是契约要求的。
 *
 * 两条来自 traits 的行为写在这里，别漏（漏了不报错，只是契约变红）：
 * - 路径一律 NFC 归一（`é` 的两种写法必须是同一个文件）；
 * - `caseSensitive: false` → 查找按折叠后的名字比，但**列出来的仍是当初存进来那个名字**。
 */
export class MemoryShelf implements FileShelf {
  /** Task 8 落地后 `FileShelf` 有 `id`；这里先给上，免得两边分家。 */
  readonly id = 'memory'
  readonly traits: ShelfTraits = { caseSensitive: false, hasTrash: true, listingIsLive: true, reportsInProgress: false }

  /** 折叠后的键 → { 原样路径（NFC）, 字节数 }。 */
  private readonly files = new Map<string, { path: string; size: number }>()
  /** 折叠后的目录键 → 原样路径（`mkdir` 与写文件时登记祖先）——用来区分"空目录"和"目录不存在"，
   *  也是 `listDirRecursive(includeDirs:true)` 列目录行的数据源。 */
  private readonly dirs = new Map<string, string>([[this.key('/'), '/']])

  /** 归一：NFC + 去尾斜杠；大小写折叠只在 `caseSensitive: false` 时做。 */
  private key(path: string): string {
    const p = path.normalize('NFC').replace(/\/+$/, '') || '/'
    return this.traits.caseSensitive ? p : p.toLowerCase()
  }

  private registerAncestors(path: string): void {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`
      this.dirs.set(this.key(p), p)
    }
  }

  /** 灌一份文件（测试用）。 */
  put(path: string, size: number): void {
    const nfc = path.normalize('NFC')
    this.files.set(this.key(nfc), { path: nfc, size })
    this.registerAncestors(nfc)
  }

  private dirExists(dirKey: string): boolean {
    if (this.dirs.has(dirKey)) return true
    const prefix = dirKey === '/' ? '/' : `${dirKey}/`
    return [...this.files.keys()].some((k) => k.startsWith(prefix))
  }

  async listDirRecursive(
    path: string, maxDepth = 5, _refresh = false, includeDirs = false,
  ): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const dirKey = this.key(path)
    if (!this.dirExists(dirKey)) throw new Error('object not found')
    const prefix = dirKey === '/' ? '/' : `${dirKey}/`
    const out: { name: string; size: number; isDir: boolean }[] = []
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue
      // 名字取原样存的那份（折叠只用于比对），相对根、`/` 分隔。
      const rel = f.path.slice(prefix.length)
      if (rel.split('/').length - 1 > maxDepth) continue
      out.push({ name: rel, size: f.size, isDir: false })
    }
    if (includeDirs) {
      for (const [k, p] of this.dirs) {
        if (k === dirKey || !k.startsWith(prefix)) continue
        const rel = p.slice(prefix.length)
        if (rel.split('/').length - 1 > maxDepth) continue
        out.push({ name: rel, size: 0, isDir: true })
      }
    }
    return out
  }

  async mkdir(path: string): Promise<void> {
    const dirKey = this.key(path)
    this.dirs.set(dirKey, path.normalize('NFC').replace(/\/+$/, '') || '/')
    this.registerAncestors(path.normalize('NFC'))
  }

  async move(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    const src = this.key(srcDir)
    const dst = dstDir.normalize('NFC').replace(/\/+$/, '') || '/'
    const picked = names.map((n) => {
      const hit = this.files.get(this.key(`${src === '/' ? '' : src}/${n}`))
      if (!hit) throw new Error('object not found')
      return { name: n.normalize('NFC'), size: hit.size, from: this.key(hit.path) }
    })
    for (const p of picked) {
      this.files.delete(p.from)
      this.put(`${dst === '/' ? '' : dst}/${p.name}`, p.size)
    }
    this.dirs.set(this.key(dst), dst)
  }

  async rename(path: string, newName: string): Promise<void> {
    const nfc = path.normalize('NFC')
    const cur = this.files.get(this.key(nfc))
    if (!cur) throw new Error(`object not found: ${nfc}`)
    const dir = nfc.slice(0, nfc.lastIndexOf('/'))
    const next = `${dir}/${newName.normalize('NFC')}`
    if (this.files.has(this.key(next))) throw new Error(`already exists: ${next}`)
    this.files.delete(this.key(nfc))
    this.files.set(this.key(next), { path: next, size: cur.size })
  }

  /**
   * 删。**不存在的名字静默成功**——照抄真实网盘（2026-09-03 活体：OpenList 的夸克挂载对不存在的
   * 名字答 code 200 success）。别"顺手"改成抛错：那会让契约相信一件真实来源不做的事，而下游真正
   * 该做的是删之前自己核一遍存在性（执行器那一侧）。
   */
  async remove(dir: string, names: string[]): Promise<void> {
    const d = this.key(dir)
    for (const n of names) this.files.delete(this.key(`${d === '/' ? '' : d}/${n}`))
  }
}
