#!/usr/bin/env node
// 把 src/serve.ts bundle 成单文件 ESM，产物落在 `dist/server/`，由 `scripts/build-cli.mjs` 挑成
// `@streamapp/stream` 那个 npm 包的载荷（**唯一的发行形态**）。
// ESM 格式：ad-fixtures.ts 用了 import.meta.url。createRequire banner：CJS 依赖运行时仍调 require()
// （esbuild 的 ESM 输出不 polyfill 它）。原生依赖一律 external：把它们打进 bundle 会触发原生 require。
//
// **external 之后出不出货，判据是静态 import 还是动态 import**，不是"重不重要"：
// - 静态 import 的（better-sqlite3 / playwright-core / sharp）**必须**写进 `cli/package.json` 的
//   dependencies 随包出货——它们在开机那一刻就要解析得到，缺了是 `ERR_MODULE_NOT_FOUND`，后端起不来。
// - 只被动态 import、且有明确降级的（isolated-vm，见 `src/replay/compute-sandbox.ts`）可以不出货：
//   缺失时只有那一个功能报清楚的错，boot 不受影响。
// 这条判据由 `src/install/cli.test.ts` 的「external 掉的包」那条守卫钉着——加一个 external 就得回答它。
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cpSync, rmSync, existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { platformForTriple } from './desktop-platforms.mjs'
import { shouldShipPackage } from './release-package-set.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const esbuildBin = join(root, 'node_modules/.bin/esbuild')
const entry = join(root, 'src/serve.ts')
// 产物目录（gitignored，见 .gitignore 的 `dist/`）。发行形态运行时把它当 cwd：后端按相对路径
// 找内置包（`packages_dir=./packages`）和 sidequest 的 job 清单。
const resourcesDir = join(root, 'dist/server')
const outfile = join(resourcesDir, 'server.mjs')
// ESM 产物里给 external 的 CJS 依赖（better-sqlite3 等）补一个 `require`。
//
// **导入名必须改成一个不会撞的名字**：banner 是原样贴进产物顶部的文本，esbuild 对它一无所知，
// 不会参与重命名。而被打进来的依赖里只要有一个自己 `import { createRequire } from "node:module"`，
// 同一个模块作用域里就有了两个 `createRequire`，产物**在任何平台上都起不来**：
// `SyntaxError: Identifier 'createRequire' has already been declared`。
// dev 不走这份 bundle，所以这个坑只会在打包之后、目标机器第一次启动时才现（实测 2026-08-30，
// 全新 Windows 上就是这句话拦住了后端）。
const banner =
  "import { createRequire as __streamCreateRequire } from 'node:module'; " +
  'const require = __streamCreateRequire(import.meta.url);'

// 宿主版本必须在**构建期**钉进 bundle：readHostVersion() 源码那条 `../../package.json` 在
// server.mjs 所在的产物目录下根本指不到仓库根那份 package.json（发行包里不出货源码树）。注入后，包安装口的 hostVersion 闸门在打包产物里判的是真版本；没注入时
// 该标识符不存在，源码运行走读文件那条（typeof 对未声明标识符安全）。
const hostVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (typeof hostVersion !== 'string') throw new Error('仓库根 package.json 没有 version，无法注入宿主版本')

execFileSync(
  esbuildBin,
  [
    entry,
    `--outfile=${outfile}`,
    `--define:__STREAM_HOST_VERSION__=${JSON.stringify(hostVersion)}`,
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    '--external:better-sqlite3',
    '--external:playwright-core',
    '--external:isolated-vm',
    '--external:sharp',
    '--external:sidequest',
    '--external:@sidequest/*',
    `--banner:js=${banner}`,
  ],
  { stdio: 'inherit' },
)
console.log(`[build-server] wrote ${outfile}`)

