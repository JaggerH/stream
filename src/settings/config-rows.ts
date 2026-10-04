// src/settings/config-rows.ts
//
// 配置 row 引擎 —— 「一切可配置的东西 = 一个带 schemastery schema 的 row」。
// 设计见 docs/superpowers/specs/2026-08-17-config-rows-slice1-design.md（引擎与首批三族）、
// slice2（legacy 按键垫底）、slice3（row family），终局形态见 docs/PACKAGE.md §0。
//
// 概念切割（slice1 §2）：row 只管**配置值**（用户存的意图）；活体探测（候选清单、健康三态）
// 和维护动作留在各家自己的端点。row 上可挂两个钩子：`validate`（schema 之外的现场校验，
// 如 exe 路径必须存在）、`apply`（写入后热应用，如内存引用回读）。
//
// 两种注册面：
// - **静态 row**（`register`）：id 固定、schema 在代码里，存 settings.json 的 `rows[id]`。
// - **row family**（`registerFamily`）：id = `<prefix>:<rest>`，schema 与存储由 family 的
//   resolve 现场解出——给「schema 来自数据、id 无界」的场合（源 runtime_config：manifest
//   随 recipe 安装/重载而变，perInstance 实例 ref 由用户起名）。resolve 认不出 → 对外 404，
//   这本身就是写入护栏（任意 ref 写入 = 一个源能改掉别的源的 key）。
//
// 分层（读时合并）：
//   schema 默认值 ← deployDefaults(config.yaml 部署层) ← 用户层(存量按键覆盖 legacy 投影)
// 合并语义沿用 withRuntimeDefaults 的既有判据：只给**缺失**字段补默认；空串 = 用户主动清空，
// 保留不回落（schemastery 的 default 恰好只填 undefined）。
//
// 密文语义（四处手写收成这一处）：`.role('secret')` 的字段 GET 永不回显（只回 configured
// 布尔）；PUT 空串 = 保留存量。
import type Schema from 'schemastery'
import type { StreamSettings } from '../settings-store.ts'

/** 引擎对存储的全部要求——SettingsStore 实现它（rows 键落 settings.json 用户层）。 */
export interface ConfigRowStore {
  get(): StreamSettings
  rowValues(id: string): Record<string, unknown> | undefined
  setRowValues(id: string, values: Record<string, unknown>): void
  clearRowValues(id: string): void
}

export interface ConfigRowSpec {
  /** row id，同时是 `/api/config/:rowId` 的路径段。 */
  id: string
  /** 扁平 object schema（只支持一层 dict；密文字段 `.role('secret')`）。 */
  schema: Schema
  /** config.yaml 部署层的默认值（注册方闭包住自己的 config，引擎不认识 AppConfig）。 */
  deployDefaults?: () => Record<string, unknown>
  /** 旧键的读时投影（`videoSources`/`llm.prompt`/…）；按键垫在 rows[id] 之下。 */
  legacy?: (settings: StreamSettings) => Record<string, unknown> | undefined
  /** schema 之外的现场校验；抛错 → HTTP 400。收到的是写完之后的生效视图（归一化后）。 */
  validate?: (values: Record<string, unknown>) => void | Promise<void>
  /** 写入成功后的热应用；抛错 → 回滚存储并向上抛（HTTP 400）。 */
  apply?: (values: Record<string, unknown>) => void | Promise<void>
}

/** family 现场解出的一行：schema + 自带存储绑定（不落 `rows` 键）。 */
export interface ConfigFamilyRow {
  schema: Schema
  /** 用户层（可含 family 自己的旧键投影，如 SettingsStore.runtimeConfig 的 tmdb 投影）。 */
  user(): Record<string, unknown> | undefined
  /** 裸存量（persist 合并的基底；与 user 分开是为了不把投影值复制成第二份真相）。 */
  raw(): Record<string, unknown> | undefined
  /** 整条替换这一行的存量。 */
  write(record: Record<string, unknown>): void
  clear(): void
  validate?: (values: Record<string, unknown>) => void | Promise<void>
  apply?: (values: Record<string, unknown>) => void | Promise<void>
}

export interface ConfigRowFamilySpec {
  /** row id 前缀：`<prefix>:<rest>`。 */
  prefix: string
  /** 由 rest 解出这一行；认不出 → undefined（对外 404）。每次调用现解——数据源热重载天然跟上。 */
  resolve: (rest: string) => ConfigFamilyRow | undefined
}

