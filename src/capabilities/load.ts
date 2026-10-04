/**
 * 把用户装进来的**可选能力包**从盘上请到场，交给 `createCapabilityHost` 挂上。
 *
 * 内置能力（Stream Desktop）走静态 import，不经这里；到场之后两边走**同一个** `host.mount()`
 * （spec 2026-09-06 §2 不变量 3）。这里只回答「模块怎么到场」这一问：扫
 * `<dataDir>/recipes/`（与插件、recipe 包同一个扫描器 `scanPackages`），挑出填了 `capability`
 * 槽位的包，`pathToFileURL` 之后动态 import 它的 `dist/index.js`。
 *
 * **`pathToFileURL` 不是可省的**：Windows 上 `import('C:\\...')` 直接抛
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`（盘符被当成协议），而桌面端的后端正跑在那儿——症状是
 * 装好的包一个都不上，只有一行日志。
 *
 * **每个包独立 try/catch，只记一行**：一个第三方包起不来不该拖死别的包，也不该拖死后端
 * （spec §3.3 的红线）。**但不许静默**：跳过的每一个都留一行带包名和原因的日志，否则
 * 「装了没生效」与「根本没装」在界面上长得一模一样。
 *
 * **兜错还有时间那一半**：import 与 mount 各套一个超时（`mountTimeoutMs`，默认 30s）。
 * 只兜 throw 不兜 hang 等于没兜——这条路被 `await` 在后端启动路径上，一个永不 settle 的
 * mount 就是"端口上永远没人听"。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { scanPackages, type StreamPackage } from '../packages/scan.ts'
import { USER_LAYER_SCAN } from '../replay/recipe-package.ts'
import type { Capability } from '../../shared/capability/types.ts'
import type { CapabilityHost } from './host.ts'

export interface LoadedCapability {
  pkg: StreamPackage
  /** 能力自己申报的名字（`capability.name`），不一定等于包 id。 */
  name: string
  tools: string[]
}

export interface LoadOptionalCapabilitiesOptions {
  /** 用户层包目录（`<dataDir>/recipes`）。不存在 → 空数组。 */
  recipesDir: string
  host: CapabilityHost
  log: (line: string) => void
  /** `config.yaml` 的 `capabilities:` 那一格，按**能力名**索引。 */
  config?: Record<string, unknown>
  /** 注入点，只为测试：默认 `import(pathToFileURL(...))`。 */
  importModule?: (fileUrl: string) => Promise<unknown>
  /**
   * 单个包「import + mount」的耐心上限（毫秒，默认 30s；`<=0` 关掉）。
   *
   * **没有这道闸的表现是后端永远起不来**：`loadOptionalCapabilities` 被 `await` 在
   * `serve.ts` 的启动路径上，一个包的 `mount()` 里 `await` 了一个永不 settle 的东西
   * （等一个没人应答的容器、等一把用户还没填的钥匙），整个后端就停在那儿——端口上没人听、
   * 日志停在上一行，症状和"启动很慢"一字不差。所以超时**不是可选的优雅**：它是
   * 「一个第三方包不该拖死后端」这条红线在时间维度上的那一半。
   */
  mountTimeoutMs?: number
}

const DEFAULT_MOUNT_TIMEOUT_MS = 30_000

/**
 * 到点就抛，**不取消原来那个 promise**——ESM 的 import 与包自己的 mount 都停不掉。
 * 能保证的只有"装载器不再等它"：这个包被跳过、后端接着起。它自己后来若真跑完了，
 * 注册动作会撞上 host 的撞名/已挂闸，不会静默半挂上。
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms 还没完成`)), ms)
      // 定时器不该把进程钉在事件循环上：这条路只在超时那一刻有意义。
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

function isCapability(v: unknown): v is Capability {
  const c = v as Partial<Capability> | undefined
  return !!c && typeof c.name === 'string' && c.name.length > 0 && typeof c.mount === 'function'
}

export async function loadOptionalCapabilities(opts: LoadOptionalCapabilitiesOptions): Promise<LoadedCapability[]> {
  const importModule = opts.importModule ?? ((url: string) => import(/* @vite-ignore */ url))
  const packages = scanPackages(opts.recipesDir, {
    ...USER_LAYER_SCAN,
    onPackageError: (dir, err) => opts.log(`[stream-capabilities] WARN 包 ${dir} 读不动，跳过：${err.message}`),
  })

  const out: LoadedCapability[] = []
  const timeoutMs = opts.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS
  for (const pkg of packages.filter((p) => p.capability)) {
    const entry = join(pkg.dir, pkg.capability as string)
    try {
      const mod = (await withTimeout(
        importModule(pathToFileURL(entry).href),
        timeoutMs,
        `包 ${pkg.id} 的 import`,
      )) as { capability?: unknown }
      if (!isCapability(mod.capability)) {
        opts.log(`[stream-capabilities] WARN 包 ${pkg.id} 的 ${pkg.capability} 没有导出一个 capability，跳过`)
        continue
      }
      const cap = mod.capability
      const mounted = await withTimeout(
        // 凭证域从**包描述符**带过去，不问模块要（`stream.credentials` 那一格已经过了
        // `credentialsSchema` 与安装确认页；模块级属性是装完才读得到的，见 MountDeclaration）。
        opts.host.mount(cap, opts.config?.[cap.name] ?? {}, { credentials: pkg.credentials }),
        timeoutMs,
        `包 ${pkg.id} 的 mount`,
      )
      out.push({ pkg, name: mounted.name, tools: mounted.tools })
      opts.log(`[stream-capabilities] 装载 ${pkg.id} → 能力 ${mounted.name}（工具 ${mounted.tools.length} 个）`)
    } catch (err) {
      opts.log(`[stream-capabilities] WARN 能力包 ${pkg.id} 装载失败，跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}
