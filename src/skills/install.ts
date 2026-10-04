/**
 * **把随包出货的 skill 送进用户自己那两个 agent 的手里。**
 *
 * 形状是「一处副本 + N 条链接」：
 *
 * ```
 * <包资源>/.claude/skills/<name>/      随 npm 包出货，只读
 *         │ materialize（整份重刷）
 *         ▼
 * <dataDir>/skills/<name>/             盘上唯一副本
 *         ▲                    ▲
 * ~/.claude/skills/stream-<name>   ~/.agents/skills/stream-<name>      （链接）
 * ```
 *
 * `~/.agents/skills` 同时是 DSH（dsh-skill-filesystem 的 agentsHome 默认 `~/.agents`）读的根，
 * 所以 codex 那一档就是 DSH 那一档，不另设。
 *
 * **为什么是链接不是两份拷贝**：拷贝就是镜像，升级之后用户手里是旧的，而**没有任何一处会喊**。
 * 链接之后 `npm i -g` 一升级两个 agent 手里同时变新，漂移在结构上不可能发生。
 *
 * **为什么中间要过一次 `<dataDir>/skills/` 而不直接链接进包资源目录**：`npx` 形态的包住在 npm
 * 的临时缓存里，那个路径会被清掉，链接随之悬空——表现是"这个 skill 突然不见了"。dataDir 下这份
 * 稳定、用户找得到（排查时要把这个路径念给他听），而且与扩展物化（`materializeExtension`）
 * **同一个形状**：出问题时只有一条路径要查。
 *
 * **写用户的全局配置目录是外向副作用**：只有显式调用才发生，后端启动时一次都不碰；而且可撤销
 * （`uninstallSkills` 只删自己建的那些）。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { LANDING_PREFIX, SKILLS_ROOT_REL, landingName, retiredSkillNames, shippedSkillNames } from './shipped.ts'

/** 用户那两个 agent 各自认的 skill 目录（相对 home）。两家文法相同，只有目录名不同。 */
export const HOST_SKILL_DIRS = {
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
} as const

export type SkillHost = keyof typeof HOST_SKILL_DIRS

export const ALL_HOSTS: SkillHost[] = ['claude-code', 'codex']

/** 一个落点的结局。`copy` 不是失败，但**必须让用户看见**——那一份升级时不会自己变新。 */
export type LandingMode = 'link' | 'copy'

export interface LandingResult {
  skill: string
  path: string
  mode?: LandingMode
  /** 没动它的理由（有它就说明这个落点被跳过了）。 */
  skipped?: string
}

export interface HostResult {
  host: SkillHost
  root: string
  landings: LandingResult[]
}

/**
 * 把出货的 skill 目录整份刷进 `<dataDir>/skills/`。
 *
 * **每次都先删后拷**：留着上一版的残余文件，两代内容会混在一起被 agent 读到，症状是
 * "我明明升级了，它还按老规矩来"。
 *
 * @param opts.sourceRoot - 含 `.claude/skills/` 的那个根（用 `shippedRoot(SKILLS_ROOT_REL)` 取，
 *   dev 下是仓库根、发行形态下是资源目录）。
 * @param opts.dataDir - 用户数据目录。
 * @returns 副本目录与真正拷过去的那几份。
 * @throws 源目录缺席时抛并点名路径——这是发行包漏拷了它，和"这一份内容是空的"必须长得不一样。
 */
export function materializeSkills(opts: { sourceRoot: string; dataDir: string }): {
  dir: string
  names: string[]
} {
  const dest = join(opts.dataDir, 'skills')
  const names = shippedSkillNames()
  for (const name of names) {
    const src = join(opts.sourceRoot, SKILLS_ROOT_REL, name)
    if (!existsSync(src)) {
      throw new Error(`skill 缺席：${src}（发行包漏拷了它？出货清单在 scripts/build-{server,cli}.mjs）`)
    }
  }
  for (const name of names) {
    const out = join(dest, name)
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    cpSync(join(opts.sourceRoot, SKILLS_ROOT_REL, name), out, { recursive: true })
  }
  return { dir: dest, names }
}

/** 这个落点是不是我们放的：名字带前缀，**且**它确实指向我们那份副本。 */
function ours(path: string, copyDir: string): boolean {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return false
  }
  if (st.isSymbolicLink()) {
    try {
      return realpathSync(path) === realpathSync(copyDir)
    } catch {
      // 悬空链接：目标没了。它仍然是我们留下的（名字带前缀 + 是个链接），该被收拾掉。
      return resolve(readlinkSync(path)) === resolve(copyDir)
    }
  }
  // 拷贝档：目录里有我们的印记文件才算自己的，避免误删用户手写的同名目录。
  return st.isDirectory() && existsSync(join(path, STAMP))
}

/** 拷贝档留下的印记。**它是 uninstall 敢不敢删这个目录的唯一依据**。 */
const STAMP = '.stream-managed'

