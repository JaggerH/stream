/**
 * `params_schema.<k>.format:'path'` 参数的**派生键**：一条路径参数进 runner 之前拆成几个 recipe 能直接
 * 拿来写判据 / 分流的片段。派生在 `materializeParams`（`src/mcp/validate-params.ts`）里做，这里只放
 * "拆法"——装载闸（`recipe-store.ts`）要用同一份名单判 `branch.when.param` 认不认这些键，两处各写一份
 * 后缀名单迟早漂：一边派生了 `_kind`、另一边不认，表现是"按扩展名分流的 branch 装载就被拒"。
 *
 * | 键 | 值 | 给谁用 |
 * |---|---|---|
 * | `{k}_name` | 最后一段（文件名，含扩展名） | 界面上显示的是文件名不是路径 |
 * | `{k}_stem` | 文件名去掉扩展名 | — |
 * | `{k}_stem6` | `_stem` 的前 6 个字 | **对截断鲁棒的判据**：微信把长文件名截成「中基协登记备...2期.pdf」，全名恒不命中，前几个字仍在（活体 2026-09-18） |
 * | `{k}_ext` | 扩展名，小写、不带点（没有就是空串） | 判据的另一半，或 `branch` 分流 |
 * | `{k}_kind` | `image`（png/jpg/jpeg/gif/webp）/ `file` | 图片挂进微信输入框只显示缩略图、没有文件名——文字判据对它恒不成立，recipe 按它分流 |
 *
 * **`_stem6` 的 6 是照活体截断位置定的**（「中基协登记备」正好 6 个字）；主干不足 6 个字时就是整个主干。
 * 主干太短（一两个字）时它作为包含匹配的查询会多命中，判据要另想——那不是这里能替 recipe 决定的。
 */

export const PATH_DERIVED_SUFFIXES: readonly string[] = ['name', 'stem', 'stem6', 'ext', 'kind']

/** 微信/QQ 这类客户端按「图片消息」而不是「文件」处理的扩展名。 */
export const IMAGE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export const STEM_HEAD_CHARS = 6

/** 一个 `format:'path'` 参数的所有派生键（`materializeParams` 翻译完路径之后调）。 */
export function derivePathParams(key: string, value: string): Record<string, string> {
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? value
  const dot = name.lastIndexOf('.')
  // `.bashrc` 这种以点开头的没有扩展名；`a.` 这种尾巴上的点也不算
  const hasExt = dot > 0 && dot < name.length - 1
  const stem = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot + 1).toLowerCase() : ''
  return {
    [`${key}_name`]: name,
    [`${key}_stem`]: stem,
    [`${key}_stem6`]: [...stem].slice(0, STEM_HEAD_CHARS).join(''),
    [`${key}_ext`]: ext,
    [`${key}_kind`]: IMAGE_EXTS.has(ext) ? 'image' : 'file',
  }
}

/** 这个键派生出来的全部键名（装载闸用：`branch.when.param` 允许指向它们）。 */
export function pathDerivedKeys(key: string): string[] {
  return PATH_DERIVED_SUFFIXES.map((s) => `${key}_${s}`)
}
