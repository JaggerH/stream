/**
 * **合并身份表**：宿主静态表（`./system/index.ts`）+ 包声明的 Provider 行
 * （`package.json#stream.providers`，spec 2026-09-18-facility-knowledge-stage2-design §2.2）。
 *
 * 为什么另开一个模块而不是往 `system/index.ts` 里塞：那张表是**字面量 import 的静态表**，
 * 它成立的前提就是"编译期确定"。包行是运行期才知道的，混进去会让那条性质悄悄失效。
 *
 * **这张表是快照，不是 thunk。** 与 `serving` / `retires` 相反：那两样每次现查是对的（换一次
 * 表只影响下一次查询），而身份表的下游是 `ensureSystemRows`——它按表**建 DB 行**、并把
 * "system=1 且不在表里"的行**删掉**。表在运行中变一次，就等于一次静默的建行/删行。所以只在
 * 装配期（sources 域，provider 域之前）挂一次；包装卸后新行要到**下一次启动**才出现，卸载后
 * 的清退也走那条既有路径（`seed.ts` 的清退分支）。
 */
import type { SystemIdentity } from './system/types.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import type { DeclaredProviderRow } from '../replay/recipe-package.ts'
import type { ProviderMemberRef } from '../store/types.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'

let packageIdentities: ReadonlyMap<string, SystemIdentity> = new Map()
let callsiteDefaults: ReadonlyMap<string, string[]> = new Map()

/** 一条被拒的包行（调用方必须把它说出去——静默丢一条行 = 用户装了包却没有那个能力）。 */
export interface RejectedProviderRow { id: string; facility: string; reason: string }

/**
 * 声明行里的**裸名**成员补成全名（`<包名>/<局部名>`）。
 *
 * 为什么必须补：包作者写的是自己包里的局部名（他不该被迫重复一遍自己的 npm 包名），
 * 而 `Registry.get` 对裸名有一套四级解析——第三方装一个同名源就能把这条成员指到别人家去。
 * 补成全名之后这条成员**指死**，同时 `pruneDeadMembers` 也才判得出它是不是被代码删了
 * （它的判据第一条就是"成员 id 是个全名"）。
 *
 * 不碰三种：已经带 `/` 的（已是全名）、`rsshub:` 目录路由（不归任何包）、
 * `{mode:'auto'}` 这类现取的扩展式（它没有可指的目标）。包没有 npm 名时也不碰——
 * 拼不出全名就别拼一个假的。
 */
function qualifyMembers(members: ProviderMemberRef[], packageName?: string): ProviderMemberRef[] {
  if (!packageName) return members
  return members.map((m) => {
    const source = (m as { source?: unknown }).source
    if (typeof source !== 'string') return m
    if (source.includes('/') || source.startsWith('rsshub:')) return m
    return { ...m, source: `${packageName}/${source}` }
  })
}

/** 声明 → 身份（`default*` 三个前缀在这儿盖上；缺省值与 `SystemIdentity` 的语义对齐）。 */
function toIdentity(row: DeclaredProviderRow): SystemIdentity {
  const d = row.declaration
  return {
    id: d.id,
    category: d.category,
    serveKeys: [...d.serveKeys],
    fallback: d.fallback ?? false,
    strategy: d.strategy,
    ...(d.expand ? { expand: d.expand } : {}),
    ...(d.provides ? { provides: [...d.provides] } : {}),
    contract: d.contract ?? null,
    defaultLabel: d.label,
    defaultDescription: d.description,
    defaultMembers: qualifyMembers(d.members, row.packageName),
    ...(row.packageName ? { declaredBy: row.packageName } : {}),
  }
}

/**
 * 装配期挂上包声明的行。**撞名硬拒、不覆盖**（同 normalizer / adapter 撞名的规则），三条判据：
 * `id` 撞任何现有行；`serveKeys` 里任一个键已被**同 category** 的某行 serve；`fallback: true`
 * 而该 category 已经有兜底行。判重的基准是"此刻已接受的表"，所以两个包声明同一个键时先到先得，
 * 后到的被拒且说清撞了谁。返回被拒清单，调用方负责出声。
 *
 * **兜底那一条不是洁癖**：`ProviderDirectory.match` 在没有具名命中时返回该 category 的**全部**
 * 兜底行（`directory.ts`），所以混进来的第二条兜底不会报错、也不会顶掉谁——它只是从此和宿主
 * 那条一起被调用，把一个 category 的兜底从"一条"悄悄变成"两条"。身份表这一层是唯一拦得住的地方。
 */
