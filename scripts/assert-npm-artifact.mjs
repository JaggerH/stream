#!/usr/bin/env node
/**
 * publish 闸：断言 `package.json` 的 `files` 里列的每一项**在盘上真的有东西**。
 *
 * 为什么需要它：能力包和它们的平台包出货的都是**构建产物**（`lib/`、
 * `platforms/<pkg>/bin/`），两者都在 `.gitignore` 里。于是在一个没跑过构建的干净检出里
 * `npm publish` 会**成功**，产出一个空壳包——`npm install` 照样成功，要一直到运行时插件去
 * 找那个文件才报「没装上」。整条链上没有任何一处会红，直到用户那边坏掉。
 *
 * 为什么挂 `prepack` 而不是写进发布脚本：`npm publish` 必跑 `prepack`，所以不管是 CI 跑的
 * 还是有人在本地手发，这道闸都在。只写在 workflow 里的话，绕过 workflow 就等于没有。
 *
 * 判据从 `files` 派生，不另立一份清单——往 `files` 里加一项，这道闸自动跟着守它。
 *
 * **第二条判据：`exports` 里指到的每个文件都得真的在盘上。** `files` 全绿不代表包能用——
 * `files` 说的是"这些东西打进 tarball"，`exports` 说的是"import 这个子路径时给你这个文件"，
 * 两份清单各写各的，谁也不管谁。真栽过的形状（Stream Desktop 的浏览器那一半，
 * 2026-09-06）：`dsh.ts`
 * 有了真内容之后 tsdown 把两个入口的公共部分切成第三个 chunk `lib/src-<hash>.js`，而当时的
 * `files` 是逐文件白名单、列不到它——`files` 那一关照样全绿，`npm publish` 成功、`npm install`
 * 成功，一直要到运行时 `import` 才 `ERR_MODULE_NOT_FOUND`。
 *
 * 这条判据只保证"入口文件本身在"，**保证不了它 import 的 chunk 也在**（那要真跑一次 import）。
 * 但它是零成本的那一半：`files` 里干脆没写 `lib` 时，第一个塌的就是入口本身。
 *
 * **第三条判据：`dependencies` / `optionalDependencies` / `peerDependencies` 里不许有 `file:` /
 * `link:` / `workspace:`。** 本地协议在仓库里装得上、测得绿、`npm pack` 也成功，发上 npm 之后
 * 别人 `npm install` 才发现那个路径在 registry 上不存在。同样是"整条链没有一处会红，直到用户
 * 那边坏掉"。为什么是 publish 闸而不是一条根测试：开发期这么写是合法的——扩展包还没发上 npm，
 * `file:` 是当下唯一跑得通的形态；一条现在必红的根测试只会把 main 弄红。
 *
 * **第四条判据：非 private 的包若声明 `repository` / `homepage`，必须是公开 GitHub 链接；README
 * 里不许有指向 `docs/` 的相对路径。** 一个点了 404 的链接比没有链接更坏——它让人以为自己找错了地方。
 *
 * 负对照（这道闸不是摆设，随手可验）：在任一能力包里把 `exports['.'].default` 改成
 * `./lib/nope.js` 再跑本脚本，必须以 "exports['.'].default → ./lib/nope.js 不存在" 退出 1。
 *
 * **第五条判据（只对 Stream 包——`package.json#stream.code` 或 `stream.capability` 在）：代码槽位的
 * 产物必须**恰好**是一个文件，且整份 tarball 清单过安装门白名单。** 后端装第三方包时只认
 * `dist/index.js` 这一个字面量（`src/packages/code-entry.ts`），安装门（`src/replay/recipe-install.ts`
 * 的 `isAllowedPackageFile`）拒掉任何别的带斜杠的路径。所以 (a) 声明的入口在盘上且非空；(b) `dist/`
 * 里没有第二个文件——tsdown 切出的 chunk、上一代残留、sourcemap，进了 tarball 都会让用户那边的
 * 安装被拒，而 `files: ["dist"]` 出的是整个目录；(c) `npm pack --dry-run` 的清单逐条过白名单——判据
 * 不在这里复刻，交给 `scripts/recipe-release-plan.ts --check`（它 import 的就是安装门那一个函数，
 * CI 发布前核的也是它），这样"本地 prepack 过了、装的时候被拒"这种分家不可能发生。
 *
 * 对这类包，`files` 里**没有 glob 字符的、又不是构建物**的条目（`manifests.yaml` / `README.md`）缺席
 * 不算错：七个带代码的内置包共用同一份 `files` 清单，而一个只做动作的包本来就没有 Source 清单。
 * 这道闸守的是"构建物在不在"——那是 gitignore 里、干净检出上看不见的东西；源码文件少了 git 自己
 * 会说。glob 条目一律不查存在性：npm 对没匹配到的 glob就是不带，真出货了什么由 (c) 说。
 *
 * 用法：`node <repo>/scripts/assert-npm-artifact.mjs [<包目录>]`——不传就是 cwd（`prepack` 那一刻
 * cwd 正是被打包的那个包）。
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = resolve(process.argv[2] ?? process.cwd())
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const entries = pkg.files ?? []

if (entries.length === 0) {
  console.error(`[assert-npm-artifact] ${pkg.name}: package.json 没有 files 字段——这道闸守不住任何东西，先把出货清单写明。`)
  process.exit(1)
}

/** 这个包声明的代码槽位入口（`stream.code.entry` 与 `stream.capability` 指同一个文件）；没有 = 纯数据包或非 Stream 包。 */
const codeEntry = pkg.stream?.code?.entry ?? pkg.stream?.capability
const isStreamPackage = pkg.stream !== undefined && pkg.stream !== null
/** Stream 包里可以合法缺席的源码槽位（见头注第五条）。 */
const OPTIONAL_STREAM_SLOTS = new Set(['manifests.yaml', 'README.md'])
const hasGlob = (s) => /[*?[\]{}]/.test(s)

