import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localRecipesDir, mountLocalRecipeRoutes } from './local-recipes-routes.ts'

let root = ''
let mountedIds = new Set<string>()
let app: Hono

/** 一个手放的本地包：`package.json`（**没有 name**，所以命名空间兜底成 `local/<目录名>`）+ 一份 recipe。 */
function writeLocalPackage(name: string, sourceId: string, recipe?: unknown): string {
  const dir = join(root, 'recipes', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ stream: { type: 'recipe', name, facility: name, schemaVersion: 1 } }),
  )
  writeFileSync(
    join(dir, `${sourceId}.recipe.json`),
    JSON.stringify(
      // 这份骨架就是出货给用户的那份模板（`write-recipe` skill 里那段）。**别在这里
      // 简化它**：写少一格（比如漏掉 `version`）recipe 就整份不装，而这正是这一口要照出来
      // 的那种失败——我自己写这条测试时就先漏了 `version`，两轮才发现。
      recipe ?? {
        version: 1,
        kind: 'http',
        sourceId,
        request: { url: 'https://example.com/api/list?page=1', method: 'GET' },
        pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'data.items', maxPages: 1 },
        assert: [{ path: 'data.items', desc: 'list endpoint returned data.items' }],
        mapping: { title: 'title', link: 'url', guid: 'example-{id}' },
        meta: { normalizer: 'rsshub', type: 'post', description: name },
      },
    ),
  )
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stream-local-recipes-'))
  mkdirSync(join(root, 'recipes'), { recursive: true })
  mountedIds = new Set()
  app = new Hono()
  mountLocalRecipeRoutes(app, {
    recipesDir: localRecipesDir(root),
    mounted: (id) => mountedIds.has(id),
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const get = async () =>
  (await (await app.request('/api/recipes/local')).json()) as {
    dir: string
    ok: boolean
    packages: { id: string; dir: string; error?: string; sources: { id: string; mounted: boolean }[] }[]
  }

describe('GET /api/recipes/local', () => {
  it('空目录：告诉他往哪写，且 ok 为 false（没有包 ≠ 一切正常）', async () => {
    const body = await get()
    expect(body.dir).toBe(join(root, 'recipes'))
    expect(body.packages).toEqual([])
    // 判据要有牙：一个都没有的时候报 ok:true，用户会以为"写进去了、已经生效"。
    expect(body.ok).toBe(false)
  })

  it('写好一份、registry 里也有 → 每条源 mounted:true，ok:true', async () => {
    writeLocalPackage('my-site', 'feed')
    mountedIds.add('local/my-site/feed')
    const body = await get()
    expect(body.packages).toHaveLength(1)
    expect(body.packages[0]!.id).toBe('my-site')
    expect(body.packages[0]!.sources).toEqual([{ id: 'local/my-site/feed', mounted: true }])
    expect(body.ok).toBe(true)
  })

  // 这一条是整个端点的理由：文件写对了、解析也过了，但**热重挂还没发生 / 那一轮失败了**。
  // 没有这一口的话，这个状态和"源本身不工作"长得一模一样。
  it('解析得动但 registry 里没有 → mounted:false，ok:false（"写了但没装载"）', async () => {
    writeLocalPackage('my-site', 'feed')
    const body = await get()
    expect(body.packages[0]!.sources).toEqual([{ id: 'local/my-site/feed', mounted: false }])
    expect(body.ok).toBe(false)
  })

  it('包写坏了 → 出一行带原文的 error，其余包照常列（一个坏包不掀翻这一口）', async () => {
    writeLocalPackage('good', 'feed')
    mountedIds.add('local/good/feed')
    const bad = join(root, 'recipes', 'broken')
    mkdirSync(bad, { recursive: true })
    writeFileSync(
      join(bad, 'package.json'),
      JSON.stringify({ stream: { type: 'recipe', name: 'broken', facility: 'broken', schemaVersion: 1 } }),
    )
    writeFileSync(join(bad, 'x.recipe.json'), '{ not json')

    const body = await get()
    const broken = body.packages.find((p) => p.id === 'broken')!
    expect(broken.error, '坏包必须带上原文——只说"失败了"等于让他重新猜一遍').toBeTruthy()
    expect(body.packages.find((p) => p.id === 'good')!.sources[0]!.mounted).toBe(true)
    expect(body.ok).toBe(false)
  })

  it('命名空间是 local/<目录名>：改目录名就换命名空间，不与任何 npm 包相等', async () => {
    writeLocalPackage('another-name', 'feed')
    const body = await get()
    expect(body.packages[0]!.sources[0]!.id).toBe('local/another-name/feed')
  })
})
