import { backendUrl } from './backendUrl.ts'

/**
 * 「一个要交给 `<img src>` / `<video poster>` 的图片地址，该怎么变成浏览器真能取到的地址」——
 * **全前端只此一处**。
 *
 * **为什么需要代理**：很多图床（腾讯系 qpic 一类）按 `Referer` 判来源，来源不是自家就不发图。
 * 浏览器直连拿到的是一张**空白图**——不报错、不降级、控制台安静，页面上只是少了一张封面。
 * 后端的 `/api/media/image?url=…` 服务端去取、**不带 Referer**，绕开这道墙。
 *
 * **为什么它必须是幂等的、而不是「谁记得谁加」**：这条判据的消费点有二十多处（封面卡、队列、
 * 迷你播放器、全屏播放台、选集面板、详情页海报…），漏一处的症状就是上面那张空白图——
 * **没有任何一处会喊**。让 `imgUrl` 对「已经是代理地址」原样放行之后，
 * **多包一层不再是错误**，于是「拿不准就包上」永远是安全动作，而漏掉才是唯一的失败模式。
 * 此前不是这样：`MovieChannel` 里三处被当成"绕过了代理"的落点，追到上游其实都已经代理过，
 * 照着补一层就会变成"代理去取自己"。
 *
 * **那为什么不直接用 `<img referrerPolicy="no-referrer">`？浏览器免费提供、字节不过后端。**
 * 这是下一个人会问的第一个问题，答案是**它只覆盖一部分，而漏掉的那部分它原理上救不了**。
 * 拿库里真实的封面地址在真浏览器里逐张量过（同一张图四种取法比对）：
 *
 * - **只看 Referer 的墙**（`i*.hdslb.com`、爱奇艺 `pic*.iqiyipic.com`）：默认策略取不到，
 *   `no-referrer` 取得到。这一档 `no-referrer` **确实够用**，和代理等价。
 * - **要求带自家 Referer 的墙**（豆瓣的图床，空 Referer 回 418）：`no-referrer`
 *   **救不了**——浏览器只能把 Referer 拿掉，**不能伪造成别人**。代理能，而且已经在这么做了
 *   （`src/http/image-fetch.ts` 问 `refererForUrl`，按包的 `serving[].referer` 声明给这台图床送它要的 Referer）。
 *   **这是代理不可替代的第一个理由。**
 * - **混合内容**：库里约 15% 的封面是 `http://`（xhs 图床、部分 hdslb）。页面一旦是 https
 *   （自托管那档带 TLS），浏览器直接拦掉，`referrerPolicy` 是什么都无关。代理把它变成同源
 *   https。**这是不可替代的第二个理由。**
 *
 * 所以判据是：**代理不是「no-referrer 的服务端版」，它多出来的是"改写请求"和"换个源"两件事**，
 * 而这两件事浏览器给不了。反过来也别把代理当万能——它有自己的失败面（见下），
 * 而且**它不带 cookie**，需要登录态才给图的源，直连反而更强。
 *
 * **代价与已知失败面**（别以为包上就一定更好）：
 * - 字节全从后端过。实测封面**平均 919KB、中位 379KB、最大 5.4MB**（源站发的是原图，
 *   3000×3000 那种，而列表里只显示 36px）。真要省，该做的是**尺寸**，不是拆代理。
 * - `image-fetch.ts` 写死一个桌面 Chrome UA，**这个 UA 本身会被某些 WAF 当靶子**：荔枝
 *   `cdnimg101.gzlzfm.com`（库里最大的一类封面）对该 UA 回 403，去掉 UA 或换成 curl 的就 200；
 *   于是出现「直连好好的、走代理反而 502」。这类回归**只在活体量得到，代码里看不出来**。
 *
 * 住在自己的文件里、没并进 `api.ts`：和邻居 `backendUrl.ts` 同一个理由——它是个纯函数，而
 * `videoPlan.ts` / `audioTrack.ts` 这些纯模块要用它，又被那些**整个 mock 掉 `api.ts`** 的测试
 * 引用着；让纯模块去 import 网络层，等于把这个判据绑上别人的 mock。`api.ts` 只把它再导出一次，
 * 组件侧的既有 import 和既有 mock 都不用动。
 */

/** 这个地址**不该**再包一层代理的四种形状（分开导出，因为它就是那条判据本身，测试钉的是它）。 */
export function imageProxyBypass(src: string): 'data' | 'blob' | 'already-proxied' | 'backend-route' | null {
  // 字节已经在手里了，代理无从取起。
  if (src.startsWith('data:')) return 'data'
  // blob: 是本页面的对象 URL，别的源（包括后端）根本解析不了它。
  if (src.startsWith('blob:')) return 'blob'
  // 已经是代理地址——再包一层就是让后端去取它自己。
  if (src.includes('/api/media/image?')) return 'already-proxied'
  // 根相对 = 后端自己的路由（`/api/media/netdisk-thumb?…` 之类）。它已经在我们这一侧，
  // 只缺一个源；缺的那件事归 backendUrl，不归代理。
  // **`//` 要先排除**：协议相对（`//host/x.jpg`）也是斜杠开头，但它指的是别人的源，
  // 当成后端路由就会拼出 `http://后端//host/x.jpg`。
  if (src.startsWith('/') && !src.startsWith('//')) return 'backend-route'
  return null
}

/**
 * 后端图片出口：服务端取图（不带 Referer），防盗链的封面/海报才能在浏览器里显示出来。
 * 对上面四种形状原样放行（根相对的那种只补源）。**拿不准就调它**——它是幂等的。
 */
export function imgUrl(baseUrl: string, src: string): string {
  const bypass = imageProxyBypass(src)
  if (bypass === 'backend-route') return backendUrl(baseUrl, src)
  if (bypass) return src
  // 协议相对（`//host/x.jpg`）在浏览器里合法，但后端 `new URL()` 解析不了——补上 scheme 再交出去。
  const abs = src.startsWith('//') ? `https:${src}` : src
  return `${baseUrl}/api/media/image?url=${encodeURIComponent(abs)}`
}
