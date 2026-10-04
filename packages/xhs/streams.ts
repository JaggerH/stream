/** 表的容量上限（条）。进程内一张小表，最近打开过的两百条笔记足够覆盖「打开 → 播放」这一段路。 */
export const STREAM_TABLE_MAX = 200

/**
 * noteId → 笔记页里现取到的签名 mp4 地址。**进程内、不落盘**，容量有界的 LRU。
 *
 * 为什么要这张表：流地址只在打开笔记（xhs-detail）时才拿得到，而播放请求（xhs-resolve）是另一次
 * 独立的调用——两者之间只有这张表在传话。写入方是 detail 的映射（`detail.ts`），读取方是
 * 解析成员（`adapter.ts`）。
 *
 * **不按时钟过期**：签名地址的真实寿命我们不知道，而 `<video>` 的 Range 请求会反复打到 xhs-resolve——
 * 按 TTL 清掉之后每一次 Range 都是一次 miss，miss 又没有合法的现取路（没有 token 的 detail 运行注定
 * 落 fallback-nav 失败、白烧一个限速名额）。地址真死了的信号是 CDN 在播放时回的 4xx，通用播放路由
 * 本来就会把它原样透给前端；这里只负责「最近记过的那条地址」，直到被下一次打开笔记覆盖或被 LRU 挤掉。
 */
export class StreamTable {
  private readonly rows = new Map<string, string>()
  constructor(private readonly max: number = STREAM_TABLE_MAX) {}

  set(noteId: string, url: string): void {
    // Map 按插入序迭代：删了再插 = 挪到最新；超容量就挤掉最旧的那条。
    this.rows.delete(noteId)
    this.rows.set(noteId, url)
    if (this.rows.size > this.max) {
      const oldest = this.rows.keys().next().value
      if (oldest !== undefined) this.rows.delete(oldest)
    }
  }

  /** 命中即返回，并把它刷成最新（正在播的那条别被挤掉）。 */
  get(noteId: string): string | undefined {
    const url = this.rows.get(noteId)
    if (url === undefined) return undefined
    this.rows.delete(noteId)
    this.rows.set(noteId, url)
    return url
  }

  get size(): number {
    return this.rows.size
  }
}
