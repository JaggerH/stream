import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { pickableIn, pickableAnywhere } from './pick.ts'
import { PICK_SURFACES } from './types.ts'

// 守住 REAL `packages/` 里那份「哪些源不出现在哪个选择面」的名单。
//
// 为什么必须钉住名字而不只是行为：`pick_in` 缺省是「两个面都能挑到」（见 pick.ts 里为什么是这个
// 方向）。缺省宽松意味着**漏写一份 `pick_in` 不会有任何东西报错**——它只是安静地出现在「添加来源」
// 里，就像这条改动之前"给笔记点赞"和"去建一把 API key"能被当成来源挑中一样。名单钉死之后，
// 新加一份该收窄的 recipe 却忘了申报，这条用例当场变红。
//
// 反过来也钉：名单里的每一条都要**仍然存在**。删掉一个源却留着它的名字，会让这份名单慢慢
// 变成一份没人敢动的历史。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))

/** 只在 Provider 成员面挑得到：不是一条可订阅的流，但确实被 Provider 行当成员用。 */
const PROVIDER_ONLY = [
  'aihuishou-recycle', // resale-search 行的成员：购买决策残值格借的一条腿，不是可订阅的信息源
  'baidu-search', // web_search 第二档的搜索腿
  'baidu-share', // netdisk-verify-baidu 行的成员
  'brave-search',
  'btbtla-detail', // btbtla 组合体 expand 的那一档
  'goofish-search', // resale-search 行的成员：残值格的挂牌价腿，不是可订阅的信息源
  'google-search',
  'quark-share', // netdisk-verify-quark 行的成员
  'telegram-search',
]

/** 两个面都不出现：后端代码 / 配置流程按名字直调，没有"挑"这个动作。 */
const NEVER_PICKABLE = [
  'chatgpt-chat', // 对话动作：按会话 URL 直调，不是可订阅的信息源
  'deepseek-chat', // 同上：对话动作，只经工具按 URL 调用
  'doubao-chat-images', // 动作 recipe：把一条豆包对话里生成好的图读回来，按对话 URL 直调
  'doubao-drafts-clear', // 动作 recipe：清空豆包网页版「草稿」栏（不可恢复），只经 run_action_recipe 跑
  'doubao-image', // 动作 recipe：豆包网页版生图，经 meta.produces:"images" 申报成 /v1/images/generations 的模型
  'eastmoney-login', // 登录动作：不是内容来源，两个选择面都不该出现它
  'firecrawl-create-key',
  'firecrawl-read-key',
  'goofish-edit', // 动作 recipe：改在售商品的标题/描述/价，同 goofish-publish
  'goofish-polish', // 动作 recipe：擦亮在售商品，同 goofish-publish
  'goofish-publish', // 动作 recipe：把商品发上闲鱼，只经 run_action_recipe 跑，且必须二次确认
  'groq-create-key',
  'photopea-cutout', // 动作 recipe：Photopea 抠图，只经 run_action_recipe / POST /api/recipes/action 跑
  'photopea-mask', // 同上：按多边形 / 魔棒切层
  'photopea-place', // 同上：按数值摆放
  'photopea-run', // 同上：通用跑脚本
  'qq-send', // 动作 recipe：只经 MCP 的 run_action_recipe 跑，且必须二次确认
  'qq-send-see', // 同上，`see` 词汇那一版
  'wechat-send', // 同 qq-send：动作 recipe，不是内容来源
  'wechat-send-file', // 同上：发文件那一条
  'xhs-detail', // 打开一条笔记时由 enrich 直调
  'xhs-like', // 点赞/收藏的写操作
  'xueqiu-detail',
  'zhipu-create-key',
]

function shippedRecipes(): Array<{ sourceId: string; pick_in?: string[] }> {
  const out: Array<{ sourceId: string; pick_in?: string[] }> = []
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    for (const file of readdirSync(join(PACKAGES_DIR, pkg.name))) {
      if (!file.endsWith('.recipe.json')) continue
      const json = JSON.parse(readFileSync(join(PACKAGES_DIR, pkg.name, file), 'utf-8')) as {
        sourceId?: string
        meta?: { pick_in?: string[] }
      }
      if (json.sourceId) out.push({ sourceId: json.sourceId, pick_in: json.meta?.pick_in })
    }
  }
  return out
}

describe('pick_in on the shipped recipes', () => {
  it('exactly these sources are provider-only', () => {
    const ids = shippedRecipes()
      .filter((r) => r.pick_in?.length === 1 && r.pick_in[0] === 'provider')
      .map((r) => r.sourceId)
    expect(ids.sort()).toEqual(PROVIDER_ONLY)
  })

  it('exactly these sources are pickable nowhere', () => {
    const ids = shippedRecipes()
      .filter((r) => r.pick_in?.length === 0)
      .map((r) => r.sourceId)
    expect(ids.sort()).toEqual(NEVER_PICKABLE)
  })

  it('every other shipped recipe stays pickable on both surfaces', () => {
    const narrowed = new Set([...PROVIDER_ONLY, ...NEVER_PICKABLE])
    for (const recipe of shippedRecipes()) {
      if (narrowed.has(recipe.sourceId)) continue
      for (const surface of PICK_SURFACES) {
        expect(pickableIn(recipe as never, surface), `${recipe.sourceId} on ${surface}`).toBe(true)
      }
    }
  })

  it('the predicate reads the declaration, not the capability list', () => {
    // 这条钉的是 pick.ts 头注里那句话：`xhs-search` 和 `google-search` 能力都是 `search`，
    // 一个是可订阅的流、一个只当成员——所以判据不能从 capabilities 推。
    expect(pickableIn({ pick_in: undefined }, 'stream')).toBe(true)
    expect(pickableIn({ pick_in: ['provider'] }, 'stream')).toBe(false)
    expect(pickableIn({ pick_in: ['provider'] }, 'provider')).toBe(true)
    expect(pickableAnywhere({ pick_in: [] })).toBe(false)
    expect(pickableAnywhere({ pick_in: ['provider'] })).toBe(true)
  })
})
