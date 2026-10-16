import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { BrowserCookie } from '../types.ts'
import type { CookieSource } from './cookie-provider.ts'
import { LOCAL_DEVICE } from '../devices/run-context.ts'

/** 设备 id → 文件名。冒号换下划线，其余非 [A-Za-z0-9._-] 一律换掉——id 来自配对与 hello，不能让它拼出路径。 */
export function cookieFileName(deviceId: string): string {
  return `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')}.json`
}

/**
 * 升级前只有一份 `data/cookies.json`。首启把它改名为 `local` 设备的快照——**只改名不改内容**。
 * 新文件已在就不动旧文件（那是迁移跑过之后有人又放回来的，不能覆盖新的）。
 * 改名失败保留原文件并告警：静默丢掉它的表现是用户「突然全站掉登录」。
 */
function migrateLegacy(legacy: string, target: string, log: (line: string) => void): void {
  if (!existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(legacy, target)
    chmodSync(target, 0o600)
    log(`[cookies] 迁移：${legacy} → ${target}`)
  } catch (e) {
    log(`[cookies] WARN 迁移 ${legacy} 失败，保留原文件：${(e as Error).message}`)
  }
}

/** 「这台 Stream 手里的登录态现在什么样」——一份纯本地快照，读它不打网络、不会失败。 */
export interface CookieHealth {
  /** 现在握着哪些 cookie 域。空 = 扩展还没推过第一轮，**不是故障**。 */
  domains: string[]
  /** 上一次整份替换的时刻（epoch ms）；null = 从来没取到过。排查时"这份多旧了"只有它能答。 */
  updatedAt: number | null
}

/**
 * 后端从用户 Chrome 里取回来的那份登录态，落在 `data/cookies/<设备>.json`。
 *
 * **不加密**：后端就是消费端，采集时本来就拿明文 cookie 发请求——自己解自己的密不增加任何
 * 安全性，只增加一个"密钥和密文放在同一个目录"的仪式。用文件权限管（0600，同
 * `data/ext-relay-token`）。**别把加密加回来。**
 *
 * 它实现的是 `CookieSource` 那个接缝：所有取 cookie 的地方读的都是 `cookieString(domain)`，
 * 换来源对上层无感。
 *
 * **按设备一份**（`data/cookies/<设备>.json`）：在 NAS 上登录得到的会话只给 NAS 上的执行用，
 * 否则「PC 登录、NAS 下单」的分叉又回来了。见 openspec/changes/device-execution/design.md D4。
 */
export class PushedCookieStore implements CookieSource {
  private readonly file: string
  private cache: Record<string, BrowserCookie[]> | null = null
  private updatedAt: number | null = null

  /** 仅 local 设置：改名失败时 `read()` 回退读它，升级不掉登录。 */
  private readonly legacy?: string

  constructor(dataDir: string, deviceId: string = LOCAL_DEVICE, log: (line: string) => void = console.log) {
    this.file = join(dataDir, 'cookies', cookieFileName(deviceId))
    if (deviceId === LOCAL_DEVICE) {
      this.legacy = join(dataDir, 'cookies.json')
      migrateLegacy(this.legacy, this.file, log)
    }
  }

  /**
   * 整份替换（不是按域合并）。语义跟着扩展走：它每次推的是"现在该同步的全部域"的全量，
   * 所以用户去掉一个域之后，那个域就该消失。按域合并会把它变成永不过期的僵尸登录态。
   */
  replace(cookies: Record<string, BrowserCookie[]>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const at = Date.now()
    const tmp = `${this.file}.tmp`
    // 先写临时文件再 rename：采集随时可能在读，半份 JSON 会让它把"解析失败"当成"没登录"。
    writeFileSync(tmp, JSON.stringify({ updatedAt: at, cookies }), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
    this.cache = cookies
    this.updatedAt = at
  }

  async fetch(): Promise<Record<string, BrowserCookie[]>> {
    return this.read().cookies
  }

  /** 健康面用：现在握着哪些域、什么时候取的。没有文件 = 还没取过（不是故障）。 */
  status(): CookieHealth {
    const { cookies, updatedAt } = this.read()
    return { domains: Object.keys(cookies).sort(), updatedAt }
  }

  private read(): { cookies: Record<string, BrowserCookie[]>; updatedAt: number | null } {
    if (this.cache) return { cookies: this.cache, updatedAt: this.updatedAt }
    // 新文件不在才回退旧文件（改名失败的情形）；新旧都在时永远读新的。
    const src = existsSync(this.file) ? this.file : this.legacy && existsSync(this.legacy) ? this.legacy : null
    if (!src) return { cookies: {}, updatedAt: null }
    try {
      const raw = JSON.parse(readFileSync(src, 'utf8')) as {
        updatedAt?: number
        cookies?: Record<string, BrowserCookie[]>
      }
      this.cache = raw.cookies ?? {}
      this.updatedAt = raw.updatedAt ?? null
    } catch {
      // 文件坏了 → 当作"还没推过"，让扩展下一轮把它盖掉。这里绝不能抛：抛出去就是
      // 整条采集链路起不来，而真正的修复动作（等扩展再推一次）本来是自动会发生的。
      this.cache = {}
      this.updatedAt = null
    }
    return { cookies: this.cache, updatedAt: this.updatedAt }
  }
}

/** 每台设备一份快照的集合。`fetch(deviceId)` 实现 `CookieSource`，缺省是 local。 */
export class DeviceCookieStores implements CookieSource {
  private readonly stores = new Map<string, PushedCookieStore>()
  constructor(private readonly dataDir: string, private readonly log: (line: string) => void = console.log) {}

  forDevice(deviceId: string): PushedCookieStore {
    let s = this.stores.get(deviceId)
    if (!s) {
      s = new PushedCookieStore(this.dataDir, deviceId, this.log)
      this.stores.set(deviceId, s)
    }
    return s
  }

  async fetch(deviceId: string = LOCAL_DEVICE): Promise<Record<string, BrowserCookie[]>> {
    return this.forDevice(deviceId).fetch()
  }
}
