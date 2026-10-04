import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readEmbeddedFromDir, writeEmbeddedToDir } from './recipe-embed.ts'
import { loadRecipePackages } from '../replay/recipe-package.ts'
import type { EmbeddedRecipePackage } from './bundle-format.ts'

/** 一份 loader 能通过校验的最小 recipe 体（kind:browser）。 */
const validRecipe = (sourceId: string) => JSON.stringify({
  version: 1, kind: 'browser', sourceId, cookieDomain: 'x.com', entryUrl: 'https://x.com/',
  loginCheck: { loggedIn: '.me', wall: '.login-wall' },
  actions: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 3, noProgressStop: 2 }],
  harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 2, mapping: { title: 't' }, assert: [] },
})

/** 造一个内嵌包（packageJson 里可控 name/facility）。 */
function mkEmbedded(over: { name?: string; facility?: string; sourceId?: string } = {}): EmbeddedRecipePackage {
  const facility = over.facility ?? 'xhs'
  const sourceId = over.sourceId ?? 'xhs-home'
  const pkgJson: Record<string, unknown> = { version: '1.0.0', stream: { type: 'recipe', facility, schemaVersion: 1 } }
  if (over.name !== undefined) pkgJson.name = over.name
  return {
    facility,
    packageJson: JSON.stringify(pkgJson),
    recipeFiles: { [`${sourceId}.recipe.json`]: validRecipe(sourceId) },
  }
}

describe('recipe embed 落盘/读取对偶', () => {
  it('read → write → 目录逐字一致', () => {
    const src = mkdtempSync(join(tmpdir(), 'rsrc-'))
    const pkgDir = join(src, 'xhs')
    mkdirSync(pkgDir)
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@streamapp/xhs', version: '1.0.0',
      stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 },
    }))
    writeFileSync(join(pkgDir, 'xhs-home.recipe.json'), '{"sourceId":"xhs-home"}')

    const embedded = readEmbeddedFromDir(pkgDir)
    expect(embedded.facility).toBe('xhs')
    expect(embedded.recipeFiles['xhs-home.recipe.json']).toContain('xhs-home')

    const dstRoot = mkdtempSync(join(tmpdir(), 'rdst-'))
    writeEmbeddedToDir(embedded, dstRoot)
    // 落盘目录 = dirNameFor(name)（@streamapp/xhs → @streamapp__xhs），不是 facility 单段 xhs。
    expect(existsSync(join(dstRoot, '@streamapp__xhs', 'package.json'))).toBe(true)
    expect(readFileSync(join(dstRoot, '@streamapp__xhs', 'xhs-home.recipe.json'), 'utf8')).toContain('xhs-home')
  })

  it('往返回归锁：读一个真实 builtin 包 → embed → 写到临时 userDir → loadRecipePackages 能认出（防 embed 读写与 loader 解析不一致的回归）', () => {
    const builtinPkgDir = join(process.cwd(), 'packages', 'telegram')
    const embedded = readEmbeddedFromDir(builtinPkgDir)
    expect(embedded.facility).toBe('telegram')

    const userDir = mkdtempSync(join(tmpdir(), 'recipe-user-'))
    writeEmbeddedToDir(embedded, userDir)

    const loaded = loadRecipePackages(userDir)
    const pkg = loaded.descriptors.find((d) => d.facility === 'telegram')
    expect(pkg).toBeTruthy()
    expect(pkg!.sources.length).toBeGreaterThan(0)
  })
})

describe('I-2：writeEmbeddedToDir 落盘身份与 npm install 对齐', () => {
  it('有 name → 落到 dirNameFor(name)，不是 facility 单段', () => {
    const dst = mkdtempSync(join(tmpdir(), 'i2a-'))
    writeEmbeddedToDir(mkEmbedded({ name: '@streamapp/xhs', facility: 'xhs' }), dst)
    expect(existsSync(join(dst, '@streamapp__xhs'))).toBe(true)
    expect(existsSync(join(dst, 'xhs'))).toBe(false)
  })

  it('无 name → 回落 facility 单段', () => {
    const dst = mkdtempSync(join(tmpdir(), 'i2b-'))
    writeEmbeddedToDir(mkEmbedded({ name: undefined, facility: 'toubiec' }), dst)
    expect(existsSync(join(dst, 'toubiec'))).toBe(true)
  })

  it('name 非法（含 ../）→ 抛错，不落盘', () => {
    const dst = mkdtempSync(join(tmpdir(), 'i2c-'))
    expect(() => writeEmbeddedToDir(mkEmbedded({ name: '@x/../../evil' }), dst)).toThrow()
    // 抛在任何写盘之前：目录里一个子项都不该有。
    expect(readdirSync(dst)).toEqual([])
  })

  it('name 为空串 → 当作无 name，回落 facility（不抛）', () => {
    const dst = mkdtempSync(join(tmpdir(), 'i2d-'))
    writeEmbeddedToDir(mkEmbedded({ name: '', facility: 'lizhi' }), dst)
    expect(existsSync(join(dst, 'lizhi'))).toBe(true)
  })

  // I-2 的回归锁：同一 logical 包经「bundle 分享」和「npm install」两条路进来，
  // 必须收敛到同一个目录、loadRecipePackages 不抛 duplicate sourceId（否则下次重启崩）。
  it('同一包两条路 → 只有一个目录、loadRecipePackages 不抛', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'i2coexist-'))

    // 路 A：bundle 分享落盘
    writeEmbeddedToDir(mkEmbedded({ name: '@streamapp/xhs', facility: 'xhs', sourceId: 'xhs-home' }), userDir)
    // 路 B：npm install 同名包落盘（dirNameFor(@streamapp/xhs) = @streamapp__xhs），逐字模拟 install 的落点
    const npmDir = join(userDir, '@streamapp__xhs')
    mkdirSync(npmDir, { recursive: true })
    writeFileSync(join(npmDir, 'package.json'), JSON.stringify({
      name: '@streamapp/xhs', version: '1.0.1', stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 },
    }))
    writeFileSync(join(npmDir, 'xhs-home.recipe.json'), validRecipe('xhs-home'))

    // 目录数：@streamapp__xhs 恰好一个，没有第二份 xhs/
    const dirs = readdirSync(userDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    expect(dirs).toEqual(['@streamapp__xhs'])

    // loader 不撞 duplicate sourceId（两条路同 sourceId 若落两个目录会在此抛）
    expect(() => loadRecipePackages(userDir)).not.toThrow()
    const loaded = loadRecipePackages(userDir)
    expect(loaded.descriptors.filter((d) => d.facility === 'xhs').length).toBe(1)
  })
})
