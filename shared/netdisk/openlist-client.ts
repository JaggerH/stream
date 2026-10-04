/**
 * OpenList（AList v3 同一套 `/api`）客户端的**核心**——两个宿主同吃一份：Stream 后端
 * （`./alist-client.ts` 的 `AlistClient` 继承它当文件货架；standby 唤醒与地址解析由宿主
 * `src/netdisk/alist-client.ts` / alist 包的 adapter 经 `fetchFn` 与 `baseUrl` thunk 注入）和
 * 网盘能力包（`capabilities/netdisk/`，external 档直接用它）。所以这里对宿主零假设：
 *
 * - `fetchFn` 注入（Stream 那边包成 `withAwake`，插件那边就是全局 fetch）；
 * - `baseUrl` 可以是 thunk——host 档下容器醒着时地址才存在，构造期快照必得空串；
 * - 认证：token **裸放** `Authorization` 头。OpenList 对 `Bearer ` 前缀答 401（活体实测 2026-09-02），
 *   别"顺手"加。
 *
 * 直链缓存：网盘直链有时效（夸克/阿里约几小时），按 path 缓存 raw_url，TTL 30 分钟；播放中途失效
 * 由播放器 error 触发重 resolve（缓存 miss 后重取）。
 */

export interface OpenListFile {
  name: string
  size: number
  isDir: boolean
}

/** admin storage 条目（/api/admin/storage/list 原样字段，update 时整体回传）。 */
export interface OpenListStorage {
  id: number
  mount_path: string
  driver: string
  /** JSON 字符串（AList 协议如此），含 cookie 等驱动私有字段。 */
  addition: string
  disabled: boolean
  status?: string
  order?: number
  [k: string]: unknown
}

/**
 * 这条错误是不是「文件在网盘侧已经没了」（用户手动删除 / 移动 / 重命名后旧路径失效）。
 * 是终局，区别于超时 / CDN 抖 / cookie 失效那类临时故障。AList 把「对象不存在」报成 `code 500` +
 * 此文案。判据只认这一句、不认宽泛的 `not found`，免得把「storage not found」也误判成文件被删。
 */
export function isObjectNotFound(message: string): boolean {
  return /object not found/i.test(message)
}

/** `move` 专属：OpenList 在父目录缓存里找不到 dst 时的那一句。比 `isObjectNotFound` 窄——
 *  只有它值得刷父目录重试；源文件不在（同样是 object not found）刷了也没用。 */
export function isDstDirMissing(message: string): boolean {
  return /failed to get dst dir/i.test(message) && isObjectNotFound(message)
}

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** `move` 等落地的轮次与间隔（活体实测约 1.5s 翻面，见 `move` 头注）。上限 ~15s。 */
const MOVE_SETTLE_TRIES = 15
const MOVE_SETTLE_INTERVAL_MS = 1000

export interface OpenListClientOptions {
  /** 基址（可带尾斜杠）；给 thunk 则每次请求现求值。 */
  baseUrl: string | (() => string)
  token: string
  /** 401 时换新 token（Stream 托管模式：用存储的 admin 密码重登）。缺省 = 不重试。 */
  refresh?: () => Promise<string>
  /** 注入便于测试；默认 setTimeout。`move` 等落地时退避用。 */
  sleep?: (ms: number) => Promise<void>
  /** 出站 fetch。缺省 = 调用时的全局 fetch（不在构造期捕获，测试 stub 全局才生效）。 */
  fetchFn?: typeof fetch
  ttlMs?: number
}

export class OpenListClient {
  private readonly resolveBase: () => string
  private token: string
  private readonly refresh: (() => Promise<string>) | undefined
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchFn: typeof fetch
  private readonly ttlMs: number
  private linkCache = new Map<string, { url: string; expiresAt: number }>()
  private idCache = new Map<string, { id: string; expiresAt: number }>()
  private sizeCache = new Map<string, { size: number; expiresAt: number }>()

