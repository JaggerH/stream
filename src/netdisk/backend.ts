import { QUARK_PLAY_HEADERS } from '../../shared/netdisk/quark/play.ts'

/** 网盘文件路径 → 它所属的网盘（Provider dispatch 键的前缀，如 `quark-play`）。
 *
 *  **仅此一处**做 mount→网盘 的映射：NetdiskService、Provider 行、调用点都不含网盘字样。
 *  加百度 = 加一行。 */
export function netdiskBackendOf(path: string): string | null {
  if (path.startsWith('/quark/')) return 'quark'
  return null
}

/** 取某网盘的转码档直链要带什么：静态头 + 从哪个域取 cookie。
 *
 *  转码档直链是**受保护**的：夸克缺 referer/cookie 直接 412。三个地方要用同一份——播放代理、
 *  分片代理、抽音轨提取——所以放一处，别各写各的。 */
export const NETDISK_PLAY_SERVING: Record<string, { cookieDomain: string; headers: Record<string, string> }> = {
  quark: { cookieDomain: 'quark.cn', headers: QUARK_PLAY_HEADERS },
}