// RSSHub 跑在**自己的 worker 线程**里（`src/rsshub-client.ts` → `src/rsshub-worker.ts`），而 worker
// 入口是 `new Worker(new URL('./rsshub-worker.…', import.meta.url))` —— **运行时按路径找的文件，
// 不会被上面那次 bundle 拽进 server.mjs**。所以它必须自己打一份、和 server.mjs 同目录出货；
// 漏了它，发行安装上 RSSHub 本体装了也白装，每条 rsshub 源都是 ERR_MODULE_NOT_FOUND。
//
// 三个 external，各有各的理由：
//   rsshub    —— 用户机器上由 npm 装的运行时依赖（`cli/package.json` 的硬依赖），652 个包，
//                打进来既不可能也不该；worker 用变量 `import(pkgPath)` 拿它，本来也 bundle 不了。
//   tsx / hono/jsx —— **只有开发检出那一档**才会走到（转 .ts 路由、垫 JSX 的 React）；发行形态
//                下 RSSHub 是预构建 ESM，两样都不加载。它们在 worker 里是动态 import，正是为了
//                让这份产物在没有 tsx 的机器上**能加载**。
execFileSync(
  esbuildBin,
  [
    join(root, 'src/rsshub-worker.ts'),
    `--outfile=${join(resourcesDir, 'rsshub-worker.mjs')}`,
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    '--external:rsshub',
    '--external:tsx',
    '--external:hono/jsx',
  ],
  { stdio: 'inherit' },
)
console.log(`[build-server] wrote ${join(resourcesDir, 'rsshub-worker.mjs')}`)

// Sidequest 的 job 清单。**必须和 server.mjs 同目录出货**：它是 Sidequest 在运行时按路径读的
// 文件，不是被 bundle 进去的模块（`jobsFilePath`）。漏了它，任务中心会静默降级成 inert——
// 后端照常 200，只有日志里一行，而定时采集整个不跑（实测 2026-08-30，全新 Windows）。
// 解析规则见 `src/tasks/center.ts` 的 `resolveJobsFile`：先找和自己同目录的这一份。
// Sidequest 的 job 清单。**发行形态下不能照抄仓库里那份**：它写的是
// `export { StreamTaskJob } from './src/tasks/stream-task-job.ts'`，而载荷里没有源码树，
// 于是任务中心起来了、job 一跑就 ERR_MODULE_NOT_FOUND。
//
// 也**不能把 job 类单独再打一份**出货：jobs 是 `runner:'inline'`，就在后端进程里跑；
// 单独一份会造出第二个模块图（第二份任务注册表），job 看到的是空的。
// 指向 bundle 自己即可——同一个文件 URL 命中 ESM 模块缓存，拿到的就是正在跑的那一份。
// 对应的再导出在 `src/serve.ts` 末尾。
writeFileSync(
  join(resourcesDir, 'sidequest.jobs.js'),
  "export { StreamTaskJob } from './server.mjs'\n",
)
console.log('[build-server] generated sidequest.jobs.js → resources/ (re-exports from server.mjs)')

// 面板产物（`app/dist-panel` 的那几个 IIFE bundle）。后端按 `<repoRoot>/app/dist-panel` 发
// `/panel/*`，而发行形态下 repoRoot 就是安装目录——**不出货就是 404**，8900 独立页与 DSH
// 插件挂点里 Stream 的影视/详情/研究/管理四棵树全是空的（独立页先坏），而后端本身一切正常
// （实测 2026-08-30，干净 Windows）。
// 先构建再拷：这些 bundle 不进 git，跟 server.mjs 一样是每次 build 现产的。
try {
  execFileSync('npm', ['run', 'build:panel'], { cwd: join(root, 'app'), stdio: 'inherit' })
  const panelDest = join(resourcesDir, 'app', 'dist-panel')
  rmSync(panelDest, { recursive: true, force: true })
  cpSync(join(root, 'app/dist-panel'), panelDest, { recursive: true })
  console.log(`[build-server] copied app/dist-panel → ${panelDest}`)
} catch (e) {
  // 和 stream-desktop 那一步同样的取舍：不中断整个打包，但警告要说清缺的是什么能力。
  console.warn(`[build-server] 面板产物未出货（8900 独立页与 DSH 插件挂点里 Stream 的面板会 404，独立页先坏）：${String(e).slice(0, 200)}`)
}

