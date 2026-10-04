/**
 * 扩展握手时自报字段（版本 / 浏览器 / 平台）的解析与清洗。
 *
 * 住在共享库而不是 `src/browser/capability-store.ts`：中继在 WS upgrade 的那一刻就要解析它，
 * 而中继必须能被独立进程（未来的 DSH 插件）import——把它留在 capability-store 里，中继就得
 * 背上那个文件的 fs 读写与 harvest-browser 类型。这里是叶子：零 import。
 *
 * `cleanField` / `MAX_FIELD_LEN` 原本是 capability-store 的模块私有件，随这一家一起搬过来并
 * 导出——capability-store 自己还有第二处用到 cleanField（解析 lastSeenAt），它从这里 import
 * 回去，保持单一定义。
 */

/**
 * 扩展握手时**自报**的三个字段（后端永远猜不到扩展自己的版本号）。
 * **老版本扩展一个都不带，这是正常情况不是异常**：缺失 → 该字段保持原样，绝不清空、不报错、
 * 更不能因此判成"扩展有问题"。
 */
export interface ExtHandshake {
  extVersion?: string
  browser?: string
  platform?: string
}

/** 自报字段的长度上限：这些值原样进日志和 UI，扩展侧写飞了不该把缓存文件撑爆。 */
export const MAX_FIELD_LEN = 64

/** 非字符串 / 空白 / 超长 一律按"没给"处理，返回 undefined（调用方据此保持原值不动）。 */
export function cleanField(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  return s.slice(0, MAX_FIELD_LEN)
}

/** 把任意来源（URL query / JSON）的自报字段收成干净的 ExtHandshake。缺就是缺，不造值。 */
export function sanitizeHandshake(raw: unknown): ExtHandshake {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: ExtHandshake = {}
  const extVersion = cleanField(src.extVersion)
  const browser = cleanField(src.browser)
  const platform = cleanField(src.platform)
  if (extVersion) out.extVersion = extVersion
  if (browser) out.browser = browser
  if (platform) out.platform = platform
  return out
}

/**
 * 从扩展 WS 升级请求的 URL 里取自报字段：`/api/ext?extVersion=…&browser=…&platform=…`。
 *
 * 为什么走 query 而不是握手后的第一条消息：写入点必须**只有一处**（`ExtRelay.connect()`），
 * query 在 connect 那一刻就已经在手上了。token 仍然走 subprotocol（那个是 secret，不能进 URL 和
 * 访问日志）；这三个字段不是 secret。老版本扩展不带 query → 返回空对象，一切照常。
 */
export function parseExtHandshake(url: string | undefined): ExtHandshake {
  if (!url) return {}
  let params: URLSearchParams
  try {
    params = new URL(url, 'http://localhost').searchParams
  } catch {
    return {}
  }
  return sanitizeHandshake({
    extVersion: params.get('extVersion') ?? undefined,
    browser: params.get('browser') ?? undefined,
    platform: params.get('platform') ?? undefined,
  })
}
