import {
  QUARK_SHARE_EXPIRE_DAYS, makeQuarkCall, quarkShareCreate, quarkShareDelete, quarkShareMyPage,
  type QuarkCall, type QuarkShareCreateResult, type QuarkShareRow,
} from '../../shared/netdisk/quark/share-api.ts'
import { quarkResolveDirFid, type QuarkBrowseDeps } from '../../shared/netdisk/quark/browse.ts'
import type { AlistClient } from './alist-client.ts'

export interface ShareCreateInput {
  /** OpenList 路径（`/quark/闲鱼数据包/<pack>`），第一段是挂载点 */
  path: string
  /** 4 位提取码；缺省 = 公开分享 */
  passcode?: string
  /** 0 = 永久（默认）；夸克只认 0/1/7/30 */
  expireDays?: number
}

export interface ShareCreateOutput {
  url: string
  passcode?: string
  pwdId?: string
}

export type ShareCreateErrorCode = 'validation_error' | 'unsupported' | 'not_found' | 'unavailable' | 'upstream_error'

/** 带分类码的错误——HTTP 面按 code 翻状态（400/501/404/503/502），不用猜 message。
 *  自建分享的三件事（建 / 列 / 删）共用这一个错误类型：它们错的方式是同一套（参数、登录态、夸克拒了），
 *  各造一个只会让 HTTP 面多抄一份 code → 状态的表。 */
export class ShareCreateError extends Error {
  constructor(readonly code: ShareCreateErrorCode, message: string) {
    super(message)
    this.name = 'ShareCreateError'
  }
}

/** AList driver → 能建分享的网盘。目前只有夸克；加百度 = 加一行 + 一份 shared/netdisk/baidu 实现。 */
const SHARE_DRIVER_BACKEND: Record<string, 'quark'> = { Quark: 'quark' }

export interface ShareCreateDeps {
  alist: Pick<AlistClient, 'listStorages'>
  /** 凭证只经宿主派发的这一口拿（与 quark-save / 追更同一份夸克 cookie）。 */
  cookieFor: (domain: string) => Promise<string | undefined>
  fetchFn?: typeof fetch
  log?: (msg: string) => void
  /** 注入便于测试；默认就是 shared/netdisk/quark 里那两条。 */
  resolveFid?: (segments: string[], deps: QuarkBrowseDeps) => Promise<string | null>
  create?: (call: QuarkCall, opts: { fids: string[]; title?: string; passcode?: string; expireDays?: number }, deps: { sleep?: (ms: number) => Promise<void> }) => Promise<QuarkShareCreateResult>
}

/**
 * OpenList 路径 → 夸克分享链接。**编排层**：只有这里同时看得见 OpenList 的挂载表（路径第一段是哪个
 * driver）和宿主派发的登录态；夸克 API 本身住 `shared/netdisk/quark/`（两个宿主同吃）。
 *
 * 路径 → fid 走 `quarkResolveDirFid`（只读、逐层 file/sort），前提与「跳转夸克」同一条：`/quark` 挂载
 * rooted 在夸克根。目录不存在 → `not_found`（不建目录：建分享的对象是导出脚本已经上传好的那个包）。
 */
export function makeShareCreate(deps: ShareCreateDeps): (input: ShareCreateInput) => Promise<ShareCreateOutput> {
  const resolveFid = deps.resolveFid ?? quarkResolveDirFid
  const create = deps.create ?? quarkShareCreate
  return async (input) => {
    const segments = input.path.split('/').filter(Boolean)
    const mount = `/${segments[0] ?? ''}`
    const inner = segments.slice(1)
    if (!inner.length) throw new ShareCreateError('validation_error', `path 必须指向挂载点下面的目录，收到 ${JSON.stringify(input.path)}`)
    if (input.expireDays !== undefined && !QUARK_SHARE_EXPIRE_DAYS.includes(input.expireDays)) {
      throw new ShareCreateError('validation_error', `expireDays 只能是 ${QUARK_SHARE_EXPIRE_DAYS.join('/')}（0 = 永久），收到 ${input.expireDays}`)
    }

    let driver: string | undefined
    try {
      driver = (await deps.alist.listStorages()).find((s) => s.mount_path === mount)?.driver
    } catch (e) {
      throw new ShareCreateError('upstream_error', `读 OpenList 挂载表失败：${(e as Error).message}`)
    }
    const backend = SHARE_DRIVER_BACKEND[driver ?? '']
    if (!backend) throw new ShareCreateError('unsupported', `挂载点 ${mount} 的 driver=${JSON.stringify(driver)} 不支持建分享（目前只有夸克）`)

    const cookie = await deps.cookieFor('quark.cn')
    if (!cookie) throw new ShareCreateError('unavailable', '没有夸克登录态（quark.cn 不在同步域里，或还没取回过）')

    const fid = await resolveFid(inner, { cookieFor: async () => cookie, fetchFn: deps.fetchFn, log: deps.log })
    if (!fid) throw new ShareCreateError('not_found', `夸克盘上没有这个目录：${inner.join('/')}`)

    const r = await create(makeQuarkCall(deps.fetchFn ?? fetch, cookie), {
      fids: [fid], title: inner[inner.length - 1], passcode: input.passcode, expireDays: input.expireDays,
    }, {})
    if (!r.ok || !r.url) throw new ShareCreateError('upstream_error', `夸克建分享失败（${r.stage}）：${r.message}`)
    return { url: r.url, passcode: r.passcode, pwdId: r.pwdId }
  }
}

