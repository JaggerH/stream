// 「用户要装的那份扩展，文件在哪」。两条安装路径（手动 / 代装）**必须指向同一个目录**：
// 出问题时排查只有一个路径，用户看到的说明和 agent 真正选中的也不会分家。
//
// 来源两档，与 `resolveDesktopPluginSpec` 同形：
//
// 1. `<repoRoot>/extension/.output/chrome-mv3` 在就用它（开发机）。**判据是产物在不在，不是
//    "是不是开发模式"**——目录在、但 `pnpm --dir extension build` 没跑过，正是开发者最容易
//    撞上的现场，悄悄装一个别的版本只会让他怀疑人生。
// 2. npm 包 `@streamapp/chrome-extension`（`scripts/publish-extension.mjs` 发的，内容就是同一份
//    `chrome-mv3/`）。**`resolvePkg` 回的是包根，扩展目录要再拼一层 `chrome-mv3`**：包根下还有
//    `package.json` / `index.js`，把包根整份装进 Chrome 会被判成"无效扩展"。
//
// 两个消费者共用这两档：Stream 后端与能力包 `@streamapp/desktop`（装它的人按定义没有 Stream
// 后端，第二档是他唯一的来源）。
//
// **CLI 发行包**（`npm i @streamapp/stream`）走第二档：`scripts/build-cli.mjs` 不把扩展产物
// 搬进 `resources/`，改由 `cli/package.json` 依赖那个 npm 包，装包时 npm 解得出来。第一档留给
// 开发检出（以及任何把 `extension/.output/chrome-mv3` 摆在 cwd 下同一相对路径的形态）。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const EXTENSION_NPM_PACKAGE = '@streamapp/chrome-extension'

export interface ExtensionSource {
  kind: 'repo' | 'npm'
  dir: string
}

export function resolveExtensionSource(opts: {
  repoRoot: string
  exists?: (p: string) => boolean
  resolvePkg?: (spec: string) => string
}): ExtensionSource | undefined {
  const exists = opts.exists ?? existsSync
  const built = join(opts.repoRoot, 'extension/.output/chrome-mv3')
  if (exists(built)) return { kind: 'repo', dir: built }
  const resolvePkg = opts.resolvePkg
  if (!resolvePkg) return undefined
  try {
    return { kind: 'npm', dir: join(resolvePkg(EXTENSION_NPM_PACKAGE), 'chrome-mv3') }
  } catch {
    return undefined
  }
}

/**
 * 物化的落点。**单独导出**是因为调用方要在物化**之前**问一句"这个目录已经在了吗"
 * （见 `materializeExtension` 头注最后一段），而它不该自己再拼一遍这个相对路径——拼两遍
 * 就是两份实现，漂了之后表现是"检查的是 A、写的是 B"，每次都重拷。
 */
export function extensionDestDir(dataDir: string): string {
  return join(dataDir, 'extension')
}

/**
 * 把来源整份复制到 `<dataDir>/extension/`，回绝对路径。
 *
 * **落在 dataDir 而不是直接把 Chrome 指向来源目录**：node_modules 会在升级时被整个重写，
 * 而 Chrome 记着的是一个绝对路径——被重写的那一刻扩展就"损坏"了。dataDir 下这份稳定、
 * 用户找得到（手动装那条路要把这个路径念给他听）。
 *
 * **每次都整份重来**（先删后拷）：留着上一版的残余文件，Chrome 会把两代混着加载，
 * 症状是"改了没生效"。
 *
 * **所以调用它是一个动作，不是一次检查。** 目录已经在、而且 Chrome 可能正加载着它的时候，
 * 别调这个函数——那一瞬间的 `rm -rf` 会让 Chrome 把扩展判成"损坏"，而"一直没配对"的典型
 * 现场恰恰就是扩展已经装上了、只是连不上。要不要重来由调用方判（`extensionDestDir` 给它
 * 落点），这里只负责"重来"这件事本身。
 */
export function materializeExtension(opts: {
  repoRoot: string
  dataDir: string
  exists?: (p: string) => boolean
  resolvePkg?: (spec: string) => string
}): { dir: string; source: 'repo' | 'npm' } {
  const src = resolveExtensionSource(opts)
  if (!src) {
    throw new Error(
      '找不到扩展的构建产物：仓库里的 `extension/.output/chrome-mv3` 不在（开发机上先跑 ' +
        '`pnpm --dir extension build`），也没装 ' +
        EXTENSION_NPM_PACKAGE +
        '（发行形态应当自带）。',
    )
  }
  const dest = extensionDestDir(opts.dataDir)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(src.dir, dest, { recursive: true })
  return { dir: dest, source: src.kind }
}
