import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  previewRecipePackage,
  installRecipePackage,
  uninstallRecipePackage,
  checkRecipeUpdates,
  currentVersion,
  planRecipeUpdates,
  formatRecipeUpdateNotice,
  listInstalledRecipePackages,
  dirNameFor,
  readHostVersion,
  assertInstallable,
  type RecipeInstallDeps,
} from './recipe-install.ts'
import { parseStreamDescriptor } from '../packages/descriptor.ts'
import type { RegistryClient, Packument } from './recipe-registry.ts'
import { loadRecipePackages, TRUST_SIDECAR } from './recipe-package.ts'
import { occupiedByBuiltins, withInstalled } from '../packages/activate.ts'
import type { StreamPackage } from '../packages/scan.ts'

// ---------------------------------------------------------------------------
// packTgz: build a minimal valid ustar tarball (gzipped) for test fixtures.
// untarGz() (Task 6) never validates the checksum field, but we compute it
// per the POSIX ustar spec anyway (cheap, and keeps the fixture byte-for-byte
// compatible with a real `npm pack` output, not just with our own parser).
// ---------------------------------------------------------------------------
function tarHeader(path: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(path, 0, 100, 'utf-8')
  buf.write('0000644\0', 100, 8)
  buf.write('0000000\0', 108, 8)
  buf.write('0000000\0', 116, 8)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12)
  buf.write('        ', 148, 8) // checksum field treated as 8 spaces while summing
  buf[156] = 0x30 // typeflag '0' = regular file
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

function packTgz(files: Record<string, string>): Buffer {
  return packTgzEntries(Object.entries(files))
}

/** 同一个 path 可以出现多次——tar 就是一串条目，没有"键唯一"这回事（`Record` 表达不出来）。
 *  这正是「校验的和落盘的不是同一份字节」那条漏洞的形状。 */
function packTgzEntries(files: Array<[string, string]>): Buffer {
  const parts: Buffer[] = []
  for (const [path, content] of files) {
    const data = Buffer.from(content, 'utf-8')
    parts.push(tarHeader(`package/${path}`, data.length))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024)) // two zero blocks = end-of-archive marker
  return gzipSync(Buffer.concat(parts))
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const PKG_NAME = '@streamapp/xhs'
const PKG_VERSION = '1.0.0'

const VALID_RECIPE = {
  version: 1,
  kind: 'http',
  sourceId: 'xhs-search',
  request: { url: 'https://example.com/api/search', method: 'GET' },
  pagination: { mode: 'increment', itemsAt: 'data.items', maxPages: 1, param: 'page', start: 0, step: 1 },
  assert: [],
  mapping: {},
  meta: { description: 'search xhs posts', effects: ['write'], capabilities: ['timeline'], params_schema: { q: {} } },
}

function pkgJson(stream: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: PKG_NAME,
    version: PKG_VERSION,
    stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1, ...stream },
    ...extra,
  })
}

/** 新形描述：没有 `type`、没有 `schemaVersion`，身份靠 `id`（P1 起目录扫描就受理这一形）。 */
function unifiedPkgJson(stream: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: PKG_NAME,
    version: PKG_VERSION,
    stream: { id: 'xhs', ...stream },
    ...extra,
  })
}

function makeRegistry(files: Record<string, string>, version = PKG_VERSION, integrity?: string): RegistryClient {
  return makeRegistryFromTgz(packTgz(files), version, integrity)
}

function makeRegistryFromTgz(tgz: Buffer, version = PKG_VERSION, integrity?: string): RegistryClient {
  const packument: Packument = {
    'dist-tags': { latest: version },
    versions: { [version]: { version, dist: { tarball: 'https://reg.example/t.tgz', ...(integrity && { integrity }) } } },
  }
  return {
    async packument() { return packument },
    async tarball() { return tgz },
    async search() { return [] },
  }
}

const TEST_HOST_VERSION = '1.2.3'

function makeDeps(overrides: Partial<RecipeInstallDeps> & { registry: RegistryClient }): RecipeInstallDeps {
  return {
    userDir: overrides.userDir ?? '',
    builtinPackageSourceIds: overrides.builtinPackageSourceIds ?? (() => []),
    facilityRateLimit: overrides.facilityRateLimit ?? (() => undefined),
    hostVersion: overrides.hostVersion ?? TEST_HOST_VERSION,
    occupiedNames: overrides.occupiedNames ?? (() => occupiedByBuiltins([])),
    ...overrides,
  }
}

let userDir: string
beforeEach(() => { userDir = mkdtempSync(join(tmpdir(), 'recipe-install-')) })
afterEach(() => { rmSync(userDir, { recursive: true, force: true }) })

