import type { OpenListStorage as AlistStorage } from './openlist-client.ts'
import { findPreset } from './mount-presets.ts'

/** 一条浏览器 cookie 记录里挂载用得到的那几格（Stream 的 `BrowserCookie` 与浏览器插件的
 *  `BrowserCookieRecord` 都满足它）。这份文件两个宿主同吃，所以不 import 任一方的类型。 */
export interface BrowserCookie {
  name: string
  value: string
  domain: string
}

/**
 * 挂载 reconciler —— 期望态在 Stream 侧（settings 持久化的 mounts 配置），
 * AList 只是执行器。启动时/挂载后对比 storage/list：
 *   缺 → create；被标 disabled（cookie 失效）→ 拉新 cookie update + enable；
 *   不认识的 storage（用户手动在别处建的）一概不动。
 * 幂等：连跑两遍第二遍零变更。
 */

/** 期望态条目（settings.alist.mounts 持久化形态）。 */
export interface MountEntry {
  presetId: string
  /** 缺省用 preset.mountPath。 */
  mountPath?: string
}

/** reconciler 只依赖 client 的 4 个 admin 方法——便于单测注入 mock。 */
export interface StorageAdmin {
  listStorages(): Promise<AlistStorage[]>
  createStorage(s: { mount_path: string; driver: string; addition: string }): Promise<void>
  updateStorage(s: AlistStorage): Promise<void>
  enableStorage(id: number): Promise<void>
}

/** cookie 来源（生产 = 登录态快照的 fetch，单测注入固定表）。 */
export type CookieSource = () => Promise<Record<string, BrowserCookie[]>>

export interface ReconcileResult {
  created: string[]
  healed: string[]
  /** 快照里没有该域的 cookie —— UI 引导「用浏览器登录 xx」。 */
  missingCookie: string[]
  /** 已就绪无需动作。 */
  ok: string[]
}

/** 单个 preset 的实时健康态（GET /api/netdisk/mounts 下发，UI 据此渲染）。 */
export type MountStatus = 'mounted' | 'error' | 'cookieReady' | 'noCookie'

/**
 * 由 AList storage 现状 + cookie 可得性推 preset 健康：
 *   有 storage 且未禁用/状态正常 → mounted；
 *   有 storage 但被禁用或状态异常（cookie 多半失效）→ error；
 *   无 storage 但有 cookie → cookieReady（可自动挂载）；
 *   无 storage 且无 cookie → noCookie（待用扩展同步）。
 */
export function mountStatusOf(storage: AlistStorage | undefined, hasCookie: boolean): MountStatus {
  if (storage) return !storage.disabled && (!storage.status || storage.status === 'work') ? 'mounted' : 'error'
  return hasCookie ? 'cookieReady' : 'noCookie'
}

/**
 * cookie 域匹配：精确域、点前缀/子域变体，以及父域（`.quark.cn` 的 cookie
 * 对 `pan.quark.cn` 生效 —— 快照常按裸父域存键）。
 */
export function cookiesForDomain(
  all: Record<string, BrowserCookie[]>,
  domain: string,
): BrowserCookie[] | undefined {
  const direct = all[domain]
  if (direct?.length) return direct
  for (const [k, v] of Object.entries(all)) {
    if (!v.length) continue
    const nk = k.replace(/^\./, '')
    // 子域/点变体（www.115.com ← 115.com），或父域覆盖（quark.cn → pan.quark.cn）
    if (nk === domain || nk.endsWith(`.${domain}`) || domain.endsWith(`.${nk}`)) return v
  }
  return undefined
}

function serializeCookies(cookies: BrowserCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export async function reconcileMounts(
  desired: MountEntry[],
  admin: StorageAdmin,
  fetchCookies: CookieSource,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: [], healed: [], missingCookie: [], ok: [] }
  if (desired.length === 0) return result // 无期望态就不读快照，省一次取数

  const storages = await admin.listStorages()
  const byPath = new Map(storages.map((s) => [s.mount_path, s]))
  let cookieData: Record<string, BrowserCookie[]> | undefined // 惰性拉取，且只拉一次

  for (const entry of desired) {
    const preset = findPreset(entry.presetId)
    if (!preset) continue // 未知 preset：配置陈旧，跳过不抛——不阻塞其余挂载
    const mountPath = entry.mountPath ?? preset.mountPath
    const existing = byPath.get(mountPath)

    if (existing && !existing.disabled) {
      result.ok.push(mountPath) // 已就绪：幂等第二遍全部走这条路径
      continue
    }

    cookieData ??= await fetchCookies()
    const cookies = cookiesForDomain(cookieData, preset.cookieDomain)
    if (!cookies) {
      result.missingCookie.push(mountPath)
      continue
    }
    const addition = JSON.stringify({ ...preset.additionDefaults, cookie: serializeCookies(cookies) })

    if (!existing) {
      await admin.createStorage({ mount_path: mountPath, driver: preset.driver, addition })
      result.created.push(mountPath)
    } else {
      // disabled = cookie 失效自愈路径：换 addition 后 enable
      await admin.updateStorage({ ...existing, addition })
      await admin.enableStorage(existing.id)
      result.healed.push(mountPath)
    }
  }
  return result
}
