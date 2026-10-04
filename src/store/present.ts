import type { ChannelRecord } from './types.ts'

/** present 字段的唯一合法化入口——三处调用点（app.ts POST/PATCH/校验、import-bundle）共用，
 *  别再各自内联 `raw === 'mixed' ? 'timeline' : raw`。
 *  'mixed'（迁移前的过渡值）→ 'timeline'；旧包只带 `variant` 无 `present` 由调用方传
 *  `ch.present ?? ch.variant` 进来；非法/undefined → undefined（调用方决定兜底值）。 */
export function coercePresent(raw: unknown): ChannelRecord['present'] | undefined {
  const mapped = raw === 'mixed' ? 'timeline' : raw
  if (mapped === 'timeline' || mapped === 'search' || mapped === 'audio' || mapped === 'video' || mapped === 'research' || mapped === 'embed') return mapped
  return undefined
}