describe('previewRecipePackage', () => {
  it('happy path: returns facility/clamped rateLimit/recipes(with effects)/confirm', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({ rateLimit: { burst: 10, perMinute: 20 } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({
      registry,
      userDir,
      facilityRateLimit: () => ({ burst: 5, perMinute: 30, maxWaitMs: 5000 }),
    })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.name).toBe(PKG_NAME)
    expect(preview.version).toBe(PKG_VERSION)
    expect(preview.facility).toBe('xhs')
    expect(preview.rateLimit).toEqual({ burst: 5, perMinute: 20, maxWaitMs: 5000 }) // clamped, not either side verbatim
    expect(preview.recipes).toEqual([
      { id: '@streamapp/xhs/xhs-search', description: 'search xhs posts', capabilities: ['timeline'], effects: ['write'], params: ['q'] },
    ])
    expect(preview.overrides).toEqual([])
    expect(typeof preview.confirm).toBe('string')
    expect(preview.confirm).toMatch(/^sha512-/)
  })

  it('preview 亮出 proxies：这个包会让后端替它连哪些主机（serving 的 match ∪ hosts）', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({ serving: [{ match: '.x.fm', hosts: ['cdn1.x.fm', 'cdn.y.com'], reason: 'r' }] }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.proxies).toEqual(['.x.fm', 'cdn1.x.fm', 'cdn.y.com'])
  })

  it('没有 serving 声明 → proxies 为空数组（确认页据此显示"不代理"）', async () => {
    const registry = makeRegistry({ 'package.json': pkgJson({}), 'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE) })
    expect((await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).proxies).toEqual([])
  })

  it('preview 亮出 providers：包声明的 Provider 行 id（确认页据此提示重启后生效）', async () => {
    const X_ROW = {
      id: 'x-track', category: 'resolve', serveKeys: ['x'], strategy: 'sequential',
      label: 'X', description: 'x', members: [{ mode: 'auto', matches: 'x.com/song', params: { id: '$input' } }],
    }
    const registry = makeRegistry({
      'package.json': pkgJson({ providers: [X_ROW] }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.providers).toEqual(['x-track'])
  })

  it('没有声明 providers → 空数组', async () => {
    const registry = makeRegistry({ 'package.json': pkgJson({}), 'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE) })
    expect((await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).providers).toEqual([])
  })

  it('rejects a tarball with a file outside the whitelist', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'evil.js': 'console.log("pwned")',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/whitelist/)
  })

  it('rejects when stream.type is not "recipe"', async () => {
    const registry = makeRegistry({
      'package.json': JSON.stringify({ name: PKG_NAME, version: PKG_VERSION, stream: { type: 'plugin', facility: 'xhs', schemaVersion: 1 } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow()
  })

  it('rejects a schemaVersion newer than this app supports', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({ schemaVersion: 99 }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/upgrade the app/)
  })

  // 「该 sourceId 已被另一个已装包占着 → 拒装」那道闸门撤了：命名空间化之后两个不同的包
  // 产不出同一个全名（全名相同 ⇒ npm 名相同 ⇒ 是同一个包），它挡的冲突已经不存在。
  it('别的包有个同名局部 recipe → 照装不误（两条全名并存，不是冲突）', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    // 内置层里那个同名包不叫 @streamapp/xhs —— 与正在装的这个不同名，一条都盖不到。
    const deps = makeDeps({ registry, userDir, builtinPackageSourceIds: () => [] })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.overrides).toEqual([])
    expect(preview.recipes.map((r) => r.id)).toEqual(['@streamapp/xhs/xhs-search'])
  })

  it('内置层有同 npm 名的包 → 记进 overrides（这是升级，不是李代桃僵）', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({
      registry,
      userDir,
      // 判据是**包名**：内置层那个 @streamapp/xhs 出的全名。
      builtinPackageSourceIds: (n) => (n === PKG_NAME ? ['@streamapp/xhs/xhs-search', '@streamapp/xhs/xhs-home'] : []),
    })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    // 只列**这一版真的会换掉**的那些：内置的 xhs-home 不在新包里，它留着。
    expect(preview.overrides).toEqual(['@streamapp/xhs/xhs-search'])
  })

  it('preview 展示的 recipe id 是全名（用户批准的名字 = 装上后它真正叫什么）', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.recipes.map((r) => r.id)).toEqual(['@streamapp/xhs/xhs-search'])
  })

  it('gives a readable error (not a bare TypeError) when the registry packument has no dist-tags', async () => {
    const registry: RegistryClient = {
      async packument() { return { versions: {} } as unknown as Packument },
      async tarball() { return Buffer.alloc(0) },
      async search() { return [] },
    }
    const deps = makeDeps({ registry, userDir })
    try {
      await previewRecipePackage(deps, PKG_NAME)
      expect.unreachable('expected previewRecipePackage to throw')
    } catch (err) {
      expect(String(err)).not.toMatch(/Cannot read propert/i) // not the bare TypeError
      expect(String(err)).toContain(PKG_NAME)
      expect(String(err)).toMatch(/dist-tags/)
    }
  })

  it('rejects when registry-declared integrity does not match the actual tarball hash', async () => {
    const registry = makeRegistry(
      { 'package.json': pkgJson({}), 'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE) },
      PKG_VERSION,
      'sha512-thisIsNotTheRealHashAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    )
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/integrity mismatch/)
  })

  it('C1 bypass sample: rejects README.js (extension outside the whitelist)', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'README.js': 'console.log("pwned via README")',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/whitelist/)
  })

  it('C1 bypass sample: rejects a nested path riding in under README\'s prefix (README.x/evil.js)', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'README.x/evil.js': 'console.log("pwned via nested path")',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/whitelist/)
  })

  it('I1: rejects a recipe whose meta fails recipeToManifest synthesis (install gate ≥ load gate)', async () => {
    const badRecipe = { ...VALID_RECIPE, meta: { ...VALID_RECIPE.meta, capabilities: ['not-a-real-capability'] } }
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(badRecipe),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow()
  })

  it('I1: rejects an invalid manifests.yaml entry', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'manifests.yaml': '- id: xhs-search\n  adapter: replay\n  capabilities: [not-a-real-capability]\n',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/manifests\.yaml/)
  })

  it('I2: rejects when the tarball\'s package.json declares a different name than requested', async () => {
    const registry = makeRegistry({
      'package.json': JSON.stringify({ name: '@someone/else', version: PKG_VERSION, stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/name mismatch/)
  })

  it('I4: rejects a tarball with more entries than the cap', async () => {
    const files: Record<string, string> = {
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    }
    // README isn't in the whitelist twice, so pad with... actually the whitelist only
    // allows 5 distinct shapes; use many *.recipe.json files (each a valid recipe with a
    // distinct sourceId) to blow the entry-count cap without touching the whitelist gate.
    for (let i = 0; i < 205; i++) {
      files[`extra-${i}.recipe.json`] = JSON.stringify({ ...VALID_RECIPE, sourceId: `extra-${i}` })
    }
    const registry = makeRegistry(files)
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/too many files/)
  })

  it('Minor: rejects a tarball larger than MAX_TARBALL_BYTES', async () => {
    // Bypass packTgz entirely — the size gate runs BEFORE untarGz/gunzip, so the stub can
    // just hand back an oversized buffer without it needing to be valid gzip at all.
    const registry: RegistryClient = {
      async packument() {
        return { 'dist-tags': { latest: PKG_VERSION }, versions: { [PKG_VERSION]: { version: PKG_VERSION, dist: { tarball: 'https://reg.example/big.tgz' } } } }
      },
      async tarball() { return Buffer.alloc(2 * 1024 * 1024 + 1) },
      async search() { return [] },
    }
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/too large/)
  })

  it('Minor: rejects an unpacked payload larger than MAX_UNPACKED_BYTES', async () => {
    // A single highly-compressible file whose DECOMPRESSED size blows the 20MB unpacked
    // cap, but whose gzipped size stays well under the 2MB tarball cap — proves the two
    // limits are independent gates (a small-on-the-wire tarball can still be a bomb).
    const registry = makeRegistry({ 'xhs-search.recipe.json': 'a'.repeat(21 * 1024 * 1024) })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/unpacked size too large/)
  })

  it('A2: rejects two recipe files in the SAME package declaring the same sourceId', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'xhs-search-2.recipe.json': JSON.stringify(VALID_RECIPE), // same sourceId: 'xhs-search'
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/more than one recipe file/)
  })

  it('accepts real npm-forced bundled docs: LICENCE (British), README.rst, CHANGELOG.md, NOTICE', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      LICENCE: 'MIT',
      'README.rst': 'title\n=====\n',
      'CHANGELOG.md': '# changelog',
      NOTICE: 'notice text',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).resolves.toBeDefined()
  })

  it('still rejects code files and nested paths riding in under the newly-widened names', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'evil.js': 'console.log("pwned")',
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/whitelist/)

    const registry2 = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'LICENSE.sh': 'echo pwned',
    })
    const deps2 = makeDeps({ registry: registry2, userDir })
    await expect(previewRecipePackage(deps2, PKG_NAME)).rejects.toThrow(/whitelist/)
  })
})

// ---------------------------------------------------------------------------
// P4: 统一描述 + 三道新闸门（代码入口白名单 / hostVersion / backend 拒绝）
// ---------------------------------------------------------------------------
const CODE_JS = 'export const activate = () => ({ adapters: {} })\n'

describe('P4: 安装口受理统一描述', () => {
  it('accepts the unified descriptor (no `type`, identity via `id`)', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.facility).toBe('xhs')
    expect(preview.recipes.map((r) => r.id)).toEqual(['@streamapp/xhs/xhs-search'])
  })

  it('falls back to `id` as the facility when the unified descriptor declares no facility', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson(),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.facility).toBe('xhs')
  })

  it('installs a unified-descriptor package to disk (whole path, not just preview)', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(existsSync(join(dir, 'xhs-search.recipe.json'))).toBe(true)
    // 盘上那份 package.json 仍是新形（描述解析不该把它改写成旧形）
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).stream.id).toBe('xhs')
  })
})

/**
 * 撞内置 = 安装期拒。装进来的后果全是 fail-closed 的开不了机（内置包被拖进动态 import / 撞名
 * 检查两边都不激活），而恢复路径是让用户去翻文件系统删包——所以必须在装进盘之前就拒掉，
 * 且消息要说清撞了谁、请改名。
 */
