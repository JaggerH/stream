/**
 * 一个完整的桌面 Chrome UA。**它不是默认值**——想发就得在调用点显式传 `userAgent: BROWSER_UA`。
 * 为什么默认不发（实测 10 个图床 × 4 种 UA 全都不劣、而固定指纹是 WAF 的靶子）、复发样本在哪，
 * 见宿主 `src/http/image-fetch.ts` 头注——那里是图片代理的调用点，也是这段结论的证据所在。
 *
 * 住 `shared/`：包（xhs adapter 直打站方接口）和宿主的媒体代理同吃这一份常量；
 * 常量被 inline 进包的 bundle 无害。
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