/** 递归找第一个非空文件；有就返回它的相对路径，没有返回 undefined。 */
function firstNonEmptyFile(abs, rel) {
  const st = statSync(abs)
  if (st.isFile()) return st.size > 0 ? rel : undefined
  for (const name of readdirSync(abs)) {
    const hit = firstNonEmptyFile(join(abs, name), `${rel}/${name}`)
    if (hit) return hit
  }
  return undefined
}

const problems = []

// 平台包不是普通的「bin/ 里有什么都发什么」：OCR 运行时需要一组具名文件，视觉检测器
// see-detector.onnx 却明确不出货。目录白名单会把后者或任意本机构件静默塞进 npm 包，
// 所以这里把可发行集合写成每个平台的精确名单，并同时核 manifest 与已构建目录。
const DESKTOP_PLATFORM_FILES = {
  '@streamapp/desktop-win32-x64': [
    'bin/stream-desktop.exe', 'bin/ocr-det.onnx', 'bin/ocr-rec.onnx', 'bin/ocr-rec-dict.txt',
    'bin/onnxruntime.dll', 'bin/msvcp140.dll', 'bin/vcruntime140.dll', 'bin/vcruntime140_1.dll',
  ],
  '@streamapp/desktop-darwin-x64': [
    'bin/stream-desktop', 'bin/ocr-det.onnx', 'bin/ocr-rec.onnx', 'bin/ocr-rec-dict.txt', 'bin/libonnxruntime.dylib',
  ],
  '@streamapp/desktop-darwin-arm64': [
    'bin/stream-desktop', 'bin/ocr-det.onnx', 'bin/ocr-rec.onnx', 'bin/ocr-rec-dict.txt', 'bin/libonnxruntime.dylib',
  ],
}
const desktopFiles = DESKTOP_PLATFORM_FILES[pkg.name]
if (desktopFiles) {
  const declared = [...entries].sort()
  const expected = [...desktopFiles].sort()
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    problems.push(`桌面平台包的 files 必须是逐文件白名单（${expected.join(', ')}），当前是 ${declared.join(', ') || '空'}。`)
  }
  const binDir = join(pkgDir, 'bin')
  if (existsSync(binDir)) {
    const allowed = new Set(expected.map((file) => file.slice('bin/'.length)))
    const extra = listFiles(binDir).filter((file) => !allowed.has(file))
    if (extra.length > 0) problems.push(`桌面平台 bin/ 出现白名单外文件：${extra.map((file) => `bin/${file}`).join(', ')}`)
  }
}
for (const entry of entries) {
  const rel = entry.replace(/\/$/, '')
  if (hasGlob(rel)) continue
  const abs = join(pkgDir, rel)
  if (!existsSync(abs)) {
    if (isStreamPackage && OPTIONAL_STREAM_SLOTS.has(rel)) continue
    problems.push(`${rel} 不存在`)
    continue
  }
  if (!firstNonEmptyFile(abs, rel)) {
    problems.push(`${rel} 里没有任何非空文件`)
  }
}