// —— 建出去的链接之后归谁管：列 + 删 ——————————————————————————————————
// 与建分享同一层、同一口凭证（`cookieFor('quark.cn')`）。这两件事**不经 OpenList 挂载表**：
// 「我的分享」是账号级的一张表，和路径挂在哪个挂载点无关，硬要过一遍挂载表只会凭空多一个失败点。

/** 列 / 删共用的依赖。比 `ShareCreateDeps` 少一格 alist（见上面那段：这两件事不看挂载表）。 */
export interface ShareManageDeps {
  /** 凭证只经宿主派发的这一口拿（与建分享同源）。 */
  cookieFor: (domain: string) => Promise<string | undefined>
  fetchFn?: typeof fetch
  /** 注入便于测试；默认就是 shared/netdisk/quark/share-api.ts 里那两条。 */
  myPage?: typeof quarkShareMyPage
  remove?: typeof quarkShareDelete
}

export interface ShareListInput {
  /** 1 起。 */
  page?: number
  /** 每页条数，1..100，缺省 50。 */
  size?: number
}
export interface ShareListOutput {
  items: QuarkShareRow[]
  page: number
  size: number
  /** 账号下的分享总数——`page * size < total` 就还有下一页。 */
  total: number
}

export const SHARE_LIST_MAX_SIZE = 100

async function quarkCallFor(deps: ShareManageDeps): Promise<QuarkCall> {
  const cookie = await deps.cookieFor('quark.cn')
  if (!cookie) throw new ShareCreateError('unavailable', '没有夸克登录态（quark.cn 不在同步域里，或还没取回过）')
  return makeQuarkCall(deps.fetchFn ?? fetch, cookie)
}

/**
 * 列当前账号建出去的分享（一页）。**只读**。
 *
 * 为什么要分页而不是替调用方翻完：一个账号的分享是只增不减的（每单一条 7 天链接，一年几百条），
 * 「一次全捞回来」迟早变成几十次上游请求塞进一个 HTTP 响应里。`total` 一并回，调用方自己决定翻几页。
 */
export function makeShareList(deps: ShareManageDeps): (input?: ShareListInput) => Promise<ShareListOutput> {
  const myPage = deps.myPage ?? quarkShareMyPage
  return async (input = {}) => {
    const page = input.page ?? 1
    const size = input.size ?? 50
    if (!Number.isInteger(page) || page < 1) throw new ShareCreateError('validation_error', `page 必须是 ≥1 的整数，收到 ${input.page}`)
    if (!Number.isInteger(size) || size < 1 || size > SHARE_LIST_MAX_SIZE) {
      throw new ShareCreateError('validation_error', `size 必须是 1..${SHARE_LIST_MAX_SIZE} 的整数，收到 ${input.size}`)
    }
    const r = await myPage(await quarkCallFor(deps), { page, size })
    if (!r.ok) throw new ShareCreateError('upstream_error', `夸克列分享失败：${r.message}`)
    return { items: r.rows, page, size, total: r.total }
  }
}

export interface ShareDeleteInput {
  /** `share/list` 每行的 `shareId`（**不是** pwdId / 链接尾巴）。 */
  shareIds: string[]
}
export interface ShareDeleteResult {
  shareId: string
  ok: boolean
  /** 失败时夸克的原话（成功时不带）。 */
  message?: string
}
export interface ShareDeleteOutput {
  results: ShareDeleteResult[]
  deleted: number
  failed: number
}

export const SHARE_DELETE_MAX = 100

/**
 * 删掉自己建的分享，**逐条**发、**逐条**回判。删的是链接不是文件（语义与证据见
 * `quarkShareDelete` 的注释：删完目录仍在盘上，且不可逆、没有回收站）。
 *
 * 为什么不用夸克那个天然的批量：数组里混一条不存在的 id，整个请求回 `500 / code 15000`，
 * 且说不出是哪一条挂了（活体 2026-09-07 实测）。一条坏 id 静默带走整批，正是这里最不能出的事。
 * 代价如实说：N 条 = N 次上游请求，所以上界卡在 `SHARE_DELETE_MAX`。
 *
 * 逐条失败**不抛**（结果在 `results` 里）；抛出来的只有整批都做不成的事：参数不对、没登录态。
 */
export function makeShareDelete(deps: ShareManageDeps): (input: ShareDeleteInput) => Promise<ShareDeleteOutput> {
  const remove = deps.remove ?? quarkShareDelete
  return async (input) => {
    const ids = input.shareIds
    if (!Array.isArray(ids) || !ids.length) throw new ShareCreateError('validation_error', 'shareIds 必须是非空数组')
    if (ids.length > SHARE_DELETE_MAX) throw new ShareCreateError('validation_error', `一次最多删 ${SHARE_DELETE_MAX} 条，收到 ${ids.length}`)
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) throw new ShareCreateError('validation_error', 'shareIds 里有空项')

    const call = await quarkCallFor(deps)
    const results: ShareDeleteResult[] = []
    for (const shareId of ids) {
      try {
        const r = await remove(call, shareId)
        results.push(r.ok ? { shareId, ok: true } : { shareId, ok: false, message: r.message })
      } catch (e) {
        // 网络抖一下不该让后面几条一起陪葬——这一条记下原话，循环照常往下走。
        results.push({ shareId, ok: false, message: (e as Error).message })
      }
    }
    return { results, deleted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }
  }
}