describe('P4 fix: 第三方包撞内置已占的名字 → 安装期拒绝', () => {
  /** 内置那一层的真身形状（bootstrap 注入的就是 `scanPackages(config.packages_dir)` 的产物）。 */
  const BUILTINS = [
    { id: 'alist', code: { entry: './activate.ts', adapters: ['alist'], normalizers: ['alist'] } },
    { id: 'pansou', code: { entry: './activate.ts', adapters: ['pansou'], normalizers: ['pansou'] } },
  ] as unknown as StreamPackage[]
  const occupiedNames = () => occupiedByBuiltins(BUILTINS)

  it('拒绝一个 stream.id 撞上内置包 id 的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'alist' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir, occupiedNames })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/alist/)
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/内置|builtin/)
  })

  // 回归（活体实测：目录并轨后 preview @streamapp/toubiec → 400）。内置那 29 个包里 19 个是
  // **纯 recipe 包**，它们的 id 不该占位：用户层覆盖内置 recipe 包正是这条线支持的能力，
  // 一占位，官方随应用发布的每个 recipe 包就装不了也升不了。
  it('放行一个 stream.id 撞上内置【纯 recipe 包】id 的包——那是受支持的覆盖', async () => {
    const occupiedWithPureRecipe = () => occupiedByBuiltins([
      ...BUILTINS,
      { id: 'toubiec', facility: 'toubiec', cookieDomain: 'toubiec.cn' },
    ] as unknown as StreamPackage[])
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'toubiec', facility: 'toubiec' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir, occupiedNames: occupiedWithPureRecipe })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.facility).toBe('toubiec')
  })

  it('拒绝一个 adapter 名撞上内置包已占名字的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'notalist', code: { entry: 'dist/index.js', adapters: ['pansou'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/pansou/)
  })

  it('拒绝一个 normalizer 名撞上内置包已占名字的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'notalist', code: { entry: 'dist/index.js', normalizers: ['alist'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/alist/)
  })

  // enricher 名 / connect 域名在 activatePackages 第一段撞上同样是「两边都不激活」→ 抛 → packages 域
  // 起不来；一个**不同名**的第三方包申报了内置已占的那一个，装得进、下次启动才炸。所以两格都拒在安装门。
  const BUILTINS_WITH_ENRICH = [
    ...BUILTINS,
    { id: 'xhs', pkgName: '@streamapp/xhs', credentials: ['xiaohongshu.com'], code: { entry: './activate.ts', adapters: ['xhs'], enrichers: ['xhs-detail'], connect: ['xiaohongshu.com'] } },
  ] as unknown as StreamPackage[]

  it('拒绝一个 enricher 名撞上内置包已占名字的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'notxhs', code: { entry: 'dist/index.js', enrichers: ['xhs-detail'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames: () => occupiedByBuiltins(BUILTINS_WITH_ENRICH) })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/enricher "xhs-detail"/)
  })

  it('拒绝一个 connect 域名撞上内置包已占域名的包（大小写不同也算撞）', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'notxhs', credentials: ['XiaoHongShu.com'], code: { entry: 'dist/index.js', connect: ['XiaoHongShu.com'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames: () => occupiedByBuiltins(BUILTINS_WITH_ENRICH) })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/connect 域名 "XiaoHongShu\.com"/)
  })

  it('同 npm 名的新版申报同一个 enricher / connect 照常放行——那是自我升级', async () => {
    // PKG_NAME 就是 '@streamapp/xhs'，与 BUILTINS_WITH_ENRICH 里内置 xhs 的 npm 名一致
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', credentials: ['xiaohongshu.com'], code: { entry: 'dist/index.js', adapters: ['xhs'], enrichers: ['xhs-detail'], connect: ['xiaohongshu.com'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames: (self: string) => occupiedByBuiltins(BUILTINS_WITH_ENRICH, self) })
    await expect(previewRecipePackage(deps, PKG_NAME)).resolves.toMatchObject({ code: { adapters: ['xhs'] } })
    // 不剔自己（旧接线）→ 就是那条 enricher 拒绝
    await expect(
      previewRecipePackage(makeDeps({ registry, userDir, occupiedNames: () => occupiedByBuiltins(BUILTINS_WITH_ENRICH) }), PKG_NAME),
    ).rejects.toThrow(/同名|xhs/)
  })

  // 宿主自己的四件 adapter 名在 activatePackages 那头已经是保留名（fail-closed 开不了机），
  // 安装期同样要拒——占用表天然含着它们，不用在这边另写一份名单。
  it('拒绝宿主保留的 adapter 名（占用表自带，不用另写名单）', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'notalist', code: { entry: 'dist/index.js', adapters: ['rsshub'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/rsshub/)
  })

  it('不撞的照常放行（闸门不是把所有带代码的包都拒了）', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', adapters: ['xhs-demo'], normalizers: ['xhs-demo'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir, occupiedNames }), PKG_NAME)
    expect(preview.code).toEqual({ entry: 'dist/index.js', adapters: ['xhs-demo'], normalizers: ['xhs-demo'] })
  })

  // 占用表的取法不许随内置包增减而漂：它从**内置包自己申报的 stream.code** 推出来，
  // 加一个内置包 = 占用表自动多一行，没有第二份名单要跟着改。
  it('占用表由内置包自己申报的 code 推出来，外加宿主四件保留名', () => {
    const occupied = occupiedByBuiltins(BUILTINS)
    expect(occupied.ids).toEqual(new Set(['alist', 'pansou']))
    expect(occupied.normalizers).toEqual(new Set(['alist', 'pansou']))
    for (const n of ['alist', 'pansou', 'builtin', 'rsshub', 'replay', 'browser']) {
      expect(occupied.adapters.has(n)).toBe(true)
    }
  })

  // 内置带 code 的包也发 npm（今天 4 个）：装 `@streamapp/xhs` 的新版就是装**同一个包**——它申报的 id /
  // adapter / normalizer 与内置那份一字不差。占用表按 npm 名剔掉那一个内置包（bootstrap 传
  // `occupiedByBuiltins(packages, selfPkgName)`），否则这条自我升级路在安装门就被拒，启动时
  // 「同名两层只激活一层」（pick-layer）永远轮不到。
  it('放行与内置带 code 的包【同 npm 名】的新版——名字一字不差是自我升级，不是撞名', async () => {
    const builtinsWithXhs = [
      ...BUILTINS,
      { id: 'xhs', pkgName: PKG_NAME, code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs'], enrichers: ['xhs-detail'] } },
    ] as unknown as StreamPackage[]
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', adapters: ['xhs'], normalizers: ['xhs'], enrichers: ['xhs-detail'] } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir, occupiedNames: (self: string) => occupiedByBuiltins(builtinsWithXhs, self) })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.code?.adapters).toEqual(['xhs'])
    // 不按 npm 名剔（旧接线）→ 就是那条"与内置插件包同名"的拒绝
    await expect(
      previewRecipePackage(makeDeps({ registry, userDir, occupiedNames: () => occupiedByBuiltins(builtinsWithXhs) }), PKG_NAME),
    ).rejects.toThrow(/同名|xhs/)
  })
})

describe('P4: 白名单只对 dist/index.js 这一个字面路径开例外', () => {
  const codeStream = { facility: 'xhs', code: { entry: 'dist/index.js', adapters: ['demo'], normalizers: ['demo-norm'] } }

  it('accepts exactly one declared code entry and surfaces it in the preview', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson(codeStream),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.code).toEqual({ entry: 'dist/index.js', adapters: ['demo'], normalizers: ['demo-norm'] })
    // 既有字段一个不动（前端在用）
    expect(preview.facility).toBe('xhs')
    expect(preview.overrides).toEqual([])
    expect(preview.confirm).toMatch(/^sha512-/)

    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf-8')).toBe(CODE_JS)
  })

  it('omits `code` from the preview when the package declares none', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)
    expect(preview.code).toBeUndefined()
    // 纯数据包两格都该空着——`capability` 恒有值的话，确认页会把每一个 recipe 包都吓一遍，
    // 而"所有包都最高档"等于没有分级。
    expect(preview.capability).toBeUndefined()
  })

  it('rejects a dist/index.js that the package did NOT declare (stowaway code)', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(/stream\.code/)
  })

  it('rejects a declared code entry that is missing from the tarball', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson(codeStream),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(/dist\/index\.js/)
  })

  it('rejects a code.entry pointing anywhere else', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs', code: { entry: 'dist/main.js' } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(/dist\/index\.js/)
  })

  // 铁律：verifyTarball 拒绝任何含 `/` 的路径。放行的是**一个字面串**，不是一条 pattern —
  // 任何拼写变体（大小写、双斜杠、前缀 `./`、`..`）都必须照拒。
  const slashVariants = [
    'dist/evil.js',
    'dist/nested/x.js',
    'src/index.js',
    './dist/index.js',
    'dist//index.js',
    'DIST/INDEX.JS',
    '../dist/index.js',
    'dist/../dist/index.js',
    'dist/./index.js',
  ]
  // `..` 形态在更早一层（untarGz 的越界检查）就被挡下，所以两条消息都算过关。
  const REFUSED = /whitelist|escapes package root/
  for (const bad of slashVariants) {
    it(`rejects "${bad}" (whitelist)`, async () => {
      const registry = makeRegistry({
        'package.json': unifiedPkgJson({ facility: 'xhs' }),
        'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
        [bad]: 'console.log("pwned")',
      })
      await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(REFUSED)
    })

    it(`rejects "${bad}" even when riding alongside a legitimately declared dist/index.js`, async () => {
      const registry = makeRegistry({
        'package.json': unifiedPkgJson(codeStream),
        'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
        'dist/index.js': CODE_JS,
        [bad]: 'console.log("pwned")',
      })
      await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(REFUSED)
    })
  }

  // 反斜杠：白名单的 recipe pattern 里 `[^/]*` 是**允许** `\` 的，而 untarGz 的越界检查也只按
  // `/` 切段——于是在 Windows（桌面端的 sidecar 后端就跑在那儿）上 join() 把 `\` 当分隔符，
  // 一个内容合法的 recipe JSON 就能写到包目录外面去。任何含 `\` 的路径一律拒。
  const backslashVariants = [
    'a\\..\\..\\..\\evil.recipe.json',
    '..\\evil.recipe.json',
    'sub\\x.recipe.json',
    'dist\\index.js',
    'READ\\ME.md',
  ]
  for (const bad of backslashVariants) {
    it(`rejects "${bad}" (backslash is a path separator on Windows)`, async () => {
      const registry = makeRegistry({
        'package.json': unifiedPkgJson({ facility: 'xhs' }),
        'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
        [bad]: JSON.stringify(VALID_RECIPE),
      })
      await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(REFUSED)
    })
  }
})