/** GET /api/config/:rowId 的响应形状。 */
export interface ConfigRowStatus {
  /** `schema.toJSON()` 的序列化（refs 形式）；客户端 `new Schema(json)` 复原。 */
  schema: unknown
  /** 分层合并后的值，密文字段剔除。 */
  values: Record<string, unknown>
  secrets: Record<string, { configured: boolean }>
}

/** 引擎内部把静态 row 与 family row 归一成这一个形状。 */
interface RowBinding {
  schema: Schema
  deployDefaults?: () => Record<string, unknown>
  user(): Record<string, unknown> | undefined
  raw(): Record<string, unknown> | undefined
  write(record: Record<string, unknown>): void
  clear(): void
  validate?: (values: Record<string, unknown>) => void | Promise<void>
  apply?: (values: Record<string, unknown>) => void | Promise<void>
}

function assertFlatObject(id: string, schema: Schema): void {
  if (schema.type !== 'object' || !schema.dict) {
    throw new Error(`[config-rows] row ${id}: only flat object schemas are supported`)
  }
}

export class ConfigRowRegistry {
  private readonly specs = new Map<string, ConfigRowSpec>()
  private readonly families = new Map<string, ConfigRowFamilySpec>()

  constructor(private readonly store: ConfigRowStore) {}

  /** 注册一个静态 row。返回注销器（域插件包在 ctx.effect 里，随域卸载）。重复 id 硬拒——
   *  两个域抢同一个 rowId 是接线错误，静默覆盖会让先注册那家的 schema 悄悄消失。 */
  register(spec: ConfigRowSpec): () => void {
    if (this.specs.has(spec.id)) throw new Error(`[config-rows] duplicate row id: ${spec.id}`)
    assertFlatObject(spec.id, spec.schema)
    this.specs.set(spec.id, spec)
    return () => { this.specs.delete(spec.id) }
  }

  /** 注册一个 row family（slice3）。前缀撞车同样硬拒。 */
  registerFamily(family: ConfigRowFamilySpec): () => void {
    if (this.families.has(family.prefix)) {
      throw new Error(`[config-rows] duplicate family prefix: ${family.prefix}`)
    }
    this.families.set(family.prefix, family)
    return () => { this.families.delete(family.prefix) }
  }

  has(id: string): boolean {
    return this.binding(id) !== undefined
  }

  /** 静态 row 的 id 清单（family 是无界空间，不可枚举，不在内）。 */
  ids(): string[] {
    return [...this.specs.keys()]
  }

  // ── 归一 lookup ─────────────────────────────────────────────────────────────

  private binding(id: string): RowBinding | undefined {
    const spec = this.specs.get(id)
    if (spec) {
      return {
        schema: spec.schema,
        deployDefaults: spec.deployDefaults,
        validate: spec.validate,
        apply: spec.apply,
        user: () => {
          const row = this.store.rowValues(id)
          const legacy = spec.legacy?.(this.store.get())
          if (!row && !legacy) return undefined
          const picked: Record<string, unknown> = {}
          for (const key of Object.keys(spec.schema.dict ?? {})) {
            const v = row?.[key] !== undefined ? row[key] : legacy?.[key]
            if (v !== undefined) picked[key] = v
          }
          return picked
        },
        raw: () => this.store.rowValues(id),
        write: (record) => this.store.setRowValues(id, record),
        clear: () => this.store.clearRowValues(id),
      }
    }
    const sep = id.indexOf(':')
    if (sep <= 0) return undefined
    const family = this.families.get(id.slice(0, sep))
    const row = family?.resolve(id.slice(sep + 1))
    if (!row) return undefined
    assertFlatObject(id, row.schema)
    return row
  }

  private must(id: string): RowBinding {
    const b = this.binding(id)
    if (!b) throw new Error(`[config-rows] unknown row: ${id}`)
    return b
  }

  private static dictKeys(b: RowBinding): string[] {
    return Object.keys(b.schema.dict ?? {})
  }

  private static secretKeys(b: RowBinding): string[] {
    return Object.entries(b.schema.dict ?? {})
      .filter(([, field]) => field.meta.role === 'secret')
      .map(([key]) => key)
  }

  /** 用户层的值：legacy 投影**按键垫底**、存量按键覆盖（不是整块替换——AList 的 bootstrap
   *  接管只往 rows 写 token，用户的 url 可能还躺在旧键上，整块替换会把它挡掉）。
   *  **只含 schema 声明的键**（legacy 块里可能躺着退役字段——不让它们穿透）。
   *  「主动清空」仍成立：存量里的 `''` 按键盖掉 legacy 值。undefined = 用户从没写过。 */
  userValues(id: string): Record<string, unknown> | undefined {
    const b = this.must(id)
    const user = b.user()
    if (!user) return undefined
    const picked: Record<string, unknown> = {}
    for (const key of ConfigRowRegistry.dictKeys(b)) {
      if (user[key] !== undefined) picked[key] = user[key]
    }
    return picked
  }

