// 图片真实尺寸的会话内缓存：src → 该图加载后报上来的 naturalWidth/naturalHeight。
//
// 为什么需要它（两条，都是活体量出来的）：
//
// 1. **条目自带的宽高经常没有，或者是错的。** 时间线上 134 张有封面的卡里 78 张数据里
//    压根没带宽高；带了的那些里也有一批是把**短视频的**尺寸挂到了封面图上——实测框子
//    声明 `1080 / 1920`（竖），里面装的图真实比例却是 1.33（横）。所以"声明的尺寸"不是
//    真相源，加载后图片自己报的才是。
// 2. **瀑布流靠比例参差才成立。** 缺尺寸时退到一个固定比例 + object-cover，等于把所有
//    封面裁成同一个形状——正是"统一网格"的观感，把做瀑布流的理由抵消掉了。
//
// 缓存的作用是**让重排只发生一次**：第一次见到某张图时按占位比例预留，加载完成学到真实
// 比例、框子归位（这一下会挪动它下面的卡片）；此后同一张图在任何地方渲染都直接命中缓存，
// 一次都不再跳。估高器（masonry.ts 的 cardMetrics）读的是同一份缓存，所以分列用的高度和
// 渲染出来的高度是同一个来源，不会各说各话。
//
// 只活在内存里，不落盘：刷新页面重新学一遍即可。落 localStorage 能让刷新后也不跳，但那是
// 另一个量级的东西（要管容量和失效），现在没有证据说值得。
export interface MediaSize {
  w: number
  h: number
}

const sizes = new Map<string, MediaSize>()

export function rememberMediaSize(src: string, w: number, h: number): void {
  // 0 尺寸 = 图还没真的解码出来（或加载失败），记下去会污染缓存并让框子塌掉。
  if (!src || !w || !h) return
  sizes.set(src, { w, h })
}

export function getMediaSize(src: string | undefined): MediaSize | undefined {
  return src ? sizes.get(src) : undefined
}

/** 只给测试用——模块级 Map 会跨用例串味。 */
export function clearMediaSizes(): void {
  sizes.clear()
}