describe('P4: hostVersion 闸门', () => {
  it('rejects a package demanding a host newer than this one, naming the actual host version', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs', hostVersion: '>=99.0.0' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/99\.0\.0/)
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(new RegExp(TEST_HOST_VERSION.replace(/\./g, '\\.')))
  })

  it('accepts a satisfied hostVersion', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs', hostVersion: '>=1.0.0' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).resolves.toBeDefined()
  })

  it('readHostVersion() reads the repo root package.json — the host version is never hardcoded', () => {
    const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'))
    expect(readHostVersion()).toBe(root.version)
  })

  // 打包后的后端是 esbuild 打出来的单文件 server.mjs，源码那条相对路径在那儿指不到仓库根的
  // package.json。求值点在 bootstrap 里没有 try/catch——所以这里**读不到必须不抛**，否则整个
  // 桌面端后端起不来。构建期注入的版本才是打包产物的真相源（scripts/build-server.mjs）。
  it('readHostVersion() returns undefined instead of throwing when the file is not there', () => {
    expect(readHostVersion(new URL('../../does-not-exist-package.json', import.meta.url))).toBeUndefined()
  })

  it('readHostVersion() returns undefined when the file has no version field', () => {
    const bogus = join(userDir, 'package.json')
    writeFileSync(bogus, JSON.stringify({ name: 'x' }))
    expect(readHostVersion(new URL(`file://${bogus}`))).toBeUndefined()
  })

  // 宿主版本未知时闸门 fail-closed：不掀翻启动，但声明了 hostVersion 的包一律拒装——
  // 「跳过」等于这道闸门在打包产物里静默失效。
  it('refuses a package declaring hostVersion when the host version is unknown', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs', hostVersion: '>=1.0.0' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir, hostVersion: undefined }), PKG_NAME))
      .rejects.toThrow(/宿主版本/)
  })

  it('still installs a package that declares no hostVersion when the host version is unknown', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir, hostVersion: undefined }), PKG_NAME))
      .resolves.toBeDefined()
  })
})

/**
 * P5b: 容器格对第三方开放，但只开**钳制后**的那个形状。这一组盯三件事：
 *  ① 不合规的声明在**装之前**就被拒，且理由原样透到 preview 的报错里；
 *  ② 合规的能装，preview 展示的是钳制后的值（env 只给键名）；
 *  ③ **落盘的 package.json 就是那一份**——校验的和落盘的不能是两份字节（P4 那次 Critical）。
 */