/**
 * 把 `exports` 摊平成 `[标签, 相对路径]`——它可以是一个字符串、一张子路径表、或每个子路径下
 * 再套一张条件表（`types` / `default` / …）。只收 `./` 开头的相对路径：`exports` 里也能写包名
 * 转发之类的东西，那些不是本包盘上的文件。
 */
function flattenExports(node, label, out) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) out.push([label, node])
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    flattenExports(value, `${label}[${JSON.stringify(key)}]`, out)
  }
}

const exportTargets = []
flattenExports(pkg.exports, 'exports', exportTargets)
for (const [label, rel] of exportTargets) {
  // `./package.json` 这类源码文件本来就在，一起查——它在不在同样决定 `import` 成不成。
  const abs = join(pkgDir, rel.slice(2))
  if (!existsSync(abs) || statSync(abs).size === 0) {
    problems.push(`${label} → ${rel} 不存在或是空文件`)
  }
}

// ── 第三条判据：依赖里不许有本地协议（`file:` / `link:` / `workspace:`）────────────────────
//
// 这三种写法在**本仓库里**都能装、测试全绿、`npm pack` 也成功——但发到 npm 上之后，别人
// `npm install` 时 registry 上根本没有那个路径可解，装到的是一个依赖悬空的包。它和上面两条
// 是同一种病：整条链上没有一处会红，直到用户那边坏掉。
//
// 判据放在 publish 这一刻而不是写成一条根测试，是因为**开发期这么写是合法的**：扩展包
// (`@streamapp/chrome-extension`) 还没发上 npm，本地 `file:` 引用是当下唯一能跑通的形态。
// 一条现在必红的根测试只会把 main 弄红，而这道闸只在真要发的那一刻拦。
const LOCAL_PROTOCOLS = ['file:', 'link:', 'workspace:']
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (typeof range !== 'string') continue
    if (LOCAL_PROTOCOLS.some((p) => range.startsWith(p))) {
      problems.push(
        `${field}["${name}"] = "${range}" 是本地依赖协议——发到 npm 上装不了。` +
          `先把 ${name} 发上 npm（扩展包走 \`node scripts/publish-extension.mjs\`），再把这一格改成 ^<version>。`,
      )
    }
  }
}