// boot 时按 cwd 读的只读资源目录（bootstrap loadConfig：packages_dir=./packages，resource-dir 反导已退役）。
// 每次 build 刷新拷，不作为静态副本 commit（见 .gitignore）。内置包（插件包 + tier-0 的 http/html recipe 包）
// 都住这一层，包自己的 `manifests.yaml` 和 `*.recipe.json` 跟着目录一起走，所以拷这一个目录就齐了。
// **RSSHub 本体随发行包出货**，但不是从这里拷的：它是 npm 包 `rsshub`（`cli/package.json` 的硬
// 依赖，预构建 ESM），由用户机器上的 npm 装到 `<安装目录>/node_modules/rsshub`。旁边那个 git
// 检出**仍然不拷**——它是开发形态用的 TS 源码（自己写路由时改了要立刻跑到，见
// `src/rsshub-client.ts` 的解析顺序：检出 > npm 包）。
// 跟着检出走的是 **catalog**（`assets/build/routes.json`，RSSHub 的构建产物，不在 npm tarball
// 里）：发行形态没有它，选源页降级为「curated + recipe，无 RSSHub 长尾」。路由本身照跑。
// 出货资源里不放测试件与开发残渣：这是**分发给用户的包**——测试代码、mock、__pycache__
// 进不了货。
const SHIP_SKIP = /(?:\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$|(?:^|[\\/])(?:__pycache__|__tests__|node_modules)(?:[\\/]|$)/
// 出货 skill 目录（`src/skills/shipped.ts` 的 SHIPPED_SKILLS，由 shipped.test.ts 钉两处清单一致）。
for (const dir of ['packages', '.claude/skills/purchase-decision', '.claude/skills/netdisk-library', '.claude/skills/drive-live-ui', '.claude/skills/share-recipes', '.claude/skills/write-recipe', '.claude/skills/stream-assistant', '.claude/skills/onboard-source']) {
  const dest = join(resourcesDir, dir)
  rmSync(dest, { recursive: true, force: true })
  const source = join(root, dir)
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      if (SHIP_SKIP.test(src)) return false
      if (dir !== 'packages') return true
      const [packageId] = relative(source, src).split(/[\\/]/)
      return !packageId || shouldShipPackage(packageId)
    },
  })
  console.log(`[build-server] copied ${dir}/ → ${dest} (tests/dev artifacts skipped)`)
}

// triple 必须是**构建目标**的，不是本机的：本项目从 Linux 交叉编译到 Windows，拿 host
// triple 会产出一个 Linux 二进制、落进错的平台包，而 npm 安装照样成功。
// 取值顺序：命令行 --target → 本机 host。
//
// **它必须在这里（靠前）解出来**：下面 better-sqlite3 那一步要按它挑原生件——跨平台构建时
// 拿本机那份是坏的，而坏得很晚（要到目标机器第一次启动才炸）。
const fromArgv = process.argv.find((a) => a.startsWith('--target='))?.slice(9)
  ?? (process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : undefined)
const hostTriple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n').find((l) => l.startsWith('host:'))?.slice(6).trim()
const targetTriple = fromArgv || hostTriple

// --sqlite-prebuild=<triple>:<path> 把某 target 的 better-sqlite3 预编译 .node 换进去（跨平台构建用）。
// 见 Task 7：从归档的 --win32-x64-sqlite= 推广到四平台。不带该 flag 时：目标平台 == 本机就用本机
// 那份原生件；不等就**自动去下载对应平台的预编译件**（见 `stageSqlitePrebuild`）。
const prebuildArg = process.argv.find((a) => a.startsWith('--sqlite-prebuild='))
const prebuildPath = prebuildArg
  ? prebuildArg.slice('--sqlite-prebuild='.length).split(':').slice(1).join(':')
  : undefined
if (prebuildArg && !existsSync(prebuildPath)) {
  throw new Error(`--sqlite-prebuild 指向的 .node 不存在: ${prebuildPath}`)
}

/** rust triple → better-sqlite3 预编译件文件名里的 `<platform>-<arch>`。不在表里 = 我们没为它出过货。 */
const SQLITE_PLATFORM = {
  'x86_64-pc-windows-gnu': 'win32-x64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
}

/** node 大版本 → `NODE_MODULE_VERSION`（原生件 ABI）。预编译件的文件名里带的就是这个数。 */
const NODE_ABI = { 20: '115', 22: '127', 24: '137' }

/**
 * 下载目标平台的 better-sqlite3 预编译 `.node`，返回它的路径。
 *
 * **ABI 要跟着"我们打包进去的那个 node"走，不是构建机的 node**：两者不同版本时（设了
 * `STREAM_BUNDLED_NODE`）挑错 ABI 的原生件同样加载不了，而症状一模一样。
 *
 * 源的顺序和 `stageNode` 一致：官方（GitHub Release）优先、npmmirror 兜底——这台构建机到
 * 境外的 TLS 握手时好时坏，而镜像是同一份产物。全挂就抛，且把试过哪些列出来。
 */
