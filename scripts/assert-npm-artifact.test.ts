// scripts/assert-npm-artifact.test.ts
//
// 这道闸守的是一种**只在别人机器上现形**的失败：出货物是构建产物、又在 .gitignore 里，于是
// 干净检出直接 publish 会成功地发出一个空壳包，`npm install` 照样成功，一直到运行时才报
// 「没装上」。所以闸本身必须有测试——一道从来没红过的闸，和没有闸分不出来。
//
// 用真进程跑（而不是 import 一个函数）是故意的：它的契约就是**退出码**（`prepack` 靠非 0
// 才能拦住 `npm publish`），import 进来测函数返回值等于换了一个契约测。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'assert-npm-artifact.mjs')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assert-npm-artifact-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 在临时包目录里跑闸；返回 { code, out }，非 0 不抛（退出码正是被测契约）。 */
function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: `${err.stdout}${err.stderr}` }
  }
}

function writeManifest(files: string[], exports?: unknown): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@test/pkg', version: '0.0.0', files, ...(exports !== undefined ? { exports } : {}) }),
  )
}

describe('assert-npm-artifact', () => {
  it('files 里的目录不存在（= 没跑过构建的干净检出）→ 非 0，且点名是哪一项', () => {
    writeManifest(['bin/'])
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('bin')
  })

  it('目录在但里面是空的 → 同样非 0（目录存在不等于产物存在）', () => {
    writeManifest(['bin/'])
    mkdirSync(join(dir, 'bin'))
    expect(runGate().code).toBe(1)
  })

  it('文件在但是 0 字节 → 非 0。cp 中断、构建写了个空文件都长这样，而它照样能发出去', () => {
    writeManifest(['bin/'])
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'stream-desktop.exe'), '')
    expect(runGate().code).toBe(1)
  })

  it('产物齐了 → 0，放行', () => {
    writeManifest(['bin/'])
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'stream-desktop.exe'), 'MZ...')
    expect(runGate().code).toBe(0)
  })

  it('files 列的是具体文件（主包的形状：lib/index.js）→ 逐个查，缺一个就拦', () => {
    writeManifest(['lib/index.js', 'lib/index.d.ts'])
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
    const missing = runGate()
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('index.d.ts')

    writeFileSync(join(dir, 'lib', 'index.d.ts'), 'export {}')
    expect(runGate().code).toBe(0)
  })

  it('桌面平台包不能把整个 bin/ 当白名单：否则 see-detector 之类的本机构件会随 publish 漏出去', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@streamapp/desktop-win32-x64', version: '0.0.0', files: ['bin/'] }),
    )
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'stream-desktop.exe'), 'MZ...')
    writeFileSync(join(dir, 'bin', 'see-detector.onnx'), 'not for distribution')
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('bin/')
    expect(r.out).toContain('see-detector')
  })

  // ── 第二条判据：exports 指到的文件也得在 ─────────────────────────────────────────────
  //
  // `files` 和 `exports` 是两份各写各的清单：前者说"打进 tarball"，后者说"import 这个子路径时
  // 给你这个文件"，谁也不管谁。真栽过的形状（Stream Desktop 的前身，浏览器那一半）：`files` 全绿、publish 成功、
  // install 成功，一直到运行时 import 才 ERR_MODULE_NOT_FOUND。

  it('exports 指到一个不存在的文件 → 非 0，且点名是哪个子路径的哪个条件', () => {
    writeManifest(['lib'], { '.': { types: './lib/index.d.ts', default: './lib/index.js' } })
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.d.ts'), 'export {}')
    // 只缺 default 那一份——`files` 那一关照样绿（`lib` 目录里有非空文件）。
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('./lib/index.js')
    expect(r.out).toContain('default')
  })

  it('【有牙证明】同一份清单里 files 全绿，只有 exports 那条判据能拦住它', () => {
    // 这条和上一条只差一个断言：证明上一条红的原因确实是新判据，而不是 files 那一关顺手红的。
    writeManifest(['lib'], { '.': './lib/index.js' })
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'other.js'), 'export {}') // lib 非空 → files 那关放行
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('lib 里没有任何非空文件')
    expect(r.out).toContain('./lib/index.js')
  })

  it('exports 的子路径表（"." 与 "./dsh" 两个入口）逐个查，都在才放行', () => {
    writeManifest(['lib'], {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './dsh': { types: './lib/dsh.d.ts', default: './lib/dsh.js' },
      './package.json': './package.json',
    })
    mkdirSync(join(dir, 'lib'))
    for (const f of ['index.d.ts', 'index.js', 'dsh.d.ts']) writeFileSync(join(dir, 'lib', f), 'export {}')
    expect(runGate().code).toBe(1) // 缺 dsh.js
    writeFileSync(join(dir, 'lib', 'dsh.js'), 'export {}')
    expect(runGate().code).toBe(0)
  })

  it('exports 里的非相对目标（包名转发）不查——那不是本包盘上的文件', () => {
    writeManifest(['lib'], { '.': './lib/index.js', './vendor': 'some-other-package/thing' })
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
    expect(runGate().code).toBe(0)
  })

  it('没有 exports 字段 → 只查 files，照常放行（大多数包是这个形状）', () => {
    writeManifest(['lib'])
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
    expect(runGate().code).toBe(0)
  })

  it('没有 files 字段 → 非 0：这道闸的判据是从 files 派生的，没有它就等于没在守', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@test/pkg', version: '0.0.0' }))
    expect(runGate().code).toBe(1)
  })

  // ── 第三条判据：依赖里不许有本地协议 ─────────────────────────────────────────────────
  //
  // `file:` 在本仓库里装得上、测得绿、`npm pack` 也成功；发上 npm 之后别人 `npm install`
  // 才发现 registry 上没有那个路径。闸放在 publish 这一刻，是因为开发期这么写是合法的。

  /** 写一份产物齐全的 manifest（files/exports 两关必绿），只让 deps 那一格变量。 */
  function writeHealthyPkgWithDeps(deps: Record<string, unknown>, field = 'dependencies'): void {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@test/pkg', version: '0.0.0', files: ['lib'], [field]: deps }),
    )
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
  }

  it('dependencies 里有 file: → 非 0，点名是哪个包，并说清该怎么改', () => {
    writeHealthyPkgWithDeps({ '@streamapp/chrome-extension': 'file:../../extension' })
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('@streamapp/chrome-extension')
    expect(r.out).toContain('file:')
    expect(r.out).toContain('^<version>')
    // 有牙证明：红的是新判据，不是 files/exports 那两关顺手红的。
    expect(r.out).not.toContain('没有任何非空文件')
  })

  it('link: / workspace: 同样拦；正常的 semver 范围放行', () => {
    writeHealthyPkgWithDeps({ a: 'link:../a' })
    expect(runGate().code).toBe(1)
    writeHealthyPkgWithDeps({ a: 'workspace:*' }, 'peerDependencies')
    expect(runGate().code).toBe(1)
    writeHealthyPkgWithDeps({ a: 'file:../a' }, 'optionalDependencies')
    expect(runGate().code).toBe(1)

    writeHealthyPkgWithDeps({ a: '^1.2.3', b: 'npm:c@^2' })
    expect(runGate().code).toBe(0)
  })

  it('公开仓库链接放行，陌生或非 HTTPS 的链接拒绝——npm 页面不能把读者带到死路', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@streamapp/stream', version: '0.0.0', files: ['lib'],
        repository: { type: 'git', url: 'git+https://github.com/JaggerH/stream.git' },
        homepage: 'https://github.com/JaggerH/stream#readme',
      }),
    )
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
    expect(runGate().code).toBe(0)

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@test/pkg', version: '0.0.0', files: ['lib'], homepage: 'http://intranet.example' }))
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('公开 GitHub 链接')
  })

  // ── 第五条判据：Stream 包的代码槽位——恰好一个产物、tarball 清单过安装门白名单 ─────────
  //
  // 后端装第三方包只认 `dist/index.js` 一个字面量；`dist/` 里多一个 chunk 或 tarball 里夹了别的
  // 文件，安装门会拒掉**整个包**——而 `npm publish` 对此毫无感觉。这几条都会真跑一次
  // `npm pack --dry-run`（经 `recipe-release-plan.ts --check`），比上面那些慢一个量级。

  /** 七个带代码的内置包共用的 manifest 形状：`files` 是标准四格，`stream.code.entry` 指 dist。 */
  function writeStreamCodePkg(over: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '0.0.0',
        type: 'module',
        files: ['dist', '*.recipe.json', 'manifests.yaml', 'README.md'],
        stream: { id: 'pkg', code: { entry: 'dist/index.js' } },
        ...over,
      }),
    )
  }

  it('dist/index.js 在、独占目录、清单只有白名单内的文件 → 0；README / manifests 缺席不算错（动作包本来就没有）', () => {
    writeStreamCodePkg()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.js'), 'export function activate() {}')
    writeFileSync(join(dir, 'x.recipe.json'), '{}')
    const r = runGate()
    expect(r.out).not.toContain('README.md 不存在')
    expect(r.code).toBe(0)
  })

  it('dist/ 里多出一个 chunk → 非 0，点名那个文件（files 那关照样绿——dist 非空）', () => {
    writeStreamCodePkg()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.js'), 'import "./chunk-abc.js"')
    writeFileSync(join(dir, 'dist', 'chunk-abc.js'), 'export {}')
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('chunk-abc.js')
    expect(r.out).not.toContain('没有任何非空文件')
  })

  it('声明了代码槽位但没跑构建（dist 不在）→ 非 0，提示先 bundle', () => {
    writeStreamCodePkg()
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('packages:bundle')
  })

  it('files 写宽了、tarball 里夹进安装门不收的文件（如 tsdown.config.ts）→ 非 0，点名它', () => {
    writeStreamCodePkg({ files: ['dist', 'tsdown.config.ts'] })
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {}')
    writeFileSync(join(dir, 'tsdown.config.ts'), 'export default {}')
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('tsdown.config.ts')
  })

  it('非 Stream 包缺一个字面 files 条目照样拦——可选槽位的宽限只给 Stream 包', () => {
    writeManifest(['lib', 'README.md'])
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}')
    const r = runGate()
    expect(r.code).toBe(1)
    expect(r.out).toContain('README.md 不存在')
  })

  it('闸接受包目录参数——不必 cd 进去（根脚本逐包调它）', () => {
    writeStreamCodePkg()
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {}')
    const out = execFileSync(process.execPath, [SCRIPT, dir], { cwd: tmpdir(), encoding: 'utf8', stdio: 'pipe' })
    expect(out).toContain('放行')
  })
})