describe('P5b: 容器格对第三方开放（钳制）', () => {
  const BACKEND_OK = { image: 'ghcr.io/someone/thing:1.0', port: 8080, mem: '1G', volumes: ['data:/var/lib/data'], env: { API_TOKEN: 'super-secret' } }

  function registryWithBackend(backend: Record<string, unknown>, stream: Record<string, unknown> = {}, name = PKG_NAME) {
    return makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs', backend, ...stream }, { name }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
  }

  it('合规的容器声明能装，preview 给出钳制后的摘要（env 只给键名，值不外泄）', async () => {
    const deps = makeDeps({ registry: registryWithBackend(BACKEND_OK), userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.backend).toEqual({
      image: 'ghcr.io/someone/thing:1.0',
      service: 'xhs',                       // 宿主指派 = 包 id，包没得选
      port: 8080,
      mem: '1G',
      volumes: ['xhs_data:/var/lib/data'],  // 加了包前缀
      envKeys: ['API_TOKEN'],
      standby: { idleMinutes: 30 },         // 宿主兜的默认值，用户在确认页看得到
    })
    expect(JSON.stringify(preview)).not.toContain('super-secret')
  })

  it('落盘的 package.json 写的是钳制后的声明（与 preview 同一份）', async () => {
    const deps = makeDeps({ registry: registryWithBackend(BACKEND_OK), userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    const onDisk = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { stream: { backend: Record<string, unknown> } }
    expect(onDisk.stream.backend).toEqual({
      image: 'ghcr.io/someone/thing:1.0',
      port: 8080,
      mem: '1G',
      volumes: ['xhs_data:/var/lib/data'],
      env: { API_TOKEN: 'super-secret' },
      service: 'xhs',
      standby: { idleMinutes: 30 },
    })
    // 摘要与落盘同源：确认页看到的每一格，盘上都是同一个值
    expect(onDisk.stream.backend.service).toBe(preview.backend?.service)
    expect(onDisk.stream.backend.volumes).toEqual(preview.backend?.volumes)
    expect(onDisk.stream.backend.standby).toEqual(preview.backend?.standby)
  })

  it.each([
    ['自己指派 service 名', { ...BACKEND_OK, service: 'alist' }, /service/],
    ['缺 mem（不限制 = 吃满宿主内存）', { image: 'i:1', port: 80 }, /mem/],
    ['宿主路径 bind', { image: 'i:1', port: 80, mem: '1G', volumes: ['/etc:/etc'] }, /bind|卷/],
    ['多开一个宿主口', { image: 'i:1', port: 80, mem: '1G', publish: 5244 }, /publish/],
    ['顶掉宿主注入的 env', { image: 'i:1', port: 80, mem: '1G', env: { STREAM_CREDENTIAL_TOKEN: 'x' } }, /STREAM_CREDENTIAL_TOKEN/],
  ])('拒 %s——理由原样透到 preview 的报错里', async (_label, backend, re) => {
    const deps = makeDeps({ registry: registryWithBackend(backend), userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(re)
  })

  // gpu / 大 mem 一律放行：装一个包本来就是信任作者，钳它们挡不住任何人（THIRD_PARTY_LIMITS 头注）。
  const GPU = { image: 'i:1', port: 80, mem: '10G', gpu: true }
  it('第三方 scope 要 GPU + 10G → 照装，落盘原样', async () => {
    const deps = makeDeps({ registry: registryWithBackend(GPU, {}, '@acme/xhs'), userDir })
    const preview = await previewRecipePackage(deps, '@acme/xhs')
    expect(preview.backend?.mem).toBe('10G')
    expect(preview.backend?.gpu).toBe(true)
    const { dir } = await installRecipePackage(deps, '@acme/xhs', undefined, preview.confirm)
    const onDisk = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { stream: { backend: Record<string, unknown> } }
    expect(onDisk.stream.backend.gpu).toBe(true)
    expect(onDisk.stream.backend.mem).toBe('10G')
  })

  it('被拒的包一个字节都没落盘', async () => {
    const deps = makeDeps({ registry: registryWithBackend({ image: 'i:1', port: 80 }), userDir })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow()
    expect(existsSync(join(userDir, dirNameFor(PKG_NAME)))).toBe(false)
  })

  // service 名是全局命名空间。内置 douyin 那个包的 service 名（douyin-tiktok-download-api）
  // **不等于**它的 id（Douyin_TikTok_Download_API），所以 id 闸门放它过去——必须有单独一格。
  it('拒撞上内置 service 名的包，即使 id 闸门放它过去', async () => {
    const occupiedNames = () => occupiedByBuiltins([
      { id: 'Douyin_TikTok_Download_API', backend: { image: 'i:1', port: 80, service: 'douyin-tiktok-download-api' } },
    ] as unknown as StreamPackage[])
    const registry = makeRegistry({
      'package.json': JSON.stringify({
        name: PKG_NAME,
        version: PKG_VERSION,
        stream: { id: 'douyin-tiktok-download-api', facility: 'xhs', backend: { image: 'i:1', port: 80, mem: '1G' } },
      }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir, occupiedNames }), PKG_NAME))
      .rejects.toThrow(/douyin-tiktok-download-api/)
  })

  // 凭证域是这个容器**能拿到的登录态**（宿主给它自己那一个 broker token，只放行申报过的域）。
  // 摘要里没有这一格（它是包级申报，代码格也吃它），所以 preview 必须自己带出来——
  // 确认页要摆的正是它，前端拿不到就等于用户批准了一份看不见边界的东西。
  it('preview 带出包申报的凭证域', async () => {
    const deps = makeDeps({ registry: registryWithBackend(BACKEND_OK, { credentials: ['douyin.com'] }), userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.credentials).toEqual(['douyin.com'])
  })

  it('没申报凭证域时 preview 不造一个空名单出来', async () => {
    const deps = makeDeps({ registry: registryWithBackend(BACKEND_OK), userDir })
    expect((await previewRecipePackage(deps, PKG_NAME)).credentials).toBeUndefined()
  })

  it('不带容器的包不受这道闸门影响（service 名没被占用）', async () => {
    const occupiedNames = () => occupiedByBuiltins([
      { id: 'Douyin_TikTok_Download_API', backend: { image: 'i:1', port: 80, service: 'douyin-tiktok-download-api' } },
    ] as unknown as StreamPackage[])
    const registry = makeRegistry({
      'package.json': JSON.stringify({
        name: PKG_NAME,
        version: PKG_VERSION,
        stream: { id: 'douyin-tiktok-download-api', facility: 'xhs' },
      }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const preview = await previewRecipePackage(makeDeps({ registry, userDir, occupiedNames }), PKG_NAME)
    expect(preview.backend).toBeUndefined()
  })
})

describe('A3: dirNameFor must not let a scoped and unscoped name collide', () => {
  it('an unscoped package cannot masquerade as a scoped one\'s install directory', async () => {
    // @streamapp/xhs mangles to "@streamapp__xhs" (leading @ kept); the unscoped
    // "streamapp__xhs" mangles to itself. They must land in DIFFERENT directories, or an
    // attacker publishing the unscoped twin could overwrite an already-installed scoped
    // package on install (sourceIds need not overlap — the conflict gate would miss it).
    const scoped = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const depsScoped = makeDeps({ registry: scoped, userDir })
    const previewScoped = await previewRecipePackage(depsScoped, PKG_NAME)
    const { dir: scopedDir } = await installRecipePackage(depsScoped, PKG_NAME, undefined, previewScoped.confirm)
    expect(existsSync(scopedDir)).toBe(true)

    const unscopedName = 'streamapp__xhs'
    const unscoped = makeRegistry({
      'package.json': JSON.stringify({ name: unscopedName, version: '1.0.0', stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }),
      'evil-search.recipe.json': JSON.stringify({ ...VALID_RECIPE, sourceId: 'evil-search' }),
    })
    const depsUnscoped = makeDeps({ registry: unscoped, userDir })
    const previewUnscoped = await previewRecipePackage(depsUnscoped, unscopedName)
    const { dir: unscopedDir } = await installRecipePackage(depsUnscoped, unscopedName, undefined, previewUnscoped.confirm)

    expect(unscopedDir).not.toBe(scopedDir)
    expect(existsSync(scopedDir)).toBe(true) // the scoped package's install must survive untouched
    expect(existsSync(join(scopedDir, 'xhs-search.recipe.json'))).toBe(true)
  })
})

describe('5a: historical uppercase package names are accepted (npm only bans uppercase in NEW packages)', () => {
  it('installs a package whose name has uppercase letters (e.g. a JSONStream-style legacy name)', async () => {
    const upperName = 'JSONStream'
    const registry = makeRegistry({
      'package.json': JSON.stringify({ name: upperName, version: PKG_VERSION, stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, upperName)
    const { dir } = await installRecipePackage(deps, upperName, undefined, preview.confirm)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('malicious package names (C2 — directory traversal via `name`)', () => {
  const evilNames = ['@x/y/../../evil', '..', '../../etc', '../escape']
  for (const evilName of evilNames) {
    it(`rejects "${evilName}" at the preview/install/uninstall entry points`, async () => {
      const registry = makeRegistry({
        'package.json': JSON.stringify({ name: evilName, version: PKG_VERSION, stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }),
        'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      })
      const deps = makeDeps({ registry, userDir })
      await expect(previewRecipePackage(deps, evilName)).rejects.toThrow()
      await expect(installRecipePackage(deps, evilName, undefined, 'whatever')).rejects.toThrow()
      await expect(uninstallRecipePackage({ userDir }, evilName)).rejects.toThrow()
    })
  }
})

describe('installRecipePackage', () => {
  it('rejects a mismatched confirm token', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    await expect(installRecipePackage(deps, PKG_NAME, undefined, 'sha512-wrong')).rejects.toThrow(/confirm token mismatch/)
    expect(existsSync(join(userDir, dirNameFor(PKG_NAME)))).toBe(false) // nothing written on rejection
  })

  it('writes to disk under the mangled dir name with the CLAMPED rateLimit, on a matching confirm', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({ rateLimit: { burst: 10, perMinute: 20 } }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({
      registry,
      userDir,
      facilityRateLimit: () => ({ burst: 5, perMinute: 30, maxWaitMs: 5000 }),
    })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    const { dir, version } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(dir).toBe(join(userDir, '@streamapp__xhs')) // A3: leading `@` kept — see dirNameFor
    expect(version).toBe(PKG_VERSION)
    expect(existsSync(join(dir, 'xhs-search.recipe.json'))).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    expect(written.stream.rateLimit).toEqual({ burst: 5, perMinute: 20, maxWaitMs: 5000 })
  })

  it('atomic upgrade: a file present in the old version does not linger after upgrading (M1)', async () => {
    const registryV1 = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'README.md': '# v1 only',
    })
    const depsV1 = makeDeps({ registry: registryV1, userDir })
    const previewV1 = await previewRecipePackage(depsV1, PKG_NAME)
    const { dir } = await installRecipePackage(depsV1, PKG_NAME, undefined, previewV1.confirm)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)

    const registryV2 = makeRegistry(
      { 'package.json': pkgJson({}, { version: '1.1.0' }), 'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE) },
      '1.1.0',
    )
    const depsV2 = makeDeps({ registry: registryV2, userDir })
    const previewV2 = await previewRecipePackage(depsV2, PKG_NAME)
    const { dir: dir2, version } = await installRecipePackage(depsV2, PKG_NAME, undefined, previewV2.confirm)

    expect(dir2).toBe(dir)
    expect(version).toBe('1.1.0')
    expect(existsSync(join(dir, 'xhs-search.recipe.json'))).toBe(true)
    expect(existsSync(join(dir, 'README.md'))).toBe(false) // stale v1.0.0-only file must not linger
  })

  it('A1: an orphaned .tmp scratch dir does not break loadRecipePackages (bootstrap survives a crashed install)', () => {
    // Simulate a crash mid-install: a full scratch package (package.json + recipe.json)
    // left behind under userDir/.tmp/<random>/, exactly what installRecipePackage's tmp
    // dir looks like before the rename that swaps it into place.
    const orphan = join(userDir, '.tmp', 'deadbeef')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'package.json'), pkgJson({}))
    writeFileSync(join(orphan, 'xhs-search.recipe.json'), JSON.stringify(VALID_RECIPE))

    // loadRecipePackages only reads ONE level under userDir and stops at ".tmp has no
    // package.json directly under it" — the orphan one level deeper is invisible to it,
    // not merely tolerated.
    expect(() => loadRecipePackages(userDir)).not.toThrow()
    expect(loadRecipePackages(userDir).descriptors).toHaveLength(0)
  })

  it('A1: install sweeps a STALE orphaned .tmp scratch before writing (crash-safe cleanup)', async () => {
    const orphan = join(userDir, '.tmp', 'orphan-from-a-crash')
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'package.json'), pkgJson({}))
    // Backdate it well past the "stale" threshold — a real crash orphan is old by the time
    // the NEXT install runs (that's how crash orphans are told apart from a sibling install
    // that is still mid-write, see the concurrency test below).
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(orphan, old, old)

    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)

    expect(existsSync(orphan)).toBe(false)
  })

  it('B1: a FRESH scratch dir from a concurrent in-flight install is NOT deleted by another install starting up', async () => {
    // Simulates two installs racing: B starts while A's scratch dir (fresh mtime — A is
    // still writing to it) already exists under the shared .tmp root. B's startup sweep
    // must only clear STALE orphans, never anything that could still be a live sibling.
    const inFlight = join(userDir, '.tmp', 'a-still-writing')
    mkdirSync(inFlight, { recursive: true })
    writeFileSync(join(inFlight, 'package.json'), pkgJson({}))

    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)

    expect(existsSync(inFlight)).toBe(true) // still there — B's sweep did not touch a fresh sibling
  })
})

describe('uninstallRecipePackage', () => {
  it('finds the installed dir by package name, deletes it, returns true; false if not found', async () => {
    const registry = makeRegistry({
      'package.json': pkgJson({}),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(existsSync(dir)).toBe(true)

    expect(await uninstallRecipePackage({ userDir }, PKG_NAME)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(await uninstallRecipePackage({ userDir }, PKG_NAME)).toBe(false)
  })

  // 终审 Minor 5：只删目录 = 容器继续跑，而下次启动它既不在 provision 名单也不在 standby
  // 名册 → 永不回收的常驻容器，没有任何日志会再提到它。
  it('包声明了 backend → 卸载时把它的容器一起收掉（service 名 = 落盘的那个）', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), unifiedPkgJson({
      backend: { image: 'ghcr.io/someone/thing:1.0', service: 'xhs', port: 8080, mem: '1G' },
    }))
    const deprovisioned: string[] = []
    expect(await uninstallRecipePackage({
      userDir,
      deprovision: async (s) => { deprovisioned.push(s); return 'removed' },
    }, PKG_NAME)).toBe(true)
    expect(deprovisioned).toEqual(['xhs'])
    expect(existsSync(dir)).toBe(false)
  })

  it('包没有 backend → 一次 docker 调用都不发', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), unifiedPkgJson())
    let called = 0
    expect(await uninstallRecipePackage({
      userDir,
      deprovision: async () => { called += 1; return 'removed' },
    }, PKG_NAME)).toBe(true)
    expect(called).toBe(0)
  })

  it('docker 够不着 → 卸载照样成功，但要说出来"容器没清掉，需要手工 docker rm"', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), unifiedPkgJson({
      backend: { image: 'ghcr.io/someone/thing:1.0', service: 'xhs', port: 8080, mem: '1G' },
    }))
    const notices: Array<{ kind: string; severity: string; title: string; body?: string }> = []
    expect(await uninstallRecipePackage({
      userDir,
      deprovision: async () => 'unavailable',
      notify: (n) => void notices.push(n),
    }, PKG_NAME)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.kind).toBe('container-left')
    expect(`${notices[0]!.title}${notices[0]!.body}`).toMatch(/docker rm/)
  })

  // 容器收掉了、命名卷故意留着（数据，删掉不可逆）——但留了就得说，否则用户机器上多出一个
  // 永远不会有人再提起的卷，唯一的线索是磁盘慢慢变少。
  it('容器收干净了、但包挂了命名卷 → 要说出来卷留在原地、以及怎么自己删', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), unifiedPkgJson({
      backend: {
        image: 'ghcr.io/someone/thing:1.0',
        service: 'xhs',
        port: 8080,
        mem: '1G',
        volumes: ['xhs_data:/var/lib/thing', 'xhs_cache:/var/cache'],
      },
    }))
    const notices: Array<{ kind: string; severity: string; title: string; body?: string }> = []
    expect(await uninstallRecipePackage({
      userDir,
      deprovision: async () => 'removed',
      notify: (n) => void notices.push(n),
    }, PKG_NAME)).toBe(true)
    expect(notices).toHaveLength(1)
    // 两种话不能共用一个 dedupeKey（见 UninstallNotice.kind）——接线方拿它拼 key。
    expect(notices[0]!.kind).toBe('volumes-left')
    expect(notices[0]!.severity).toBe('info')
    expect(`${notices[0]!.title}${notices[0]!.body}`).toMatch(/xhs_data/)
    expect(`${notices[0]!.title}${notices[0]!.body}`).toMatch(/xhs_cache/)
    expect(`${notices[0]!.title}${notices[0]!.body}`).toMatch(/docker volume rm/)
  })

  it('容器收干净了、包没挂卷 → 不发通知（没有留下任何东西，没什么可说的）', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), unifiedPkgJson({
      backend: { image: 'ghcr.io/someone/thing:1.0', service: 'xhs', port: 8080, mem: '1G' },
    }))
    const notices: unknown[] = []
    await uninstallRecipePackage({
      userDir,
      deprovision: async () => 'removed',
      notify: (n) => void notices.push(n),
    }, PKG_NAME)
    expect(notices).toEqual([])
  })

  it('5b: finds a package that was hand-symlinked into userDir (symlink-to-directory is not invisible)', async () => {
    // A real dir living OUTSIDE userDir, symlinked in — entry.isDirectory() returns false
    // for a symlink entry regardless of what it points to, so a naive dir-only filter makes
    // this package invisible to findInstalledDir.
    const realDir = mkdtempSync(join(tmpdir(), 'recipe-symlinked-'))
    writeFileSync(join(realDir, 'package.json'), pkgJson({}))
    writeFileSync(join(realDir, 'xhs-search.recipe.json'), JSON.stringify(VALID_RECIPE))
    symlinkSync(realDir, join(userDir, dirNameFor(PKG_NAME)), 'dir')

    expect(await uninstallRecipePackage({ userDir }, PKG_NAME)).toBe(true)
    rmSync(realDir, { recursive: true, force: true })
  })
})

