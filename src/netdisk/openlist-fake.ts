/**
 * 假 OpenList 服务端：内存文件表 + 一个 `fetch` 兼容函数，只应答 `OpenListClient` 真正会打的那几条
 * （`/api/fs/list|mkdir|move|remove`）。给 `FileShelf` 契约测试用——**契约必须真的过一遍 HTTP 那层**，
 * 否则翻页、信封 code、`object not found` 文案这些"客户端自己那一半"根本没被验到。
 *
 * 形状对齐真实 OpenList（见 `shared/netdisk/openlist-client.ts`）：
 * - 一律 HTTP 200 + 信封 `{ code, message, data }`；失败是 `code: 500` + 文案，不是 HTTP 4xx/5xx。
 * - 对象不存在的文案就是 `object not found`（`isObjectNotFound` 只认这一句）。
 * - `fs/list` 分页返回 `{ content, total }`，`content` 为空时真实服务端给 `null`——照给，
 *   客户端那句 `data.content ?? []` 才算被验过。
 * - 大小写敏感（`OPENLIST_TRAITS.caseSensitive: true`），不折叠。
 *
 * 两处**故意不完美**的地方，它们是契约用例的牙齿所在——把它们做"干净"，两条用例就变成真空绿：
 *
 * 1. **目录列表是缓存的**（`listingIsLive: false` 的那一格）。`/api/fs/list` 给的是该目录**上一次
 *    取快照时**的样子，只有请求带 `refresh: true` 才重新取。`mkdir` 会顺手把新目录的快照置为空——
 *    于是"建目录 → 搬进去 → 不 refresh 地列"看到的是空目录，正是真实网盘上会咬人的那一幕。
 *    契约第一条因此必须带 refresh；去掉它就红。
 * 2. **移动是异步的**（夸克实测 move 155ms 返回、+1503ms 才翻面）。源目录里那份在其后
 *    `MOVE_GHOST_LISTINGS` 次取快照里仍然看得见，客户端的 `waitMoved` 重试循环因此真的会转起来，
 *    而不是第一圈就满足。
 */

/** 移动之后，源目录还会"看见"那份文件多少次取快照。 */
const MOVE_GHOST_LISTINGS = 2

interface Entry {
  name: string
  size: number
  is_dir: boolean
}