async function stageSqlitePrebuild(triple, pkgDir) {
  const plat = SQLITE_PLATFORM[triple]
  if (!plat) throw new Error(`没有为 ${triple} 登记 better-sqlite3 预编译件的平台名（补进 SQLITE_PLATFORM）`)
  const ver = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
  const nodeVer = process.env.STREAM_BUNDLED_NODE ?? process.version
  const major = Number(nodeVer.replace(/^v/, '').split('.')[0])
  const abi = NODE_ABI[major] ?? (nodeVer === process.version ? process.versions.modules : undefined)
  if (!abi) throw new Error(`不知道 node ${nodeVer} 的原生件 ABI（补进 NODE_ABI）`)
  const file = `better-sqlite3-v${ver}-node-v${abi}-${plat}.tar.gz`
  const sources = [
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${ver}/${file}`,
    `https://cdn.npmmirror.com/binaries/better-sqlite3/v${ver}/${file}`,
  ]
  const tmp = join(root, 'dist/.sqlite-dl')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const archive = join(tmp, file)
  const tried = []
  for (const url of sources) {
    try {
      console.log(`[build-server] 下载 better-sqlite3 预编译件（${plat}, node ABI ${abi}）: ${url}`)
      execFileSync('curl', ['-fsSL', '--connect-timeout', '20', '-o', archive, url], { stdio: 'inherit' })
      execFileSync('tar', ['-xzf', archive, '-C', tmp])
      const out = join(tmp, 'build/Release/better_sqlite3.node')
      if (!existsSync(out)) throw new Error('解包后没找到 build/Release/better_sqlite3.node')
      return out
    } catch (e) {
      tried.push(`${url} → ${String(e).slice(0, 120)}`)
    }
  }
  throw new Error(
    `better-sqlite3 的 ${plat} 预编译件拿不到，试过：\n  ${tried.join('\n  ')}\n` +
    `没有它就只能打进本机平台那份，那个包在目标机器上一启动就炸——所以这里直接失败，` +
    `不产出一个坏包。离线构建请自己下好再传 --sqlite-prebuild=${triple}:<path-to-.node>。`,
  )
}

function findPnpmPkg(name) {
  const pnpmDir = join(root, 'node_modules/.pnpm')
  // pnpm 把 scope 包的目录名里的 `/` 编码成 `+`（`@sidequest/sqlite-backend` →
  // `@sidequest+sqlite-backend@1.16.2`），而**包自己在里层仍然是真名**。不换这一下，
  // 任何 scope 包都会被判成"没装"——报错还长得像依赖真的缺失。
  const dirPrefix = name.replace('/', '+')
  // `${name}@` 的 `@` 防前缀误撞（`playwright-core@` 不会被 `playwright@` 命中）。
  const matches = readdirSync(pnpmDir).filter((d) => d.startsWith(`${dirPrefix}@`))
  if (matches.length === 0) throw new Error(`${name} not found under node_modules/.pnpm`)
  if (matches.length > 1) {
    // 多版本共存（不同 peer 依赖树）→ 打第一个但告警：原生件 ABI 挑错版会在运行时炸，值得人核对。
    console.warn(`[build-server] WARN: ${name} 有多个版本 ${matches.join(', ')}，打包首个 ${matches[0]}；请核对 pnpm-lock 是否与运行时 resolve 一致`)
  }
  return join(pnpmDir, matches[0], 'node_modules', name)
}
const nodeModulesDest = join(resourcesDir, 'node_modules')
rmSync(nodeModulesDest, { recursive: true, force: true })