describe('checkRecipeUpdates', () => {
  it('reports an installed package whose registry latest is newer', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}))
    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, '1.1.0'), userDir })
    const updates = await checkRecipeUpdates(deps)
    expect(updates).toEqual([{ name: PKG_NAME, installed: PKG_VERSION, latest: '1.1.0' }])
  })

  it('5b: sees a package that was hand-symlinked into userDir (listInstalled must not skip symlinked dirs)', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'recipe-symlinked-'))
    writeFileSync(join(realDir, 'package.json'), pkgJson({}))
    symlinkSync(realDir, join(userDir, dirNameFor(PKG_NAME)), 'dir')

    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, '1.1.0'), userDir })
    expect(await checkRecipeUpdates(deps)).toEqual([{ name: PKG_NAME, installed: PKG_VERSION, latest: '1.1.0' }])
    rmSync(realDir, { recursive: true, force: true })
  })

  it('does NOT report when latest equals installed', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}))
    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, PKG_VERSION), userDir })
    expect(await checkRecipeUpdates(deps)).toEqual([])
  })

  it('does NOT report when the registry latest is a REGRESSION (older than installed) — B2', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}, { version: '2.0.0' })) // installed 2.0.0
    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, '1.9.0'), userDir }) // latest dist-tag regressed to 1.9.0
    expect(await checkRecipeUpdates(deps)).toEqual([])
  })

  it('treats a pre-release as older than the same numeric version without a suffix', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}, { version: '1.0.0' }))
    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, '1.0.0-beta.1'), userDir })
    expect(await checkRecipeUpdates(deps)).toEqual([]) // pre-release is not "newer"
  })

  it('reports a proper pre-release-to-release bump as newer', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}, { version: '1.0.0-beta.1' }))
    const deps = makeDeps({ registry: makeRegistry({ 'package.json': pkgJson({}) }, '1.0.0'), userDir })
    expect(await checkRecipeUpdates(deps)).toEqual([{ name: PKG_NAME, installed: '1.0.0-beta.1', latest: '1.0.0' }])
  })

  it('a packument with no dist-tags for one package does not crash the whole update check (still swallowed, still readable if surfaced)', async () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}))
    const registry: RegistryClient = {
      async packument() { return { versions: {} } as unknown as Packument },
      async tarball() { return Buffer.alloc(0) },
      async search() { return [] },
    }
    const deps = makeDeps({ registry, userDir })
    await expect(checkRecipeUpdates(deps)).resolves.toEqual([]) // swallowed per-package, no throw out of the whole loop
  })

  it('查 packument 是并发的（allSettled），且一个包 reject 只让它自己缺席、其余照报', async () => {
    for (const [n, v] of [['@t/a', '1.0.0'], ['@t/b', '1.0.0'], ['@t/c', '1.0.0']] as const) {
      const dir = join(userDir, dirNameFor(n))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: n, version: v }))
    }
    // 三个查询必须同时在飞：每个 packument 都等同一个 gate，串行的话第一个永远等不到第二个发起。
    let inFlight = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const registry: RegistryClient = {
      async packument(name) {
        inFlight++
        peak = Math.max(peak, inFlight)
        if (inFlight === 3) release()
        await gate
        inFlight--
        if (name === '@t/b') throw new Error('ENOTFOUND')
        return { 'dist-tags': { latest: '2.0.0' }, versions: {} } as unknown as Packument
      },
      async tarball() { return Buffer.alloc(0) },
      async search() { return [] },
    }
    const out = await checkRecipeUpdates(makeDeps({ registry, userDir }))
    expect(peak).toBe(3)
    expect(out.map((c) => c.name).sort()).toEqual(['@t/a', '@t/c'])
  })
})

