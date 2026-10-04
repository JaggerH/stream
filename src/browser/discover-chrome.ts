/**
 * Chrome 候选发现 —— WSL 分叉下"后端在 Linux 里、浏览器在 Windows 上"，得先找到那个 exe。
 *
 * 只**发现**，不**选择**（spec §4）。返回的是候选清单，谁来用由调用方问用户；排序上 Windows 侧
 * 在前只是默认倾向（WSL 里的 Chrome 要 WSLg 才有界面，登录态几乎不在那儿），**不是自动选中**。
 * 替用户挑错的症状极其隐蔽：一切"正常运行"，只是采集全程游客态、什么都采不到。
 *
 * **依赖全部注入**（`DiscoverFs`）：函数体内不碰真实文件系统，所以它在任何机器上都能单测——
 * CI、Mac、纯 Linux 跑出来的结果只取决于喂进去的桩。真实环境用 {@link nodeDiscoverFs}。
 *
 * 适用范围：后端跑在 Linux/WSL 时。后端原生跑在 Windows 上时的路径解析归 host-agent 的
 * `chrome_candidates`（`app/host-agent/src/launch.rs`），那边走 `%ProgramFiles%` 这类 env，
 * 不是 `/mnt/<drive>` 形式，两者别混。
 */

import { access, readdir, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'

export interface ChromeCandidate {
  /** 绝对路径。WSL 档下的 Windows 侧是 `/mnt/<drive>/...` 形式 */
  exe: string
  /** 决定默认排序（spec §4）：windows 在前 */
  side: 'windows' | 'linux'
  /** standard = 系统级安装目录；user-install = 某个 Windows 用户的 AppData；path = PATH 里找到的 */
  source: 'standard' | 'user-install' | 'path'
}

/**
 * 发现所需的全部外界能力。实现随环境替换，`discoverChromeCandidates` 只认这个接口。
 * 每个方法都允许"查不到"，但**不该抛**——真抛了也不会让整轮发现失败（见 `safe`）。
 */
export interface DiscoverFs {
  /** 这个路径存在吗（文件即可） */
  exists(path: string): Promise<boolean>
  /** 列出目录下的条目名（不含路径）。目录不存在 → `[]` */
  listDir(path: string): Promise<string[]>
  /** 在 PATH 里解析一个可执行文件名 → 绝对路径；找不到 → `undefined` */
  which(cmd: string): Promise<string | undefined>
  /**
   * Windows 盘在本机的挂载根，如 `['/mnt/c', '/mnt/d']`。**不是 `/mnt/c` 写死的**——挂载点由
   * `wsl.conf` 的 `root` 决定，得按实际挂载来。非 WSL 环境返回 `[]`。
   */
  windowsMounts(): Promise<string[]>
}

/** 系统级安装的两个位置。64 位装在 `Program Files`，32 位/旧包在 `Program Files (x86)`，两个都有人用 */
export const WINDOWS_SYSTEM_DIRS = ['Program Files', 'Program Files (x86)'] as const
const WINDOWS_CHROME_SUFFIX = 'Google/Chrome/Application/chrome.exe'
/** 用户级安装（不需要管理员权限装的那种）落在各自的 AppData 下 */
const USER_INSTALL_SUFFIX = `AppData/Local/${WINDOWS_CHROME_SUFFIX}`
/** Linux 侧按 PATH 里的常见命令名找 */
export const LINUX_CHROME_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
] as const

/** 单个探测失败（权限、盘掉了、桩抛错）只丢掉这一条候选，不该让别的候选跟着消失 */
const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

const trimTrailingSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p)

/**
 * 列出这台机器上所有能用的 Chrome。**Windows 侧在前，Linux 侧在后**——只是排序。
 *
 * 同一个 exe 不会出现两次（同一块盘挂在多个点、两个命令名指向同一个二进制，都会撞上）。
 */