export function setPackageIdentities(rows: DeclaredProviderRow[]): RejectedProviderRow[] {
  const accepted = new Map<string, SystemIdentity>()
  const callsites = new Map<string, string[]>()
  const rejected: RejectedProviderRow[] = []
  const has = (id: string) => SYSTEM_IDENTITIES.has(id) || accepted.has(id)
  const existing = () => [...SYSTEM_IDENTITIES.values(), ...accepted.values()]
  const keyOwner = (category: string, key: string): string | undefined =>
    existing().find((i) => i.category === category && i.serveKeys.includes(key))?.id
  const fallbackOwner = (category: string): string | undefined =>
    existing().find((i) => i.category === category && i.fallback)?.id
  // 「包能往哪些调用点填默认行」只有一个真相源：调用点表里 mode='dispatch' 的那些。写死一份
  // 名单的话，加一个 dispatch 调用点就会静默地把包挡在外面——而挡住的表现是那个能力不在。
  const dispatchCallsites = new Set(PROVIDER_CALLSITES.filter((c) => c.mode === 'dispatch').map((c) => c.id))

  for (const row of rows) {
    const d = row.declaration
    if (has(d.id)) {
      rejected.push({ id: d.id, facility: row.facility, reason: 'id 已被现有 Provider 行占用' })
      continue
    }
    const clash = d.serveKeys.map((k) => [k, keyOwner(d.category, k)] as const).find(([, owner]) => owner)
    if (clash) {
      rejected.push({ id: d.id, facility: row.facility, reason: `serveKey "${clash[0]}" 已被同 category 的 ${clash[1]} 服务` })
      continue
    }
    const fallbackHolder = d.fallback ? fallbackOwner(d.category) : undefined
    if (fallbackHolder) {
      rejected.push({ id: d.id, facility: row.facility, reason: `category "${d.category}" 的兜底行已经是 ${fallbackHolder}，一个 category 只能有一条` })
      continue
    }
    const badCallsite = (d.callsites ?? []).find((id) => !dispatchCallsites.has(id))
    if (badCallsite) {
      rejected.push({ id: d.id, facility: row.facility, reason: `callsite "${badCallsite}" 不是 dispatch 调用点，包出的行只能填 dispatch 调用点的默认行` })
      continue
    }
    accepted.set(d.id, toIdentity(row))
    for (const callsiteId of d.callsites ?? []) {
      callsites.set(callsiteId, [...(callsites.get(callsiteId) ?? []), d.id])
    }
  }
  packageIdentities = accepted
  callsiteDefaults = callsites
  return rejected
}

/** 一条身份（宿主优先——包行永远进不到已占用的 id）。 */
export function identityOf(id: string): SystemIdentity | undefined {
  return SYSTEM_IDENTITIES.get(id) ?? packageIdentities.get(id)
}

/** 合并表。顺序 = 宿主声明序在前、包行在后（只影响 `ensureSystemRows` 的建行次序）。
 *
 *  **优先级与 `identityOf` 同向：宿主赢。** 今天撞 id 的包行进不来，所以这条取舍不可观测；
 *  写死它是因为两处若反向，将来任何一条让包行进表的放宽都会变成"同一个 id 两个答案"。 */
export function allIdentities(): ReadonlyMap<string, SystemIdentity> {
  if (packageIdentities.size === 0) return SYSTEM_IDENTITIES
  const merged = new Map(SYSTEM_IDENTITIES)
  for (const [id, identity] of packageIdentities) if (!merged.has(id)) merged.set(id, identity)
  return merged
}

/** 调用点 id → 声明了它的包行 id（声明序）。`src/providers/callsites.ts` 用它并默认行。 */
export function packageCallsiteDefaults(): ReadonlyMap<string, string[]> {
  return callsiteDefaults
}
