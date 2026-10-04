/**
 * 旧术语回补清单的牙（AGENTS.md「改了底层模型 → 旧术语就是你的回补清单」）。
 *
 * 能力包搬进 `capabilities/<x>/` 并改名 `@streamapp/<x>`；浏览器与桌面两个包合成一个，
 * 现在它叫 **Stream Desktop**（`capabilities/desktop/`、`@streamapp/desktop`、能力名
 * `desktop`、日志前缀 `[stream-desktop]`）。留在文件里的旧名不会让任何东西报错——脚本照跑
 * （路径已经不存在，只是那一步静默地什么都没做）、文档照读（读的人照着一个不存在的目录去
 * 找）。所以判据只能是"仓库里搜不到它"。
 *
 * 三条正则，各守一次改名：
 *
 * 1. `OLD_NAME`（搬家那次）**用排除法，不用包名白名单**。数出来的那种写法（`browser|netdisk|
 *    desktop|meituan`）漏掉了两类真命中：通配形态 `dsh-plugin-<星号>`（一句话罩住所有包，正是
 *    文档里最常见的写法；这里不写字面量是因为紧跟的斜杠会把本段注释提前收尾），以及往后新增
 *    的能力包。`dsh-plugin-` 这个前缀今天只剩 `dsh-plugin-stream-ui` 一个合法归宿（那个包名
 *    没变），所以规则反过来写：**前缀后面不是 `stream-ui` 的一律算命中**。
 *    `@streamapp/dsh-plugin-` 这种包名前缀也一并被罩住——正则不锚定行首。
 *
 * 2. `MERGED_NAME`（合包那次）罩住 `@streamapp/browser`、`stream-browser`、`capabilities/browser`。
 *    **`desktop` 那一支已经从这条正则里拿掉了**：它今天是现行名（Stream Desktop 的包目录与包名），
 *    再守着它就会把正确的写法判成旧名。**`stream-browser` 这个词有两个和能力包无关的合法用法**，
 *    负向前瞻放行它们：`stream-browser-verify:`（`VERIFY_PREFIX`，扩展与后端之间的线上常量，
 *    改它等于让所有装好的扩展验不过）和 `stream-browser-extension`（扩展自己那个 npm 包名）。
 *
 * 3. `COMPUTER_USE_NAME`（改名成 Stream Desktop 那次）罩住 `computer-use`：包目录、包名
 *    `@streamapp/computer-use`、能力名与日志前缀 `[stream-computer-use]` 全是这个词。
 *
 * 允许命中的：历史档案（`docs/superpowers/**`、`.superpowers/**`）——它们记的是写下那天的事实，
 * 改了反而是伪造；外加 `EXEMPT` 里那两份，各自的理由写在那儿。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './http/build-identity.ts'

/**
 * 不走的目录，写成**相对仓库根的路径前缀**——不是 basename。
 *
 * 按 basename 匹配会误伤：`lib` 一条就会顺手跳过任何叫 `lib` 的源码目录，`data` 同理。
 * 前缀匹配则精确到"仓库里的这一个"，新加的同名目录不会被静默放行。
 *
 * Git 工作树会由 `--exclude-standard` 排掉构建产物；公开 archive 没有 `.git`，会走文件系统
 * 回退，因此这里还要列出回退时必跳的构建根。其余两类不是 gitignored：历史档案是跟踪着的，
 * `.claude/worktrees` 是别人那棵树（未跟踪、也没被忽略）。
 */
const SKIP_PREFIXES = [
  // 历史档案：记的是写下那天的事实，改了反而是伪造。
  'docs/superpowers',
  '.superpowers',
  // 别人那棵树。`.gitignore` 里被忽略的是 `.worktrees/`，不是这一个。
  '.claude/worktrees',
  // archive 回退扫描时的生成物；它们复制的是源码，不是待守的源码本身。
  'dist',
  'cli/resources',
  'cli/bin',
  'extension/.output',
]

