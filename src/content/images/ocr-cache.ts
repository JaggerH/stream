// src/content/images/ocr-cache.ts
//
// OCR 结果的**按图缓存**。命名空间规格住在它描述的那个值旁边（同 `wireArticleCache`）。
//
// 为什么按图、不按文章：`extractArticle` 那份 `article` 缓存与阅读器（`/api/enrich?source=link`）
// 共享，把 `parse` 行的 deps 耦合进一条纯读路径是错的。按图还白拿两个好处——同一张图被两篇
// 文章引用只付一次；重跑 extract 时逐图全命中、零模型调用。
//
// 每张图一次视觉模型调用是这整件事里**唯一持续产生费用**的部分，这个缓存管住的正是重跑那一档
//（conversion 落库，打开文章只是读记录，不会重付）。
import type { ContentCache } from '../../content-cache.ts'
import type { OcrImagesDeps } from './ocr-images.ts'

const NS = 'ocr-image'
/** 图上的字是**稳定事实**：同一个 URL 的图片内容不会变（变了通常是换 URL）。30d。 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 声明命名空间（bootstrap 接缓存层时调一次）。
 *
 *  **这一个不需要撤销**（另外两个 `wire*` 返回 disposer）：它只往 `cacheLayer` 自己的 map 里
 *  写一格规格，没有模块级指针指着这份句柄——规格随那个 ContentCache 一起生灭，重复装配也只是
 *  往新那份上重新登记。
 *
 *  **刻意不设 `negativeTtlMs`**：这条路上的 `null` 有两种来源——图上真没字，和 `parse` 行全员
 *  失败（没配视觉模型 / 限流 / 后端没醒）。后者缓存 30 天等于把一次配置故障固化成"这张图没字"，
 *  而且配置修好后也不会自愈。宁可下次再试一遍。 */
export function wireOcrImageCache(cacheLayer: ContentCache): void {
  // version: 2 —— 2026-08-06 OCR_INSTRUCTION 升级为「按视觉区域提取」：同一张图的识别结果语义
  // 变了，旧缓存（纯转写产物）不该再喂给阅读器。ContentCache 按 version 判定，bump 后旧行
  // 全部 miss，重跑即按新指令重新识别。
  cacheLayer.register(NS, { ttlMs: TTL_MS, version: 2 })
}

/** 给一对 `OcrImagesDeps` 套上按图缓存：key = 图片 URL，命中即返回、不调 `parse` 行。
 *  `cache` 为 null（测试 / 独立跑）时原样透传。
 *
 *  URL 只在 `fetchBytes` 手上，而 `ocr(bytes, mime)` 只拿得到字节——所以用**这一次取图返回的
 *  字节对象**当身份牌（WeakMap，取完即可回收）把 URL 递过去。`ocr` 的签名是那个零件的对外合同，
 *  不为缓存去改它；WeakMap 按对象身份索引，并发取多张图也不会串。
 *
 *  缓存查在取字节**之后**：省下的是模型调用（唯一的钱），图片本身重下一次的代价可以忽略，
 *  而且 `fetchBytes` 那层还带着 SSRF 白名单与体积上限，绕过去反而弱化了闸门。 */
export function withImageOcrCache(deps: OcrImagesDeps, cache: ContentCache | null): OcrImagesDeps {
  if (!cache) return deps
  const urlOf = new WeakMap<Uint8Array, string>()
  return {
    fetchBytes: async (url) => {
      const got = await deps.fetchBytes(url)
      if (got) urlOf.set(got.bytes, url)
      return got
    },
    ocr: async (bytes, mime) => {
      const url = urlOf.get(bytes)
      if (!url) return deps.ocr(bytes, mime) // 字节不是从上面那条路来的：不认得是哪张图，不缓存
      return cache.tryGet<string>(NS, url, () => deps.ocr(bytes, mime))
    },
  }
}
