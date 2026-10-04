// src/safe-segment.ts — 「这一段能不能当路径分量用」的唯一判据。
//
// 判据是**黑名单**：非空、不是纯点（`.`/`..`/`...`）、不含路径分隔符。不是字符集白名单——
// 白名单看着更严，实际上把一整类合法名字判死：真实 artifacts 目录里 90 个 artifact（69 个不
// 重复名）过不了 ASCII 白名单，其中 54 个是**名字带空格**（`R-multiple distribution`、
// `XOM price vs relativeEP and TSY floors log`），16 个带中文（`top_window_C_物理需求中国房地产`）。
// 仅有的那个 distribution artifact 就在带空格那一档里，于是白名单一上，那个 view 对现有数据
// 一次都跑不到。安全需要的是「跳不出目录」，那由分隔符和纯点决定，与字符是空格还是哪个语种无关。
//
// `basename(seg) === seg` 是兜底：分隔符判断随平台走，basename 是平台自己的答案。
import { basename } from 'node:path'

export function isSafeSegment(seg: string): boolean {
  return !!seg && !/^\.+$/.test(seg) && !seg.includes('/') && !seg.includes('\\') && basename(seg) === seg
}
