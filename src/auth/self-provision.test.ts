import { describe, expect, it } from 'vitest'
import { selfProvisionRecipesFor } from './self-provision.ts'
import type { SourceManifest } from '../manifest/types.ts'

/** 只给被测判据用得上的字段；其余用 as 收口——这条判据只读 id/title/runtime_config。 */
function m(id: string, ref?: string, title = id): SourceManifest {
  return {
    id, title,
    runtime_config: ref ? { ref, fields: {}, provisions: ['apiKey'] } : undefined,
  } as unknown as SourceManifest
}

describe('selfProvisionRecipesFor', () => {
  it('按 ref 找出能补它的 recipe', () => {
    const all = [m('groq-create-key', 'groq'), m('zhipu-create-key', 'zhipu'), m('xhs-home')]
    expect(selfProvisionRecipesFor(all, 'groq').map((o) => o.sourceId)).toEqual(['groq-create-key'])
  })

  it('没有能补的 ref 返回空，不抛', () => {
    expect(selfProvisionRecipesFor([m('xhs-home')], 'groq')).toEqual([])
  })

  // 方向：声明同一个 ref 只说明"和这格配置有关系"，不等于"能补它"。`eastmoney-login`
  // 声明 ref `eastmoney` 是为了**读**用户手填的资金账号/交易密码，跑它一万遍也变不出那两个值。
  // 把消费方算成能补，agent 就会去劝用户跑一条根本补不了的 recipe——比不给建议更坏。
  it('声明了同一个 ref 但没有 provisions 的（消费方）不算能补', () => {
    const consumer = {
      id: 'eastmoney-login', title: '东方财富 登录',
      runtime_config: { ref: 'eastmoney', fields: {} },
    } as unknown as SourceManifest
    expect(selfProvisionRecipesFor([consumer], 'eastmoney')).toEqual([])
  })

  // 一个 ref 可能有两条 recipe，且不等价：读是幂等的，建会在账号里堆同名 key。
  // 顺序是这个函数的产出契约的一部分，不是实现细节——调用方直接取第一个。
  it('同一个 ref 有 read 和 create 时，read 排在前面', () => {
    const all = [m('firecrawl-create-key', 'firecrawl'), m('firecrawl-read-key', 'firecrawl')]
    expect(selfProvisionRecipesFor(all, 'firecrawl').map((o) => o.kind)).toEqual(['read', 'create'])
  })

  // 真实的那 4 条 recipe（recipe-manifest.ts 合成时）没有 title，只有 description
  // （见 self-provision.ts 里 label 那行的注释）。m() 的默认值 title = id 会掩盖这条
  // 回落，所以这里手写一个没有 title 的 manifest，别复用 m()。
  it('manifest 没有 title 时，label 落到 description', () => {
    const noTitle = {
      id: 'zhipu-create-key',
      description: '创建智谱 API Key',
      runtime_config: { ref: 'zhipu', fields: {}, provisions: ['apiKey'] },
    } as unknown as SourceManifest
    expect(selfProvisionRecipesFor([noTitle], 'zhipu').map((o) => o.label)).toEqual(['创建智谱 API Key'])
  })

  it('manifest 既没有 title 也没有 description 时，label 落到 id', () => {
    const bare = {
      id: 'zhipu-create-key',
      runtime_config: { ref: 'zhipu', fields: {}, provisions: ['apiKey'] },
    } as unknown as SourceManifest
    expect(selfProvisionRecipesFor([bare], 'zhipu').map((o) => o.label)).toEqual(['zhipu-create-key'])
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recipeToManifest } from '../replay/recipe-manifest.ts'

/** 从被测模块自己的位置推仓库根，**不用 `process.cwd()`**：worktree 会话里 cwd 会漂到
 *  另一棵树上，夹具写进 A 树、断言扫 B 树，表现成一条"确定性的偶发红"（AGENTS.md 有记）。 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../..')

/**
 * 这条判据吃的是 manifest，而「这条 recipe 会替用户填哪一格」的**唯一真相源**是
 * `provisionedConfigSlot(recipe)`（`src/replay/recipe-provisioner.ts`，同时也是写口 sink 的
 * 绑定条件；那份名单的数字由 `recipe-provisioner.test.ts` 钉着，不在这里重钉一遍）。
 *
 * 中间那一跳是 `recipeToManifest`：它把那个判据的结论投影成 `runtime_config.provisions`。
 * **这条测试钉的就是那一跳**——投影一断，manifest 侧就永远看不到任何"能自助补"的东西，
 * 而两边单看都正常：recipe 里 `extract` 好好的，`provisionedConfigSlot` 也照常报得出来，
 * 只是配置卡和 agent 那边恒空。
 */
describe('provisions 是从 provisionedConfigSlot 投影下来的', () => {
  function manifestOf(pkg: string, file: string) {
    const recipe = JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, file), 'utf8')) as Parameters<typeof recipeToManifest>[0]
    return recipeToManifest(recipe, pkg, '@streamapp/builtin')
  }

  it('产出 key 的那条 recipe → manifest 上带着 provisions', () => {
    const m = manifestOf('groq', 'groq-create-key.recipe.json')
    expect(m.runtime_config).toMatchObject({ ref: 'groq', provisions: ['apiKey'] })
  })

  // 反向：`eastmoney-login` 声明 ref `eastmoney` 是为了**读**用户手填的资金账号/交易密码，
  // 它没有 `extract`、什么都产不出来。projection 必须让它保持空手，否则 agent 会去劝用户跑
  // 一条根本补不了那两格的 recipe。
  it('只消费那格配置的 recipe → manifest 上没有 provisions，也就不进自助补的选项', () => {
    const m = manifestOf('eastmoney', 'eastmoney-login.recipe.json')
    expect(m.runtime_config?.ref).toBe('eastmoney')
    expect(m.runtime_config?.provisions).toBeUndefined()
    expect(selfProvisionRecipesFor([m], 'eastmoney')).toEqual([])
  })

  // 包作者在 meta 里手写一份也不算数——一条判据只有一个真相源，抄第二遍就会漂。
  it('meta 里手写的 provisions 被剥掉，以推出来的为准', () => {
    const recipe = JSON.parse(readFileSync(join(repoRoot, 'packages/eastmoney/eastmoney-login.recipe.json'), 'utf8')) as {
      meta: { runtime_config: Record<string, unknown> }
    }
    recipe.meta.runtime_config.provisions = ['zjzh']
    const m = recipeToManifest(recipe as unknown as Parameters<typeof recipeToManifest>[0], 'eastmoney', '@streamapp/builtin')
    expect(m.runtime_config?.provisions).toBeUndefined()
  })
})
