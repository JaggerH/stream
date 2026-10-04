/**
 * 「这条 audio media 身上有没有一个**源站原始直链**」——前后端同吃一份，因为两边把它喂给的是
 * 同一个漏斗（`src/audio/track-source.ts` 的 `resolveTrackSource`）的**最后一档**：
 *
 *  - 前端：播放时把它填进 `/api/media/tracks/resolve?…&fallback=<它>`；
 *  - 后端：转写取字节时直接把它当 `fallbackUrl` 传给漏斗。
 *
 * 两份实现一旦漂移，表现是「能播但转不了写」（或反过来）——两边单看都正常，没有任何测试会红。
 *
 * 认两种形状：我们自己的 resolve 路由带着 `?…&fallback=<enclosure>`（已识别的播客），或者
 * 存量数据里裸着的源站直链。其余一律 undefined（一条干净的 resolve 路由、退役老路由、空值）
 * ——没有这个额外的数据，让漏斗按 platform:id 自己去解析。
 */
export function originFallback(storedUrl: string | undefined): string | undefined {
  if (!storedUrl) return undefined
  const qi = storedUrl.indexOf('?')
  if (qi >= 0) {
    const fb = new URLSearchParams(storedUrl.slice(qi + 1)).get('fallback')
    if (fb) return fb
  }
  if (!storedUrl.includes('/resolve') && /^https?:\/\//i.test(storedUrl)) return storedUrl
  return undefined
}
