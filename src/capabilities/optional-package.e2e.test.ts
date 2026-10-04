/**
 * 可选能力包的整条缝：**真的 `npm pack` 出来的 tarball** → 安装门 → 扫包 → 动态 import →
 * mount → 工具出现在 `host.toolDefs()`。
 *
 * 为什么必须有这一条，而不是靠 `recipe-install.test.ts` 加 `load.test.ts` 两半：
 *
 * - `recipe-install.test.ts` 用的是**自己手搓的** ustar tarball（`packTgz`），只证明「白名单
 *   放行了 `dist/index.js`」；它落盘之后没人再去 import 它。
 * - `load.test.ts` 的假包是**直接写进临时目录**的，没经过安装门；它证明「目录里有这么一个包
 *   就能装载」，证不了「装进去的东西长这样」。
 *
 * 两半各自全绿、缝上却断掉，是这条线最容易出的那种错——而且**没有一处会喊**：包装得进去、
 * `/api/packages` 里能看到它，只是工具一个都没有。所以这一条从 `npm pack` 起跑：真 npm 的
 * tarball 布局（`package/` 前缀、ustar、gzip）、真 `dist/index.js` 一个文件自包含。
 *
 * 夹具包是临时目录里现造的，不是仓库里那两个真包——那两个的 `dist/` 是 gitignored 的构建产物，
 * 干净检出里不在，照它跑这条就会变成一条"没装就跳过"的假绿。夹具能守住的正是缝本身。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewRecipePackage, installRecipePackage, dirNameFor } from '../replay/recipe-install.ts'
import type { RecipeInstallDeps } from '../replay/recipe-install.ts'
import type { Packument, RegistryClient } from '../replay/recipe-registry.ts'
import { occupiedByBuiltins } from '../packages/activate.ts'
import { parseStreamDescriptor } from '../packages/descriptor.ts'
import { repoRoot } from '../http/build-identity.ts'
import { createCapabilityHost } from './host.ts'
import { loadOptionalCapabilities } from './load.ts'

const PKG_NAME = '@demo/optional-cap'
const PKG_VERSION = '0.1.0'

/** 能力体：一个自包含的 `dist/index.js`（只 import node: 内置，与真包的约束一致）。 */
const DIST_INDEX = `
export const capability = {
  name: 'demo-optional',
  async mount(ctx, config) {
    ctx.log.info('mounted with ' + JSON.stringify(config ?? {}))
    ctx.registerTools([
      { name: 'demo_optional_verb', description: 'demo', parameters: {}, execute: async () => ({ ok: true }) },
    ])
    ctx.onDispose(() => {})
  },
}
`

let workDir: string
let userDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'optional-cap-'))
  userDir = join(workDir, 'recipes')
  mkdirSync(userDir, { recursive: true })
})
afterEach(() => { rmSync(workDir, { recursive: true, force: true }) })

