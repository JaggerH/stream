// 「点开一条内容」的意图——用户点的是**媒体**还是**正文**。两种布局（列表行 PostItemRow /
// 瀑布流卡片 PostCard）共用这一份判据，详情页据此决定左边那格视频自己播不播。
//
// 为什么需要它：这一格信息以前在 `onOpen(item, mediaIndex?)` 的签名处就被抹平了——
// 「点正文（不带 index）」和「点第 0 张媒体」到了 App 的 `openDetail(item, mediaIndex = 0)`
// 之后长得一模一样，于是详情页只能一视同仁，把每一次打开都当成"我要看这个视频"，
// ArtPlayer 一挂载就自动播（`autoplay: true`）。表现就是：在时间线里点帖子的标题/正文，
// 详情页确实开了，但整块画面立刻开始放视频——用户要的是先读。

/** 'watch' = 点的是媒体本身（缩略图 / 封面 / ▶）：那一下点击自带 user activation，自动播是他要的。
 *  'read'  = 点的是标题 / 正文 / 元信息：他要看的是内容，别抢着播。 */
export type OpenDetailIntent = 'watch' | 'read'

export type OpenDetailOptions = {
  /** 图集从第几张开始看（点第 N 张缩略图进来的）。 */
  mediaIndex?: number
  /** 这一下点击是想看还是想读；缺省按 'read' 处理（见 autoPlaysDetailMedia）。 */
  intent?: OpenDetailIntent
}

/** 详情页左边那格媒体要不要自己播起来。**缺省不播**：说不清用户是不是冲着媒体来的时候，
 *  安静地开着比抢着播更不会错——想看的人点一下播放键就行，不想看的人却挡不住一个自动播。 */
export function autoPlaysDetailMedia(intent?: OpenDetailIntent): boolean {
  return intent === 'watch'
}
