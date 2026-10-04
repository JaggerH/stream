/**
 * 内置包的 npm 发布判定（`release-recipes.yml` 用）。
 *
 * 判据：`packages/<id>/` **有 `package.json#name`、不 `private`、填了 recipe 槽位或代码槽位**（判法见
 * `readRecipePackages`）、**且该包名已经在 npm 上存在（任意版本）、但没有这个精确版本** → 发。
 * 带代码槽位（`stream.code`）的包多两步：发之前先 `bundle` 出 `dist/index.js`、再过 `assert-npm-artifact.mjs`
 * 那道闸（产物在、独占 `dist/`、tarball 清单过安装门白名单）；纯 recipe 包只核 tarball 清单。
 *
 * 一个包第一次发布（首发）永远是人为动作，绝不由 CI 自动触发——哪些内置包要公开发布
 * 是生意上的决定（例如收费 recipe 包必须绝不能因为"npm 上还没有"就被自动发出去），
 * 不能靠"npm 上查不到这个名字"来推断"该发"。CI 只负责跟着已经上线的包走版本 bump：
 * 包已经在 npm 上、这次改动 bump 了 version → 发；包压根没在 npm 上 → 跳过并打一行「首发请人工」，
 * 等人手动 `npm publish` 完成 onboarding 之后，CI 才开始接手它后续的版本。
 *
 * **registry 打不通不等于"npm 上没有"**：只有 npm 明确回 E404 才算没上过；别的错（断网、限流、
 * 鉴权、npm 自己挂了）一律抛出去让流水线红——吞成"没有要发的包"是绿着什么都没发，没有一处会喊。
 *
 *   pnpm exec tsx scripts/recipe-release-plan.ts [<packagesDir>]        # 打印要发的包（JSON 数组，每项 {dir,name,version,code}）
 *   pnpm exec tsx scripts/recipe-release-plan.ts --check <dir>          # 核该包 `npm pack --dry-run` 的文件清单（不构建，见 checkPackage）
 *   pnpm exec tsx scripts/recipe-release-plan.ts --publish [<packagesDir>]  # 判定 → 逐包（bundle → assert →）核白名单 → npm publish（CI 用）
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedPackageFile } from '../src/replay/recipe-install.ts'
import { parseStreamDescriptor } from '../src/packages/descriptor.ts'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

export interface RecipePackageInfo {
  dir: string
  name: string
  version: string
  private: boolean
  /** 这个包填了 recipe 槽位或代码槽位——"有东西可发到 npm"。判法见 `readRecipePackages`。 */
  publishable: boolean
  /** 填了 `stream.code`：发之前要先 bundle 出 `dist/index.js` 并过 `assert-npm-artifact.mjs`。 */
  code: boolean
}

/**
 * 读一层内置包目录。**"可不可发"按槽位判，与装载器同一把尺，不读 `stream.type`**：
 * `parseStreamDescriptor` 把旧形的 `type: 'recipe'` 读进来即丢弃（descriptor.ts），装载器从来
 * 不看它。可发的包 = 填了 recipe 槽位（至少一个 `*.recipe.json`）**或**代码槽位（`stream.code`）：
 * 前者走 `stream update` 那条纯数据安装路，后者出预编译的 `dist/index.js`（`pnpm packages:bundle`）、
 * 用户层 `stream add` 装到的就是那份产物。只填容器 / 凭证域 / Source 清单而没有 recipe 也没有代码的包
 * 没有东西可发。对今天的 46 个内置包，这条判据打上 publishable 标记的有 39 个（含 3 个 private
 * 的容器包：alist / pansou / douyin-tiktok-download-api——安装门今天装不进带容器的第三方包，见
 * docs/TODO.md）；非 private、真正可发的 36 个（32 个纯 recipe 包 + 4 个带代码的包：bilibili / xhs /
 * netease / eastmoney）。`recipe-release-plan.test.ts` 钉着 36 这个数并逐名列出那 4 个。
 *
 * package.json 解析不过 / 目录里没有 package.json 的子目录跳过——这条脚本是拿来发包的，
 * 一个坏包不该把整条流水线拖红；坏包在后端启动时自有 `onPackageError` 报它。
 */