/** 造一个包目录并用**真的 `npm pack`** 打成 tarball，返回它的字节。 */
function packRealTarball(streamField: Record<string, unknown>): Buffer {
  const pkgDir = join(workDir, 'src-pkg')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: PKG_NAME, version: PKG_VERSION, type: 'module', main: 'dist/index.js', files: ['dist'], stream: streamField }, null, 2),
  )
  writeFileSync(join(pkgDir, 'dist', 'index.js'), DIST_INDEX)
  const out = join(workDir, 'packed')
  mkdirSync(out, { recursive: true })
  execFileSync('npm', ['pack', pkgDir, '--pack-destination', out, '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const files = readdirSync(out).filter((f) => f.endsWith('.tgz'))
  expect(files, 'npm pack 没产出 tarball').toHaveLength(1)
  return readFileSync(join(out, files[0] as string))
}

function makeDeps(tgz: Buffer): RecipeInstallDeps {
  const packument: Packument = {
    'dist-tags': { latest: PKG_VERSION },
    versions: { [PKG_VERSION]: { version: PKG_VERSION, dist: { tarball: 'https://reg.example/t.tgz' } } },
  }
  const registry: RegistryClient = {
    async packument() { return packument },
    async tarball() { return tgz },
    async search() { return [] },
  }
  return {
    registry,
    userDir,
    builtinPackageSourceIds: () => [],
    facilityRateLimit: () => undefined,
    hostVersion: '1.2.3',
    occupiedNames: () => occupiedByBuiltins([]),
  }
}

describe('可选能力包：npm tarball → 安装门 → 装载 → 工具面', () => {
  it('装进去之后 loadOptionalCapabilities 真的 import 到并挂上了它的工具', async () => {
    const deps = makeDeps(packRealTarball({ id: 'demo-optional', capability: 'dist/index.js' }))

    // 1) 确认页要**明说**这是个能力包：用户批准的是"它会在后端进程里跑"，不是一堆 recipe。
    const preview = await previewRecipePackage(deps, PKG_NAME)
    expect(preview.capability).toEqual({ entry: 'dist/index.js' })

    // 2) confirm 走本次 preview 发的 integrity（TOCTOU 闸门）。
    const { dir } = await installRecipePackage(deps, PKG_NAME, undefined, preview.confirm)
    expect(dir).toBe(join(userDir, dirNameFor(PKG_NAME)))
    expect(existsSync(join(dir, 'dist', 'index.js')), '白名单必须放行 dist/index.js').toBe(true)

    // 3) 真装载：不注入 importModule，走默认那条 `import(pathToFileURL(...))`——
    //    「装到盘上的那份字节能不能被 import」正是这条缝要证的事。
    const logs: string[] = []
    const host = createCapabilityHost({ dataDir: join(workDir, 'data'), log: (l) => logs.push(l), reservedToolNames: () => [] })
    const loaded = await loadOptionalCapabilities({
      recipesDir: userDir,
      host,
      log: (l) => logs.push(l),
      config: { 'demo-optional': { hello: 'world' } },
    })

    expect(loaded.map((l) => l.name)).toEqual(['demo-optional'])
    expect(loaded[0]?.tools).toEqual(['demo_optional_verb'])
    expect(host.toolDefs().map((d) => d.name)).toEqual(['demo_optional_verb'])
    // config 是按**能力名**索引递进去的，不是按包 id——两者可以不同，写错的表现是包永远收到 `{}`。
    expect(logs.join('\n')).toContain('"hello":"world"')

    await host.dispose()
  })

  it('声明了 capability 却没带 dist/index.js → 安装门拒收（不是装进去一个空壳）', async () => {
    const pkgDir = join(workDir, 'bad-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: PKG_NAME, version: PKG_VERSION, stream: { id: 'demo-optional', capability: 'dist/index.js' } }),
    )
    const out = join(workDir, 'packed-bad')
    mkdirSync(out, { recursive: true })
    execFileSync('npm', ['pack', pkgDir, '--pack-destination', out, '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const tgz = readFileSync(join(out, readdirSync(out).filter((f) => f.endsWith('.tgz'))[0] as string))

    await expect(previewRecipePackage(makeDeps(tgz), PKG_NAME)).rejects.toThrow(/dist\/index.js/)
  })
})

/**
 * 仓库里那个真包（netdisk）的**清单本身**要过安装门的第一关。
 *
 * 这条是被真 tarball 撞出来的：包只写了 `stream.capability`，没写 `stream.id`，于是
 * `previewRecipePackage` 在解描述符那一步就抛 `stream.id — required`——**包永远装不进去**。
 * 而单跑包自己的 suite、`npm pack`、`assert-npm-artifact` 三处全绿：它们只问"文件在不在"，
 * 没有一处去解那份清单。上面那条 e2e 也抓不到（它的夹具自己写了 `id`）。
 *
 * 所以判据必须直接落在**仓库里那份 package.json** 上，不落在夹具上。（meituan 的源码住
 * `JaggerH/stream-packages`，它的清单这里够不着，同一条判据由那边的 prepack 闸与发布流程守。）
 */
describe('仓库里的可选能力包，清单过得了描述符解析', () => {
  it.each(['netdisk'])('capabilities/%s/package.json', (name) => {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'capabilities', name, 'package.json'), 'utf8')) as Record<string, unknown>
    const desc = parseStreamDescriptor(raw, `capabilities/${name}/package.json`)
    expect(desc.id, '没有 id 的包在安装门第一步就被拒，且三道 pack 闸都看不见').toBeTruthy()
    expect(desc.capability).toBe('dist/index.js')
  })
})
