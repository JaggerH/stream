import type { Adapter, AdapterFetchResult } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { AlistClient } from '../../shared/netdisk/alist-client.ts'
import { displayTitle } from './normalizer.ts'

/** compose service 名（本包容器）——`withAwake` 的唤醒键。 */
export const ALIST_SERVICE = 'alist'

/** 宿主经 `ctx` 递进来的两样运行时能力（包不 import 宿主的运行时单例，见 `PluginContext`）：
 *  - `backendUrl`：本包容器此刻的地址（compose 档容器 DNS / host 档醒着的容器的 loopback
 *    origin），**thunk 不是值**——host 档下 origin 只在容器醒着时存在，构造期快照必得空。
 *  - `withAwake`：打容器前先唤醒（standby 管着的容器闲置会停）。 */
export interface AlistAdapterDeps {
  backendUrl: () => string | undefined
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
}

/**
 * token 解析：显式 ctor 参数（宿主传 config.alist_token）→ ALIST_TOKEN env。
 * 对齐 pansou 的三级回退风格（base url 的回退见 `resolveAlistUrl`）。
 */
export function resolveAlistToken(explicit?: string): string | undefined {
  return explicit ?? process.env.ALIST_TOKEN
}

/** server-side fetch base：显式（ctx.config.url）→ ALIST_URL env（调试逃生门，包自己读）→ 宿主此刻给的
 *  容器地址（none 档 → ''）。宿主自己那份同形的解析器在 `src/netdisk/alist-client.ts`。 */
export function resolveAlistUrl(explicit: string | undefined, backendUrl: () => string | undefined): string {
  return explicit ?? process.env.ALIST_URL ?? backendUrl() ?? ''
}

/**
 * AList 插件适配器 —— 一个 adapter 服务整个 alist 插件的两条 source：
 *   - alist-list（fixed_params.mode = 'list'）：列目录/枚举文件；
 *   - alist-resolve（fixed_params.mode = 'resolve'）：文件路径 → 临时直链 raw_url。
 * 复用 shared/netdisk/alist-client.ts（fs/list + fs/get + 30min 直链缓存），不重复 HTTP 逻辑；
 * 地址 thunk 与唤醒都从 deps（`ctx`）注入。
 *
 * why 惰性建 client：token 走 config/env（非 manifest auth），未配置 token 时插件仍要在
 * 插件页/Provider 成员候选里可见（source 已入 registry），但真正 fetch 才需要 token——
 * 所以 client 到首次 fetch 才构造，未配置时不影响可见性，只在被实际调用时 fail loud。
 */
export class AlistAdapter implements Adapter {
  readonly id = 'alist'
  private client?: AlistClient

  constructor(
    private readonly deps: AlistAdapterDeps,
    private readonly baseUrl?: string,
    private readonly token?: string,
    /** 托管模式取 token 的通道（宿主注入接管序列）：401 时重登，没 token 时负责第一次取。外接模式缺省。 */
    private readonly refresh?: () => Promise<string>,
  ) {}

  async init(_env: Record<string, string>): Promise<void> {} // 凭证走 config/env，非 manifest broker

  private ensureClient(): AlistClient {
    if (this.client) return this.client
    const token = resolveAlistToken(this.token)
    // 没 token 也没接管通道 = 外接模式漏填，说清让人去填。有通道（托管模式，启动时容器在睡、
    // 登录没跑成）就带着空 token 建 client，第一次请求之前由它经通道取来。
    if (!token && !this.refresh) throw new Error('[alist] 缺少 token：请配置 config.alist_token 或 ALIST_TOKEN 环境变量')
    this.client = new AlistClient({
      // 每次请求现解析：fetch 都在 withAwake 回调里，求值时容器已醒、地址才有。
      baseUrl: () => resolveAlistUrl(this.baseUrl, this.deps.backendUrl),
      token: token ?? '',
      refresh: this.refresh,
      fetchFn: (input, init) => this.deps.withAwake(ALIST_SERVICE, () => fetch(input, init)),
    })
    return this.client
  }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<unknown[] | AdapterFetchResult> {
    const mode = String(manifest.fixed_params?.mode ?? params.mode ?? 'list')
    const path = String(params.path ?? '/')
    const client = this.ensureClient()
    if (mode === 'resolve') {
      const rawUrl = await client.rawUrl(path)
      return [{ path, raw_url: rawUrl }]
    }
    if (mode === 'audio') {
      const dir = path.replace(/\/$/, '')
      const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|wav|opus)$/i
      const files = await client.listDirRecursive(dir)
      const items = files
        .filter((f) => !f.isDir && AUDIO_EXT.test(f.name))
        .map((f) => {
          const abs = `${dir}/${f.name}`
          const name = f.name.split('/').pop() ?? f.name
          // title 用共享的 displayTitle（剥扩展名/水印/分享者电台名前缀）——前端各处显示的是
          // 顶层 item.title，光在 normalizer 里清洗看不见效果。`name`/`path` 保留真实文件名。
          return { guid: abs, title: displayTitle(name), path: abs, name, size: f.size }
        })
      // 一条 audio 流 = 一个目录，目录名就是电台/专辑名 → 订阅时自动填进流名（backfillLabel）。
      // 只有这一档报：list/resolve 不产订阅流。scheduler 的作者推断兜不住网盘文件（没有 author）。
      return { items, title: dir.split('/').pop() || undefined }
    }
    // 默认 list：枚举目录内文件（AlistFile[]），供绑定向导选目录与增量同步 diff。
    return client.listDir(path)
  }
}