/**
 * 建一个落点：优先符号链接，建不出来就拷贝并如实报告。
 *
 * Windows 上用 **junction**：目录 junction 不需要管理员权限、也不需要开发者模式，而 `'dir'`
 * 类型的符号链接两者都要——不区分的话在一台普通 Windows 上这一步必然 EPERM。
 */
function land(from: string, to: string): LandingMode {
  rmSync(to, { recursive: true, force: true })
  try {
    symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    return 'link'
  } catch {
    cpSync(from, to, { recursive: true })
    // 印记在拷贝之后写——源目录里没有它，所以它只可能是我们放的。
    writeFileSync(join(to, STAMP), 'Managed by Stream (POST /api/skills/install). Safe to delete.\n')
    return 'copy'
  }
}

export interface InstallOptions {
  dataDir: string
  home: string
  hosts?: SkillHost[]
}

/**
 * 把副本链接进每个 agent 的 skill 目录。
 *
 * **已经存在的落点分两种，处置不同**：是我们放的就整份换新；不是（用户自己手写了一个同名的）
 * 就**跳过并说明**——删掉用户的东西是不可逆的，宁可少装一个然后如实说。
 */
export function installSkills(opts: InstallOptions): HostResult[] {
  const copyRoot = join(opts.dataDir, 'skills')
  return (opts.hosts ?? ALL_HOSTS).map((host) => {
    const root = join(opts.home, HOST_SKILL_DIRS[host])
    mkdirSync(root, { recursive: true })
    pruneRetired(root, copyRoot)
    const landings = shippedSkillNames().map((skill): LandingResult => {
      const from = join(copyRoot, skill)
      const to = join(root, landingName(skill))
      if (existsSync(to) && !ours(to, from)) {
        return { skill, path: to, skipped: '这个位置已经有别的东西（不是 Stream 放的），没有动它' }
      }
      return { skill, path: to, mode: land(from, to) }
    })
    return { host, root, landings }
  })
}

/** 现查：每个 agent 那边此刻有哪几个我们的落点。**不缓存**——用户可能在 Stream 之外动过它。 */
export function skillStatus(opts: InstallOptions): HostResult[] {
  const copyRoot = join(opts.dataDir, 'skills')
  return (opts.hosts ?? ALL_HOSTS).map((host) => {
    const root = join(opts.home, HOST_SKILL_DIRS[host])
    const landings = shippedSkillNames().flatMap((skill): LandingResult[] => {
      const to = join(root, landingName(skill))
      if (!existsSync(to) && !isDangling(to)) return []
      const from = join(copyRoot, skill)
      if (!ours(to, from)) return [{ skill, path: to, skipped: '不是 Stream 放的' }]
      return [{ skill, path: to, mode: lstatSync(to).isSymbolicLink() ? 'link' : 'copy' }]
    })
    return { host, root, landings }
  })
}

/**
 * 清掉出过货、后来改名或撤掉的那些落点（`RETIRED_SKILLS`）。
 *
 * **不做这件事，从出货名单里删一个名字就等于把它永久留在用户机器上**——`install` 只写当前名单里
 * 的，`uninstall` 也只删当前名单里的，谁都不会回头看一眼那个已经不在名单里的旧名。而留下的是一份
 * **旧名、旧范围**的 skill，它会继续答问题，看起来像个正经答案。
 *
 * 判据和别处一样是 `ours`：不是我们放的（用户自己手写了一个同名的）就不动。
 */
function pruneRetired(root: string, copyRoot: string): void {
  for (const skill of retiredSkillNames()) {
    const to = join(root, landingName(skill))
    if (!existsSync(to) && !isDangling(to)) continue
    if (!ours(to, join(copyRoot, skill))) continue
    rmSync(to, { recursive: true, force: true })
  }
}

/** 悬空链接：`existsSync` 对它是 false（它跟随目标），但 `lstatSync` 看得见。 */
function isDangling(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** 撤销：只删我们建的那些落点（判据同 `ours`）。副本目录留着——它归 `<dataDir>`，删它是另一件事。 */
export function uninstallSkills(opts: InstallOptions): { removed: string[]; kept: LandingResult[] } {
  const copyRoot = join(opts.dataDir, 'skills')
  const removed: string[] = []
  const kept: LandingResult[] = []
  for (const host of opts.hosts ?? ALL_HOSTS) {
    const root = join(opts.home, HOST_SKILL_DIRS[host])
    // 退役的那些也一起撤——用户装过它们，卸载就该干净。
    for (const skill of [...shippedSkillNames(), ...retiredSkillNames()]) {
      const to = join(root, landingName(skill))
      if (!existsSync(to) && !isDangling(to)) continue
      if (!ours(to, join(copyRoot, skill))) {
        kept.push({ skill, path: to, skipped: '不是 Stream 放的，没有删' })
        continue
      }
      rmSync(to, { recursive: true, force: true })
      removed.push(to)
    }
  }
  return { removed, kept }
}

/** 落点名字的前缀（导出给路由与测试；判据本身在 `ours`）。 */
export { LANDING_PREFIX }
