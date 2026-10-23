import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { loadRecipePackages, USER_LAYER_SCAN } from './recipe-package.ts'
import { previewRecipePackage, type RecipeInstallDeps } from './recipe-install.ts'
import { occupiedByBuiltins } from '../packages/activate.ts'
import type { RegistryClient } from './recipe-registry.ts'

// 东财的登录 recipe 原样拿来当夹具：它声明了 meta.login 与 secret_params [zjzh, jymm]。
const LOGIN_RECIPE = readFileSync(join(import.meta.dirname, '../../packages/eastmoney/eastmoney-login.recipe.json'), 'utf-8')
const pkgJson = (whoami: unknown) => JSON.stringify({
  name: '@acme/broker',
  version: '1.0.0',
  stream: { id: 'eastmoney', credentials: ['eastmoneysec.com'], whoami },
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'whoami-pkg-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function writePkg(whoami: unknown, withLogin = true): void {
  const dir = join(root, 'broker')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), pkgJson(whoami))
  if (withLogin) writeFileSync(join(dir, 'eastmoney-login.recipe.json'), LOGIN_RECIPE)
}

describe('whoami.login 的装载校验', () => {
  it('param 是登录 recipe 的 secret_params 之一 → 照常装载', () => {
    writePkg({ kind: 'login', param: 'zjzh' })
    expect(loadRecipePackages(root, USER_LAYER_SCAN).descriptors.map((d) => d.facility)).toEqual(['eastmoney'])
  })

  it('param 不在 secret_params 里 → 拒这个包', () => {
    writePkg({ kind: 'login', param: 'account' })
    expect(() => loadRecipePackages(root, USER_LAYER_SCAN)).toThrow(/stream\.whoami\.param — "account" 不是登录 recipe 的 secret_params 之一/)
  })

  it('包里没有登录 recipe → 拒', () => {
    writePkg({ kind: 'login', param: 'zjzh' }, false)
    expect(() => loadRecipePackages(root, USER_LAYER_SCAN)).toThrow(/没有 facility "eastmoney" 的登录 recipe/)
  })
})

// 最小 ustar（同 recipe-install.test.ts 的 packTgz）。
function packTgz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf-8')
    const h = Buffer.alloc(512)
    h.write(`package/${path}`, 0, 100, 'utf-8')
    h.write('0000644\0', 100, 8)
    h.write('0000000\0', 108, 8)
    h.write('0000000\0', 116, 8)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12)
    h.write('00000000000\0', 136, 12)
    h.write('        ', 148, 8)
    h[156] = 0x30
    h.write('ustar\0', 257, 6)
    h.write('00', 263, 2)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    parts.push(h, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function deps(files: Record<string, string>): RecipeInstallDeps {
  const tgz = packTgz(files)
  const registry: RegistryClient = {
    async packument() { return { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://reg.example/t.tgz' } } } } },
    async tarball() { return tgz },
    async search() { return [] },
  }
  return {
    registry,
    userDir: root,
    builtinPackageSourceIds: () => [],
    facilityRateLimit: () => undefined,
    hostVersion: '1.2.3',
    occupiedNames: () => occupiedByBuiltins([]),
  }
}

describe('whoami 的安装校验', () => {
  it('login.param 越界在安装口就拒', async () => {
    await expect(previewRecipePackage(deps({
      'package.json': pkgJson({ kind: 'login', param: 'account' }),
      'eastmoney-login.recipe.json': LOGIN_RECIPE,
    }), '@acme/broker')).rejects.toThrow(/stream\.whoami\.param/)
  })

  it('url 越界在安装口就拒', async () => {
    await expect(previewRecipePackage(deps({
      'package.json': pkgJson({ kind: 'http', url: 'https://evil.example/me', id: 'id' }),
    }), '@acme/broker')).rejects.toThrow(/stream\.whoami\.url/)
  })

  it('合法的 login 形状照常预览', async () => {
    const r = await previewRecipePackage(deps({
      'package.json': pkgJson({ kind: 'login', param: 'zjzh' }),
      'eastmoney-login.recipe.json': LOGIN_RECIPE,
    }), '@acme/broker')
    expect(r.facility).toBe('eastmoney')
  })
})
