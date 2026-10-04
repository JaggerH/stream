/**
 * 夸克分享 API 的两步（token → detail）——验活（`verify.ts`）和转存（`save.ts`）都从这里起手，
 * 一份实现两个消费者，别各写一遍（cookie 头、UA、referer、分页参数任何一处分家都是静默错位）。
 *
 * cookie 鉴权、无签名（`docs/PACKAGE.md §5`、spec §0）：匿名也能验活；转存才需要登录态。
 */
export const QUARK_Q = '?pr=ucpro&fr=pc&uc_param_str='
export const QUARK_DRIVE_H = 'https://drive-h.quark.cn/1/clouddrive'
export const QUARK_DRIVE_PC = 'https://drive-pc.quark.cn/1/clouddrive'
/** quark answers a bare client with its landing page; these two make it answer as the web app does. */
export const QUARK_BASE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://pan.quark.cn/',
}

export type QuarkCall = (url: string, init?: RequestInit) => Promise<{ status: number; body: Record<string, any> }>

/**
 * 造一个带固定头（+ 可选 cookie）的调用器。夸克在 4xx 上照样把判决写在 body 里
 * （403 41031 封禁 / 404 41006 不存在），所以先读 body、把 status 一并交给调用方判——裸看状态码会
 * 把原因藏起来。body 不是 JSON → `code: -1`。
 */
export function makeQuarkCall(send: typeof fetch, cookie?: string): QuarkCall {
  return async (url, init) => {
    const res = await send(url, {
      ...init,
      headers: { ...QUARK_BASE_HEADERS, ...(cookie ? { cookie } : {}), ...(init?.headers ?? {}) },
    })
    const body = (await res.json().catch(() => ({ code: -1, message: `HTTP ${res.status}` }))) as Record<string, any>
    return { status: res.status, body }
  }
}

export interface QuarkShareEntry {
  fid: string
  share_fid_token: string
  file_name: string
  dir?: boolean
  size?: number
}

