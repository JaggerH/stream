// src/http/local-recipes-routes.ts — 「我自己写的 recipe 放哪、它装载了吗、没装载是为什么」
// （spec 2026-09-05-skill-delivery-design §5）。
//
// **这一口存在的理由是：这条路上「写了但没装载」和「装载了但这个源不工作」长得完全不一样，
// 而在此之前没有任何一处分得开它俩。** 用户（或替他干活的 agent）把文件写进
// `<dataDir>/recipes/<名字>/` 之后，唯一的证据是后端日志里一行 `recipe packages reloaded: N`
// ——日志他不会看，而且那个 N 也不告诉他"我那份在不在里头"。于是他只能去试采一次，
// 采不到再回头猜是哪一端坏了。
//
// **判据取自两端，不是自己验自己**：一端是现扫盘上那些包（谁在那儿、解析得动吗），另一端是
// **活着的 registry**（调度真正会用的那张表）。只报第一端等于把"我又解析了一遍，没问题"
// 当成"它生效了"——这条线上同一种自证已经犯过好几次。
import { join } from 'node:path'
import type { Hono } from 'hono'
import { loadRecipePackages, USER_LAYER_SCAN } from '../replay/recipe-package.ts'

export interface LocalRecipeRoutesDeps {
  /** 用户可写的那层 recipe 目录（`<dataDir>/recipes`）——**要告诉用户往哪写的就是它**。 */
  recipesDir: string
  /**
   * 这条全名此刻在不在活着的 registry 里。**这是独立的那一端**：它由 bootstrap 的装载路径
   * 填，不是本路由自己解析出来的。注入而不是直接引 registry，是因为路由不该持有它。
   */
  mounted: (sourceId: string) => boolean
}

interface LocalPackageRow {
  /** 目录名（也是它的命名空间：`local/<目录名>`，见 localNamespace）。 */
  id: string
  dir: string
  /** 这个包声明的源，各自在不在 registry 里。 */
  sources: { id: string; mounted: boolean }[]
  /** 解析失败时的原文。有它就说明这个包**整份没装**（不是"装了一半"——跳过是干净的）。 */
  error?: string
}

export function mountLocalRecipeRoutes(app: Hono, deps: LocalRecipeRoutesDeps): void {
  app.get('/api/recipes/local', (c) => {
    const failures = new Map<string, string>()
    // 现扫，不用启动快照：这一口的全部意义就是回答"我**刚**写进去那份怎么样了"。
    const loaded = loadRecipePackages(deps.recipesDir, {
      ...USER_LAYER_SCAN,
      // 坏包报一条、跳过——一个写坏的包不该让这一口整个 500，那正是他要来这里查的东西。
      onPackageError: (dir, err) => failures.set(dir, err.message),
    })

    const packages: LocalPackageRow[] = loaded.descriptors.map((d) => ({
      id: d.name ?? d.dir.split(/[\\/]/).pop() ?? d.facility,
      dir: d.dir,
      sources: d.sources.map((s) => ({ id: s.id, mounted: deps.mounted(s.id) })),
    }))
    for (const [dir, error] of failures) {
      packages.push({ id: dir.split(/[\\/]/).pop() ?? dir, dir, sources: [], error })
    }
    packages.sort((a, b) => a.id.localeCompare(b.id))

    return c.json({
      dir: deps.recipesDir,
      packages,
      // 一句话判据，省得每个调用方自己推：全绿 = **有包**、每个都解析得动、且它的每条源都在
      // registry 里。**空目录必须是 false**——`[].every(...)` 天然为真，照它报 ok 的话，
      // "我写进去了" 和 "我写错地方了、这儿一个都没有" 会给出同一个绿灯。
      ok: packages.length > 0 && packages.every((p) => !p.error && p.sources.length > 0 && p.sources.every((s) => s.mounted)),
    })
  })
}

/** `<dataDir>` → 用户那层 recipe 目录。**别在别处再拼一次**：两处各拼各的迟早分家。 */
export const localRecipesDir = (dataDir: string): string => join(dataDir, 'recipes')
