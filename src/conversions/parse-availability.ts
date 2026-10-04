/** parse 梯子里 MinerU 那个成员的 source 名（`packages/builtin/manifests.yaml` 的 `ocr-mineru`）。 */
export const OCR_MINERU_SOURCE = 'ocr-mineru'

/**
 * 「这台机器认不认得出图上的字」= parse 梯子上有没有一个**可能干活**的成员。
 * `ocr-mineru` 只有 mineru 包在场（可选包，`stream add @streamapp/mineru`）才算数；其余成员
 * （视觉模型）是用户自己加的，加了就算。UI 据此决定按钮显不显示（docs/API.md：别用
 * 「POST 一次看是不是 503」去试探）。extract 的 ocr 分支和 frames 的逐帧 OCR 共用这一份判据——
 * 分家的表现是「一个按钮亮着、另一个恒 503」。
 *
 * 成员判定用 `typeof m.source === 'string'`，搬家前是 `'source' in m`——`ProviderMemberRef`
 * 的 `source` 变体本就把它类型成 `string`，所以这条改写目前是空操作；这么写是为了让非字符串
 * 的 `source`（万一出现）永远不算数，而不是意外算进来。
 */
export function parseLadderLit(members: ReadonlyArray<Record<string, unknown>>, opts: { mineruInstalled: boolean }): boolean {
  return members.some((m) => typeof m.source === 'string' && (!isMineru(m.source) || opts.mineruInstalled))
}

/** 系统行的默认成员写的是带命名空间的 `@streamapp/builtin/ocr-mineru`（`src/providers/system/parse.ts`），
 *  存量库里还留着短名 `ocr-mineru`——两种写法都是同一个成员。只认短名的后果：命名空间那份被当成
 *  「用户自己加的成员」，梯子在 mineru 缺席时照亮，按钮亮着、一按就 503。 */
const isMineru = (s: string) => s === OCR_MINERU_SOURCE || s === `@streamapp/builtin/${OCR_MINERU_SOURCE}`
