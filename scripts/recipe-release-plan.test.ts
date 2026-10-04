import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  firstPublishHint,
  isNpmNotFound,
  offendingPackFiles,
  parseNpmVersions,
  readRecipePackages,
  selectPackagesToPublish,
  type RecipePackageInfo,
} from './recipe-release-plan.ts'

const pkg = (over: Partial<RecipePackageInfo>): RecipePackageInfo =>
  ({ dir: '/p/x', name: '@streamapp/x', version: '1.0.0', private: false, publishable: true, code: false, ...over })

describe('selectPackagesToPublish', () => {
  it('可发的包、非 private、已在 npm 上（旧版本）、这个版本还没有 → 发', () => {
    expect(selectPackagesToPublish([pkg({})], () => ['0.9.0'])).toHaveLength(1)
  })
  it('带代码的包同一把尺：npm 上有旧版、本版本未发 → 发', () => {
    expect(selectPackagesToPublish([pkg({ code: true })], () => ['0.9.0'])).toHaveLength(1)
  })
  it('该版本已在 npm → 跳过（重跑流水线是绿的）', () => {
    expect(selectPackagesToPublish([pkg({})], () => ['1.0.0'])).toEqual([])
  })
  it('包压根不在 npm 上（undefined）→ 跳过，即使版本是新的——首发是人为动作', () => {
    expect(selectPackagesToPublish([pkg({})], () => undefined)).toEqual([])
  })
  it('包压根不在 npm 上（空数组）→ 跳过，即使版本是新的——首发是人为动作', () => {
    expect(selectPackagesToPublish([pkg({})], () => [])).toEqual([])
  })
  it('带代码的包不在 npm 上（模拟 npm view 回 E404 → 空列表）→ 跳过，且打出「首发请人工」提示带 bundle 步', () => {
    const logs: string[] = []
    const p = pkg({ name: '@streamapp/eastmoney', dir: '/repo/packages/eastmoney', code: true })
    expect(selectPackagesToPublish([p], () => [], (m) => logs.push(m))).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('首发请人工')
    expect(logs[0]).toContain('@streamapp/eastmoney@1.0.0')
    expect(logs[0]).toContain('cd /repo/packages/eastmoney && pnpm bundle && npm publish --access public')
  })
  it('纯 recipe 包的首发提示不带 bundle 步；已在 npm 上的包不打提示', () => {
    expect(firstPublishHint(pkg({}))).not.toContain('bundle')
    const logs: string[] = []
    selectPackagesToPublish([pkg({})], () => ['0.9.0'], (m) => logs.push(m))
    expect(logs).toEqual([])
  })
  it('private / 不可发（没 recipe 也没代码） / 没有 name → 不发，也不打首发提示', () => {
    const logs: string[] = []
    expect(selectPackagesToPublish([
      pkg({ private: true }),
      pkg({ name: '@streamapp/plugin', publishable: false }),
      pkg({ name: '' }),
    ], () => [], (m) => logs.push(m))).toEqual([])
    expect(logs).toEqual([])
  })
})

/** 判"可不可发"走的是装载器那把尺（`parseStreamDescriptor` + 有无 `*.recipe.json` + 有无 `stream.code`），
 *  不读 `stream.type`。对着仓库真实的内置包目录钉一个数：31 个纯 recipe 包 + 13 个带代码且可发的包 = 44
 *  （v2ex / hackernews / cloudflare / xunlei / shooter / omdb 是纯代码包，没有 recipe 文件，靠 `stream.code` 进可发名单；
 *  没在 npm 上的，CI 只打「首发请人工」，不会自动发）。rsshub 也带代码，但它是 `required` 的宿主内核包、保持 private。
 *  另外 3 个带容器的带代码包（alist / pansou / douyin-tiktok-download-api）保持 private——
 *  第三方容器钳制（service 由宿主指派、必须写 mem、id 文法）与用户层同名容器包的顶掉/并存都还没设计，
 *  见 docs/TODO.md「带容器的内置包怎么走 npm 安装」。
 *  以后加一个内置包这条会变红，改数之前先回答：它该不该被 CI 发到 npm。 */
