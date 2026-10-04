import type { AlistStorage } from './alist-client.ts'
import type { SourceType } from '../video/types.ts'

/**
 * AList driver 名 → 资源搜索的 SourceType。
 *
 * 只列搜索侧真的能吐出来的类型（SourceType 全集里的网盘只有 quark/baidu/aliyun）。
 * 115 / UC / Local / Onedrive 等驱动能挂，但搜索源不会返回这些类型的链接，映射不到
 * 就忽略——不是遗漏。
 *
 * driver 字符串以 AList `/api/admin/storage/list` 的原样值为准。
 */
const DRIVER_TO_SOURCE_TYPE: Record<string, SourceType> = {
  Quark: 'quark',
  BaiduNetdisk: 'baidu',
  AliyundriveOpen: 'aliyun',
  AliyundriveShare: 'aliyun',
}

/**
 * 这台机器上「能用」的下载类型：magnet/ed2k 无条件（不依赖 AList）+ AList 上实际
 * 挂着且搜索侧有对应类型的网盘。
 *
 * 真相源是实际 storages 而非 MOUNT_PRESETS：presets 是挂载助手的清单，用户绕过
 * Stream 直接在 AList 里手挂的盘也该被认。
 */
export function searchableSourceTypes(storages: AlistStorage[]): SourceType[] {
  const out: SourceType[] = ['magnet', 'ed2k']
  for (const s of storages) {
    if (s.disabled) continue
    const t = DRIVER_TO_SOURCE_TYPE[s.driver]
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}