describe('currentVersion', () => {
  it('已装版优先于内置版（用户层整包盖住内置那份）；只有内置版时就是内置版', () => {
    expect(currentVersion({ builtin: '1.0.1', installed: '1.0.2' })).toBe('1.0.2')
    expect(currentVersion({ builtin: '1.0.1' })).toBe('1.0.1')
    expect(currentVersion({ installed: '0.9.0' })).toBe('0.9.0')
  })
})

describe('listInstalledRecipePackages: tolerates a stray top-level yaml in userDir (not a migration leftover — it is the user\'s own file)', () => {
  it('still lists the real package instead of throwing on the unrelated yaml', () => {
    const dir = join(userDir, dirNameFor(PKG_NAME))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), pkgJson({}))
    writeFileSync(join(userDir, 'notes.yaml'), 'not a stream package\n')

    expect(listInstalledRecipePackages(userDir)).toEqual([
      { name: PKG_NAME, version: PKG_VERSION, facility: 'xhs', sourceIds: [], hasCode: false },
    ])
  })
})

/**
 * 校验的和落盘的必须是同一份字节。tar 是一串条目、同一个 path 可以出现两次：校验读**第一份**、
 * 写盘循环顺序遍历后写覆盖先写 → 用户在确认页看到的是第一份，盘上、下次启动装载的是第二份。
 * 借此能换掉 stream.id / npm name / code 名单（申报个保留名 → 启动直接抛 → 后端起不来、只能
 * 手删文件）。zip 那条路先收进 Map 再校验+写，天然没有这个形状。
 */
describe('P4 fix: tarball 里出现重复 path → 拒装（校验的和落盘的不能是两份字节）', () => {
  const GOOD_PKG = unifiedPkgJson({ facility: 'xhs' })
  const EVIL_PKG = JSON.stringify({ name: PKG_NAME, version: PKG_VERSION, stream: { id: 'builtin-impostor', code: { entry: 'dist/index.js', adapters: ['rsshub'] } } })

  it('两份 package.json：第一份过闸门、第二份落盘 —— 必须拒', async () => {
    const deps = makeDeps({
      registry: makeRegistryFromTgz(packTgzEntries([
        ['package.json', GOOD_PKG],
        ['xhs-search.recipe.json', JSON.stringify(VALID_RECIPE)],
        ['package.json', EVIL_PKG],
      ])),
      userDir,
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/duplicate|重复/i)
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/package\.json/)
  })

  it('两份 manifests.yaml：同样拒', async () => {
    const deps = makeDeps({
      registry: makeRegistryFromTgz(packTgzEntries([
        ['package.json', GOOD_PKG],
        ['xhs-search.recipe.json', JSON.stringify(VALID_RECIPE)],
        ['manifests.yaml', '[]\n'],
        ['manifests.yaml', 'not: a list\n'],
      ])),
      userDir,
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/duplicate|重复/i)
  })

  it('两份 dist/index.js：同样拒（申报的是审过的那份，落盘的是另一份代码）', async () => {
    const deps = makeDeps({
      registry: makeRegistryFromTgz(packTgzEntries([
        ['package.json', unifiedPkgJson({ facility: 'xhs', code: { entry: 'dist/index.js', adapters: ['demo'] } })],
        ['xhs-search.recipe.json', JSON.stringify(VALID_RECIPE)],
        ['dist/index.js', CODE_JS],
        ['dist/index.js', 'export const activate = () => { throw new Error("gotcha") }\n'],
      ])),
      userDir,
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/duplicate|重复/i)
  })

  it('两份同名 *.recipe.json：同样拒', async () => {
    const deps = makeDeps({
      registry: makeRegistryFromTgz(packTgzEntries([
        ['package.json', GOOD_PKG],
        ['xhs-search.recipe.json', JSON.stringify(VALID_RECIPE)],
        ['xhs-search.recipe.json', JSON.stringify({ ...VALID_RECIPE, request: { url: 'https://evil.example/x', method: 'GET' } })],
      ])),
      userDir,
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).rejects.toThrow(/duplicate|重复/i)
  })

  it('没有重复的照常放行', async () => {
    const deps = makeDeps({
      registry: makeRegistryFromTgz(packTgzEntries([
        ['package.json', GOOD_PKG],
        ['xhs-search.recipe.json', JSON.stringify(VALID_RECIPE)],
      ])),
      userDir,
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).resolves.toMatchObject({ facility: 'xhs' })
  })
})

/**
 * 撞名闸门只挡内置 = 只挡了一半：两个第三方包申报同一个 adapter 名各自装都成功，启动时
 * activatePackages 按设计「两边都不激活」→ 抛 → 后端起不来，UI 里恢复不了。占用表必须含已装的
 * 第三方包（bootstrap 注入，见 withInstalled）。
 */
describe('P4 fix: 撞已装第三方包申报的名字 → 安装期拒绝', () => {
  const occupiedNames = () => withInstalled(occupiedByBuiltins([]), [
    { id: 'other', pkgName: '@someone/other', dir: '/x', credentials: ['taken.example'], code: { entry: 'dist/index.js', adapters: ['taken-a'], normalizers: ['taken-n'], enrichers: ['taken-e'], connect: ['taken.example'] } },
  ] as unknown as StreamPackage[])

  it('拒绝一个 enricher 名 / connect 域名撞上已装第三方包的包', async () => {
    const e = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', enrichers: ['taken-e'] } }),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry: e, userDir, occupiedNames }), PKG_NAME)).rejects.toThrow(/taken-e/)
    const c = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', credentials: ['taken.example'], code: { entry: 'dist/index.js', connect: ['taken.example'] } }),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry: c, userDir, occupiedNames }), PKG_NAME)).rejects.toThrow(/taken\.example/)
  })

  it('拒绝一个 adapter 名撞上已装第三方包的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', adapters: ['taken-a'] } }),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir, occupiedNames }), PKG_NAME)).rejects.toThrow(/taken-a/)
  })

  it('拒绝一个 normalizer 名撞上已装第三方包的包', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', normalizers: ['taken-n'] } }),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir, occupiedNames }), PKG_NAME)).rejects.toThrow(/taken-n/)
  })

  it('占用表按正在装的那个包自己剔除 —— 升级 / 重装不被自己挡住', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ id: 'xhs', code: { entry: 'dist/index.js', adapters: ['self-a'] } }),
      'dist/index.js': CODE_JS,
    })
    const installed = [
      { id: 'xhs', pkgName: PKG_NAME, dir: '/x', code: { entry: 'dist/index.js', adapters: ['self-a'] } },
    ] as unknown as StreamPackage[]
    const deps = makeDeps({
      registry,
      userDir,
      occupiedNames: (self: string) => withInstalled(occupiedByBuiltins([]), installed, self),
    })
    await expect(previewRecipePackage(deps, PKG_NAME)).resolves.toMatchObject({ code: { adapters: ['self-a'] } })
  })
})