export function readRecipePackages(packagesDir: string): RecipePackageInfo[] {
  return readdirSync(packagesDir)
    .map((d) => join(packagesDir, d))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => {
      let raw: Record<string, unknown>
      try { raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return [] }
      let publishable = false
      let code = false
      try {
        const desc = parseStreamDescriptor(raw, `${dir}/package.json`)
        const hasRecipeFiles = readdirSync(dir).some((f) => f.endsWith('.recipe.json'))
        code = desc.code !== undefined
        publishable = hasRecipeFiles || code
      } catch {
        // 不是一个合法的 Stream 包描述 → 不可发（但仍列出来，让 `--publish` 的输出里看得见它）
      }
      return [{
        dir,
        name: typeof raw.name === 'string' ? raw.name : '',
        version: typeof raw.version === 'string' ? raw.version : '',
        private: raw.private === true,
        publishable,
        code,
      }]
    })
}

/** 「这个包不在 npm 上、CI 不会替你首发」的提示——判定跳过它时打一行，不然一个 bump 了版本、
 *  却从没上过 npm 的包会在流水线里**静默**消失，看起来像"判定没挑上它"。 */
export function firstPublishHint(p: RecipePackageInfo): string {
  const steps = p.code ? 'pnpm bundle && npm publish --access public' : 'npm publish --access public'
  return `首发请人工：${p.name}@${p.version} 不在 npm 上，CI 不代劳。cd ${p.dir} && ${steps}`
}

export function selectPackagesToPublish(
  pkgs: RecipePackageInfo[],
  publishedVersions: (name: string) => string[] | undefined,
  log: (msg: string) => void = () => {},
): RecipePackageInfo[] {
  return pkgs.filter((p) => {
    if (!p.publishable || p.private || !p.name || !p.version) return false
    const versions = publishedVersions(p.name)
    // 不在 npm 上（undefined / 空数组）→ 首发是人为动作，CI 绝不代劳
    if (!versions || versions.length === 0) {
      log(firstPublishHint(p))
      return false
    }
    return !versions.includes(p.version)
  })
}

/** `npm pack` 会带进 tarball、但安装侧白名单（`isAllowedPackageFile`）不收的文件。 */
export function offendingPackFiles(files: string[]): string[] {
  return files.filter((f) => !isAllowedPackageFile(f))
}

/** `npm view <name> versions --json` 的输出形状 → 版本列表。npm 只有一个版本时不包一层数组
 *  （直接给一个字符串）；别的形状（对象 / null / 数字）一律当"没有版本"。 */
export function parseNpmVersions(parsed: unknown): string[] {
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  if (typeof parsed === 'string') return [parsed]
  return []
}

/** 这次 `npm view` 失败是不是"npm 上压根没有这个包名"。npm 的 404 在 stdout（`--json` 时是
 *  `{"error":{"code":"E404",…}}`）或 stderr（`npm ERR! code E404`）里都带 `E404` 字样。 */
export function isNpmNotFound(err: { stdout?: unknown; stderr?: unknown; message?: string }): boolean {
  return [err.stdout, err.stderr, err.message].some((s) => typeof s === 'string' && s.includes('E404'))
}

/** 该包名在 npm 上已发布的所有版本；npm 明确说没有这个包名（E404）→ `[]`（首发要人手动做，见头注）。
 *  **别的失败原样抛**：把断网 / 限流 / 鉴权错吞成 `[]`，流水线会打一句「没有要发的包」然后绿掉。 */