/**
 * 扫描清单的来源：**问 git 要，不自己 walk 目录树**。
 *
 * 自己 walk 的那一版按 `SKIP_PREFIXES` 排除构建产物，而那份名单永远追不上真实的 gitignore：
 * `.output` 只写了根前缀，够不着 `extension/.output`；`cli/resources/**` 根本没进过名单。于是打包进去的旧源码被当成仓库内容扫出来，这条守卫在
 * **主检出上恒红**（worktree 里没有这些产物目录，所以只在主检出红——症状长得像"别人把 main
 * 弄坏了"）。改成 `git ls-files` 之后判据与 gitignore 天然同源，不需要两处同步。
 *
 * `--cached --others --exclude-standard` 三个一起给：只要 `--cached` 会漏掉**刚写下还没
 * `git add`** 的文件，而那正是最需要被守住的一类（新写的文档里带着旧名字，提交时没人喊）。
 *
 * @param root - 仓库根。参数化是为了让下面那条用例能喂一个自造的临时仓库。
 */
export function listScannedFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\0').filter(Boolean)
  } catch {
    // git archive deliberately has no .git. Its source tree is still what this
    // guard must inspect; only installation and VCS machinery are irrelevant.
    const files: string[] = []
    const walk = (dir: string, rel = ''): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), child)
        else if (entry.isFile()) files.push(child)
      }
    }
    walk(root)
    return files
  }
}

/**
 * 逐字放行的两份，各有各的理由——**不是"改起来麻烦"**：
 *
 * - `packages/browser/package.json`：那是一个 **Stream 包**（headless 浏览器取数源），不是能力包。
 *   它按 `@streamapp/<目录名>` 的惯例叫 `@streamapp/browser`，`private: true`，从不发布。
 * - `capabilities/desktop/README.md`：发布那一节要说清「发新包的同时把哪几个旧包
 *   deprecate」——那句话的全部作用就是点名，去掉名字它就没用了。
 */
const EXEMPT = new Set([
  'packages/browser/package.json',
  'capabilities/desktop/README.md',
])

/**
 * `.rs` 必须在里面：那个二进制**自己打印给用户看的用法字符串**（`eprintln!("用法：stream-desktop
 * focus-probe …")`）住在 Rust 源码里，而它正是"照着敲会失败"的那一类——名字漏改了不报错，
 * 只是用户敲出来的命令不存在。改名那一轮它就是这么漏过去的：守卫全绿，`app/host-agent/src/`
 * 里三处旧的 exe 名一直活着，因为后缀白名单里没有 `.rs`（2026-09-08 补）。
 */
const TEXT_FILE = /\.(ts|tsx|mjs|cjs|js|json|yml|yaml|md|sh|rs)$/

/**
 * `dsh-plugin-` 后面不是这两个词的，一律算命中。负向前瞻是零宽的，所以
 * `dsh-plugin-browser` / `dsh-plugin-<星号>` / `@streamapp/dsh-plugin-netdisk` 全部命中，
 * 而两类**不是我们那些包**的写法放行：
 *
 * - `stream`：罩住 `dsh-plugin-stream-ui`（包名没变）与 `docs/research/` 里那个假想的
 *   `dsh-plugin-stream` 薄壳（从没作为目录存在过）。
 * - `design`：罩住历史 spec 的**文件名**，如 `2026-09-04-meituan-dsh-plugin-design.md`。
 *   这些引用散在正文各处（不都跟 `docs/superpowers/` 同行，所以按目录跳过不管用），而
 *   文件名是写下那天的事实，改了就是伪造——真去改还会把一串引用指向不存在的文件。
 */
const OLD_NAME = /dsh-plugin-(?!stream|design)/

/**
 * 合包那次的旧名。`stream-browser` 那一支带负向前瞻，因为这个词有两个和能力包无关的合法用法
 * （见文件头注）：`stream-browser-verify:` 是线上常量，`stream-browser-extension` 是扩展的包名。
 */
const MERGED_NAME = /@streamapp\/browser|stream-browser(?!-verify|-extension)|capabilities\/browser/

/**
 * 改名成 Stream Desktop 那次（2026-09-07）。`computer-use` 这个词在仓库里没有任何合法用法——
 * 包目录、包名、能力名、日志前缀四处全改成了 `desktop`，所以直接一刀切。
 */
const COMPUTER_USE_NAME = /computer-use/

