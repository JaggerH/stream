import type { MediaContext } from './types.ts'

/** FNV-1a 32-bit。不是密码学 hash —— 目的只是给同一条音轨一个稳定短标签，
 *  好让样本能分组，同时不把原始路径写进诊断文件。 */
export function hashPath(path: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 把一个播放 URL 压成脱敏上下文：只留 host、pathname 的 hash、是否同源。
 * query 和 fragment **整个丢弃** —— 签名 URL 的密钥就在 query 里，那是隐私红线。
 * 解析失败返回 null（记录器随后原样记 media: null，不抛错、不中断播放）。
 */
export function redactUrl(raw: string, pageOrigin: string): MediaContext | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw, pageOrigin)
  } catch {
    return null
  }
  // blob:/data: 没有有意义的 host，且 data: 的「路径」就是内容本身 —— 只记协议。
  if (u.protocol === 'blob:' || u.protocol === 'data:') {
    return { host: u.protocol, pathHash: hashPath(u.protocol), sameOrigin: true }
  }
  return { host: u.host, pathHash: hashPath(u.pathname), sameOrigin: u.origin === pageOrigin }
}