function reply(code: number, message: string, data: unknown): Response {
  return new Response(JSON.stringify({ code, message, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const ok = (data: unknown): Response => reply(200, 'success', data)
const notFound = (): Response => reply(500, 'failed to get obj: object not found', null)

function normDir(path: string): string {
  const p = path.normalize('NFC').replace(/\/+$/, '')
  return p === '' ? '/' : p
}

const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)

export interface FakeOpenListServer {
  /** 传给 `AlistClient({ fetchFn })`。 */
  fetch: typeof fetch
  /** `{ '/dir/a.mp3': size }` → 落进内存表（父目录一并登记）。 */
  seed: (files: Record<string, number>) => void
  /** 观测用：`listCalls` = 收到多少次 `fs/list`，`snapshotTakes` = 其中有多少次真去取了新快照。 */
  readonly stats: { listCalls: number; snapshotTakes: number }
}

export function makeFakeOpenListServer(): FakeOpenListServer {
  /** 全路径（NFC）→ 字节数。 */
  const files = new Map<string, number>()
  /** 显式建过的目录（`mkdir` / seed 时登记祖先），用来区分"空目录"和"目录不存在"。 */
  const dirs = new Set<string>(['/'])
  /** 目录 → 上一次取的快照（`listingIsLive: false`：不 refresh 就一直给这份）。 */
  const snapshots = new Map<string, Entry[]>()
  /** 刚搬走、但源目录还会看见几次的那些份。 */
  const ghosts: Array<{ dir: string; name: string; size: number; left: number }> = []
  const stats = { listCalls: 0, snapshotTakes: 0 }

  const registerAncestors = (path: string): void => {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) dirs.add(`/${parts.slice(0, i).join('/')}`)
  }

  const dirExists = (dir: string): boolean =>
    dirs.has(dir) || [...files.keys()].some((k) => k.startsWith(dir === '/' ? '/' : `${dir}/`))

  const liveEntriesOf = (dir: string): Entry[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`
    const out: Entry[] = []
    const seenDirs = new Set<string>()
    for (const [path, size] of files) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) out.push({ name: rest, size, is_dir: false })
      else seenDirs.add(rest.slice(0, slash))
    }
    for (const d of dirs) {
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (rest !== '' && !rest.includes('/')) seenDirs.add(rest)
    }
    for (const d of seenDirs) out.push({ name: d, size: 0, is_dir: true })
    return out
  }

  /** 取一份新快照：现状 + 还没散掉的 ghost（取一次消耗一次）。 */
  const takeSnapshot = (dir: string): Entry[] => {
    stats.snapshotTakes++
    const out = liveEntriesOf(dir)
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i]!
      if (g.dir !== dir) continue
      if (!out.some((e) => e.name === g.name)) out.push({ name: g.name, size: g.size, is_dir: false })
      g.left--
      if (g.left <= 0) ghosts.splice(i, 1)
    }
    snapshots.set(dir, out)
    return out
  }

  const handlers: Record<string, (body: Record<string, unknown>) => Response> = {
    '/api/fs/list': (body) => {
      stats.listCalls++
      const dir = normDir(String(body.path ?? '/'))
      const cached = snapshots.get(dir)
      let all: Entry[]
      if (body.refresh !== true && cached) {
        all = cached // 缓存档：给上一次那份，哪怕盘上早就变了
      } else {
        if (!dirExists(dir)) return notFound()
        all = takeSnapshot(dir)
      }
      const page = Number(body.page ?? 1)
      const per = Number(body.per_page ?? 200)
      const slice = per > 0 ? all.slice((page - 1) * per, page * per) : all
      // 真实服务端空目录给 null，不给 []。
      return ok({ content: slice.length === 0 ? null : slice, total: all.length })
    },
    '/api/fs/mkdir': (body) => {
      const dir = normDir(String(body.path ?? ''))
      // 只有**新建**的目录才当场被缓存成"空"——不 refresh 地列它，看到的就是这份。
      // 对已经存在（且有东西）的目录幂等 mkdir 绝不能置空，那会凭空造出一份不存在的空列表。
      if (!dirExists(dir)) snapshots.set(dir, [])
      dirs.add(dir)
      registerAncestors(dir)
      return ok(null) // 幂等：已存在也答 200（真实 OpenList 亦然）
    },
    '/api/fs/move': (body) => {
      const src = normDir(String(body.src_dir ?? ''))
      const dst = normDir(String(body.dst_dir ?? ''))
      const names = (body.names as string[] | undefined) ?? []
      if (!dirExists(src) || !dirExists(dst)) return notFound()
      const picked: Array<[string, number]> = []
      for (const raw of names) {
        const name = raw.normalize('NFC')
        const size = files.get(join(src, name))
        if (size === undefined) return notFound()
        picked.push([name, size])
      }
      for (const [name, size] of picked) {
        files.delete(join(src, name))
        files.set(join(dst, name), size)
        // 异步落地：源目录还会看见它几次（客户端的 waitMoved 就是为这个存在的）
        ghosts.push({ dir: src, name, size, left: MOVE_GHOST_LISTINGS })
      }
      return ok(null)
    },
    '/api/fs/remove': (body) => {
      const dir = normDir(String(body.dir ?? ''))
      const names = (body.names as string[] | undefined) ?? []
      if (!dirExists(dir)) return notFound()
      // 活体实测（2026-09-03，夸克挂载）：删一个**不存在的名字**照样答 code 200 success。
      // 这里照抄那份沉默——假服务端比真的严格，等于让契约相信一件真实网盘不做的事。
      for (const raw of names) files.delete(join(dir, raw.normalize('NFC')))
      return ok(null)
    },
  }

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const handler = handlers[url.pathname]
    if (!handler) return new Response('not implemented', { status: 404 })
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    return handler(body)
  }) as typeof fetch

  return {
    fetch: fetchFn,
    stats,
    seed: (input) => {
      for (const [rawPath, size] of Object.entries(input)) {
        const path = rawPath.normalize('NFC')
        files.set(path, size)
        registerAncestors(path)
      }
    },
  }
}
