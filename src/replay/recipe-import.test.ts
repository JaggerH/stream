import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { inspectPackage, importPackage } from './recipe-import.ts'
import { occupiedByBuiltins } from '../packages/activate.ts'
import { readPackageTrust } from './recipe-package.ts'
import type { StreamPackage } from '../packages/scan.ts'

/** 内置那一层已占的名字。默认这批测试不关心撞内置，用空的内置清单（它仍自带宿主四件保留名）；
 *  专门验撞内置那条的用例自己传一份非空的（见文件末尾）。 */
const BUILTIN_NAMES = occupiedByBuiltins([])

// ── minimal zip writer (stored entries only) ─────────────────────────────────

function zipOf(entries: Array<[name: string, data: string | Buffer]>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, raw] of entries) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    const nameB = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // comp size
    local.writeUInt32LE(data.length, 22) // uncomp size
    local.writeUInt16LE(nameB.length, 26)
    parts.push(local, nameB, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 10) // method
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameB.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameB]))
    offset += 30 + nameB.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function recipeJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1, kind: 'browser', sourceId: 'demo-feed', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.me', wall: '.login-wall' },
    actions: [
      { kind: 'goto', url: 'https://x.com/home' },
      { kind: 'scroll', dwell_s: [1, 2], maxTimes: 3, noProgressStop: 2 },
    ],
    harvest: { urlPattern: 'https://x.com/api/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 2, mapping: { title: 't' }, assert: [] },
    ...over,
  })
}

const PKG_JSON = JSON.stringify({
  name: '@streamapp/demo', version: '1.0.0', author: 'tester',
  stream: { type: 'recipe', facility: 'demo', schemaVersion: 1, cookieDomain: 'x.com', author: 'tester' },
})
const MANIFESTS = '- id: demo-feed\n  adapter: replay\n  description: demo\n  topics: []\n'

function goodZip(): Buffer {
  return zipOf([
    ['demo/package.json', PKG_JSON],
    ['demo/manifests.yaml', MANIFESTS],
    ['demo/demo-feed.recipe.json', recipeJson()],
  ])
}

let dir: string
let zipPath: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recipe-import-')); zipPath = join(dir, 'pkg.zip') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('inspectPackage', () => {
  it('reports facility, domains touched, and action kinds before unpacking', () => {
    writeFileSync(zipPath, goodZip())
    const info = inspectPackage(zipPath, BUILTIN_NAMES)
    expect(info.facility).toBe('demo')
    expect(info.cookieDomain).toBe('x.com')
    expect(info.domains).toContain('x.com')
    expect(info.actionKinds.sort()).toEqual(['goto', 'scroll'])
    expect(info.sources).toEqual(['demo-feed'])
  })
})