function npmVersions(name: string): string[] {
  let out: string
  try {
    out = execFileSync('npm', ['view', name, 'versions', '--json'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  } catch (e) {
    if (isNpmNotFound(e as { stdout?: unknown; stderr?: unknown })) return []
    throw new Error(`npm view ${name} versions 失败（不是 404，不能当"没上过 npm"）：${(e as Error).message}`)
  }
  const parsed: unknown = JSON.parse(out)
  // `--json` 档 npm 把错误也写成 JSON（`{"error":{"code":…}}`）——实测 404 时它退出码是 1、上面就
  // 抛了，但别赌这一点：退出 0 却带 error 对象的，同样按"只有 E404 才算没上过"处理。
  const errCode = (parsed as { error?: { code?: unknown } } | null)?.error?.code
  if (errCode !== undefined) {
    if (errCode === 'E404') return []
    throw new Error(`npm view ${name} versions 回了错误 ${String(errCode)}（不是 404，不能当"没上过 npm"）`)
  }
  return parseNpmVersions(parsed)
}

function packFiles(dir: string): string[] {
  // `--ignore-scripts`：`npm pack --dry-run` 照样跑 `prepack`，而带代码的包的 `prepack` 正是
  // `assert-npm-artifact.mjs`，它反过来调本文件的 `--check` 取清单——不关掉脚本就是一条无限递归
  // （实测会挂死）。清单本身与脚本无关：只看 `files` + 目录内容。
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>
  return (parsed[0]?.files ?? []).map((f) => f.path)
}

/** 核该包 tarball 文件清单，命中白名单外的文件就非 0 退出并点名。`--check <dir>` 与 `--publish`
 *  的逐包核对都是它——同一份判据，不会出现"本地 --check 过了、CI 发布时又用另一套标准"。
 *
 *  **这一步刻意不构建**：`assert-npm-artifact.mjs`（带代码的包的 `prepack`）就是经 `--check` 借这份
 *  清单判据的，`--check` 若再去 bundle + assert 就成了环。构建与产物闸在 `prepareCodePackage`，只有
 *  `--publish` 走它。 */
function checkPackage(dir: string): void {
  const bad = offendingPackFiles(packFiles(dir))
  if (bad.length) {
    console.error(`tarball 里有安装侧不收的文件：${bad.join('、')}——删掉或加进 package.json 的 files 白名单`)
    process.exit(1)
  }
  console.log('pack ok')
}

/** 带代码的包发之前的两步：`bundle-code-packages.mjs <dir>` 出 `dist/index.js`（尊重 `STREAM_TSDOWN_BIN`），
 *  再 `assert-npm-artifact.mjs <dir>` 过产物闸（入口在且非空、独占 `dist/`、tarball 过白名单、README 无死链）。
 *  任一步非 0 就抛——`npm publish` 自己也会跑 `prepack`（= 同一道闸），这里提前跑是为了让失败落在
 *  "还没碰 registry" 的那一刻，而不是发到一半。 */
function prepareCodePackage(dir: string): void {
  execFileSync(process.execPath, [join(SCRIPTS_DIR, 'bundle-code-packages.mjs'), dir], { stdio: 'inherit' })
  execFileSync(process.execPath, [join(SCRIPTS_DIR, 'assert-npm-artifact.mjs'), dir], { stdio: 'inherit' })
}

/** `--publish [<packagesDir>]`：判定 → 逐包（带代码的先 bundle + assert）→ 核白名单 → `npm publish`。
 *  已发布则该轮 plan 为空，天然可重跑。 */
function publishAll(packagesDir: string): void {
  const plan = selectPackagesToPublish(readRecipePackages(packagesDir), npmVersions, (m) => console.log(m))
  if (!plan.length) {
    console.log('没有要发的包')
    return
  }
  for (const p of plan) {
    console.log(`== ${p.name}@${p.version} (${p.dir})${p.code ? ' [code]' : ''}`)
    if (p.code) prepareCodePackage(p.dir)
    checkPackage(p.dir)
    execFileSync('npm', ['publish', '--access', 'public'], { cwd: p.dir, stdio: 'inherit' })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--check') {
    checkPackage(resolve(args[1] ?? '.'))
  } else if (args[0] === '--publish') {
    publishAll(resolve(args[1] ?? 'packages'))
  } else {
    const packagesDir = resolve(args[0] ?? 'packages')
    const plan = selectPackagesToPublish(readRecipePackages(packagesDir), npmVersions, (m) => console.error(m))
    console.log(JSON.stringify(plan.map(({ dir, name, version, code }) => ({ dir, name, version, code }))))
  }
}
