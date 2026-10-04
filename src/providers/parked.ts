import type { ProviderRecord } from '../store/types.ts'

/** parked = 搭车导入、尚未激活的 Provider 行（T1：存 options.parked===true，零 schema 迁移）。
 *  parked 行留在库里、UI 可见可弃，但被所有 serves 匹配/枚举点排除——即「趴着」。 */
export function isParked(p: ProviderRecord): boolean {
  return (p.options as { parked?: unknown } | undefined)?.parked === true
}