describe('importPackage — trust boundary', () => {
  it('rejects zip-slip entries (../ escape)', () => {
    writeFileSync(zipPath, zipOf([['../evil.txt', 'x'], ['demo/package.json', PKG_JSON]]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, occupiedNames: BUILTIN_NAMES })).toThrow(/\.\.|slip|escape/i)
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false)
  })

  it('rejects absolute-path entries', () => {
    writeFileSync(zipPath, zipOf([['/etc/evil', 'x']]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, occupiedNames: BUILTIN_NAMES })).toThrow()
  })

  it('rejects a recipe whose goto leaves the declared cookieDomain', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', PKG_JSON],
      ['demo/manifests.yaml', MANIFESTS],
      ['demo/demo-feed.recipe.json', recipeJson({
        actions: [{ kind: 'goto', url: 'https://evil.com/track' }],
      })],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, occupiedNames: BUILTIN_NAMES })).toThrow(/evil\.com/)
  })

  it('rejects oversized files', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', PKG_JSON],
      ['demo/big.recipe.json', Buffer.alloc(2 * 1024 * 1024, 0x20)],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, occupiedNames: BUILTIN_NAMES })).toThrow(/size|尺寸|large/i)
  })

  it('does not install when confirm() returns false', () => {
    writeFileSync(zipPath, goodZip())
    expect(() => importPackage(zipPath, dir, { confirm: () => false, occupiedNames: BUILTIN_NAMES })).toThrow(/confirm|cancel/i)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  // P4: zip 这条路与 npm tarball 那条路必须是同一把尺 —— 判据分家就会出现「tarball 装不进、
  // zip 能装进」，同一个包换个入口就绕过了闸门。
  const unifiedPkg = (stream: Record<string, unknown> = {}) => JSON.stringify({
    name: '@streamapp/demo', version: '1.0.0',
    stream: { id: 'demo', facility: 'demo', cookieDomain: 'x.com', ...stream },
  })

  it('accepts the unified descriptor (no `type`), same as the tarball path', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg()],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(inspectPackage(zipPath, BUILTIN_NAMES, '1.2.3').facility).toBe('demo')
  })

  it('rejects a file outside the whitelist (zip had no whitelist at all before P4)', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', PKG_JSON],
      ['demo/demo-feed.recipe.json', recipeJson()],
      ['demo/evil.js', 'console.log("pwned")'],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })).toThrow(/whitelist/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  // 反斜杠在 Windows 上就是路径分隔符（桌面端 sidecar 后端跑在那儿）。zip 这条路的 zip-slip
  // 守卫本来就拒它——这条测试把它钉死，因为 tarball 那条路是靠白名单拒的，两条路的判据不能分家。
  it('rejects a backslash entry that would escape on Windows', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg()],
      ['demo/a\\..\\..\\evil.recipe.json', recipeJson()],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES }))
      .toThrow(/whitelist|slip|escape/i)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects a stowaway dist/index.js that the descriptor did not declare', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg()],
      ['demo/demo-feed.recipe.json', recipeJson()],
      ['demo/dist/index.js', 'export const activate = () => ({})\n'],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })).toThrow(/stream\.code/)
  })

  it('accepts one DECLARED code entry and discloses it in the review', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg({ code: { entry: 'dist/index.js', adapters: ['demo'] } })],
      ['demo/demo-feed.recipe.json', recipeJson()],
      ['demo/dist/index.js', 'export const activate = () => ({})\n'],
    ]))
    expect(inspectPackage(zipPath, BUILTIN_NAMES, '1.2.3').code).toEqual({ entry: 'dist/index.js', adapters: ['demo'], normalizers: [] })
    const { installed } = importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })
    expect(existsSync(join(installed, 'dist', 'index.js'))).toBe(true)
  })

  // P5b: 容器格对第三方开放了，但 zip 这条路必须与 tarball 那条**用同一把尺**（钳制 +
  // 落盘写钳制后的那一份），否则同一个包换个入口就能带进一份没被钳过的声明。
  it('rejects a backend that fails the clamp (缺 mem = 可以吃满宿主内存)', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg({ backend: { image: 'evil/miner:6.6.6', port: 8080 } })],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })).toThrow(/mem/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('a backend asking for GPU is accepted and the summary says so（确认页要亮 gpu）', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg({ backend: { image: 'i:1', port: 80, mem: '1G', gpu: true } })],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(inspectPackage(zipPath, BUILTIN_NAMES, '1.2.3').backend?.gpu).toBe(true)
    const { installed } = importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })
    const onDisk = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf-8')) as { stream: { backend: Record<string, unknown> } }
    expect(onDisk.stream.backend.gpu).toBe(true)
  })

  it('zip 导入的包一律写 official:false 的信任旁注——自称 @streamapp 的 zip 拿不到内置层凭据', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg()],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    const { installed } = importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })
    expect(readPackageTrust(installed)).toEqual({ official: false, reason: 'zip 导入无从核官方源' })
  })

  it('accepts a compliant backend, discloses the clamped summary, and writes THAT to disk', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg({ backend: { image: 'i:1', port: 80, mem: '1G', volumes: ['data:/x'], env: { TOKEN: 'secret' } } })],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    const info = inspectPackage(zipPath, BUILTIN_NAMES, '1.2.3')
    expect(info.backend).toEqual({
      image: 'i:1', service: 'demo', port: 80, mem: '1G',
      volumes: ['demo_data:/x'], envKeys: ['TOKEN'], standby: { idleMinutes: 30 },
    })
    expect(JSON.stringify(info)).not.toContain('secret')

    const { installed } = importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })
    const onDisk = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf-8')) as { stream: { backend: Record<string, unknown> } }
    expect(onDisk.stream.backend.service).toBe('demo')
    expect(onDisk.stream.backend.volumes).toEqual(['demo_data:/x'])
    expect(onDisk.stream.backend.standby).toEqual({ idleMinutes: 30 })
  })

  it('rejects a service name already taken by a builtin whose service ≠ its id', () => {
    const builtins = occupiedByBuiltins([
      { id: 'Douyin_TikTok_Download_API', backend: { image: 'i:1', port: 80, service: 'douyin-tiktok-download-api' } },
    ] as unknown as StreamPackage[])
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', JSON.stringify({
        name: '@streamapp/demo', version: '1.0.0',
        stream: { id: 'douyin-tiktok-download-api', facility: 'demo', cookieDomain: 'x.com', backend: { image: 'i:1', port: 80, mem: '1G' } },
      })],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: builtins }))
      .toThrow(/douyin-tiktok-download-api/)
  })

  // 撞内置这道闸门必须两条路同一把尺——tarball 那条拒了、zip 这条能进，就等于换个入口绕过去。
  it('rejects an id that collides with a builtin package', () => {
    const builtins = occupiedByBuiltins([
      { id: 'demo', code: { entry: './activate.ts', adapters: ['demo'] } },
    ] as unknown as StreamPackage[])
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg()],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: builtins }))
      .toThrow(/demo/)
    expect(existsSync(join(dir, 'demo'))).toBe(false)
  })

  it('rejects a hostVersion this host cannot satisfy', () => {
    writeFileSync(zipPath, zipOf([
      ['demo/package.json', unifiedPkg({ hostVersion: '>=99.0.0' })],
      ['demo/demo-feed.recipe.json', recipeJson()],
    ]))
    expect(() => importPackage(zipPath, dir, { confirm: () => true, hostVersion: '1.2.3', occupiedNames: BUILTIN_NAMES })).toThrow(/99\.0\.0/)
  })

  it('installs a good package and the loader can read it back', () => {
    writeFileSync(zipPath, goodZip())
    const { installed } = importPackage(zipPath, dir, { confirm: () => true, occupiedNames: BUILTIN_NAMES })
    expect(installed).toBe(join(dir, 'demo'))
    expect(readFileSync(join(dir, 'demo', 'package.json'), 'utf-8')).toContain('"facility":"demo"')
    expect(existsSync(join(dir, 'demo', 'demo-feed.recipe.json'))).toBe(true)
  })
})
