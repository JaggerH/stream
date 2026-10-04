import type { PackageReadSource } from '../../src/packages/read-source.ts'
import { ContentUnavailableError } from '../../shared/package-sdk/errors.ts'

/**
 * 「一条抖音作品的详情从哪来」——本包的 `douyin-detail` recipe（局部名，宿主按包名限定成全名）。
 *
 * **导出而不是就地写字面量**：`ctx.readSource` 那一侧和 recipe 文件的 `sourceId` 必须是同一个字，
 * 各写一份的话改了一边不会有任何一处报错（见 `src/packages/read-source.ts` 的 qualifyOwnSourceId）。
 */
export const DOUYIN_DETAIL_SOURCE = 'douyin-detail'

/**
 * 「这条作品没了」那一路产出所带的字段名（recipe 的 output 映射里同名的那一格）。
 *
 * **它是一个字段，不是一句错误文本里的标记。** recipe 在页内判出「站方回了 `status_code: 0`，
 * 但没有 `aweme_detail`」时**正常产出**一条带这个字段的条目（站方自己的判词），而不是抛异常——
 * 抛异常会被 runner 判成 drift，连吃三次就把整个源隔离掉（见 recipe 的
 * `_why_unavailable_is_an_answer`，那是活体真撞出来的）。翻译成结构化的 `ContentUnavailableError`
 * 在这一侧做，调用点据此回 404 而不是 502。
 *
 * 两处各写一份字面量 = 改了一边不会有任何一处报错，删掉的作品会静静地变成一条没有媒体的
 * 「成功」——所以 `douyin-detail.test.ts` 钉着「recipe 的 output 映射里确实有这一格」。
 */
export const DETAIL_UNAVAILABLE_FIELD = 'unavailable'

/** 一条作品详情的产出：`douyin-detail` 的 output 映射摊出来的那一行（其余几格是给 feed 用的）。 */
interface DetailRow {
  guid?: unknown
  /** 整条 aweme（`video.play_addr` / `images` / `author` / `statistics` 都在里面）。 */
  douyin?: unknown
  /** 只有「作品没了」那一路才有：站方自己的判词。见 `DETAIL_UNAVAILABLE_FIELD`。 */
  unavailable?: unknown
}

/**
 * 跑一次 `douyin-detail`，把整条 aweme 交回来 —— 形状与容器 `/api/hybrid/video_data` 的 `data`
 * 逐格相同（都是站方的 aweme），所以 `playAddrOf` / `fetchUrlFor` 这两个消费方一个字都不用改。
 *
 * `url` 原样递给 recipe 当入口：短链 / 分享链接不在这里解析，浏览器自己跟完跳转就落在作品页上
 * （容器以前替我们做的正是这件事）。
 *
 * **拿不到就抛，绝不回一个空对象**：调用方拿到 `{}` 只会静默产出一条没有媒体的「成功」，而真相是
 * 这条作品没读到。作品被删 / 私密那一档抛的是 `ContentUnavailableError`（404 而不是 502）。
 */
export async function readDouyinAweme(
  readSource: PackageReadSource,
  url: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const rows = await readSource(DOUYIN_DETAIL_SOURCE, { url }, { signal })
  const row = rows[0] as DetailRow | undefined
  // 「作品没了」是一条正常产出（带站方判词的那一格），不是一次失败——见 DETAIL_UNAVAILABLE_FIELD。
  const gone = row?.[DETAIL_UNAVAILABLE_FIELD as 'unavailable']
  if (typeof gone === 'string' && gone) throw new ContentUnavailableError(gone)
  const aweme = row?.douyin
  if (!aweme || typeof aweme !== 'object') {
    throw new Error(`[douyin-detail] ${url} 没有读到作品详情（recipe 跑完了但产出是空的）`)
  }
  return aweme as Record<string, unknown>
}