/**
 * 线上常量那一层也改成 desktop 那次（2026-09-07 第三轮）。前两轮以「包已经发出去了、改了会让
 * 装好的机器静默失联」为由把这批名字留了下来；用户拍板：外部用户为零，两台机器都是我们自己
 * 的，各重新 `--register` 一次即可。于是全部改掉：
 *
 * | 旧 | 新 |
 * |---|---|
 * | `stream-host-agent(.exe)`、Rust crate 与 `[[bin]]` | `stream-desktop` |
 * | `com.stream.host_agent` | `com.stream.desktop` |
 * | `STREAM_NO_HOST_AGENT` | `STREAM_NO_DESKTOP` |
 * | `@streamapp/host-agent-<平台>`、`platforms/host-agent-<平台>` | `@streamapp/desktop-<平台>`、`platforms/desktop-<平台>` |
 * | tag 前缀 `host-agent-v<星号>`、`release-host-agent.yml` | `desktop-v<星号>`、`release-desktop.yml` |
 *
 * （表里写「星号」不写字面量：紧跟的斜杠会把本段注释提前收尾，同一个坑本文件头注记过一次。）
 *
 * **为什么必须有牙**：这批名字漏一个不会报错。native messaging host id 两侧（`register.rs` 的
 * `DEFAULT_HOST_NAME` 与扩展的 `NATIVE_HOST_NAME`）分家的表现是"扩展永远配不上，一个字都不
 * 报"；平台包名漏一处的表现是"平台包没装"，而真因是名字对不上。
 *
 * **只守字面量，不守 `host-agent` 这个词**：三个目录（`app/host-agent/`、`src/host-agent/`、
 * `capabilities/desktop/src/host-agent/`）、debug bus 的 `host-agent` 频道、`HOST_AGENT_PACKAGES`
 * 这类内部标识符都还叫旧词——它们是内部路径/内部符号，用户看不见，没跟着改。一刀切会把这些
 * 全判成旧名，然后有人把整条守卫关掉。
 */
const LEGACY_AGENT_NAME =
  /stream-host-agent|com\.stream\.host_agent|STREAM_NO_HOST_AGENT|@streamapp\/host-agent-|host-agent-(?:win32|darwin)|host-agent-v\*|release-host-agent/

/**
 * 聚合归一那次（2026-09-06）退役掉的东西。Stream 后端成了能力包的唯一宿主，于是三个聚合者
 * 里的另外两个连同它们的名字一起没了：
 *
 * - `mcp-hub` / `stream-hub`：那个目录和它的 bin 都删了。留着这两个名字的文档会让人去
 *   `npm i -g` 一个不存在的包，或者去找一个不存在的目录——**照着做会失败得很慢**（npm 报
 *   404 之前先走一遍网络）。转发档搬进了 CLI：`stream mcp`。
 * - `dsh-context` / `dshCapabilityContext`：能力包的 DSH 那张脸没了，`CapabilityContext`
 *   的唯一实现是 `src/capabilities/host.ts`。
 * - `KNOWN_CAPABILITIES`：hub 那份**固定名单**没了——可选能力包按 `stream.capability` 槽位
 *   扫出来，撞名由 `registerTools` / `provide` 硬拒兜底。这个名字最该守：它是 AGENTS.md
 *   点名的那种「名字里带限定词的名单」，留着它就等于留着"能力有一份全集"这个已经不成立
 *   的心智模型。
 *
 * `dsh plugin` 那条装法不在这里守——它讲的是 DSH 自己的命令，`dsh-plugin-stream-ui` 仍然
 * 那么装。装能力包的旧话术由 T4 的文档判据（`docs/` 的 `rg`）扫。
 */
const RETIRED_NAME = /mcp-hub|stream-hub|dsh-context|KNOWN_CAPABILITIES|dshCapabilityContext/

/** 本文件自己必须写出旧名才守得住它，所以排除自身。 */
const SELF = 'src/capability-names.guard.test.ts'

function skipped(rel: string): boolean {
  return SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))
}

/**
 * git 会把**跟踪着的软链**当普通条目列出来（内容是链接目标那串路径）。跟过去读就会把别人那棵树
 * 的文件算成自己的——AGENTS.md 记过同一个坑：借来的目录被算成自己的，结论看起来像"我改崩了"。
 */
function isRegularFile(root: string, rel: string): boolean {
  const st = lstatSync(join(root, rel))
  return st.isFile()
}

function scan(root: string): string[] {
  return listScannedFiles(root).filter(
    (rel) => TEXT_FILE.test(rel) && !skipped(rel) && isRegularFile(root, rel),
  )
}

