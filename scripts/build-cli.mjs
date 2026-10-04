#!/usr/bin/env node
// 把 `@streamapp/stream`（那条 `npx` 命令）组装出来。
//
// **它复用 `build-server.mjs` 的产物（`dist/server/`），不另起一套**：发行形态的运行契约只有
// 一份——cwd 设成资源目录、跑 `server.mjs`、env 传端口和数据目录。
//
// **原生依赖不随包出货**：交给 npm 按用户平台装——`better-sqlite3` 的原生件、任务中心那个按包名
// 在运行时解析的 sqlite 驱动，都在 `cli/package.json` 的 dependencies 里声明。少打包一份 = 少一份
// "装到一个和 bundle 不配套的原生件"的机会，而那种错只会在运行时炸。
//
// 用法：`node scripts/build-cli.mjs`（会先跑一次 build-server.mjs）
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cpSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resources = join(root, 'dist/server')
const cliDir = join(root, 'cli')
const dest = join(cliDir, 'resources')

const skipBuild = process.argv.includes('--no-build')
if (!skipBuild) {
  console.log('[build-cli] building the server payload…')
  execFileSync(process.execPath, [join(root, 'scripts/build-server.mjs')], { stdio: 'inherit', cwd: root })
}

if (!existsSync(join(resources, 'server.mjs'))) {
  throw new Error(`[build-cli] ${resources}/server.mjs 不在——先跑 node scripts/build-server.mjs`)
}

// 出货清单。**逐项显式列**，不是"整个 resources 拷过去"：那样会把自带的 node、npm 和
// 原生 node_modules 一起塞进 tarball（几十 MB，而且平台绑死）。
//
// 每一项后面那句是"漏了会怎样"——这几条全是活体上撞出来的，不是推的：
const SHIP = [
  // 后端本体。
  { rel: 'server.mjs', why: '没它就没有后端' },
  // Sidequest 按**路径**读的 job 清单（不是被 bundle 进去的模块）。漏了它任务中心静默降级：
  // 后端照常 200、页面正常，只有日志里一行，而定时采集整个不跑。
  { rel: 'sidequest.jobs.js', why: '漏了 = 定时采集静默不跑' },
  // 内置包（35 个：清单 / recipe / adapter 代码）。
  { rel: 'packages', why: '漏了 = 一个源都没有' },
  // RSSHub 的 worker 入口。**它不在 server.mjs 里**（运行时按路径 new Worker 的文件，见
  // build-server.mjs 那一步）。RSSHub 本体由 npm 装（cli/package.json 的 `rsshub`），
  // 漏了这个入口就是「装了却跑不了」：每条 rsshub 源 ERR_MODULE_NOT_FOUND，
  // 开箱那 5 条 movie-* 榜单流全死。
  { rel: 'rsshub-worker.mjs', why: '漏了 = RSSHub 装了也跑不了' },
  // 工作台里那四棵树的独立 bundle，后端当静态文件从 /panel/* 发。漏了页面上是 404。
  { rel: 'app/dist-panel', why: '漏了 = 8900 独立页与 DSH 插件挂点里的面板全 404（独立页先坏）' },
  // **扩展不在这张清单里**：它由 npm 装（`cli/package.json` 的 `@streamapp/chrome-extension`），
  // 装机引导从那儿解出目录再物化到 <dataDir>/extension/（`shared/browser-relay/extension-dir.ts`
  // 第二档）。好处是升级扩展不用重发 Stream，且发行包小一份。
  // 出货 skill 目录：`POST /api/skills/install` 把它们链进用户自己的 Claude Code / Codex
  // （`src/skills/`）。清单由 `src/skills/shipped.test.ts` 钉着，与 build-server.mjs 那份一致。
  { rel: '.claude/skills/purchase-decision', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/netdisk-library', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/drive-live-ui', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/share-recipes', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/write-recipe', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/stream-assistant', why: '漏了 = 用户装不了这份 skill' },
  { rel: '.claude/skills/onboard-source', why: '漏了 = 用户装不了这份 skill' },
]

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const { rel, why } of SHIP) {
  const src = join(resources, rel)
  if (!existsSync(src)) throw new Error(`[build-cli] 缺 ${rel}（${why}）——上游构建没产出它`)
  const out = join(dest, rel)
  mkdirSync(dirname(out), { recursive: true })
  cpSync(src, out, { recursive: true })
}

// 法务文件与后端载荷同一趟进入 npm 包：`files` 只认 cli/ 自己的路径，不能用 ../
// 偷指仓库根，否则 npm pack 会静默漏掉声明。
for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICE']) {
  cpSync(join(root, name), join(cliDir, name))
}

// bin：把 `src/install/cli.ts` 打成一个自足的 mjs。**逻辑住在 src/ 里是故意的**——那里有
// typecheck 和测试盯着；手写一份 JS 在这里，就是一块没人验的代码。
const banner =
  "import { createRequire as __streamCreateRequire } from 'node:module'; " +
  'const require = __streamCreateRequire(import.meta.url);'
mkdirSync(join(cliDir, 'bin'), { recursive: true })
execFileSync(
  join(root, 'node_modules/.bin/esbuild'),
  [
    join(root, 'src/install/cli-entry.ts'),
    `--outfile=${join(cliDir, 'bin/stream.mjs')}`,
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    `--banner:js=#!/usr/bin/env node\n${banner}`,
    `--define:__STREAM_CLI_VERSION__=${JSON.stringify(JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version)}`,
  ],
  { stdio: 'inherit' },
)

const size = (p) => {
  const st = statSync(p)
  return st.isFile() ? st.size : 0
}
writeFileSync(join(cliDir, '.gitignore'), 'resources/\nbin/\nnode_modules/\nLICENSE\nNOTICE\nTHIRD-PARTY-NOTICE\n')
console.log(`[build-cli] ok — bin/stream.mjs ${(size(join(cliDir, 'bin/stream.mjs')) / 1e6).toFixed(1)}MB, resources/ staged`)
