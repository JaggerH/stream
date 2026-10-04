import type { ExpandSpec, ProviderCategory, ProviderMemberRef } from '../../store/types.ts'

/**
 * 一条**系统 Provider 的身份**——住在代码里，不再住在数据库行上。
 *
 * 身份 = 这行「是什么」：归哪个 category、认哪些 serves 键、用什么策略、有没有合同/组合子。
 * 编排 = 这行「怎么配」：members / options，那些留在 `providers` 表上归用户改。
 * 两者的分界就是这个接口的边界（`default*` 三个字段是例外，见下）。
 *
 * **`'*'` 在这里被拆成两个字段**：`serveKeys` 只装具名键，兜底与否是 `fallback` 布尔。
 * 于是「谁在兜底」是一个能被搜索、能被测试钉住的事实，而不是藏在一个字符串里的约定
 * （旧形状 `serves: ['*']` 在 DB 与线上响应里原样保留，由 `ProviderDirectory.wireServes()`
 *  反向合成——见 `src/providers/directory.ts`）。
 *
 * **`default*` 三个字段是建行初值，不是身份**：`ensureSystemRows` 建一条缺失的系统行时拿它们
 * 填 label/description/members，之后用户在 Provider 页面怎么改都算数，代码不再覆盖。它们放在
 * 这里只是因为「初值」也是代码知识，没有第二个更好的家。
 */
export interface SystemIdentity {
  id: string
  category: ProviderCategory
  /** 具名 serves 键（**不含**兜底）。同 category 内跨行不得重复（`index.real.test.ts` 钉着）。 */
  serveKeys: string[]
  /** 本 category 的兜底行（旧形状里 serves 含 `'*'`）。每 category 至多一条。 */
  fallback: boolean
  strategy: 'sequential' | 'concurrent' | 'expand'
  /** 仅 strategy:'expand' 用。 */
  expand?: ExpandSpec
  /**
   * 这条行申报的能力标签（同源 manifest 的 `provides`）：别的行的 `{mode:'auto', provides}` 段展开时
   * 把它当一个组合成员（`{provider: id}`）收进去。于是聚合行（资源搜索）不必点名任何站的组合体——
   * 站的包出这条行、申报标签，聚合行自己就收得到。
   */
  provides?: string[]
  /** 结果合同（命名策略引用）；null / 缺席 = 接受任何结果。 */
  contract?: Record<string, unknown> | null
  /** 建行初值 —— 用户可改，改完代码不覆盖。 */
  defaultLabel: string
  /** 建行初值 —— 同上。 */
  defaultDescription: string
  /** 建行初值 —— 同上。
   *
   *  具名成员的 `source` 写**全名**（`<npm 包名>/<局部名>`），不写裸名。裸名照样解析得到
   *  （`Registry.get` 的第 3 级），但**宿主自己的代码不吃它**：第三方装一个同名包就能把这一行
   *  推进歧义分支，而这一行是要落进用户 Provider 行的。`{provider:…}` / `{mode:'auto'}` 成员
   *  不涉及 sourceId，`rsshub:…` 是 catalog id、不属于任何包命名空间，两者都照旧。
   *  这条由 `index.real.test.ts` 的「every named default member points at a real source」钉着。 */
  defaultMembers: ProviderMemberRef[]
  /**
   * 出这条身份的包 npm 名。宿主静态表里的行**没有它**（它们归代码）。
   *
   * 它承的是一件事：`ensureSystemRows` 的清退分支要分得清「代码删了这条行」和「这一轮这个包
   * 没装上」。后者是暂时的（包 `package.json` 读不动、manifest 撞 id 被摘），而清退是永久的
   * ——行删掉、频道槽位摘掉，指着它的绑定从此静默不出结果。与 `pruneDeadMembers` 的判据同源。
   */
  declaredBy?: string
}

/**
 * 「服务一切」的兜底键。**新代码里全仓只此一处**——外面一律用 `fallback` 布尔说话。
 *
 * 它还没消失是因为线上形状不能变：DB 的 `serves` 列、`/api/providers` 的响应、前端渲染都
 * 照旧吃 `['*']`。`identityServes()` 是那个形状与内部布尔之间的唯一翻译点。
 */
export const WILDCARD = '*'

/**
 * 身份 → 落库/线上形状的 `serves`（兜底键追加在末尾）。
 *
 * 三个消费方同吃这一份：读侧的 `ProviderDirectory.wireServes`、写侧的 `putProvider` 收窄、
 * 建行的 `ensureSystemRows`。分成三份写的话，「行里存的」和「读出来的」会静默分家。
 */
export function identityServes(identity: Pick<SystemIdentity, 'serveKeys' | 'fallback'>): string[] {
  return identity.fallback ? [...identity.serveKeys, WILDCARD] : [...identity.serveKeys]
}