describe('能力包旧名不残留', () => {
  const files = scan(repoRoot).filter((f) => f !== SELF && !EXEMPT.has(f))

  // 扫到的文件要有量：清单来自 git，一旦哪一步（前缀跳过、后缀过滤）写宽了它会安静地返回
  // 一小撮，下面两条照样全绿——那正是"绿得毫无意义"。
  it('扫到了整棵树', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  /**
   * 这条钉住"扫描清单跟着 gitignore 走"这一件事本身，而不是间接依赖仓库当下的产物状态。
   * 自己造一个临时 git 仓库：一份跟踪着的源码、一份**没 add 但也没被忽略**的新文件、一份
   * 被 `.gitignore` 罩住的构建产物。前两个必须在，第三个必须不在。
   */
  it('扫描清单排除 gitignored 的构建产物，但收进未 add 的新文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'capability-names-guard-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    writeFileSync(join(root, 'tracked.ts'), 'export const a = 1\n')
    git('add', '.gitignore', 'tracked.ts')
    git('commit', '-qm', 'init')
    writeFileSync(join(root, 'untracked.md'), '# 新写的，还没 add\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'bundle.js'), 'dsh-plugin-browser\n')

    const listed = scan(root)
    expect(listed).toContain('tracked.ts')
    expect(listed).toContain('untracked.md')
    expect(listed).not.toContain('dist/bundle.js')
  })

  it('仓库里没有 dsh-plugin-（stream-ui 除外）', () => {
    const hits = files.filter((f) => OLD_NAME.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(hits, '这些文件还在指着搬走前的路径 / 包名').toEqual([])
  })

  it('仓库里没有合包前那个独立的 browser 包名', () => {
    const hits = files.filter((f) => MERGED_NAME.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(hits, '这些文件还在指着合包前的路径 / 包名（现在只有 @streamapp/desktop）').toEqual([])
  })

  it('仓库里没有 computer-use（现在叫 Stream Desktop）', () => {
    const hits = files.filter((f) => COMPUTER_USE_NAME.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(
      hits,
      '这些文件还在用 computer-use：目录是 capabilities/desktop/、包名 @streamapp/desktop、能力名 desktop、日志前缀 [stream-desktop]',
    ).toEqual([])
  })

  // 判据要能自证有牙：这条正则写宽了（比如被改成永不命中），上一条会安静地全绿。
  it('COMPUTER_USE_NAME 认得四种旧写法，且放行现行名与还叫旧词的内部路径', () => {
    for (const s of [
      "from '../../capabilities/computer-use/src/host-agent/index.ts'",
      '"name": "@streamapp/computer-use"',
      "export const HOST_AGENT_CAPABILITY_NAME = 'computer-use'",
      '[stream-computer-use] WARN mount 失败',
    ]) {
      expect(COMPUTER_USE_NAME.test(s), `应命中：${s}`).toBe(true)
    }
    for (const s of [
      'capabilities/desktop/src/host-agent/binary.ts',
      "const file = 'stream-desktop.exe'",
      '[stream-desktop] host-agent → <路径>',
    ]) {
      expect(COMPUTER_USE_NAME.test(s), `应放行：${s}`).toBe(false)
    }
  })

  it('仓库里没有改名前那批线上常量（现在全是 desktop）', () => {
    const hits = files.filter((f) => LEGACY_AGENT_NAME.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(
      hits,
      '这些文件还在用旧的线上常量：exe 是 stream-desktop、host id 是 com.stream.desktop、' +
        '平台包是 @streamapp/desktop-<平台>、开关是 STREAM_NO_DESKTOP、tag 前缀是 desktop-v*',
    ).toEqual([])
  })

  it('LEGACY_AGENT_NAME 认得每一种旧写法，且放行还叫旧词的内部路径与符号', () => {
    for (const s of [
      "const file = 'stream-host-agent.exe'",
      'name = "stream-host-agent"',
      'pub const DEFAULT_HOST_NAME: &str = "com.stream.host_agent";',
      "export const NATIVE_HOST_NAME = 'com.stream.host_agent'",
      "if (env.STREAM_NO_HOST_AGENT === '1')",
      '"@streamapp/host-agent-win32-x64": "0.4.1"',
      "'darwin-arm64': '@streamapp/host-agent-darwin-arm64',",
      'capabilities/desktop/platforms/host-agent-win32-x64/bin',
      "tags: ['host-agent-v*']",
      '.github/workflows/release-host-agent.yml',
    ]) {
      expect(LEGACY_AGENT_NAME.test(s), `应命中：${s}`).toBe(true)
    }
    // 内部路径与内部符号仍叫旧词，是有意的——用户看不见它们。守到这里就会有人把整条关掉。
    for (const s of [
      "import { mountHostAgent } from '../../capabilities/desktop/src/host-agent/index.ts'",
      'app/host-agent/Cargo.toml',
      'export const HOST_AGENT_PACKAGES: Record<string, string> = {',
      "channel: 'host-agent'",
      "const file = 'stream-desktop.exe'",
      '"@streamapp/desktop-win32-x64": "0.4.1"',
      "if (env.STREAM_NO_DESKTOP === '1')",
      "tags: ['desktop-v*']",
    ]) {
      expect(LEGACY_AGENT_NAME.test(s), `应放行：${s}`).toBe(false)
    }
  })

  it('仓库里没有 hub / DSH 脸退役前的名字', () => {
    const hits = files.filter((f) => RETIRED_NAME.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(
      hits,
      '这些文件还在讲 hub / DSH 脸那一套（Stream 后端已是能力包的唯一宿主，转发档是 `stream mcp`）',
    ).toEqual([])
  })

  it('RETIRED_NAME 认得五种退役名', () => {
    for (const s of [
      "await import('../../mcp-hub/src/load.ts')",
      'npm i -g @streamapp/mcp-hub',
      'claude mcp add stream -- stream-hub',
      "from '../../shared/capability/dsh-context.ts'",
      'const KNOWN_CAPABILITIES = [',
      'dshCapabilityContext(ctx)',
    ]) {
      expect(RETIRED_NAME.test(s), `应命中：${s}`).toBe(true)
    }
    // 名字相近但活着的东西不能被误伤——误伤的代价是有人把这条守卫整个关掉。
    for (const s of [
      'claude mcp add stream -- stream mcp',
      "import { probeBackend } from '../../shared/mcp/probe-backend.ts'",
      'src/capabilities/host.ts',
      'dsh-plugin-stream-ui/registry-table.json',
    ]) {
      expect(RETIRED_NAME.test(s), `应放行：${s}`).toBe(false)
    }
  })

  // 判据本身要能自证有牙：上一条全绿时，"正则写错了"和"仓库真干净"长得一模一样。
  it('MERGED_NAME 认得三种旧写法，且放行线上常量、扩展包名与现行的 desktop', () => {
    for (const s of [
      "import { x } from '@streamapp/browser'",
      "id: stream-browser",
      'capabilities/browser/src/index.ts',
    ]) {
      expect(MERGED_NAME.test(s), `应命中：${s}`).toBe(true)
    }
    for (const s of [
      "export const VERIFY_PREFIX = 'stream-browser-verify:'",
      '"name": "stream-browser-extension"',
      // `desktop` 那一支是**现行名**（Stream Desktop），这条正则不许再碰它——否则每一处
      // 正确的写法都会被判成旧名。
      '@streamapp/desktop',
      'capabilities/desktop/src/host-agent/binary.ts',
      '[stream-desktop] mount 失败',
    ]) {
      expect(MERGED_NAME.test(s), `应放行：${s}`).toBe(false)
    }
  })

  it('判据认得那几个包名、通配形态与包名前缀，且放行 stream-ui 与历史 spec 文件名', () => {
    for (const s of [
      'dsh-plugin-browser/src/index.ts',
      'dsh-plugin-netdisk/',
      'dsh-plugin-desktop/platforms',
      '@streamapp/dsh-plugin-meituan',
      '能力插件（`dsh-plugin-*/`）各自带 bundle patch',
    ]) {
      expect(OLD_NAME.test(s), `应命中：${s}`).toBe(true)
    }
    for (const s of [
      'dsh-plugin-stream-ui/src/registry.ts',
      '@streamapp/dsh-plugin-stream-ui',
      'docs/research 里那个假想的 dsh-plugin-stream 薄壳',
      'docs/superpowers/specs/2026-09-04-meituan-dsh-plugin-design.md',
      'spec 2026-08-17-stream-as-dsh-plugin-design.md §9',
    ]) {
      expect(OLD_NAME.test(s), `应放行：${s}`).toBe(false)
    }
  })
})