/** 第一步：share token——第一个知道这条分享还活不活着的端点。 */
export async function quarkShareToken(call: QuarkCall, pwdId: string, passcode = ''): Promise<{ status: number; body: Record<string, any> }> {
  return call(`${QUARK_DRIVE_H}/share/sharepage/token${QUARK_Q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pwd_id: pwdId, passcode, support_visit_limit_private_share: true }),
  })
}

/** 第二步：里面有什么——转存按 (fid, share_fid_token) 对寻址，不是裸 fid。 */
export async function quarkShareDetail(
  call: QuarkCall, pwdId: string, stoken: string, pdirFid = '0', perDir = 50,
): Promise<{ status: number; body: Record<string, any>; list: QuarkShareEntry[] }> {
  const url =
    `${QUARK_DRIVE_H}/share/sharepage/detail${QUARK_Q}&ver=2&pwd_id=${encodeURIComponent(pwdId)}&stoken=${encodeURIComponent(stoken)}` +
    `&pdir_fid=${encodeURIComponent(pdirFid)}&force=0&_page=1&_size=${perDir}&_fetch_total=1&_sort=file_type:asc,file_name:asc`
  const r = await call(url)
  return { ...r, list: (r.body.data?.list ?? []) as QuarkShareEntry[] }
}

/** 夸克网页版建分享只认这四档有效期（`expired_type`）。活体 2026-09-07：1 → `expired_at` 2100-01-01（永久），
 *  2/3/4 → 距今 1/7/30 天。别的天数没有对应值——四舍五入成另一档是替用户改了承诺，直接拒。 */
const SHARE_EXPIRED_TYPE: Record<number, number> = { 0: 1, 1: 2, 7: 3, 30: 4 }
/** 调用方可传的 `expireDays` 全集（0 = 永久）。 */
export const QUARK_SHARE_EXPIRE_DAYS = Object.keys(SHARE_EXPIRED_TYPE).map(Number)
const SHARE_TASK_POLLS = 15
const SHARE_TASK_INTERVAL_MS = 1000

export interface QuarkShareCreateResult {
  ok: boolean
  /** 停在哪一步：share | task；成功为 done */
  stage: string
  message: string
  shareId?: string
  url?: string
  passcode?: string
  /** 链接尾巴（`/s/<pwdId>`），验活那一路按它寻址 */
  pwdId?: string
}

/**
 * 给自己盘里的文件/文件夹建一条分享链接（**写**用户账户：需要登录态的 `call`）。
 *
 * 三步，端点与字段按活体（2026-09-07，pan.quark.cn 页内 fetch 实测）：
 *  1. `POST /1/clouddrive/share` `{fid_list, title, url_type(1 公开 / 2 提取码), expired_type, passcode?}` → `data.task_id`
 *  2. 轮询 `GET /1/clouddrive/task?task_id&retry_index` 到 `status===2`，`data.share_id` 在这里
 *  3. `POST /1/clouddrive/share/password` `{share_id}` → `data.share_url` / `data.passcode`
 * 与转存同一种形状：失败回 `stage` 而不是抛——「夸克拒了」和「任务没在预算内完成」调用方要分得开。
 */
export async function quarkShareCreate(
  call: QuarkCall,
  opts: { fids: string[]; title?: string; passcode?: string; expireDays?: number },
  deps: { sleep?: (ms: number) => Promise<void>; maxPolls?: number } = {},
): Promise<QuarkShareCreateResult> {
  const days = opts.expireDays ?? 0
  const expiredType = SHARE_EXPIRED_TYPE[days]
  if (expiredType === undefined) throw new Error(`expireDays 只能是 ${Object.keys(SHARE_EXPIRED_TYPE).join('/')}（0 = 永久），收到 ${days}`)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const json = { method: 'POST', headers: { 'content-type': 'application/json' } } as const

  const sh = await call(`${QUARK_DRIVE_PC}/share${QUARK_Q}`, {
    ...json,
    body: JSON.stringify({
      fid_list: opts.fids,
      title: opts.title ?? '',
      url_type: opts.passcode ? 2 : 1,
      expired_type: expiredType,
      ...(opts.passcode ? { passcode: opts.passcode } : {}),
    }),
  })
  const taskId = sh.body.data?.task_id
  if (sh.body.code !== 0 || !taskId) return { ok: false, stage: 'share', message: String(sh.body.message || `code ${sh.body.code}`) }

  let shareId: string | undefined
  let title = ''
  const polls = deps.maxPolls ?? SHARE_TASK_POLLS
  for (let i = 0; i < polls; i++) {
    const t = await call(`${QUARK_DRIVE_PC}/task${QUARK_Q}&task_id=${encodeURIComponent(String(taskId))}&retry_index=${i}`)
    const status = t.body.data?.status
    if (status === 2) { shareId = t.body.data?.share_id ? String(t.body.data.share_id) : undefined; title = String(t.body.data?.task_title || ''); break }
    if (status === 3) return { ok: false, stage: 'task', message: String(t.body.data?.task_title || '分享任务失败') }
    if (i < polls - 1) await sleep(SHARE_TASK_INTERVAL_MS)
  }
  if (!shareId) return { ok: false, stage: 'task', message: '分享任务未在预期时间内完成（可能仍在进行）' }

  const pw = await call(`${QUARK_DRIVE_PC}/share/password${QUARK_Q}`, { ...json, body: JSON.stringify({ share_id: shareId }) })
  const url = pw.body.data?.share_url
  if (pw.body.code !== 0 || !url) return { ok: false, stage: 'password', message: String(pw.body.message || `code ${pw.body.code}`), shareId }
  const pwdId = /\/s\/([^/?#]+)/.exec(String(url))?.[1]
  return {
    ok: true, stage: 'done', message: title || '分享完成', shareId, url: String(url),
    ...(pw.body.data?.passcode ? { passcode: String(pw.body.data.passcode) } : {}),
    ...(pwdId ? { pwdId } : {}),
  }
}

/** `expired_type` → 天数：就地反转 `SHARE_EXPIRED_TYPE`，列分享时把夸克的档位翻回调用方那套天数。
 *  反转而不是再抄一份表——抄的那份迟早和上面那份分家，而分家了没有一处会喊。 */
const EXPIRED_TYPE_DAYS: Record<number, number> = Object.fromEntries(
  Object.entries(SHARE_EXPIRED_TYPE).map(([days, type]) => [type, Number(days)]),
)

/** 有效 / 已过期 / 已失效。两种"死"分开报：`expired` 是我们建的时候自己设的期限到了（正常寿终），
 *  `invalid` 是夸克把这条下掉了（`status !== 1`，多半是违规判定）——后者要人去看一眼，前者不用。 */
export type QuarkShareState = 'active' | 'expired' | 'invalid'

/** 「我的分享」里的一行。夸克那行有三十多个字段，这里只留管理这条链接用得上的。 */
export interface QuarkShareRow {
  /** 删除按它寻址（**不是** `pwdId`）。 */
  shareId: string
  /** 链接尾巴（`/s/<pwdId>`）——手里只有一条 URL 时靠它对上是哪一行。 */
  pwdId: string
  url: string
  title: string
  /** 分享内容在盘上的位置（夸克回的 `path_info`；活体见过 `../父目录` 这种相对写法，原样带出）。 */
  pathInfo?: string
  passcode?: string
  /** 0 = 永久，1/7/30 = 天。夸克回了个不认识的 `expired_type` → undefined（它加档了，别猜）。 */
  expireDays?: number
  createdAt: string
  /** 永久分享这里是 undefined：夸克给的是 2100-01-01，原样回等于把「永久」说成一个具体日期。 */
  expiredAt?: string
  state: QuarkShareState
  fileNum: number
  size: number
  /** 夸克的审核态原样带出。活体（2026-09-07，20 条）只见过 4 和 2，判据没查清，
   *  所以**不翻译**成「违规/正常」——猜错的代价是把一条好链接说成废的。 */
  auditStatus: number
}

export interface QuarkSharePage {
  ok: boolean
  message: string
  rows: QuarkShareRow[]
  /** 账号下分享总条数（`metadata._total`）——调用方靠它知道还有没有下一页。 */
  total: number
}

/**
 * 一页「我的分享」（**读**用户账户：需要登录态的 `call`）。
 *
 * 端点按活体（2026-09-07，pan.quark.cn 页内 fetch 实测）：
 * `GET /1/clouddrive/share/mypage/detail?_page&_size&_order_field=created_at&_order_type=desc&_fetch_total=1`
 * → `data.list` + `metadata:{_page,_size,_total}`。**分页是真的**：总数 20 时 `_size=8` 的第 3 页回 4 条、
 * 第 4 页回 0 条——只取第一页当全部会静默漏掉后面所有链接。
 */
export async function quarkShareMyPage(
  call: QuarkCall, opts: { page?: number; size?: number } = {},
): Promise<QuarkSharePage> {
  const page = opts.page ?? 1
  const size = opts.size ?? 50
  const r = await call(
    `${QUARK_DRIVE_PC}/share/mypage/detail${QUARK_Q}&_page=${page}&_size=${size}` +
    `&_order_field=created_at&_order_type=desc&_fetch_total=1`,
  )
  if (r.body.code !== 0) return { ok: false, message: String(r.body.message || `code ${r.body.code}`), rows: [], total: 0 }
  const list = (r.body.data?.list ?? []) as Record<string, any>[]
  return {
    ok: true,
    message: 'ok',
    total: Number(r.body.metadata?._total ?? list.length),
    rows: list.map((e) => {
      const expiredType = Number(e.expired_type)
      const permanent = expiredType === 1
      // status !== 1 = 夸克把这条下掉了。活体只见过 1，所以别的值一律报 invalid 而不是当正常——
      // 把一条已失效的链接说成 active，用户就会一直以为买家能打开。
      const state: QuarkShareState =
        Number(e.status) !== 1 ? 'invalid'
        : !permanent && Number(e.expired_left ?? 0) <= 0 ? 'expired'
        : 'active'
      const days = EXPIRED_TYPE_DAYS[expiredType]
      return {
        shareId: String(e.share_id), pwdId: String(e.pwd_id), url: String(e.share_url ?? ''),
        title: String(e.title ?? ''), state,
        ...(e.path_info ? { pathInfo: String(e.path_info) } : {}),
        ...(e.passcode ? { passcode: String(e.passcode) } : {}),
        ...(days === undefined ? {} : { expireDays: days }),
        createdAt: new Date(Number(e.created_at)).toISOString(),
        ...(permanent || !e.expired_at ? {} : { expiredAt: new Date(Number(e.expired_at)).toISOString() }),
        fileNum: Number(e.all_file_num ?? e.file_num ?? 0),
        size: Number(e.size ?? 0),
        auditStatus: Number(e.audit_status ?? 0),
      }
    }),
  }
}

/**
 * 删掉一条自己建的分享（**写**用户账户）。`POST /1/clouddrive/share/delete` `{share_ids:[...]}`。
 *
 * **语义（活体 2026-09-07 实测，建了一条一次性分享自己删掉验的）**：
 *  - 删的是**链接**，不是文件——删完 `/quark/From Stream/_probe_share_delete` 这个目录仍在盘上（`GET /api/netdisk/fs` 列得到）。
 *    夸克的文件按 `fid` 寻址，这个端点只吃 `share_id`，两套 id 不通。
 *  - **不可逆、没有回收站**：删完 `mypage/detail` 的 `_total` 21 → 20，那条链接的 `sharepage/token`
 *    立刻回 `41012「好友已取消了分享」`。夸克的回收站是文件的，分享没有对应的东西。
 *
 * **一次只删一条**（虽然端点吃数组）：同一次实测里，数组里混一个不存在的 share_id，整个请求回
 * `500 / code 15000 inner error`——批量是全成或全败，且失败时说不出是哪一条。逐条发才能给出逐条结果。
 */
export async function quarkShareDelete(call: QuarkCall, shareId: string): Promise<{ ok: boolean; message: string }> {
  const r = await call(`${QUARK_DRIVE_PC}/share/delete${QUARK_Q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ share_ids: [shareId] }),
  })
  if (r.body.code !== 0) return { ok: false, message: String(r.body.message || `code ${r.body.code}`) }
  return { ok: true, message: String(r.body.message || 'ok') }
}

