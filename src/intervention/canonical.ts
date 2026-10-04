/**
 * 一个值的**规范 JSON**：对象键排序后序列化，所以「同样的内容、不同的键顺序」得到同一个字串。
 *
 * 两处在用，用途不同但要求同一件事——两个值相等当且仅当字串相等：
 *  - `stuck.ts`：把「工具名 + 参数」压成一个 key，用来认出「同一个动作又来了」。
 *  - `recipe-validation.ts`：把候选 recipe 的断言字段压成快照，用来认出「断言被改了」。
 *
 * 曾经两边各写一份，且已经漂了（`undefined` 的兜底一边写 `'undefined'` 一边写 `'null'`）。
 * 漂移在这里是**静默**的：两份都"能用"，只有跨两处比对同一个值时才会露馅。所以只留这一份。
 *
 * `undefined` 与 `null` 必须是两个不同的字串：在断言快照里，「这个字段不存在」和
 * 「这个字段被显式写成 null」是两件事，合并掉就等于给 agent 开了一道门。
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
