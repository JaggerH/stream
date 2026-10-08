import { OpenListClient, isObjectNotFound, type OpenListFile, type OpenListStorage } from './openlist-client.ts'
import { OPENLIST_TRAITS, type FileShelf } from './shelf.ts'

export { isObjectNotFound }
/** Stream 侧沿用的名字；本体是 `./openlist-client.ts` 的类型。 */
export type AlistFile = OpenListFile
export type AlistStorage = OpenListStorage

export interface AlistClientOptions {
  /** 字面地址，或**thunk**——host 档下 origin 是容器醒着时才存在的（standby Cell 缓存），构造期
   *  快照必得空串；给 thunk 就每次请求现解析（compose 档恒定，无行为差）。thunk 答 undefined 视作 ''。 */
  baseUrl: string | (() => string | undefined)
  token: string
  refresh?: () => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** 发请求用的 fetch。缺省是全局 fetch；测试注入假服务端、宿主给上传换一条长超时连接时用。 */
  fetchFn?: typeof fetch
  /**
   * 包在每次请求外面的那层唤醒。**生产路径必须给**（宿主：`src/netdisk/alist-client.ts` 的
   * `hostAlistClient` 用 `withAwake('alist', …)`；包：adapter 用 `ctx.withAwake`）——standby 管着的
   * 容器闲置会停，裸 fetch 打过去是 ECONNREFUSED。**唤醒放这儿而不是包进 `fetchFn`**：`baseUrl`
   * 的 thunk 是在这一层里面求值的，包进 `fetchFn` 的话地址在唤醒之前就拼好了，容器睡着时是空串。
   */
  around?: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * AList / OpenList 的文件货架客户端：核心逻辑（翻页、401 重登、直链缓存、move 落地等待……）全在
 * `./openlist-client.ts`，这里只多两样——`FileShelf` 的自述表，与 `baseUrl` 可缺席的 thunk 形状。
 *
 * 住 `shared/` 是因为**宿主和 alist 包各吃一份同一源码**：包被 tsdown 打成自包含的 `dist/index.js`，
 * 这个类会被 inline 进包的 bundle。所以它对宿主零假设：**不 import 宿主的 `pluginTarget` /
 * `withAwake` 单例**（那两份被复制进 bundle 后是第二张永远为空的表）——地址与唤醒都由调用方
 * 经 `baseUrl` thunk / `fetchFn` 注入。宿主侧的接线（plugin target、standby 唤醒、网关路径改写）
 * 在 `src/netdisk/alist-client.ts`。
 *
 * 认证仍是：设置页生成的永久 token 裸放 Authorization 头（无 Bearer 前缀）。
 */
export class AlistClient extends OpenListClient implements FileShelf {
  readonly id = 'openlist'
  /** 这个货架的自述表（spec 2026-09-03 §3.1）：规划器只读它，不认"我是 AList"。 */
  readonly traits = OPENLIST_TRAITS

  constructor(opts: AlistClientOptions, ttlMs = 30 * 60 * 1000) {
    const base = opts.baseUrl
    super({
      baseUrl: typeof base === 'function' ? () => base() ?? '' : base,
      token: opts.token,
      ...(opts.refresh ? { refresh: opts.refresh } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.around ? { around: opts.around } : {}),
      ttlMs,
    })
  }
}
