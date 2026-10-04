/**
 * 一条本机播放地址：`platform` 是 `video.resolve` 的派发键前半截，`vid` 的形状归包。
 * **根相对**——消费者是同源的浏览器与本仓自己的路由，绝不能拼出内部主机名。
 *
 * 住 `shared/`：包（fetch-url 里把作品翻成可播地址）和宿主（`src/video/play.ts` 的路由）同吃这一份；
 * 纯函数被 inline 进包的 bundle 无害。
 */
export function mediaPlayUrl(opts: { platform: string; vid: string; dl?: boolean }): string {
  const q = `platform=${encodeURIComponent(opts.platform)}&vid=${encodeURIComponent(opts.vid)}`
  return `/api/media/play?${q}${opts.dl ? '&dl=1' : ''}`
}
