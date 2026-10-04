/**
 * 「这个 facility 的登录态没了 → 去把它登回来」——宿主提供的机制，包只需要开口要。
 *
 * ### 为什么这一格归宿主
 *
 * 包知道的是"我这次拿到了 302，会话没了"；**哪条 recipe 能把它登回来、用哪个浏览器跑、账号
 * 密码从哪一格取、跑完什么时候才算生效**，一件都不是包的知识。反过来，宿主也不该去猜"这个
 * 动作重跑一次安不安全"——那是包的知识（见下面第 3 条）。所以接缝切在这里：
 * 宿主给一个 `login(facility)`，包自己决定在哪一步调它、之后重做哪一段。
 *
 * ### 三件必须做对的事
 *
 * 1. **按 `meta.login` 找，不按"这个 facility 恰好只有一条动作 recipe"猜。** 判据要有名字：
 *    猜法在包多一条动作 recipe 的那天会静默改指向，去登另一个账号，而没有一处会报错。
 *    命中多条 → 抛，不挑一个。
 * 2. **跑完必须去浏览器**取一份新 cookie，然后才让缓存重读。这一步有两层，缺哪层都不行，
 *    而且两次都真栽过（2026-09-03 同一天）：
 *
 *    - 只重读本地快照 = **自己读自己**。登录 recipe 跑完的那一刻，新 cookie 还在浏览器里；
 *      本地那份要等扩展推过来才更新。实测时间线：任务 03:44:17 开始，cookie 文件 03:45:01
 *      才落盘——中间那次重读拿到的是登录**之前**那一份，于是"登录成功了但还是 302"。
 *      所以先 `pull`（后端主动去浏览器要），不是等它自己来。
 *    - 只 pull 不 `refresh` 也不行：`CookieProvider` 另有 60 秒 TTL 缓存，盘上新了、
 *      内存里还是旧的。实测同样表现成"登录成功了但还是没登录，一分钟后自己好"。
 *
 *    两层都是正确性，不是优化。
 * 3. **登录失败要抛，不能静默返回。** 调用方拿到"登录好了"就会去重做那件事，而那件事可能
 *    是下一笔单。分不清"登上了"和"没登上"的返回值，比抛错危险得多。
 */
import type { CanonicalBrowserRecipe, Recipe } from '../replay/recipe.ts'
import { isCanonicalBrowserRecipe } from '../replay/recipe.ts'
import type { RecipeRunOutcome } from '../replay/recipe-runner.ts'

export interface FacilityLoginDeps {
  /** 现取，别在装配期拿快照——装/卸包会改这张表（见 AGENTS.md「装配期取的值 = 冻住的答案」）。 */
  recipes: () => ReadonlyMap<string, Recipe>
  /** 采集在用的那个执行器。凭据注入的五道闸、限速、冷却、lane 租约都长在它身上。 */
  run: (recipe: CanonicalBrowserRecipe, params: Record<string, string>) => Promise<RecipeRunOutcome>
  /**
   * **去浏览器取一份新 cookie，再让内存缓存重读**（两层，见头注第 2 条）。
   *
   * 名字是 `adopt` 不是 `refresh`：后者听起来像"取新的"，而这条线上真正的坑恰恰是
   * "以为取了新的、其实只重读了一份还没变的本地快照"。名字得说实话。
   */
  adoptCookies: () => Promise<void>
}

/** 找这个 facility 的登录 recipe。0 条或多条都是**说得清的错**，不返回 undefined 让调用方去猜。 */
export function findLoginRecipe(
  recipes: ReadonlyMap<string, Recipe>,
  facility: string,
): [string, CanonicalBrowserRecipe] {
  // 先按 meta.login 挑，再按 facility 收窄。`session` 只长在 browser 档上（DesktopRecipe 没有），
  // 所以判 facility 之前必须先过 `isCanonicalBrowserRecipe` —— 装载期已经钉了
  // 「login 蕴含 action + 必须有 session.facility」，这里是类型上的同一件事。
  const hits: Array<[string, CanonicalBrowserRecipe]> = []
  for (const [id, r] of recipes) {
    if (r.meta?.login !== true) continue
    if (!isCanonicalBrowserRecipe(r)) {
      throw new Error(
        `登录 recipe "${id}" 不是 browser 档——登录要在真浏览器里做（认验证码、让站点的安全控件自己算密码）`,
      )
    }
    if (r.session?.facility === facility) hits.push([id, r])
  }
  if (hits.length === 0) {
    throw new Error(
      `facility "${facility}" 没有登录 recipe（没有哪条 recipe 同时声明了 meta.login:true 和 ` +
        `session.facility:"${facility}"）——登录态掉了只能人工去站上重登`,
    )
  }
  if (hits.length > 1) {
    throw new Error(
      `facility "${facility}" 有 ${hits.length} 条登录 recipe：${hits.map(([id]) => id).join('、')}。` +
        `一个 facility 只能有一条——挑错了就是去登了别的账号，所以这里拒绝猜`,
    )
  }
  return hits[0]!
}

/**
 * 把这个 facility 登回来。成功即返回；任何一档失败都抛。
 *
 * 参数袋是**空的**：账号密码由执行器从 recipe 自己的 `runtime_config.ref` 那一格取并注入
 * （`SessionRecipeExecutor.withSecrets`），不经这里、也不经调用方——凭据不进参数袋是那条链路
 * 的既有立场，这里只是不去破坏它。
 */
export async function loginToFacility(deps: FacilityLoginDeps, facility: string): Promise<void> {
  const [id, recipe] = findLoginRecipe(deps.recipes(), facility)
  const outcome = await deps.run(recipe, {})
  if (outcome.outcome !== 'ok') {
    throw new Error(
      `登录 recipe "${id}" 没跑成（${outcome.outcome}${outcome.reason ? `：${outcome.reason}` : ''}）` +
        `——失败现场看 data/failures/ 与 debug bus 的 recipe 频道`,
    )
  }
  // 见头注第 2 条：不去浏览器取，紧接着的重试还在吃登录**之前**那份快照。
  await deps.adoptCookies()
}