  /** 分层合并的读口：schema 默认 ← deployDefaults ← 用户层。空串保留（不回落默认）。 */
  resolve(id: string): Record<string, unknown> {
    const b = this.must(id)
    const merged: Record<string, unknown> = { ...(b.deployDefaults?.() ?? {}) }
    const user = this.userValues(id)
    if (user) {
      for (const key of ConfigRowRegistry.dictKeys(b)) {
        if (user[key] !== undefined) merged[key] = user[key]
      }
    }
    // schemastery 只给 undefined 补默认，''/既有值原样过——正是 withRuntimeDefaults 的判据。
    return b.schema(merged) as Record<string, unknown>
  }

  /**
   * 这一行认识的字段名 = schema 声明的键。**这是 PUT 面严格输入闸的合法键来源**
   * （`src/http/config-rows-routes.ts`）：名单从 schema 现取而不是手抄一份，
   * 所以加字段永远不会漏——两边同一个真相源，漂移不可能发生。
   */
  keys(id: string): string[] {
    return ConfigRowRegistry.dictKeys(this.must(id))
  }

  /** GET 面：schema + 密文剔除的值 + configured 布尔。 */
  status(id: string): ConfigRowStatus {
    const b = this.must(id)
    const resolved = this.resolve(id)
    const secrets = ConfigRowRegistry.secretKeys(b)
    const values: Record<string, unknown> = {}
    for (const key of ConfigRowRegistry.dictKeys(b)) {
      if (!secrets.includes(key) && resolved[key] !== undefined) values[key] = resolved[key]
    }
    return {
      schema: b.schema.toJSON(),
      values,
      secrets: Object.fromEntries(secrets.map((key) => [key, { configured: Boolean(resolved[key]) }])),
    }
  }

  /**
   * PUT 面。语义：
   * - 只认 schema 声明的键；值为 undefined 的键当没发（部分更新合法）。
   * - 与既有存量**按键合并**（漏发的字段不丢）；legacy 值不复制进存量——
   *   它一直在 userValues 里按键垫底，复制只会造第二份真相。
   * - 密文空串 = 保留存量（存量含 legacy 垫底的那层）；非密文空串 = 主动清空
   *   （存 ''，按键盖掉 legacy，读侧不回落默认）。
   * - schema 校验 → validate 钩子 → 落盘 → apply 钩子；apply 抛错回滚落盘再上抛。
   */
  async put(id: string, incoming: Record<string, unknown>): Promise<void> {
    const b = this.must(id)
    const prevUser = this.userValues(id) ?? {}
    const prevRaw = b.raw()
    const next: Record<string, unknown> = {}
    for (const key of ConfigRowRegistry.dictKeys(b)) {
      if (prevRaw?.[key] !== undefined) next[key] = prevRaw[key]
    }
    for (const key of ConfigRowRegistry.dictKeys(b)) {
      if (Object.hasOwn(incoming, key) && incoming[key] !== undefined) next[key] = incoming[key]
    }
    for (const key of ConfigRowRegistry.secretKeys(b)) {
      if (next[key] === '') {
        const prev = prevUser[key]
        if (prev !== undefined && prev !== '') next[key] = prev
        else delete next[key]
      }
    }
    // 校验对象是**写完之后的生效视图**（legacy 垫底 + 本次写入），不是裸的增量——
    // validate 钩子（如 harvest-browser 的 exe 存在性）要看的是"这次写完 exe 是什么"，
    // 哪怕这次 PUT 根本没带 exe。类型错在 schema 归一化这一步抛。
    // **落盘只存用户发过/存过的键**——把 schema 默认值或 legacy 值也写进存量等于
    // 把"今天的默认/垫底"冻成"用户的选择"，来源一变就追不上。
    const validated = b.schema({ ...prevUser, ...next }) as Record<string, unknown>
    await b.validate?.(validated)
    const persisted: Record<string, unknown> = {}
    for (const key of Object.keys(next)) persisted[key] = validated[key]
    b.write(persisted)
    if (b.apply) {
      try {
        await b.apply(this.resolve(id))
      } catch (e) {
        if (prevRaw) b.write(prevRaw)
        else b.clear()
        throw e
      }
    }
  }
}
