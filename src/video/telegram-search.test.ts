import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSourceItems } from './content/to-release.ts'
import { applyMap } from '../replay/desktop-runner.ts'
import { fileURLToPath } from 'node:url'
import { searchMetaBySourceId, setPackageSearchSources } from '../search/seeds.ts'
import { BUILTIN_LAYER_SCAN, loadRecipePackages, searchSourcesOf } from '../replay/recipe-package.ts'
import { recipeToManifest } from '../replay/recipe-manifest.ts'
import { DEFAULT_BUDGET_MS } from './search-stream.ts'

/**
 * Telegram 资源频道 → 搜索结果行，**吃真实的 recipe 文件**。
 *
 * 为什么不喂手写的理想输入：这条路上真正会坏的是 recipe 的 `map`（谁改一条正则，搜索
 * 就静默少一个字段），而不是解析器。所以样本是活体原样、map 是文件里那一份，中间不插
 * 任何替身。
 *
 * 同一段正文有**两个消费者**——收件箱的 presenter（`packages/telegram/normalizer.ts`）和这里的搜索
 * 解析器。两边都认 `content` 这个字段名，改名就得两边一起改。
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

const recipe = JSON.parse(
  readFileSync(new URL('../../packages/telegram/telegram-search.recipe.json', import.meta.url), 'utf8'),
) as { map: Record<string, { from: string; match: string }> }

/** 活体样本（2026-08-03「夸克云盘影视资源频道」）：a11y 把整条消息读成一个控件名，原样。
 *  头两行是客户端 UI 的噪声（频道名、图片尺寸），不是消息内容。 */
const MSG = [
  '夸克云盘影视资源频道',
  '图片, 853×1280',
  '名称：凡人修仙传（2025）4K 更至EP60',
  '',
  '描述：改编自忘语同名小说，杨洋、金晨主演。',
  '',
  '夸克：https://pan.quark.cn/s/aacab8de665b',
  '',
  '📁 大小：2.5G/集',
  '🏷 标签：#凡人修仙传 #杨洋',
  '已收到   20:27 904 浏览次数',
].join('\n')

const mapped = (raw: string) => applyMap({ content: raw }, recipe.map)

describe('telegram-search → 搜索结果', () => {
  it('一条消息解析成一行带夸克链接的结果', () => {
    const rows = parseSourceItems('telegram', [mapped(MSG)], '凡人修仙传')
    expect(rows).toHaveLength(1)
    const r = rows[0].release
    expect(r.link).toBe('https://pan.quark.cn/s/aacab8de665b')
    expect(r.sourceType).toBe('quark')
    expect(r.title).toBe('凡人修仙传（2025）4K 更至EP60')
  })

  /** 开头那两行 UI 噪声若不摘掉，解析器会把**频道名**当成资源名——结果看着有货，
   *  每一行却都叫「夸克云盘影视资源」，而真正的片名不见了。 */
  it('客户端 UI 噪声不许冒充资源名', () => {
    const rows = parseSourceItems('telegram', [{ content: MSG }], '凡人修仙传')
    expect(rows.map((g) => g.release.title)).not.toContain('凡人修仙传（2025）4K 更至EP60')
  })

  /** 整段正文若不落在 `content` 上，解析器一条都认不出——退化成"有标题、没链接"，
   *  而那是最难发现的坏法：结果列表看着有货，点下去什么都没有。 */
  it('正文换个字段名就全丢——这正是 recipe 必须写 content 的原因', () => {
    const rows = parseSourceItems('telegram', [{ title: '凡人修仙传', text: MSG } as never], '凡人修仙传')
    expect(rows.flatMap((g) => (g.release.link ? [g.release.link] : []))).toEqual([])
  })

  it('登记进搜索源名册（包自己的 searchSources 声明），且关键词按 q 注入', () => {
    // 名册那一行住在包上（`package.json#stream.searchSources`），宿主表不再点名它；这里把真实的
    // 声明挂进查表再问，和装配层做的一样。
    const decls = searchSourcesOf(loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN).descriptors)
    setPackageSearchSources(() => decls)
    try {
      const meta = searchMetaBySourceId('@streamapp/telegram/telegram-search')
      expect(meta).toBeDefined()
      // recipe 的 key_param 是 q；名册里写错就等于关键词没传进去，搜索静默返回整个频道的近况
      expect(meta!.param).toBe('q')
      expect(meta!.kind).toBe('digest')
    } finally {
      setPackageSearchSources(() => [])
    }
  })

  /** 自报上限住在 recipe 里（**唯一真相源**，两条搜索路都读它投影出的 manifest 那一格）。
   *  以前它还有一份住在 `SEARCH_SOURCE_META.timeoutMs`，两边各管一条路——所以这里连
   *  「投影没丢」一起钉：`meta.member_timeout_ms` 漏进 manifest 的话，流式路会静默回落 15s。 */
  it('自报上限经 recipe→manifest 投影抵达，且小于流式路的整体预算', () => {
    const ms = recipeToManifest(recipe as never, 'telegram', '@streamapp/telegram').member_timeout_ms
    expect(ms).toBeDefined()
    expect(ms!).toBeLessThan(DEFAULT_BUDGET_MS)
  })
})
