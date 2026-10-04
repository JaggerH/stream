// 出货的桌面 recipe 必须过装载闸。
//
// 为什么单独一个文件：`recipe-store.test.ts` 验的是**规则本身**（拿手写夹具逼每条规则红一次），
// 这里验的是**我们真发出去的那几份**照着规则写了。两件事分开——规则绿不代表包里那份合规，
// 而包里那份不合规的表现是用户装完之后后端起不来（装载期 throw），本地永远撞不到。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecipe } from './recipe-store.ts'

// 仓库根从**本模块自己的位置**推，不从 `process.cwd()`：多 worktree 并行时 shell 的 cwd 会漂到
// 另一棵树上，那时这条用例扫的是别人的 packages/ 而且照样绿。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const packagesDir = join(repoRoot, 'packages')

function shippedDesktopRecipes(): Array<{ file: string; sourceId: string; json: unknown }> {
  const out: Array<{ file: string; sourceId: string; json: unknown }> = []
  if (!existsSync(packagesDir)) return out
  for (const pkg of readdirSync(packagesDir)) {
    const dir = join(packagesDir, pkg)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // 不是目录
    }
    for (const name of entries) {
      if (!name.endsWith('.recipe.json')) continue
      const file = join(dir, name)
      const json = JSON.parse(readFileSync(file, 'utf8')) as { kind?: string; sourceId?: string }
      if (json.kind !== 'desktop') continue
      out.push({ file: `packages/${pkg}/${name}`, sourceId: json.sourceId ?? name.replace(/\.recipe\.json$/, ''), json })
    }
  }
  return out
}

describe('出货的桌面 recipe', () => {
  const recipes = shippedDesktopRecipes()

  // 数字钉在这里（AGENTS.md「名单要有一个钉住数字的测试」）：这条用例的价值全在"扫到了"上，
  // 而扫不到时它同样是绿的——glob 写错、目录改名、`kind` 拼错，表现都是"0 份、全过"。
  // 加一份桌面 recipe 就把这个数字加一，顺带确认它真的被扫进来了。
  it('一共 5 份（telegram-search / qq-send / qq-send-see / wechat-send / wechat-send-file）', () => {
    expect(recipes.map((r) => r.sourceId).sort()).toEqual(['qq-send', 'qq-send-see', 'telegram-search', 'wechat-send', 'wechat-send-file'])
  })

  it.each(recipes.map((r) => [r.file, r] as const))('%s 过 validateRecipe', (_file, r) => {
    expect(() => validateRecipe(r.sourceId, r.json)).not.toThrow()
  })
})
