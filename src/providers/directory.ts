import type { ProviderCategory, ProviderRecord } from '../store/types.ts'
import type { UserStore } from '../store/user-store.ts'
import { isParked } from './parked.ts'
import type { SystemIdentity } from './system/types.ts'
import { WILDCARD, identityServes } from './system/types.ts'

/** `match()` 的返回单元：命中的行 + **它是不是靠兜底命中的**。
 *
 *  为什么是包装层而不是往 `ProviderRecord` 上加字段：`providerView` 是 `{...record, …}` 摊到
 *  线上的，加字段 = 响应形状变。 */
export interface ProviderMatch {
  row: ProviderRecord
  viaFallback: boolean
}

/** 一条行的 serves 身份（`'*'` 已拆成布尔）。 */
interface ResolvedIdentity {
  serveKeys: string[]
  fallback: boolean
}

/**
 * Provider 的**读模型唯一入口** —— 把「谁服务这个键」这件事从四处散装实现收敛成一处。
 *
 * 它合并两类来源：
 * - **代码侧**：系统身份表（`src/providers/system/`）——系统行「是什么」由代码说了算；
 * - **数据侧**：`providers` 表——用户自建行的身份仍在行上（它们没有代码），所有行的编排
 *   （members/options）都在行上。
 *
 * 三条设计定稿（spec §3.1，P1-a spike 定）：
 * 1. `match()` 的 `opts.fallback` **无默认值、必须显式传**——静默兜底从签名上不可能。
 * 2. 两档**互斥**：有具名命中就绝不混返兜底行。
 * 3. 顺序 = `listProviders()` 的 `ORDER BY id`，本类**不重排**。
 *
 * `catalog()`/`get()` 返回的系统行是**合并行**：身份字段（category/serves/strategy/contract/
 * expand）取代码，编排字段（members/options/label/description/system）取行上。今天代码身份
 * 逐字等于 seed 等于库里那一行，所以合并结果与原行逐字节相同——`/api/providers` 响应 diff
 * 为空是这条的硬验收。要 raw 行（sharing 的拍板流程）就照旧读 user-store。
 */
export class ProviderDirectory {
  constructor(
    private readonly store: Pick<UserStore, 'listProviders' | 'getProvider'>,
    private readonly systemIdentities: ReadonlyMap<string, SystemIdentity>,
  ) {}

  /** 全集（含 parked / 未激活）——UI 与 sharing 的拍板流程要看得见趴着的行。 */
  catalog(): ProviderRecord[] {
    return this.store.listProviders().map((row) => this.merged(row))
  }

  /** 挂载集（排除 parked）——所有分发/匹配都从这里选行。 */
  active(): ProviderRecord[] {
    return this.catalog().filter((row) => !isParked(row))
  }

  /** 单行（含 parked）。未知 id → null。 */
  get(id: string): ProviderRecord | null {
    const row = this.store.getProvider(id)
    return row ? this.merged(row) : null
  }

  /** 身份申报了能力标签 `tag` 的挂载行（`{mode:'auto', provides}` 段收组合成员用）。只有代码/包给的
   *  身份能申报——用户自建行没有这一格。 */
  providing(tag: string): ProviderRecord[] {
    return this.active().filter((row) => this.systemIdentities.get(row.id)?.provides?.includes(tag))
  }

  /** 这个 id 的身份是不是代码给的（= 系统行）。 */
  isSystem(id: string): boolean {
    return this.systemIdentities.has(id)
  }

  /** 具名 serves 键（**不含**兜底）——导入冲突计算靠它「serves 可枚举」。
   *
   *  传 id 时：行不在库里但 id 是系统 id，仍返回代码身份的键（身份不依赖行存在）。 */
  serveKeysOf(idOrRow: string | ProviderRecord): string[] {
    if (typeof idOrRow !== 'string') return this.identityOf(idOrRow).serveKeys
    const row = this.get(idOrRow)
    if (row) return this.identityOf(row).serveKeys
    return this.systemIdentities.get(idOrRow)?.serveKeys.slice() ?? []
  }

  /** 单行谓词：这一行是不是兜底行（`'*'`）——导入冲突计算靠它认出「两条兜底行在同 category 里
   *  互相竞争」，而那种竞争在 `serveKeysOf` 里是看不见的（具名键集合两边都空）。 */
  isFallback(row: ProviderRecord): boolean {
    return this.identityOf(row).fallback
  }

  /** 单行谓词：这一行服务 `key` 吗。`opts.fallback` 决定兜底行算不算数（无默认值）。 */
  servesKey(row: ProviderRecord, key: string, opts: { fallback: boolean }): boolean {
    const identity = this.identityOf(row)
    if (identity.serveKeys.includes(key)) return true
    return opts.fallback && identity.fallback
  }

  /**
   * 按 (category, key) 选行。**两档互斥**：
   * - 有具名命中 → 返回具名全集，`viaFallback:false`；
   * - 没有具名命中且 `opts.fallback` → 返回该 category 的全部兜底行，`viaFallback:true`；
   * - 没有具名命中且 `opts.fallback:false` → `[]`（netdisk 三个守门要的就是这个）。
   */
  match(category: ProviderCategory, key: string, opts: { fallback: boolean }): ProviderMatch[] {
    const rows = this.active().filter((row) => row.category === category)
    const specific = rows.filter((row) => this.identityOf(row).serveKeys.includes(key))
    if (specific.length) return specific.map((row) => ({ row, viaFallback: false }))
    if (!opts.fallback) return []
    return rows.filter((row) => this.identityOf(row).fallback).map((row) => ({ row, viaFallback: true }))
  }

  /** 反向合成线上/落库形状的 `serves`：兜底键追加在末尾。
   *
   *  存量已核过没有「具名 + `'*'` 混排」的行，所以对今天的每一条行，合成结果与库里逐字相同。 */
  wireServes(row: ProviderRecord): string[] {
    return identityServes(this.identityOf(row))
  }

  /**
   * 身份合并：系统行的「是什么」取代码，「怎么配」取行上。用户自建行原样返回（它们没有代码）。
   *
   * 合并的是 category/serves/strategy/contract/expand 五样；members/options/label/description/
   * system 一律取行上——那些是用户改得动的编排与文案，代码只在建行时给过初值。
   *
   * `expand` 只在身份声明了才写进去，与 `rowToProvider` 的做法一致（缺席就是没有这个键，
   * 不是一个值为 undefined 的键）：多一个键就够让 `toStrictEqual` 与响应 diff 变红。
   */
  private merged(row: ProviderRecord): ProviderRecord {
    const system = this.systemIdentities.get(row.id)
    if (!system) return row
    return {
      ...row,
      category: system.category,
      serves: this.wireServes(row),
      strategy: system.strategy,
      contract: system.contract ?? null,
      ...(system.expand ? { expand: system.expand } : {}),
    }
  }

  /**
   * 一条行的 serves 身份从哪来：**系统行取代码（代码赢），用户自建行从行上的 `serves` 反推**。
   *
   * 兼容映射刻意只住在这里，不进 `rowToProvider`——`user-store` 的 serves 读写一行不改，
   * `'*'` 在库里原样存取（`seed.test.ts` 与前端 fixture 都以那个形状为证据）。
   */
  private identityOf(row: ProviderRecord): ResolvedIdentity {
    const system = this.systemIdentities.get(row.id)
    if (system) return { serveKeys: system.serveKeys, fallback: system.fallback }
    const serves = row.serves ?? []
    return { serveKeys: serves.filter((s) => s !== WILDCARD), fallback: serves.includes(WILDCARD) }
  }
}