// ── 第四条判据：对外可见的文字里不许有只有我们自己打得开的链接 ────────────────────────────
//
// `repository` / `homepage` 在 npm 页面上会变成可点链接。公开发布前，链接若不是明确的公开
// GitHub HTTPS 地址，读者点到的很可能是私有仓库或内网；README 里的相对 `docs/` 路径则在
// npm 页面和本地安装目录都打不开。两种都比没有链接更坏。
if (!pkg.private) {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const publicGithubRepo = typeof repository === 'string' && /^git\+https:\/\/github\.com\/[^/]+\/[^/#]+\.git$/.test(repository)
  const publicGithubHomepage = typeof pkg.homepage === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/#]+(?:#.*)?$/.test(pkg.homepage)
  if (repository !== undefined && !publicGithubRepo) {
    problems.push('package.json 的 `repository` 必须是公开 GitHub 链接（git+https://github.com/<owner>/<repo>.git）。')
  }
  if (pkg.homepage !== undefined && !publicGithubHomepage) {
    problems.push('package.json 的 `homepage` 必须是公开 GitHub 链接（https://github.com/<owner>/<repo>#readme）。')
  }
  if (pkg.repository !== undefined && pkg.homepage !== undefined && publicGithubRepo && publicGithubHomepage) {
    const repoPage = repository.replace(/^git\+/, '').replace(/\.git$/, '')
    if (!pkg.homepage.startsWith(repoPage)) {
      problems.push(
        '`repository` 与 `homepage` 指向不同的公开仓库——npm 页面会把读者带到错误的项目。',
      )
    }
  }
  const readmeRel = readdirSync(pkgDir).find((n) => /^readme(\.md)?$/i.test(n))
  if (readmeRel) {
    const readme = readFileSync(join(pkgDir, readmeRel), 'utf8')
    // 只抓**指向仓库文件树**的相对路径。`https://` 开头的外链不受这条管（那些是真能打开的）。
    const deadLinks = [...readme.matchAll(/(?<![\w/.:-])(?:\.\.\/|\.\/)?docs\/[\w./@-]+/g)].map((m) => m[0])
    if (deadLinks.length > 0) {
      problems.push(
        `README（${readmeRel}）里有指向仓库 docs/ 的路径：${[...new Set(deadLinks)].join(', ')}。` +
          `装了包的人打不开它们——把需要的那句话写进 README 本身。`,
      )
    }
  }
}

// ── 第五条判据：Stream 包的代码槽位——恰好一个产物文件，整份 tarball 过安装门白名单 ─────────
//
// 三个子判据各拦一种"装得进、起不来"：入口不在（没跑构建）；`dist/` 多出文件（切了 chunk / 上一代
// 残留——安装门拒掉整个包）；tarball 里夹了别的东西（`files` 写宽了）。白名单判据本体在安装门
// （`isAllowedPackageFile`），这里经 `recipe-release-plan.ts --check` 借用它，不另抄一份正则。
if (codeEntry) {
  const entryAbs = join(pkgDir, codeEntry)
  if (!existsSync(entryAbs) || statSync(entryAbs).size === 0) {
    problems.push(`代码槽位入口 ${codeEntry} 不存在或是空文件——先 \`pnpm packages:bundle\`（内置包）/ \`pnpm -C <包> bundle\`（能力包）`)
  } else {
    const distDir = dirname(entryAbs)
    const extra = listFiles(distDir).filter((rel) => rel !== codeEntry.split('/').pop())
    if (extra.length > 0) {
      problems.push(
        `${dirname(codeEntry)}/ 里除了入口还有：${extra.join(', ')}——第三方层只认 ${codeEntry} 一个文件，` +
          '多出来的会让安装门拒掉整个包。切了 chunk 就回 tsdown.config.ts 看 noExternal；残留就 clean 后重建。',
      )
    }
  }
  const check = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
    [join(repoRoot, 'scripts', 'recipe-release-plan.ts'), '--check', pkgDir],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (check.error) {
    problems.push(`跑不起 tarball 白名单核对（${check.error.message}）——在仓库根装过依赖了吗？`)
  } else if (check.status !== 0) {
    problems.push(`tarball 清单没过安装门白名单：${(check.stderr || check.stdout).trim()}`)
  }
}

/** 目录下所有文件的相对路径（递归），用来数 `dist/` 里有没有第二个文件。 */
function listFiles(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel))
    else out.push(rel)
  }
  return out
}

if (problems.length > 0) {
  console.error(
    `[assert-npm-artifact] ${pkg.name} 这份包还不能发，拒绝打包：\n` +
    problems.map((p) => `  - ${p}`).join('\n') +
    '\n产物缺失就先跑构建（平台包：`node scripts/build-server.mjs`；能力包：`pnpm -C capabilities/<包> bundle`；带代码的内置包：`pnpm packages:bundle`）再 publish。',
  )
  process.exit(1)
}

console.log(
  `[assert-npm-artifact] ${pkg.name}: files（${entries.join(', ')}）里查存在性的那些都有内容，` +
    `exports 指到的 ${exportTargets.length} 个文件也都在` +
    (codeEntry ? `，代码槽位 ${codeEntry} 独占其目录、tarball 清单过安装门白名单` : '') +
    '，放行。',
)
