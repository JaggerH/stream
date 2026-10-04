/**
 * 「把一个**可能是根相对**的后端地址绝对化」——**全前端只此一处**。
 *
 * **为什么这件事需要一个有名字的函数**：根相对地址（`/api/media/netdisk-play?path=…`）在浏览器里
 * 按**页面自己的源**解析，而「页面的源 = 后端的源」只是同源那一档下**碰巧**成立的巧合。
 * 面板住在用户 DSH 的页面里（origin 由用户的 dsh web 决定）时它不成立，后端在 8900——请求打到
 * 一个根本没有这条路由的源上、404，而**代码里看不出任何毛病**。
 *
 * 这个判据此前有三份内联实现（`videoPlan.planVideo`、`audioTrack.toTrack`、`ArtPlayer` 里那个
 * `resolveUrl`），而第三份把 `/` 也算进「已经绝对了」直接放行——面板里网盘视频因此全部打到 DSH
 * 的源上、`<video>` 报 `error.code 4`（src not supported），而同一页的海报墙完全正常，没有任何
 * 一处会喊。三份实现的漂移不报错，所以判据收在这一处。
 * **新增一个会产出后端地址的出口，就从这里取绝对化，别再内联第四份。**
 *
 * 住在自己的文件里、没并进 `api.ts`（`imgUrl` 的邻居看着更顺手）：它是个纯函数，而
 * `videoPlan.ts` / `audioTrack.ts` 也是纯的、又被那些整个 mock 掉 `api.ts` 的测试引用着——
 * 让纯模块去 import 网络层，等于把这个判据绑上别人的 mock（真撞过：先加进 api.ts 那一版，
 * ArtPlayer 的 9 条既有测试当场全红在 "No backendUrl export is defined on the api.ts mock"）。
 */
export function backendUrl(baseUrl: string, url: string): string {
  // 有 scheme（`https:`、`blob:`、`data:`）或协议相对（`//host/…`）= 已经指名了源，别动它。
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) ? url : `${baseUrl}${url}`
}