describe('readRecipePackages（真实内置包目录）', () => {
  const packagesDir = resolve(fileURLToPath(import.meta.url), '..', '..', 'packages')
  const CODE_PACKAGE_NAMES = [
    '@streamapp/bilibili',
    '@streamapp/cloudflare',
    '@streamapp/eastmoney',
    '@streamapp/firecrawl',
    '@streamapp/hackernews',
    '@streamapp/netease',
    '@streamapp/omdb',
    '@streamapp/shooter',
    '@streamapp/telegram',
    '@streamapp/v2ex',
    '@streamapp/xhs',
    '@streamapp/xueqiu',
    '@streamapp/xunlei',
  ]
  const PRIVATE_CONTAINER_CODE_PACKAGE_NAMES = [
    '@streamapp/alist',
    '@streamapp/douyin-tiktok-download-api',
    '@streamapp/pansou',
  ]
  it('恰好 44 个可发的包（31 纯 recipe + 13 带代码），13 个带代码的逐名在内且都不 private', () => {
    const all = readRecipePackages(packagesDir)
    const publishable = all.filter((p) => p.publishable && !p.private)
    expect(publishable).toHaveLength(44)
    expect(publishable.map((p) => p.name)).toContain('@streamapp/wechat')
    const codePkgs = publishable.filter((p) => p.code).map((p) => p.name).sort()
    expect(codePkgs).toEqual(CODE_PACKAGE_NAMES)
    // 带代码的包出预编译的 `dist/index.js`（`pnpm packages:bundle`）走同一条流水线，所以不能 private
    for (const name of CODE_PACKAGE_NAMES) {
      const p = all.find((x) => x.name === name)!
      expect(p.private, name).toBe(false)
      expect(p.code, name).toBe(true)
    }
  })
  it('3 个带容器的带代码包仍保持 private——安装门今天装不进它们', () => {
    const all = readRecipePackages(packagesDir)
    for (const name of PRIVATE_CONTAINER_CODE_PACKAGE_NAMES) {
      const p = all.find((x) => x.name === name)!
      expect(p.private, name).toBe(true)
      expect(p.code, name).toBe(true)
      expect(p.publishable, name).toBe(true)
    }
  })
  it('纯 recipe 包 `code` 为假（发之前不用 bundle）', () => {
    const wechat = readRecipePackages(packagesDir).find((p) => p.name === '@streamapp/wechat')!
    expect(wechat.code).toBe(false)
    expect(wechat.publishable).toBe(true)
  })
})

describe('parseNpmVersions', () => {
  it('数组照收（只留字符串）', () => {
    expect(parseNpmVersions(['1.0.0', '1.0.1', 2])).toEqual(['1.0.0', '1.0.1'])
  })
  it('只有一个版本时 npm 不包数组——单个字符串包成一项', () => {
    expect(parseNpmVersions('1.0.0')).toEqual(['1.0.0'])
  })
  it('别的形状（对象 / null / 数字）→ 空', () => {
    expect(parseNpmVersions({ error: {} })).toEqual([])
    expect(parseNpmVersions(null)).toEqual([])
    expect(parseNpmVersions(7)).toEqual([])
  })
})

describe('isNpmNotFound', () => {
  it('stdout / stderr / message 任一处带 E404 → 是 404', () => {
    expect(isNpmNotFound({ stdout: '{"error":{"code":"E404"}}' })).toBe(true)
    expect(isNpmNotFound({ stderr: 'npm error code E404\n' })).toBe(true)
    expect(isNpmNotFound({ message: 'Command failed: E404' })).toBe(true)
  })
  it('断网 / 限流 / 鉴权错不是 404——这些必须让流水线红，不能当"没上过 npm"', () => {
    expect(isNpmNotFound({ stderr: 'npm error code ENOTFOUND\nnpm error network request failed' })).toBe(false)
    expect(isNpmNotFound({ stderr: 'npm error code E429' })).toBe(false)
    expect(isNpmNotFound({ stderr: 'npm error code E401' })).toBe(false)
    expect(isNpmNotFound({})).toBe(false)
  })
})

describe('offendingPackFiles', () => {
  it('白名单之外的文件被点名（与安装侧同一份判据）', () => {
    expect(offendingPackFiles(['package.json', 'wechat-send.recipe.json', 'README.md', 'notes/x.txt', '.env']))
      .toEqual(['notes/x.txt', '.env'])
  })
})
