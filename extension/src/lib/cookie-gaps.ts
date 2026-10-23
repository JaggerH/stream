/**
 * 最近一轮后端来取登录态（`cookiePull`）时，这个 profile 没给的域（browser-identity 冒烟后续）。
 *
 * 两种缺口，都按 profile 记、新 profile 里都可能缺，表现都和「没登录」一模一样：
 * - `refused`：不在这个 profile 的同步范围里（范围 = `config.domains` ∪ 缓存的 `requiredDomains`，存在本 profile
 *   的 `chrome.storage.local`）；
 * - `noAccess`：在范围里，但这个 profile 没给扩展这个站点的权限（用户在 chrome://extensions 里把站点访问收成
 *   「点击时 / 指定站点」，Chrome 按 profile 记）。`chrome.cookies.getAll` 此时静默回空。
 *
 * 记在 `cookieGaps`（按绑定），后端同时在面板的节点行上说出来；弹窗读它给一个「允许」：站点权限只能由扩展在
 * 用户手势里 `permissions.request`，所以修法只能在这里点。
 */
import { getConfig, mergeDomains, setConfig, LOCAL_BINDING } from './config.ts'

export const GAPS_KEY = 'cookieGaps'

export interface Gap {
  refused: string[]
  noAccess: string[]
  at: number
}

export type Gaps = Record<string, Gap>

/** 一个域对应的站点权限。`*.d` 同时匹配 `d` 本身与它的子域。 */
export const originOf = (domain: string): string => `*://*.${domain}/*`

/** 这个 profile 给没给扩展读这个域的权限。老 Chrome / 测试里没有 permissions API = 当作给了。 */
export async function hasSiteAccess(domain: string): Promise<boolean> {
  if (!chrome.permissions?.contains) return true
  try {
    return await chrome.permissions.contains({ origins: [originOf(domain)] })
  } catch {
    return true
  }
}

export async function readGaps(): Promise<Gaps> {
  const v = (await chrome.storage.local.get(GAPS_KEY))[GAPS_KEY]
  return v && typeof v === 'object' ? (v as Gaps) : {}
}

/** 记下这条绑定最近一轮的缺口；两样都没缺就删掉那一条。 */
export async function noteGaps(bindingId: string, refused: string[], noAccess: string[], now = Date.now()): Promise<void> {
  const all = await readGaps()
  if (!refused.length && !noAccess.length) {
    if (!(bindingId in all)) return
    delete all[bindingId]
  } else {
    all[bindingId] = { refused, noAccess, at: now }
  }
  await chrome.storage.local.set({ [GAPS_KEY]: all })
}

export interface FixPlan {
  /** 并进本机同步域（`config.domains`）的。 */
  addDomains: string[]
  /** 要请求的站点权限。 */
  origins: string[]
  /** 给人看的：一共补哪些域。空 = 弹窗不画。 */
  domains: string[]
}

/**
 * 弹窗一键修什么：本机绑定拒掉的并进同步域；所有绑定缺的站点权限去要。配对绑定拒掉的不在这里——远处的
 * Stream 要什么不自动给，那是 Streams 页签里逐个批准的事。
 */
export function fixPlan(gaps: Gaps): FixPlan {
  const addDomains = mergeDomains(gaps[LOCAL_BINDING]?.refused ?? [])
  const noAccess = mergeDomains(Object.values(gaps).flatMap((g) => g.noAccess))
  return { addDomains, origins: noAccess.map(originOf), domains: mergeDomains(addDomains, noAccess) }
}

/**
 * 点「允许」。**`permissions.request` 必须是第一个调用**：它只认用户手势，中间隔一个 `await` 手势就没了。
 * 用户拒了权限就什么都不改。成功后清掉记录——下一轮取数会按实情重写。
 */
export async function applyFix(plan: FixPlan): Promise<boolean> {
  const asked = plan.origins.length ? chrome.permissions.request({ origins: plan.origins }) : Promise.resolve(true)
  if (!(await asked)) return false
  if (plan.addDomains.length) {
    const cfg = await getConfig()
    await setConfig({ domains: mergeDomains(cfg.domains, plan.addDomains) })
  }
  await chrome.storage.local.remove(GAPS_KEY)
  return true
}
