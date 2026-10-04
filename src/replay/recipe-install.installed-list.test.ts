import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listInstalledRecipePackages } from './recipe-install.ts'
import { RECIPE_PACKAGE_SCHEMA_VERSION } from './recipe-package.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recipe-installed-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const RECIPE_JSON = JSON.stringify({
  version: 1, kind: 'browser', sourceId: 'demo-feed', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
  loginCheck: { loggedIn: '.me', wall: '.login-wall' },
  actions: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 3, noProgressStop: 2 }],
  harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 2, mapping: { title: 't' }, assert: [] },
})

/** 写一个最小合法包到 <dir>/<facility>/。npmName=null → 手放的本地包(package.json 无 name)。 */
function writePkg(facility: string, sourceId: string, npmName: string | null, version?: string, code?: { entry: string; adapters?: string[] }) {
  const p = join(dir, facility)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    ...(npmName ? { name: npmName } : {}),
    ...(version ? { version } : {}),
    stream: { type: 'recipe', facility, schemaVersion: RECIPE_PACKAGE_SCHEMA_VERSION, cookieDomain: 'x.com', ...(code ? { code } : {}) },
  }))
  const recipe = JSON.parse(RECIPE_JSON)
  recipe.sourceId = sourceId
  writeFileSync(join(p, `${sourceId}.recipe.json`), JSON.stringify(recipe))
}

describe('listInstalledRecipePackages', () => {
  it('装了两个包 → 各给出 name/version/facility 与它带进来的源 id', () => {
    writePkg('xhs', 'xhs-home', '@streamapp/xhs', '1.2.0')
    writePkg('telegram', 'tg-channel', '@streamapp/telegram', '0.3.1')
    const list = listInstalledRecipePackages(dir).sort((a, b) => a.name.localeCompare(b.name))
    expect(list).toEqual([
      // sourceIds 是**全名**：管理面列的必须是它装上之后真正叫什么。
      { name: '@streamapp/telegram', version: '0.3.1', facility: 'telegram', sourceIds: ['@streamapp/telegram/tg-channel'], hasCode: false },
      { name: '@streamapp/xhs', version: '1.2.0', facility: 'xhs', sourceIds: ['@streamapp/xhs/xhs-home'], hasCode: false },
    ])
  })

  it('带 stream.code 的包被标出 hasCode（卸载确认要靠它说「重启后才真正卸下」）', () => {
    writePkg('coded', 'coded-feed', '@third/coded', '2.0.0', { entry: 'dist/index.js', adapters: ['coded'] })
    writePkg('xhs', 'xhs-home', '@streamapp/xhs', '1.2.0')
    const byName = new Map(listInstalledRecipePackages(dir).map((p) => [p.name, p.hasCode]))
    expect(byName.get('@third/coded')).toBe(true)
    expect(byName.get('@streamapp/xhs')).toBe(false)
  })

  it('空目录 → 空数组，不是错误', () => {
    expect(listInstalledRecipePackages(dir)).toEqual([])
  })

  it('目录不存在 → 空数组', () => {
    expect(listInstalledRecipePackages(join(dir, 'nope'))).toEqual([])
  })

  it('没有 name 的目录（手放的本地包，非 npm 管理）被跳过', () => {
    writePkg('local', 'local-feed', null)
    writePkg('xhs', 'xhs-home', '@streamapp/xhs', '1.2.0')
    expect(listInstalledRecipePackages(dir).map((p) => p.name)).toEqual(['@streamapp/xhs'])
  })
})
