import Schema from 'schemastery'
import type { RuntimeConfigSpec } from './types.ts'

/**
 * manifest 的 runtime_config 字段声明 → schemastery schema（配置 row 引擎的 family 用，
 * spec config-rows-slice3 §2）。字段语义逐项映射：secret→role、label→description（表单
 * 字段标题）、description→comment（字段下方说明）、helpUrl→link、default 原样。
 *
 * **manifest 的 `required` 故意不映射成 schemastery 的 required**：它在旧面里只是 UI 提示，
 * 从不阻止写入；而 schemastery 的 required 会让 `resolve()` 对"还没配 key 的源"直接抛——
 * ctx.runtimeConfig 的既有契约是返回部分配置、让失败发生在真正用到的那一步。
 */
export function runtimeSpecToSchema(spec: RuntimeConfigSpec): Schema {
  const dict: Record<string, Schema> = {}
  for (const [key, field] of Object.entries(spec.fields)) {
    // 开关与文本走两条链：`.default()` 的入参类型跟着 Schema 的实参型走，合成一个联合之后
    // 它退化成 never，随便给哪种都编不过。分开写比 `as any` 诚实。
    let s: Schema
    if (field.type === 'boolean') {
      let b = Schema.boolean().description(field.label)
      if (typeof field.default === 'boolean') b = b.default(field.default)
      s = b
    } else {
      let t = Schema.string().description(field.label)
      if (field.type === 'secret') t = t.role('secret')
      if (typeof field.default === 'string') t = t.default(field.default)
      s = t
    }
    if (field.description) s = s.comment(field.description)
    if (field.helpUrl) s = s.link(field.helpUrl)
    dict[key] = s
  }
  return Schema.object(dict)
}

/**
 * 把 manifest 声明的 field default 打底到存储的 runtime config 上。
 *
 * 根因：`SettingsStore.runtimeConfig(ref)` 只返回用户存过的字段，manifest 里
 * `default: zh-CN` 这类声明在运行时完全是死的（仅当 UI 占位）。于是用户在 Source
 * Config Sheet 只填了 TMDb apiKey 时，`language` 从没进 overlay → 传给 TMDb 是
 * undefined → en-US → 元数据全英文，尽管 TMDb 有中文数据。
 *
 * 语义：**只有缺失的字段用 default**。已存在的（包括空串——那是用户主动清空、
 * 意即「要英文」）一律尊重存储，default 不覆盖。`{...defaults, ...stored}` 恰好如此：
 * stored 里出现的键（含空串）盖掉 default，缺失的键落到 default。
 */
export function withRuntimeDefaults(
  spec: RuntimeConfigSpec,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.default !== undefined) defaults[key] = field.default
  }
  return { ...defaults, ...stored }
}

/**
 * 「这份配置还缺哪几格」：`required: true` 的字段里，解析值为空（缺席 / `null` / 空串）的那些名字。
 *
 * `resolved` 必须是成员**执行时**拿到的那一份（`ctx.runtimeConfig(manifest)`：存储优先、空着回落
 * 部署环境变量）——拿别的来源判，会出现「判没配、其实能跑」或反过来的静默错位。
 *
 * 没写 `required` 的字段永远不算缺：那一格的「配没配好」仍由调用方自己的判据回答（转写梯子是
 * 「token 在不在」），别让一堆没写 required 的成员一夜之间全变「没配」。
 */
export function missingRequiredRuntimeFields(
  spec: RuntimeConfigSpec | undefined,
  resolved: Record<string, unknown>,
): string[] {
  if (!spec) return []
  return Object.entries(spec.fields)
    .filter(([key, field]) => {
      if (!field.required) return false
      const v = resolved[key]
      return v === undefined || v === null || v === ''
    })
    .map(([key]) => key)
}
