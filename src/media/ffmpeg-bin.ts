// src/media/ffmpeg-bin.ts
//
// 「这台机器上的 ffmpeg / ffprobe 在哪」——**唯一的问法**。
//
// 存在的理由是一次干净装机上的活体证据（2026-09-04，Windows `npm i @streamapp/stream@0.0.9`）：
// 一条转写跑了 88 秒，最后倒在 `spawn ffmpeg ENOENT` 上；而在那之前 `/api/conversion-kinds`
// 一直诚实不了地报 `extract.branches.stt: true`。裸 `spawn('ffmpeg')` 有两个毛病，各自都够呛：
//   1. 只认 PATH——发行安装的机器上多半没有，于是能力自述在撒谎（本文件的 `mediaToolAvailable`
//      是那句自述的判据源）；
//   2. 失败信息是 `ENOENT` 三个字母，指不了路。
//
// ## 解析顺序：显式配置 > PATH > 随包出货的平台子包
//
// 「随包那份」**故意排在 PATH 后面**，与直觉相反，理由是具体的：随包那份是
// `@ffmpeg-installer/*`（ffmpeg 4.1，2018–2020 年的构建），**不带 chromaprint muxer**；而
// `src/media/audio-fingerprint.ts` 的引擎探测正是问「ffmpeg 有没有 chromaprint」。把随包那份
// 排在前面，等于在每台本来装了完整 ffmpeg 的机器上把声学指纹这一档静默降级掉——用一个"更可控"
// 的版本换掉一个更好的版本。随包那份的职责是**兜底**（没有比有旧的差），不是抢答。
//
// ## 为什么不用 `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe` 那两个 wrapper 包
//
// 它们只做一件事：查表 + 拼路径。而各自的拼法都有坑——ffmpeg 那个按
// `__dirname.indexOf('node_modules')` 切字符串（pnpm 的 store 布局下会切错），且平台不认识时
// **抛一个字符串**（不是 Error），import 一下就能把整个模块图带崩。我们要的正是它们查的那张表，
// 那就把表抄过来（下面两张），直接依赖平台子包本身。
//
// ## 全仓的裸 spawn 清点（`rg "'ffmpeg'|'ffprobe'" src/ scripts/`）
//
// `src/` 与 `shared/` 里**一处不剩**，全部走 `requireMediaTool`：audio-windows（转写切块）、
// video-frames（抽帧 + 时长）、extract（抽音轨/字幕）、audio-fingerprint（声学指纹）、
// tag-writer（写 ID3）、format-probe、netdisk/reconcile/duration。
// **唯一不吃这条判据的是 `scripts/migrate-music/*.ts`**：一次性的本地迁移脚本，手工在开发机上
// 跑，不进任何发行产物（不在 build-cli 的 SHIP 清单里，也没有任何模块 import 它们）。
// 它们的用户就是坐在那台机器前的人，`ENOENT` 对他不构成谜题。
//
// ## 平台子包的 postinstall 不能指望——所以这里自己 chmod
//
// `@ffmpeg-installer/linux-x64` 这些非 Windows 子包靠 `postinstall: chmod u+x ffmpeg` 给二进制
// 加执行位。而 npm 11 默认拦 install scripts（本项目装 better-sqlite3 时就吃过这个警告），
// 拦掉之后文件在、执行位不在，`spawn` 报的是 `EACCES`——比 `ENOENT` 更难懂。所以 `bundled` 这
// 一档解出路径后**自己补执行位**，不把正确性押在别人的 postinstall 上。
import { accessSync, constants, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { win32 as pathWin32, posix as pathPosix } from 'node:path'

export type MediaTool = 'ffmpeg' | 'ffprobe'

/**
 * `${process.platform}-${process.arch}` → 平台子包名。
 *
 * 这四个是我们出货的平台：win32-x64 / linux-x64 / darwin-x64 / darwin-arm64。
 * （`@streamapp/desktop` 的 `HOST_AGENT_PACKAGES` 是它的子集——stream-desktop 没出 linux，
 * 见那张表的头注。两张表都由 `ffmpeg-bin.test.ts` 与 cli 的 optionalDependencies 对表。）
 * 上游还有 linux-arm/arm64、
 * win32-ia32 等，**没列进来就是没出货**：加行之前先确认那个平台上其余部分（better-sqlite3
 * 预编译件等）也备齐了，否则装得上、一跑就炸。
 *
 * 版本钉死到具体号：这两族包分别停更在 2022 / 2023，`^` 没有意义，而一个浮动的二进制依赖
 * 是最不该有的那种浮动。
 */
export const FFMPEG_PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@ffmpeg-installer/win32-x64',
  'linux-x64': '@ffmpeg-installer/linux-x64',
  'darwin-x64': '@ffmpeg-installer/darwin-x64',
  'darwin-arm64': '@ffmpeg-installer/darwin-arm64',
}

