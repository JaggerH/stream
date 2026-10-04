/**
 * 回 Stream 页面的深链。v1 只做链接跳转，不把播放器/收件箱搬进工作台（spec §7）。
 *
 * **每一条路径都是从 `app/src/lib/route.ts` 的真实路由里抄来的，不是猜的。** 只有四种
 * 形状被验证过存在：
 *   - `/timeline`            —— 收件箱时间线（`pathToRoute` 的 `timeline` / 空段）
 *   - `/search`              —— 内容搜索频道（`CONTENT_SEARCH_CHANNEL`）
 *   - `/c/<streamId>`        —— 具名频道（`pathToRoute` 的 `c` 分支）
 *   - `/video/item/<itemId>` —— 影视频道的详情二级路由（MovieChannel 的 `videoRouteFrom`）
 *
 * **没有通用的「打开某条 item」路由。** 通知中心点一条 transcribe.done 时走的是应用内事件
 * （`dispatchLocal({type:'open-artifact'})`，见 `app/src/components/NotificationBell.tsx`），
 * 不经地址栏。所以拿到一个裸 itemId 时这里**不发链接**，而不是拼一个 `/video/item/<id>`
 * 去赌它是影视条目——那会做出一个看起来能点、点了落到空页的死链。
 *
 * **基址不是常量**：这个包要能装在别人机器上，Stream 后端不一定在 `127.0.0.1:8900`。
 * 地址由 host 半经页面常量下发（见 `src/wire.ts`），`apply()` 开局 `configureBackend()`
 * 一次。没配到时每个函数返回 `undefined`——同一个理由：宁可不给链接，也不给一个指向
 * 错主机的死链。
 */

/** 当前基址（已去尾斜杠）。`undefined` = 没配到。 */
let backend: string | undefined

/**
 * 设定基址。客户端 `apply()` 开局调一次；测试里也用它复位。
 * @param url - 归一化过的基址，或 `undefined` 表示没配到。
 */
export function configureBackend(url: string | undefined): void {
  backend = url === undefined ? undefined : url.replace(/\/+$/, '')
}

/** 当前基址（面板资产装载与人话提示都读它）。 */
export function backendUrl(): string | undefined {
  return backend
}

/** 拼一个绝对 URL。`path` 必须以 `/` 打头。没有基址时返回 `undefined`。 */
function abs(path: string): string | undefined {
  return backend === undefined ? undefined : `${backend}${path}`
}

/** 收件箱时间线。 */
export function timelineUrl(): string | undefined {
  return abs('/timeline')
}

/** 内容搜索频道 —— content_search 的结果在 Stream 里就落在这一屏。 */
export function contentSearchUrl(): string | undefined {
  return abs('/search')
}

/** 一个具名频道（Stream 的 `stream_id` / `id`）。 */
export function channelUrl(streamId: string): string | undefined {
  return abs(`/c/${encodeURIComponent(streamId)}`)
}

/** 影视频道里的一条详情。**只在已知这条属于影视频道时**才用（见文件头注）。 */
export function videoItemUrl(itemId: string): string | undefined {
  return abs(`/video/item/${encodeURIComponent(itemId)}`)
}