export async function discoverChromeCandidates(fs: DiscoverFs): Promise<ChromeCandidate[]> {
  const out: ChromeCandidate[] = []
  const add = (exe: string, side: ChromeCandidate['side'], source: ChromeCandidate['source']) => {
    if (!out.some((c) => c.exe === exe)) out.push({ exe, side, source })
  }

  for (const mount of await safe(() => fs.windowsMounts(), [] as string[])) {
    const root = trimTrailingSlash(mount)

    for (const dir of WINDOWS_SYSTEM_DIRS) {
      const exe = `${root}/${dir}/${WINDOWS_CHROME_SUFFIX}`
      if (await safe(() => fs.exists(exe), false)) add(exe, 'windows', 'standard')
    }

    // Windows 用户名 ≠ Linux 用户名，所以只能**枚举** `Users/`，不能拿 `process.env.USER` 去拼。
    // 不做"哪些是真人用户"的过滤（Public/Default 这类）：底下有没有 chrome.exe 自己会回答，
    // 猜名单只会漏掉真用户。
    const users = await safe(() => fs.listDir(`${root}/Users`), [] as string[])
    for (const user of [...users].sort()) {
      const exe = `${root}/Users/${user}/${USER_INSTALL_SUFFIX}`
      if (await safe(() => fs.exists(exe), false)) add(exe, 'windows', 'user-install')
    }
  }

  for (const cmd of LINUX_CHROME_COMMANDS) {
    const exe = await safe(() => fs.which(cmd), undefined)
    if (exe) add(exe, 'linux', 'path')
  }

  return out
}

/** `/proc/mounts` 用八进制转义空格(`\040`)和反斜杠(`\134`) */
const unescapeMountField = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))

const DRIVE_ROOT = /^([A-Za-z]):\\?$/

/**
 * 从 `/proc/mounts` 里挑出**Windows 盘根**的挂载点，一块盘一个（最短的那个挂载点）。
 *
 * 为什么不是"取 fstype 是 drvfs/9p 的行"这么简单——本机实测三个坑：
 * - `/mnt/c` 会**重复出现**；
 * - Docker Desktop 把同一块 C 盘又挂到 `/mnt/wsl/docker-desktop-bind-mounts/Ubuntu/<hash>`
 *   （aname 同样是 drvfs、path 同样是 `C:\`），照单全收会得到一堆指向同一个 chrome.exe 的候选；
 * - `/usr/lib/wsl/drivers`（`aname=drivers`）和 `/Docker/host`（`path=C:\Program Files\...`）
 *   也是 9p，但前者不是盘、后者不是盘**根**。
 *
 * 判据因此落在"这行挂的是不是某块盘的根"：优先看挂载选项里的 `path=`，老式 drvfs 行没有这个
 * 选项就退回设备字段（形如 `C:`）。同一盘符只留挂载点最短的那个。
 */
export function parseWindowsMounts(procMounts: string): string[] {
  const byDrive = new Map<string, string>()
  for (const line of procMounts.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    const [device, mountPoint, , options] = fields
    const winPath = /(?:^|[,;])path=([^,;]*)/.exec(options)?.[1] ?? unescapeMountField(device)
    const drive = DRIVE_ROOT.exec(winPath)?.[1]?.toLowerCase()
    if (!drive) continue
    const mount = unescapeMountField(mountPoint)
    const prev = byDrive.get(drive)
    if (!prev || mount.length < prev.length || (mount.length === prev.length && mount < prev)) {
      byDrive.set(drive, mount)
    }
  }
  return [...byDrive.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, mount]) => mount)
}

/** 真实环境的 {@link DiscoverFs}。所有"查不到"都收敛成空值，别让一次 ENOENT 变成异常。 */
export const nodeDiscoverFs = (): DiscoverFs => ({
  async exists(path) {
    try {
      await access(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  },
  async listDir(path) {
    try {
      return await readdir(path)
    } catch {
      return []
    }
  },
  async which(cmd) {
    for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
      const p = `${trimTrailingSlash(dir)}/${cmd}`
      try {
        await access(p, constants.X_OK)
        return p
      } catch {
        /* 下一个 PATH 目录 */
      }
    }
    return undefined
  },
  async windowsMounts() {
    try {
      return parseWindowsMounts(await readFile('/proc/mounts', 'utf8'))
    } catch {
      return []
    }
  },
})
