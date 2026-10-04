/**
 * 系统 Provider 身份的**静态表**（18 条，一条一个模块）。**它不是全表**：包声明的 Provider
 * 行（`package.json#stream.providers`）在装配期并进来，合并表在 `src/providers/identities.ts`。
 *
 * 字面量 import，照 `packages/index.ts` 的 `BUILTIN_ACTIVATIONS` 先例——这样 esbuild 打得进
 * 发行 bundle、tsc 全覆盖，且「有哪些系统行」在编译期就是确定的。加一条系统行 = 加一个模块
 * 文件 + 这里加一行，`index.real.test.ts` 的数字随之改（数字变红是**要求**，不是麻烦：
 * 它逼你回答「这条真的是系统行吗」）。
 *
 * 身份进代码之后：DB 的 providers 表上，系统行只剩编排（members/options），身份字段变成死数据。
 * 设计见 `docs/superpowers/specs/2026-08-16-cordis-kernel-adoption-design.md` §3.2。
 *
 * **退役一条系统行 = 三步**：
 * 1. 从这张表里删掉那一行（并删掉它的模块文件），`index.real.test.ts` 的数字随之改。
 * 2. 已经种进用户库的那条 DB 行**不用写迁移**——`ensureSystemRows`（`../seed.ts`）每次启动
 *    自动清退：判据是「`system = 1` 且 id 不在这张表里 ⇒ 这一行的身份已经不存在了」。用户自建
 *    行是 `system = 0`，不受影响。留着不清的后果是用户在管理页看得见一条幽灵行，点下去成员指向
 *    不存在的 source，静默失败。
 * 3. 频道槽位（`options.slots`）里对它的引用由同一条清退路径顺手摘掉
 *    （`UserStore.clearProviderFromSlots`）——留着就是一个悬空 id，用户下次访问那个频道踩到的是
 *    `SlotBrokenError`，而系统行退役是我们的代码事件、不是用户的错误。
 */
import type { SystemIdentity } from './types.ts'
import { musicSearch } from './music-search.ts'
import { videoSearch } from './video-search.ts'
import { contentSearch } from './content-search.ts'
import { priceSearch } from './price-search.ts'
import { resaleSearch } from './resale-search.ts'
import { resourceSearch } from './resource-search.ts'
import { lyricsSearch } from './lyrics-search.ts'
import { downloadResolve } from './download-resolve.ts'
import { videoCanonical } from './video-canonical.ts'
import { videoMetadata } from './video-metadata.ts'
import { videoImages } from './video-images.ts'
import { fetchUrl } from './fetch-url.ts'
import { articleExtract } from './article-extract.ts'
import { llm } from './llm.ts'
import { parse } from './parse.ts'
import { podcastFeed } from './podcast-feed.ts'
import { transcribe } from './transcribe.ts'
import { subtitleSearch } from './subtitle-search.ts'

export type { SystemIdentity } from './types.ts'

/** 表的**声明顺序**。它只影响 `ensureSystemRows` 的建行次序（读出来一律 `ORDER BY id`），
 *  所以插在哪儿都行——但同类挨着放，人翻起来省事。 */
const IDENTITIES: SystemIdentity[] = [
  musicSearch,
  videoSearch,
  contentSearch,
  priceSearch,
  resaleSearch,
  resourceSearch,
  subtitleSearch,
  lyricsSearch,
  downloadResolve,
  videoCanonical,
  videoMetadata,
  videoImages,
  fetchUrl,
  articleExtract,
  llm,
  parse,
  podcastFeed,
  transcribe,
]

/** 系统身份表：id → 身份。查一条系统行「是什么」的唯一入口。 */
export const SYSTEM_IDENTITIES: ReadonlyMap<string, SystemIdentity> = new Map(
  IDENTITIES.map((identity) => [identity.id, identity]),
)