/** `pdir_fid` = 这个文件在**分享里**的父目录 fid（根 = '0'）。转存时必须原样带回：夸克按
 *  `(pdir_fid, fid, share_fid_token)` 三元组校验，子文件夹里的文件拿根目录提交会回「token校验异常」
 *  （活体 2026-09-03 撞到的）。 */
export interface QuarkTreeFile { fid: string; share_fid_token: string; pdir_fid: string; name: string; size: number; path: string }

/** 列一棵分享树的总预算：最多发多少次 detail、最多收多少个文件。一部剧一季几十集、整剧几百，
 *  超出的多半是资源站的杂烩分享，认集也用不上。 */
export const TREE_MAX_CALLS = 40
export const TREE_MAX_FILES = 2000

/**
 * 分享整棵树的**文件**清单（文件夹展开、只回文件）。`path` 是分享内相对路径（`S03/S03E14.mkv`），
 * 交给匹配引擎当 `SpecRight.name`——与绑定同步时 `listDirRecursive` 给的形状一致，规则表按 basename 认。
 * 深度与每层条数都有上界：分享可以是任意大的树，追更只要认得出缺的那几集。
 */
export async function quarkShareTree(
  call: QuarkCall, pwdId: string, stoken: string, opts: { maxDepth?: number; perDir?: number; maxCalls?: number; maxFiles?: number } = {},
): Promise<QuarkTreeFile[]> {
  const maxDepth = opts.maxDepth ?? 3
  const perDir = opts.perDir ?? 200
  const maxCalls = opts.maxCalls ?? TREE_MAX_CALLS
  const maxFiles = opts.maxFiles ?? TREE_MAX_FILES
  const out: QuarkTreeFile[] = []
  let calls = 0
  const walk = async (pdirFid: string, prefix: string, depth: number): Promise<void> => {
    // 总预算：深度 3 × 每层 200 个目录理论上能打出上万次请求，一条畸形分享就能把一轮挂死、把账号
    // 撞进限流。够到上限就停，已列到的照样返回——追更只要认得出缺的那几集。
    if (calls >= maxCalls || out.length >= maxFiles) return
    calls++
    const { list } = await quarkShareDetail(call, pwdId, stoken, pdirFid, perDir)
    for (const e of list) {
      const name = String(e.file_name ?? '')
      if (e.dir) {
        // 没 fid 的目录项没法往下列（会打出 pdir_fid=undefined 的空跑）
        if (e.fid && depth < maxDepth) await walk(e.fid, `${prefix}${name}/`, depth + 1)
        continue
      }
      if (out.length >= maxFiles) return
      out.push({ fid: e.fid, share_fid_token: e.share_fid_token, pdir_fid: pdirFid, name, size: Number(e.size ?? 0), path: `${prefix}${name}` })
    }
  }
  await walk('0', '', 0)
  return out
}