  constructor(opts: OpenListClientOptions) {
    this.resolveBase = typeof opts.baseUrl === 'function' ? opts.baseUrl : () => opts.baseUrl as string
    this.token = opts.token
    this.refresh = opts.refresh
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init))
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000
  }

  private get baseUrl(): string {
    return this.resolveBase().replace(/\/$/, '')
  }

  /** 单次请求。unauthorized 单独上报（HTTP 401 或信封 code 401），供上层决定是否重登重试。 */
  private async requestOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ unauthorized: boolean; status: number; json?: { code: number; message?: string; data: T } }> {
    const r = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: this.token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (r.status === 401) return { unauthorized: true, status: r.status }
    if (!r.ok) return { unauthorized: false, status: r.status }
    const json = (await r.json()) as { code: number; message?: string; data: T }
    return { unauthorized: json.code === 401, status: r.status, json }
  }

  protected async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let out = await this.requestOnce<T>(method, path, body)
    if (out.unauthorized && this.refresh) {
      this.token = await this.refresh() // 48h JWT 过期 → 重登一次后重试
      out = await this.requestOnce<T>(method, path, body)
    }
    if (out.unauthorized) throw new Error('[alist] code 401: token 失效且无 refresh 通道')
    if (!out.json) throw new Error(`[alist] HTTP ${out.status}`)
    if (out.json.code !== 200) throw new Error(`[alist] code ${out.json.code}: ${out.json.message ?? ''}`)
    return out.json.data
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  /**
   * 列目录（含子目录，原始条目透传）。`refresh`：false（默认）用 OpenList 自己的目录缓存；
   * true 强制回源重列（同步/换绑时用）。
   *
   * 夸克驱动实际每页封顶 200 条（2026-07-24 活体实测：304 文件目录恒返回 200）——必须翻页，
   * 否则大目录静默截断。refresh 只在第 1 页发。
   */
  async listEntries(path: string, refresh = false): Promise<OpenListFile[]> {
    const PER = 200
    const out: OpenListFile[] = []
    for (let page = 1; ; page++) {
      const data = await this.post<{
        content: Array<{ name: string; size: number; is_dir: boolean }> | null
        total?: number
      }>('/api/fs/list', { path, page, per_page: PER, refresh: refresh && page === 1 })
      const batch = data.content ?? []
      out.push(...batch.map((f) => ({ name: f.name, size: f.size, isDir: f.is_dir })))
      if (batch.length < PER) break
      if (typeof data.total === 'number' && out.length >= data.total) break
    }
    return out
  }

  /** 列目录（仅文件，目录条目滤掉——单层不递归）。 */
  async listDir(path: string, refresh = false): Promise<OpenListFile[]> {
    return (await this.listEntries(path, refresh)).filter((f) => !f.isDir)
  }

  /**
   * 递归列目录下所有文件，`name` 为相对根目录的子路径。深度上限防跑飞。
   * `includeDirs`：把目录条目也收进结果。**默认关，而且必须保持关**——文件选择框的平铺列表以
   * 「这份列表里没有可下钻的目录」为前提。目录行在深度闸门之前入结果。
   */
  async listDirRecursive(path: string, maxDepth = 5, refresh = false, includeDirs = false): Promise<OpenListFile[]> {
    const root = path.replace(/\/$/, '')
    const out: OpenListFile[] = []
    const walk = async (rel: string, depth: number): Promise<void> => {
      const abs = rel ? `${root}/${rel}` : root
      for (const e of await this.listEntries(abs, refresh)) {
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDir) {
          if (includeDirs) out.push({ name: childRel, size: e.size, isDir: true })
          if (depth < maxDepth) await walk(childRel, depth + 1)
        } else {
          out.push({ name: childRel, size: e.size, isDir: false })
        }
      }
    }
    await walk('', 0)
    return out
  }

  // ── 文件操作（建目录 / 移动）——都走 request()，共享 401 自动重登通道 ──────────────

  /** 建目录（幂等：已存在视为成功，不抛）。 */
  async mkdir(path: string): Promise<void> {
    try {
      await this.post('/api/fs/mkdir', { path })
    } catch (e) {
      if (!/exist/i.test(String((e as Error).message))) throw e
    }
  }

  /**
   * 批量移动。**返回 = 网盘现状里这些名字真的已经不在 `srcDir` 了**，不只是「请求被接受」：
   * 夸克的移动是异步任务，活体实测 move 155ms 返回、+1503ms 才翻面；不等的话下一个读现状的人
   * 会读到移动前的世界（整理面板刚搬走的文件被再规划一遍）。
   */
  async move(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    if (names.length === 0) return
    try {
      await this.post('/api/fs/move', { src_dir: srcDir, dst_dir: dstDir, names })
    } catch (e) {
      // 目标目录是这一轮刚 mkdir 出来的，OpenList 找 dst 却读的是父目录 mkdir 之前的缓存清单——
      // 于是"目录明明在、move 说不存在"。刷一次父目录再试一次；第二次还不在就是真不在，原样抛。
      // 活体（2026-09-03）：同一轮 11 份搬进 纯享/S03 成功，下一批从另一个源目录往同一处搬撞上这句。
      if (!isDstDirMissing(String((e as Error).message))) throw e
      await this.listEntries(parentOf(dstDir), true)
      await this.post('/api/fs/move', { src_dir: srcDir, dst_dir: dstDir, names })
    }
    await this.waitMoved(srcDir, names)
  }

  /** 等 `srcDir` 里不再有这些名字。只探源侧；探不通不抛（移动已被网盘接受）。 */
  private async waitMoved(srcDir: string, names: string[]): Promise<boolean> {
    const left = new Set(names)
    for (let i = 0; i < MOVE_SETTLE_TRIES; i++) {
      try {
        const now = new Set((await this.listEntries(srcDir, true)).map((f) => f.name))
        if (![...left].some((n) => now.has(n))) return true
      } catch (e) {
        // 源目录整个不见了（最后一份搬走后网盘会收掉空目录）= 落地了。
        if (isObjectNotFound(String((e as Error).message))) return true
      }
      if (i < MOVE_SETTLE_TRIES - 1) await this.sleep(MOVE_SETTLE_INTERVAL_MS)
    }
    return false
  }

  /**
   * 流式上传（OpenList `PUT /api/fs/put`）。`body` 是**开一条新流的 thunk**而不是流本身：401 重登后要
   * 再发一次，而流不能回放。`size` 必须给——OpenList 从 `Content-Length` 读文件大小，没有它答 400。
   * 同名覆盖（OpenList 语义）。`As-Task: false` = 同步等它写完再答，调用方拿到 200 就是落盘了。
   * `File-Path` 头按 OpenList 要求 URL-encode（中文路径裸放会被 Go 的 header 校验拒掉）。
   */
  async put(path: string, body: () => ReadableStream<Uint8Array>, size: number): Promise<void> {
    const once = async (): Promise<{ unauthorized: boolean; status: number; json?: { code: number; message?: string } }> => {
      const r = await this.fetchFn(`${this.baseUrl}/api/fs/put`, {
        method: 'PUT',
        headers: {
          authorization: this.token,
          'file-path': encodeURIComponent(path),
          'as-task': 'false',
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        body: body(),
        // Node fetch（undici）发流式 body 必须声明 half-duplex，否则当场 TypeError。
        duplex: 'half',
      } as RequestInit)
      if (r.status === 401) return { unauthorized: true, status: r.status }
      if (!r.ok) return { unauthorized: false, status: r.status }
      const json = (await r.json()) as { code: number; message?: string }
      return { unauthorized: json.code === 401, status: r.status, json }
    }
    let out = await once()
    if (out.unauthorized && this.refresh) {
      this.token = await this.refresh()
      out = await once()
    }
    if (out.unauthorized) throw new Error('[alist] code 401: token 失效且无 refresh 通道')
    if (!out.json) throw new Error(`[alist] HTTP ${out.status}`)
    if (out.json.code !== 200) throw new Error(`[alist] code ${out.json.code}: ${out.json.message ?? ''}`)
  }

  /** 同目录内改名。`path`=文件全路径，`name`=新文件名（不含目录）。 */
  async rename(path: string, name: string): Promise<void> {
    await this.post('/api/fs/rename', { path, name })
  }

  /** 批量删除：`names`（`dir` 下的文件名）。夸克侧进回收站（约 10 天可捞）。 */
  async remove(dir: string, names: string[]): Promise<void> {
    if (names.length === 0) return
    await this.post('/api/fs/remove', { dir, names })
  }

  // ── admin：存储管理（挂载 reconciler 用）──────────────────────────────────────────

  async listStorages(): Promise<OpenListStorage[]> {
    const data = await this.request<{ content: OpenListStorage[] | null }>('GET', '/api/admin/storage/list?page=1&per_page=0')
    return data.content ?? []
  }

  /** 建 storage。addition 由调用方序列化为 JSON 字符串（AList 协议如此）。 */
  async createStorage(s: { mount_path: string; driver: string; addition: string; order?: number }): Promise<void> {
    await this.post('/api/admin/storage/create', {
      mount_path: s.mount_path,
      driver: s.driver,
      addition: s.addition,
      order: s.order ?? 0,
      cache_expiration: 30,
      enable_sign: false,
    })
  }

  /** 改 storage（cookie 自愈走这里：换 addition 后再 enable）。 */
  async updateStorage(s: OpenListStorage): Promise<void> {
    await this.post('/api/admin/storage/update', s)
  }

  async enableStorage(id: number): Promise<void> {
    await this.post(`/api/admin/storage/enable?id=${id}`, {})
  }

  /** 文件 → 直链。带 TTL 缓存；失败不缓存。 */
  async rawUrl(path: string): Promise<string> {
    const hit = this.linkCache.get(path)
    if (hit && hit.expiresAt > Date.now()) return hit.url
    const data = await this.post<{ raw_url: string }>('/api/fs/get', { path })
    if (!data.raw_url) throw new Error('[alist] fs/get 无 raw_url')
    this.linkCache.set(path, { url: data.raw_url, expiresAt: Date.now() + this.ttlMs })
    return data.raw_url
  }

  /** 文件 → 字节数（抽音轨的网络代价等于整个容器的字节数，见 src/media/audio-route.ts）。 */
  async fileSize(path: string): Promise<number> {
    const hit = this.sizeCache.get(path)
    if (hit && hit.expiresAt > Date.now()) return hit.size
    const data = await this.post<{ size?: number }>('/api/fs/get', { path })
    if (typeof data.size !== 'number') throw new Error('[alist] fs/get 无 size')
    this.sizeCache.set(path, { size: data.size, expiresAt: Date.now() + this.ttlMs })
    return data.size
  }

  /** 文件 → driver 侧对象 id（夸克即 fid）。夸克转码播放按 fid 定位（file/v2/play）。 */
  async fileId(path: string): Promise<string> {
    const hit = this.idCache.get(path)
    if (hit && hit.expiresAt > Date.now()) return hit.id
    const data = await this.post<{ id?: string }>('/api/fs/get', { path })
    if (!data.id) throw new Error('[alist] fs/get 无 id')
    this.idCache.set(path, { id: data.id, expiresAt: Date.now() + this.ttlMs })
    return data.id
  }
}