// 代码格从「只有 `stream.code`」扩成「`stream.code` **或** `stream.capability`」。两格都指向
// 同一个字面路径 `dist/index.js`，安装门要一起认——只认前者的话，能力包带着自己那份
// dist/index.js 会被当成夹带代码拒掉，而它正是包的全部内容。
describe('P4b: dist/index.js 也可以由 stream.capability 申报', () => {
  const capStream = { facility: 'xhs', capability: 'dist/index.js' }

  it('声明了 capability 的包可以带 dist/index.js', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson(capStream),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    const deps = makeDeps({ registry, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    // capability 不是 `code` —— `code` 那一格讲的是 adapter/normalizer 申报，能力包一个都没有。
    expect(preview.code).toBeUndefined()
    // **但它必须自己有一格**：确认页把「含代码」做成最响的一档，判据就是 preview 上有没有
    // 这两格之一。少了它，一份会在后端进程内以完整权限运行、能取用户登录态的包，会以
    // 「纯数据 recipe 包」的样子一路静默装上——两边都不报错。
    expect(preview.capability).toEqual({ entry: 'dist/index.js' })
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(readFileSync(join(dir, 'dist', 'index.js'), 'utf-8')).toBe(CODE_JS)
  })

  it('声明了 capability 却没带 dist/index.js —— 拒', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson(capStream),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(/dist\/index\.js/)
  })

  it('两格都不声明却带着 dist/index.js —— 仍是夹带，拒', async () => {
    const registry = makeRegistry({
      'package.json': unifiedPkgJson({ facility: 'xhs' }),
      'xhs-search.recipe.json': JSON.stringify(VALID_RECIPE),
      'dist/index.js': CODE_JS,
    })
    await expect(previewRecipePackage(makeDeps({ registry, userDir }), PKG_NAME)).rejects.toThrow(/stream\.code/)
  })
})

describe('planRecipeUpdates', () => {
  const latest = (m: Record<string, string>) => (name: string) => m[name]
  it('内置包比 npm 旧 → 候选带 builtin，没有 installed', () => {
    expect(planRecipeUpdates([{ name: '@streamapp/wechat', version: '1.0.1' }], [], latest({ '@streamapp/wechat': '1.0.2' })))
      .toEqual([{ name: '@streamapp/wechat', builtin: '1.0.1', latest: '1.0.2' }])
  })
  it('用户层已装的更高版是"当前版"：npm 不比它新就不是候选', () => {
    expect(planRecipeUpdates(
      [{ name: '@streamapp/wechat', version: '1.0.1' }],
      [{ name: '@streamapp/wechat', version: '1.0.2' }],
      latest({ '@streamapp/wechat': '1.0.2' }),
    )).toEqual([])
  })
  it('两层都有时候选同时带 builtin 与 installed', () => {
    expect(planRecipeUpdates(
      [{ name: '@streamapp/wechat', version: '1.0.1' }],
      [{ name: '@streamapp/wechat', version: '1.0.2' }],
      latest({ '@streamapp/wechat': '1.0.3' }),
    )).toEqual([{ name: '@streamapp/wechat', builtin: '1.0.1', installed: '1.0.2', latest: '1.0.3' }])
  })
  it('只装在用户层的第三方包照常算', () => {
    expect(planRecipeUpdates([], [{ name: '@other/x', version: '0.1.0' }], latest({ '@other/x': '0.2.0' })))
      .toEqual([{ name: '@other/x', installed: '0.1.0', latest: '0.2.0' }])
  })
  it('npm 上查不到（私有 / 下架）不是候选，也不抛', () => {
    expect(planRecipeUpdates([{ name: '@streamapp/wechat', version: '1.0.1' }], [], () => undefined)).toEqual([])
  })
  it('同名出现在两层只出一条', () => {
    const out = planRecipeUpdates(
      [{ name: '@streamapp/xhs', version: '1.0.0' }],
      [{ name: '@streamapp/xhs', version: '1.0.0' }],
      latest({ '@streamapp/xhs': '1.1.0' }),
    )
    expect(out).toHaveLength(1)
  })
})

describe('formatRecipeUpdateNotice', () => {
  it('没有候选 → null（启动日志一个字都不打）', () => {
    expect(formatRecipeUpdateNotice([])).toBeNull()
  })
  it('一行说清几个包、各自从哪到哪、怎么装', () => {
    expect(formatRecipeUpdateNotice([
      { name: '@streamapp/wechat', builtin: '1.0.1', latest: '1.0.2' },
      { name: '@other/x', installed: '0.1.0', latest: '0.2.0' },
    ])).toBe('[stream] 2 个包有更新：@streamapp/wechat 1.0.1 → 1.0.2、@other/x 0.1.0 → 0.2.0。运行 `stream update` 安装。')
  })
})

describe('镜像信任核对（officialRegistry 只在主 registry 是镜像时才有）', () => {
  const files = { 'package.json': pkgJson({}), 'xhs-feed.recipe.json': JSON.stringify(VALID_RECIPE) }
  const tgz = packTgz(files)
  const sha = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const mirror = () => makeRegistryFromTgz(tgz)
  const officialWith = (integrity?: string, version = PKG_VERSION): RegistryClient => ({
    async packument() {
      return { 'dist-tags': { latest: version }, versions: { [version]: { version, dist: { tarball: 'https://registry.npmjs.org/x.tgz', ...(integrity && { integrity }) } } } }
    },
    async tarball() { throw new Error('official tarball must not be fetched') },
    async search() { return [] },
  })

  it('没配 officialRegistry（主 registry 就是官方源）→ 不核，preview 无 mirrorUnverified', async () => {
    const preview = await previewRecipePackage(makeDeps({ registry: mirror(), userDir }), PKG_NAME)
    expect(preview.mirrorUnverified).toBeUndefined()
  })
  it('官方源 integrity 与实际 tarball 一致 → 官方，不写旁注', async () => {
    const deps = makeDeps({ registry: mirror(), officialRegistry: officialWith(sha), userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.mirrorUnverified).toBeUndefined()
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(existsSync(join(dir, TRUST_SIDECAR))).toBe(false)
  })
  it('校验和不一致 → 照装、写旁注 official:false 带原因', async () => {
    const deps = makeDeps({ registry: mirror(), officialRegistry: officialWith('sha512-somethingelse'), userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.mirrorUnverified).toMatch(/校验和不一致/)
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(JSON.parse(readFileSync(join(dir, TRUST_SIDECAR), 'utf-8'))).toEqual({ official: false, reason: preview.mirrorUnverified })
  })
  it('官方源没这个版本 → 核不上', async () => {
    const deps = makeDeps({ registry: mirror(), officialRegistry: officialWith(sha, '9.9.9'), userDir })
    expect((await previewRecipePackage(deps, PKG_NAME)).mirrorUnverified).toMatch(/官方源上没有/)
  })
  it('官方源连不上 → 核不上（fail-closed），包照样能装', async () => {
    const down: RegistryClient = { async packument() { throw new Error('ECONNREFUSED') }, async tarball() { throw new Error('x') }, async search() { return [] } }
    const deps = makeDeps({ registry: mirror(), officialRegistry: down, userDir })
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.mirrorUnverified).toMatch(/连不上/)
    await expect(installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)).resolves.toBeTruthy()
  })
  it('第三方 scope 不核：officialRegistry 一次都不被问', async () => {
    const never: RegistryClient = { async packument() { throw new Error('must not be called') }, async tarball() { throw new Error('x') }, async search() { return [] } }
    const thirdParty = packTgz({ 'package.json': pkgJson({}, { name: '@other/xhs' }), 'xhs-feed.recipe.json': JSON.stringify(VALID_RECIPE) })
    const deps = makeDeps({ registry: makeRegistryFromTgz(thirdParty), officialRegistry: never, userDir })
    expect((await previewRecipePackage(deps, '@other/xhs')).mirrorUnverified).toBeUndefined()
  })
  it('旧版核得上、新版核不上：升级后旁注出现；反过来升级后旁注消失（随整棵树一起换）', async () => {
    const ok = makeDeps({ registry: mirror(), officialRegistry: officialWith(sha), userDir })
    const p1 = await previewRecipePackage(ok, PKG_NAME)
    const { dir } = await installRecipePackage(ok, PKG_NAME, undefined, p1.confirm)
    expect(existsSync(join(dir, TRUST_SIDECAR))).toBe(false)
    const bad = makeDeps({ registry: mirror(), officialRegistry: officialWith('sha512-nope'), userDir })
    const p2 = await previewRecipePackage(bad, PKG_NAME)
    await installRecipePackage(bad, PKG_NAME, undefined, p2.confirm)
    expect(existsSync(join(dir, TRUST_SIDECAR))).toBe(true)
    const p3 = await previewRecipePackage(ok, PKG_NAME)
    await installRecipePackage(ok, PKG_NAME, undefined, p3.confirm)
    expect(existsSync(join(dir, TRUST_SIDECAR))).toBe(false)
  })
})