// better-sqlite3：package.json + lib/（JS 包装）+ 编译好的 .node —— 跳过 src/deps/binding.gyp（build 期
// 才用）。外加它自己的运行时依赖链 bindings → file-uri-to-path：better-sqlite3 用 `bindings` 定位 .node，
// 缺它会在隔离环境炸（归档 3.1 踩过），必须一并出货，不能只靠 "external" 隐含。
{
  const src = findPnpmPkg('better-sqlite3')
  const dest = join(nodeModulesDest, 'better-sqlite3')
  cpSync(join(src, 'package.json'), join(dest, 'package.json'))
  cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true })
  cpSync(join(src, 'build/Release'), join(dest, 'build/Release'), { recursive: true })
  const native = join(dest, 'build/Release/better_sqlite3.node')
  if (prebuildPath) {
    cpSync(prebuildPath, native)
    console.log(`[build-server] bundled better-sqlite3 (native binary swapped: ${prebuildPath}) → ${dest}`)
  } else if (SQLITE_PLATFORM[targetTriple] && SQLITE_PLATFORM[targetTriple] !== SQLITE_PLATFORM[hostTriple]) {
    // **跨平台构建**：本机那份 .node 是给本机平台编的，拷过去在目标机器上根本加载不了。
    // 以前这里只打一行「用的是本 HOST 的原生件」就放行——于是产出一个看起来完好、
    // 在用户机器上第一次启动才炸的包，而错误信息是一句看不懂的原生模块加载失败，
    // 离真因（构建时挑错了平台）十万八千里。现在自动去下对应平台那一份，下不到就让构建失败。
    const staged = await stageSqlitePrebuild(targetTriple, src)
    cpSync(staged, native)
    rmSync(join(root, 'dist/.sqlite-dl'), { recursive: true, force: true })
  } else {
    console.log(`[build-server] bundled better-sqlite3 (native binary is this HOST's platform) → ${dest}`)
  }
  for (const dep of ['bindings', 'file-uri-to-path']) {
    const depSrc = findPnpmPkg(dep)
    const depDest = join(nodeModulesDest, dep)
    cpSync(depSrc, depDest, { recursive: true, filter: (p) => !p.includes(`${depSrc}/node_modules`) })
    console.log(`[build-server] bundled ${dep} (better-sqlite3 runtime dep) → ${depDest}`)
  }
}
// playwright-core：纯 JS、无原生件——v1 打包 app 不带任何 chromium（Non-Goal），这里只是 chrome.ts import
// 的 API 表面。
{
  const src = findPnpmPkg('playwright-core')
  const dest = join(nodeModulesDest, 'playwright-core')
  cpSync(src, dest, { recursive: true, filter: (p) => !p.includes(`${src}/node_modules`) })
  console.log(`[build-server] bundled playwright-core → ${dest}`)
}
// 任务中心的后端驱动：**按包名在运行时解析**，esbuild 打不进去。
//
// `center.ts` 传给 Sidequest 的是 `backend: { driver: '@sidequest/sqlite-backend' }`，而那个字段
// 的类型就是 `string`（`@sidequest/backend` 的 `config.d.ts`）——没有"传一个类进去"的口子。所以
// 它和它的运行时依赖必须真的躺在 `resources/node_modules` 里。
//
// 漏了它的症状**极其安静**：后端照常 200、页面一切正常，只有日志里一行
// `[tasks] task center disabled`——而定时采集整个不跑。实测 2026-08-30 在一台全新 Windows 上
// 就是这样（先是 jobsFilePath 解析错，修完才露出这一层）。
//
// 为什么用 npm 装到临时目录再拷，而不是从本仓库的 pnpm 树里挑：pnpm 的每个包目录下只有指向
// `.pnpm/` 的软链，照着递归解引用会炸开成一棵巨大且带环的树；npm 装出来的是扁平闭包，形状
// 正是运行时要的。版本从**本仓库解析到的那一份**读，不写死——两个数分家会装到一个和 bundle 里
// 那份不配套的驱动，而它不会报错，只会在某个 API 上行为不同。
//
// **better-sqlite3 从这棵闭包里剔掉**：它会带一个 12.x 且没编原生件的副本，而我们上面已经打了
// 一份带目标平台原生件的 11.10。留着它，knex 会解析到那个空壳。
{
  const ver = JSON.parse(readFileSync(join(findPnpmPkg('@sidequest/sqlite-backend'), 'package.json'), 'utf8')).version
  const tmp = join(root, 'dist/.sq-dl')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  // **这个 package.json 不是装饰**：npm 找不到它就会一路往上翻，翻到仓库里某份 package.json
  // 就把这 80 多个包装进那棵依赖树里去了（实测撞过一次，污染了前端的依赖树）。
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'stream-sq-stage', private: true }))
  console.log(`[build-server] 装任务中心的后端驱动闭包：@sidequest/sqlite-backend@${ver}`)
  execFileSync('npm', ['install', '--no-save', '--omit=dev', '--ignore-scripts', `@sidequest/sqlite-backend@${ver}`], {
    cwd: tmp,
    stdio: 'inherit',
  })
  const from = join(tmp, 'node_modules')
  rmSync(join(from, 'better-sqlite3'), { recursive: true, force: true })
  for (const name of readdirSync(from)) {
    cpSync(join(from, name), join(nodeModulesDest, name), { recursive: true })
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[build-server] bundled @sidequest/sqlite-backend + 运行时依赖 → ${nodeModulesDest}`)
}
// 注意：isolated-vm / sharp 故意**不出货**——external + 缺了降级（D-native）。

// ── stream-desktop 平台包 ─────────────────────────────────────────────────────
// 那个二进制的生命周期归 Stream Desktop（`capabilities/desktop/`），二进制按平台走 npm 子包，
// 所以这里的产物落点是**平台包的 bin/**。
//
// 一次构建只产出**当前 target 的那一个包**。四个包全有，是发版时按平台各跑一次的结果
// （交叉编译在发版 recipe 里，不在这个脚本的职责内）。
//
// 构建失败**不中断**整个打包：桌面控制是可选增强，缺了它 Stream 照常能用；让一次 Rust
// 工具链问题拦住整个发布不成比例。代价是缺失只有一行警告——所以那行警告要写清楚缺的是
// 什么能力，不能只说 "build failed"。
const agentManifest = join(root, 'app/host-agent/Cargo.toml')
if (existsSync(agentManifest)) {
  try {
    const triple = targetTriple
    if (!triple) throw new Error('无法确定目标 triple（--target / rustc -vV 都没给出）')
    const { pkg, ext } = platformForTriple(triple)
    const cargoArgs = ['build', '--release', '--manifest-path', agentManifest]
    if (triple !== hostTriple) cargoArgs.push('--target', triple)
    execFileSync('cargo', cargoArgs, { stdio: 'inherit' })
    // 交叉编译时产物在 target/<triple>/release/，本机构建时在 target/release/
    const built = triple === hostTriple
      ? join(root, 'app/host-agent/target/release', `stream-desktop${ext}`)
      : join(root, 'app/host-agent/target', triple, 'release', `stream-desktop${ext}`)
    const binDir = join(root, 'capabilities/desktop/platforms', pkg, 'bin')
    mkdirSync(binDir, { recursive: true }) // 仓库里不存二进制，目录首次构建时才出现
    cpSync(built, join(binDir, `stream-desktop${ext}`))
    console.log(`[build-server] stream-desktop → platforms/${pkg}/bin/stream-desktop${ext}`)
  } catch (e) {
    console.warn(`[build-server] stream-desktop 未打包（桌面应用自动化 + 无人值守唤起 Chrome 这两项将不可用）：${String(e).slice(0, 200)}`)
  }
}

// ── Chrome 扩展的构建产物 ─────────────────────────────────────────────────────
// 安装引导（spec 2026-08-30-extension-onboarding §5）要有一个**能指给 Chrome 看的目录**：
// 手动装那条路要把路径念给用户听，代装那条路要把它写进文件夹对话框。发行形态里如果没有
// 这个目录，两条路都是空的——而症状是"按钮点了没反应"，不是任何一处报错。
//
// 落点是资源目录里的**同一个相对路径**（`extension/.output/chrome-mv3`），因为运行时的
// 来源解析就按这个相对路径找（源码跑时锚在仓库根，打包后锚在 cwd = 这个资源目录，与
// `packages_dir=./packages` 同一个锚）。
//
// 构建失败**不中断**整体打包（同 stream-desktop 那一步）：但警告要写清缺的是什么能力。
{
  const built = join(root, 'extension/.output/chrome-mv3')
  try {
    execFileSync('pnpm', ['--dir', join(root, 'extension'), 'build'], { stdio: 'inherit' })
    if (!existsSync(built)) throw new Error(`构建跑完了但产物不在：${built}`)
    const dest = join(resourcesDir, 'extension/.output/chrome-mv3')
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(built, dest, { recursive: true })
    console.log(`[build-server] extension → ${dest}`)
  } catch (e) {
    console.warn(
      `[build-server] 扩展未打包（发行形态里将没有可安装的扩展目录，安装引导的两条路——代装和手动——都装不了）：${String(e).slice(0, 200)}`,
    )
  }
}
