import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { scanPackages } from './scan.ts'
import { buildPackageInventory } from './inventory.ts'

// 钉住**真实** `packages/` 目录上的分段结果。
//
// 这是 `isHostedPackage` 这条判据唯一不依赖人记性的守卫（同 loader.real.test.ts 之于
// `fillsPluginSlot`）：判据一放宽或收紧，下面的数字与名单立刻不对。
//
// 「包」页把 hosted 那批画成带状态行 + 开关的卡片（"宿主在替它跑东西"），其余画成紧凑单行。
// 判据错了不会报错，只会让用户以为某个东西需要照料——所以数字必须被钉住。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

describe('package inventory (real packages/ directory)', () => {
  const inventory = () => buildPackageInventory({ builtin: scanPackages(PACKAGES_DIR), user: [] })

  it('列出全部 51 个内置包（不像 /api/plugins 那样漏掉纯 recipe 包）', () => {
    expect(inventory()).toHaveLength(51)
  })

  it('恰好 5 个 hosted，且就是那 5 个', () => {
    const hosted = inventory().filter((p) => p.hosted).map((p) => p.id)
    expect(hosted.slice().sort()).toEqual([
      'Douyin_TikTok_Download_API',
      'alist',
      // bilibili 同 eastmoney：没有容器，靠凭证域申报（播放解析要用 ctx.cookieFor 拿登录态）。
      'bilibili',
      // eastmoney 没有容器，靠的是凭证域申报（它的代码要用 ctx.cookieFor 拿登录态）。
      'eastmoney',
      'pansou',
    ])
  })

  // 这条是本页的拍板结论本身：rsshub / builtin / browser（还有 replay）都过 `fillsPluginSlot`
  // ——它们提供 Source 清单 / normalizer——但没有容器、没有凭证域，**不会在运行时坏**。
  // 拿 fillsPluginSlot 当分段判据，就会把这四个摆进「需要照料」区。
  it('只提供 Source 清单 / normalizer 的包落在下段', () => {
    const byId = new Map(inventory().map((p) => [p.id, p]))
    for (const id of ['rsshub', 'builtin', 'browser', 'replay']) {
      expect(byId.get(id)?.hosted, `${id} 不该被当成"宿主在替它跑东西"`).toBe(false)
      expect(byId.get(id), `${id} 没有容器就不该有状态行`).not.toHaveProperty('runtime')
    }
  })

  // 定时任务的编辑器拿这份清单当「这条任务的账号存哪一格」的可选项。断了它，那个下拉
  // 变成空的——而"没有可选项"和"这台机器上没有任何需要填的凭据"长得一模一样。
  it('声明了 runtime_config 的包各自报出自己的 ref', () => {
    const withConfig = inventory()
      .filter((p) => (p.slots.config?.length ?? 0) > 0)
      .map((p) => [p.id, p.slots.config] as const)
    expect(Object.fromEntries(withConfig)).toEqual({
      eastmoney: ['eastmoney'],
      // 两条 recipe（create-key / read-key）共用一个 ref —— 去重后只剩一格。
      firecrawl: ['firecrawl'],
      groq: ['groq'],
      zhipu: ['zhipu'],
    })
  })

  it('每个 hosted 包都能说出它为什么 hosted（容器或凭证域，不是空名单）', () => {
    for (const p of inventory().filter((x) => x.hosted)) {
      expect(p.slots.backend === true || (p.slots.credentials?.length ?? 0) > 0, p.id).toBe(true)
    }
  })

  it('recipe 份数落到 slots.recipes 上：xhs 4 份、zuna 4 份、toubiec 3 份', () => {
    const byId = new Map(inventory().map((p) => [p.id, p]))
    expect(byId.get('xhs')?.slots.recipes).toBe(4)
    expect(byId.get('zuna')?.slots.recipes).toBe(4)
    // toubiec 没有 album：上游 getAlbum 自己坏了（-462），见 packages/toubiec/README.md
    expect(byId.get('toubiec')?.slots.recipes).toBe(3)
    expect(byId.get('alist')?.slots.recipes).toBeUndefined()
  })

  it('每个包都有可显示的名字（回落到 id，前端不该拿到空标题）', () => {
    for (const p of inventory()) expect(p.name, p.id).toBeTruthy()
  })
})