/** 同上，ffprobe 那一族。两族是**不同的上游包**（不同维护者、不同版本节奏），所以两张表。 */
export const FFPROBE_PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@ffprobe-installer/win32-x64',
  'linux-x64': '@ffprobe-installer/linux-x64',
  'darwin-x64': '@ffprobe-installer/darwin-x64',
  'darwin-arm64': '@ffprobe-installer/darwin-arm64',
}

/** 显式配置那一档读的 env 名。 */
export const MEDIA_TOOL_ENV: Record<MediaTool, string> = {
  ffmpeg: 'STREAM_FFMPEG_PATH',
  ffprobe: 'STREAM_FFPROBE_PATH',
}

export type MediaToolSource = 'config' | 'path' | 'bundled'

export type MediaToolResolution =
  | { ok: true; path: string; source: MediaToolSource }
  | { ok: false; reason: string }

export interface MediaToolLookup {
  /** `process.platform`。 */
  platform: string
  /** `process.arch`。 */
  arch: string
  /** 环境变量（读 `STREAM_FFMPEG_PATH` 与 `PATH`）。 */
  env: Record<string, string | undefined>
  /** 注入点：这条绝对路径是不是一个可执行的文件。 */
  isExecutableFile: (p: string) => boolean
  /**
   * 注入点：把 `<平台子包>/package.json` 解成绝对路径；解不出（没装 / 不是这个平台）返回
   * undefined。解 `package.json` 而不是二进制本身——平台子包没有 `main` 字段，
   * `require.resolve('<pkg>')` 会 MODULE_NOT_FOUND。
   */
  resolvePackageJson: (specifier: string) => string | undefined
  /** 注入点：给随包那份补执行位（见文件头注为什么不能指望它自己的 postinstall）。 */
  ensureExecutable?: (p: string) => void
}

/** win32 上二进制带 `.exe`，其余不带。 */
function binName(tool: MediaTool, platform: string): string {
  return platform === 'win32' ? `${tool}.exe` : tool
}

/**
 * 拼路径 / 切 PATH 都按**被查询的那个平台**来，不按本进程的平台。
 *
 * `node:path` 顶层导出跟的是 `process.platform`——在 Linux 上给它一段 `C:\tools\bin` 去 join，
 * 拼出来是 `C:\tools\bin/ffprobe.exe`。生产里两者恒等所以看不出来，但那样一来 Windows 的
 * 解析路径就**只能在 Windows 上被测到**，等于这条链路上最容易出问题的那半边没有守卫。
 */
function pathApiFor(platform: string) {
  return platform === 'win32' ? pathWin32 : pathPosix
}

/** PATH 里逐段找同名可执行文件。**不 spawn**：一次能力自述不该为了问一句话去起一个子进程。 */
function findOnPath(tool: MediaTool, look: MediaToolLookup): string | undefined {
  const raw = look.env.PATH ?? look.env.Path
  if (!raw) return undefined
  const name = binName(tool, look.platform)
  const P = pathApiFor(look.platform)
  for (const seg of raw.split(P.delimiter)) {
    if (!seg) continue
    const p = P.join(seg.replace(/^"|"$/g, ''), name)
    if (look.isExecutableFile(p)) return p
  }
  return undefined
}

/** 找不到时那句**能指路**的话。三条出路各自写清怎么走，别让用户拿着 ENOENT 去猜。 */
function notFoundReason(tool: MediaTool, look: MediaToolLookup): string {
  const key = `${look.platform}-${look.arch}`
  const table = tool === 'ffmpeg' ? FFMPEG_PLATFORM_PACKAGES : FFPROBE_PLATFORM_PACKAGES
  const pkg = table[key]
  const why =
    tool === 'ffmpeg'
      ? '转写要用它把音频重编码、切块成 STT 端能收的格式；抽帧、抽音轨、写标签也都靠它'
      : '匹配、归档、转写切窗都要靠它探媒体时长和容器格式'
  const third = pkg
    ? `③ 重装一次 \`@streamapp/stream\`——随包的 ${pkg} 会由 npm 按平台装上（注意别开 \`--ignore-scripts\` 之外还手动删了 optionalDependencies）。`
    : `③ 这个平台（${key}）我们没出随包的二进制，只能走 ① 或 ②。`
  return (
    `这台机器上找不到 ${tool}（${why}）。三条路任选一条：` +
    `① 系统装一份并放进 PATH（Windows: \`winget install Gyan.FFmpeg\`；macOS: \`brew install ffmpeg\`；` +
    `Debian/Ubuntu: \`apt install ffmpeg\`）；` +
    `② 已经装了但不在 PATH，用 \`${MEDIA_TOOL_ENV[tool]}=<二进制绝对路径>\` 指给它；` +
    third
  )
}

