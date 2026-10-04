import type { Content, Media } from '../../src/content/types.ts'
import type { Normalizer } from '../../src/content/normalize.ts'

/**
 * 网盘目录 source（alist-audio）的归一化：一个网盘音频文件 → 直接可播的音频条目。
 * 与付费播客集（resolveOnly，靠绑定补音频，实例见对应 facility 包的 README）不同——网盘 source 的文件本身就在盘里，
 * url 直接指向 netdisk-play 路由（音频经它 302 到 AList 直链），不 resolveOnly、不碰绑定。
 * 无照片就不给封面（封面独立），无时长。
 */
/** 只剥**已知音频扩展名**,不能用 `\.[^.]+$` 剥"最后一个点之后的一切"——集名本身常带点号
 *  (`怡乐·455.现代版木仓下留人`),而 adapter 已经剥过一次 `.mp3`,再剥一次就把真标题当扩展名
 *  吃掉:活体实测 10 条下架集全部退化成 `怡乐·455` / `144` 这种光秃编号(2026-07-24)。 */
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|wav|opus)$/i

/** 分享者水印：`【耗时整理‖cunlove.cn】`、`（公众号：xxx）` 这类。与内容无关，一律剥。 */
const SHARER_WATERMARK = /【[^】]*】|[（(]\s*(?:公众号|微信|整理|免费分享)[^）)]*[）)]/g

/**
 * 分享者加在文件名前的电台名前缀（`怡乐·455.…`、`怡楽播客 - 069.…`）。挂进某条流之后这个
 * 前缀就是冗余——流自己已经说了是哪个电台。
 *
 * **只在剥完剩下的是三位零填充集号时才剥**：这样子节目的两位号前缀（`玄关笔记 - 07.甲木`）
 * 不会被误当噪声吃掉——两套编号体系混判的坑已经踩过一次（跳号统计 44 vs 57）。判据与归档器
 * 的「三位才算正片编号」保持同一条。
 * 代价（已知且接受）：`第二季 - 001.开篇` 这种真前缀也会被剥；网盘挂载场景里季信息在目录层，
 * 文件名前缀基本都是分享者噪声。
 */
const SHARER_PREFIX = /^.{1,12}?\s*[-–—·]\s*(?=\d{3}[.．])/

/**
 * 文件名 → 可读标题：剥扩展名 → 剥水印 → 剥电台名前缀。**幂等**，可以在链路上被调用两次。
 * 原始文件名一个字都不动——`raw.name` / `raw.path` 仍是真身份，追溯与对账全靠它们。
 *
 * adapter（产出 `title`）和 normalizer（产出 `content.title`）共用这一份：前端各处显示的是
 * **顶层 `item.title`**，只在 normalizer 里清洗等于白清洗（活体实测：`content.title` 干净、
 * 列表里照旧显示 `怡乐·455.…`，集号也因此提不出来、排序一并失效）。
 */
export function displayTitle(rawTitle: string): string {
  return rawTitle
    .replace(AUDIO_EXT, '')
    .replace(SHARER_WATERMARK, '')
    .replace(SHARER_PREFIX, '')
    .trim()
}

export const alistNormalizer: Normalizer = (raw): Content => {
  const path = String(raw.path ?? '')
  const rawTitle = raw.title ?? raw.name
  const title = rawTitle ? displayTitle(String(rawTitle)) : undefined
  const media: Media[] = path
    ? [{ kind: 'audio', url: `/api/media/netdisk-play?path=${encodeURIComponent(path)}` }]
    : []
  return { archetype: 'audio', title, media }
}
