import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { BrowserCookie } from '../types.ts'
import type { CookieSource } from './cookie-provider.ts'

/** 「这台 Stream 手里的登录态现在什么样」——一份纯本地快照，读它不打网络、不会失败。 */
export interface CookieHealth {
  /** 现在握着哪些 cookie 域。空 = 扩展还没推过第一轮，**不是故障**。 */
  domains: string[]
  /** 上一次整份替换的时刻（epoch ms）；null = 从来没取到过。排查时"这份多旧了"只有它能答。 */
  updatedAt: number | null
}

/**
 * 后端从用户 Chrome 里取回来的那份登录态，落在 `data/cookies.json`。
 *
 * **不加密**：后端就是消费端，采集时本来就拿明文 cookie 发请求——自己解自己的密不增加任何
 * 安全性，只增加一个"密钥和密文放在同一个目录"的仪式。用文件权限管（0600，同
 * `data/ext-relay-token`）。**别把加密加回来。**
 *
 * 它实现的是 `CookieSource` 那个接缝：所有取 cookie 的地方读的都是 `cookieString(domain)`，
 * 换来源对上层无感。
 */
export class PushedCookieStore implements CookieSource {
  private readonly file: string
  private cache: Record<string, BrowserCookie[]> | null = null
  private updatedAt: number | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'cookies.json')
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
    if (!existsSync(this.file)) return { cookies: {}, updatedAt: null }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
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