/**
 * 解析一个媒体工具的绝对路径。**纯函数**（所有 I/O 走注入点），所以 Windows 的解析路径能在
 * Linux 上被测到。
 *
 * 顺序：显式配置 → PATH → 随包出货的平台子包（为什么随包排最后见文件头注）。
 *
 * 显式配置指了一条**不可执行**的路径时**直接失败、不往下走**：用户明说了用哪一个，静默换成
 * 另一个是最坏的一种"帮忙"——他会拿着一份用错版本跑出来的结果去下结论。
 */
export function resolveMediaTool(tool: MediaTool, look: MediaToolLookup): MediaToolResolution {
  const configured = look.env[MEDIA_TOOL_ENV[tool]]
  if (configured) {
    if (look.isExecutableFile(configured)) return { ok: true, path: configured, source: 'config' }
    return {
      ok: false,
      reason: `${MEDIA_TOOL_ENV[tool]} 指向 \`${configured}\`，但那里没有可执行文件。` +
        '显式配置不会被静默绕过——改对它，或者把这个环境变量去掉改走 PATH。',
    }
  }

  const onPath = findOnPath(tool, look)
  if (onPath) return { ok: true, path: onPath, source: 'path' }

  const table = tool === 'ffmpeg' ? FFMPEG_PLATFORM_PACKAGES : FFPROBE_PLATFORM_PACKAGES
  const pkg = table[`${look.platform}-${look.arch}`]
  if (pkg) {
    const pkgJson = look.resolvePackageJson(`${pkg}/package.json`)
    if (pkgJson) {
      const P = pathApiFor(look.platform)
      const p = P.join(P.dirname(pkgJson), binName(tool, look.platform))
      look.ensureExecutable?.(p)
      if (look.isExecutableFile(p)) return { ok: true, path: p, source: 'bundled' }
    }
  }
  return { ok: false, reason: notFoundReason(tool, look) }
}

const requireFromHere = createRequire(import.meta.url)

function defaultLookup(): MediaToolLookup {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    isExecutableFile: (p) => {
      try {
        accessSync(p, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    resolvePackageJson: (spec) => {
      try {
        return requireFromHere.resolve(spec)
      } catch {
        return undefined
      }
    },
    ensureExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK)
      } catch {
        // 只在"文件在但没有执行位"这一种情况下补；文件根本不在时 chmod 抛错，吞掉即可
        // （下一步的 isExecutableFile 会如实报 false）。
        try { chmodSync(p, 0o755) } catch { /* 权限不够 / 文件不在 —— 由调用方那句话去报 */ }
      }
    },
  }
}

/**
 * 记忆化：**只缓存成功**。
 *
 * 缓存失败会把「开机时还没装 ffmpeg」冻成这个进程一辈子的答案——用户装完 ffmpeg 回来点一下，
 * 页面还是说不能转写（AGENTS.md「装配期取的值 = 冻住的答案」的同一个坑）。找到的那个二进制
 * 不会跑掉，所以正面答案缓存是安全的；负面答案每次现查（几次 `accessSync`，比起一次转写可以忽略）。
 */
const resolved = new Map<MediaTool, Extract<MediaToolResolution, { ok: true }>>()

/** 现问一次：这台机器上的 `tool` 在哪（或者为什么不在）。 */
export function mediaToolResolution(tool: MediaTool, look: MediaToolLookup = defaultLookup()): MediaToolResolution {
  const hit = resolved.get(tool)
  if (hit) return hit
  const r = resolveMediaTool(tool, look)
  if (r.ok) resolved.set(tool, r)
  return r
}

/** 绝对路径，没有就 null（给"没有它就跳过这一档"的调用方，例如声学指纹的引擎探测）。 */
export function mediaToolPath(tool: MediaTool): string | null {
  const r = mediaToolResolution(tool)
  return r.ok ? r.path : null
}

/** 这台机器上有没有它。**能力自述（`/api/conversion-kinds` 的 branches）的判据源。** */
export function mediaToolAvailable(tool: MediaTool): boolean {
  return mediaToolResolution(tool).ok
}

/**
 * 要用它了：给绝对路径，没有就抛一句**能指路**的话。
 *
 * 每个 spawn / execFile 点都从这里取命令名——全仓不该再有第二处裸 `spawn('ffmpeg')`。
 */
export function requireMediaTool(tool: MediaTool): string {
  const r = mediaToolResolution(tool)
  if (!r.ok) throw new Error(r.reason)
  return r.path
}

/** 测试用：清掉记忆化。 */
export function resetMediaToolCache(): void {
  resolved.clear()
}
