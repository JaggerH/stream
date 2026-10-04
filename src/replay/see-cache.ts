import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rect } from './desktop-driver.ts'
import { validateInterrupt } from './desktop-recipe.ts'
import type { See, DesktopInterrupt } from './desktop-recipe.ts'
import type { SeeMode, SeeVia } from './desktop-see.ts'

export interface SeeCacheEntry {
  via: SeeVia
  rect: Rect
  at: number
  /**
   * 固化下来的**可复用句柄**：模型定位到的那个位置上，控件树里那个元素叫什么。
   *
   * 这一格只进 entry 供**排查**用（"当初固化到的是谁"）；**重入读的是 `handles.json`**，
   * 因为重入必须发生在读屏之前，而 entry 的键编了窗口尺寸（见 `peekHandle`）。
   *
   * 缺席 = 那个位置在控件树里没有带名字的元素（纯画出来的界面），**不是"还没固化"**——
   * 两者的处置一样（走模板 / 模型），所以不分。
   */
  a11yName?: string
}

/**
 * 识别层的本地缓存——**按机器**的那一层（spec §3 两层 recipe 的下层）。
 * 目录 `<dataDir>/desktop-see/<sourceId>/`，每个键两份文件：`<key>.json`（entry）与 `<key>.png`（模板，可缺）。
 * 键含窗口尺寸与缩放比：换机器 / 改缩放 → 键变 → 重走梯子，绝不拿旧模板去错的地方匹配。
 * `interrupts.json`：二期复盘工具写、这里读；今天只读（缺/坏都当空）。
 */
export class SeeCache {
  constructor(private readonly dir: string) {}

  /**
   * `mode` 也进键：**同一个 `see` 在动作路和判据路指的不是同一个框**（动作查元素表——整个可点
   * 区域；判据查文字表——只圈住那几个字），两条路各自还会按自己那个框裁一张模板。共用一把钥匙
   * 的话，判据种下的文字模板会被动作路当成靶子——每趟都命中、每趟点在按钮内部靠左，边缘的直接点空。
   */
  key(see: See, window: Rect, scale: number, mode: SeeMode): string {
    // **穷举解构就是这里的守卫**：往 `See` 加一格而忘了编进键，症状是新旧两个不同的 see 共用
    // 一把钥匙——拿着上一个的模板去下一个的地方匹配，每趟都命中、每趟都点空。这一行让那种
    // 遗漏在 tsc 上当场变红（`rest` 一旦非空就赋不进 `Record<string, never>`），而不是留到活体。
    const { text, icon, point, region, area, below, notBelow, not, ...rest } = see
    const _exhaustive: Record<string, never> = rest
    void _exhaustive
    const norm = JSON.stringify({ text: text ?? null, icon: icon ?? null, point: point ?? null, region: region ?? null, area: area ?? null, below: below ?? null, notBelow: notBelow ?? null, not: not ?? null })
    return createHash('sha1').update(`${norm}|${window.w}x${window.h}|${scale}|${mode}`).digest('hex').slice(0, 16)
  }

  /**
   * 句柄的键：**只吃 `see` 本身，不吃窗口尺寸、不吃 mode**。
   *
   * 和 `key()` 分开是有意的。`key()` 把窗口尺寸编进去，因为它护的是**模板**——尺寸一换，
   * 上一次裁的那张图就不该再拿去匹配。但**句柄不是模板**：一个控件叫什么，不随窗口大小变。
   * 共用 `key()` 的话，用户拖一次窗口就把固化的成果全作废了，于是每次都重新付模型钱——
   * 而那正是这一整件事要消掉的成本。
   */
  private handleKey(see: See): string {
    const { text, icon, point, region, area, below, notBelow, not, ...rest } = see
    const _exhaustive: Record<string, never> = rest
    void _exhaustive
    return createHash('sha1')
      .update(JSON.stringify({ text: text ?? null, icon: icon ?? null, point: point ?? null, region: region ?? null, area: area ?? null, below: below ?? null, notBelow: notBelow ?? null, not: not ?? null }))
      .digest('hex').slice(0, 16)
  }

  /** 这个 `see` 上一趟固化到的句柄（控件名）。没有 → null。坏文件当空，不抛。 */
  peekHandle(see: See): string | null {
    const p = join(this.dir, 'handles.json')
    if (!existsSync(p)) return null
    try {
      const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      const v = m[this.handleKey(see)]
      return typeof v === 'string' && v ? v : null
    } catch {
      return null
    }
  }

  /** 把这一趟固化到的句柄记下来。**读改写整份**——这张表按 sourceId 分目录、条目是步骤级的，
   *  几十条顶天，不值得为它引一个数据库。 */
  putHandle(see: See, name: string): void {
    mkdirSync(this.dir, { recursive: true })
    const p = join(this.dir, 'handles.json')
    let m: Record<string, string> = {}
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) m = raw as Record<string, string>
      } catch {
        m = {}
      }
    }
    m[this.handleKey(see)] = name
    writeFileSync(p, JSON.stringify(m, null, 2))
  }

  /** 句柄的键，给回执带出去用（`SeeHit.cacheKey`）——runner 靠它把陈旧句柄丢掉。 */
  handleKeyOf(see: See): string {
    return this.handleKey(see)
  }

  /**
   * 丢掉一个句柄——上一趟拿它点了，但 `expect` 没兑现（见 runner 的介入闸）。
   *
   * **和 `invalidate` 分开是必须的**：那个删的是 `<key>.json` / `<key>.png`，而句柄住在
   * `handles.json` 里。混用的后果是"作废了"其实没作废，下一趟照样拿着指错的句柄去点，
   * 而日志上写着已经作废——三处都不喊。
   */
  dropHandleKey(key: string): void {
    const p = join(this.dir, 'handles.json')
    if (!existsSync(p)) return
    try {
      const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>
      delete m[key]
      writeFileSync(p, JSON.stringify(m, null, 2))
    } catch {
      /* 坏文件不值得为它抛——下一次 putHandle 会整份重写 */
    }
  }

  get(key: string): { entry: SeeCacheEntry; template: Buffer | null } | null {
    const p = join(this.dir, `${key}.json`)
    if (!existsSync(p)) return null
    try {
      const entry = JSON.parse(readFileSync(p, 'utf8')) as SeeCacheEntry
      const tp = join(this.dir, `${key}.png`)
      return { entry, template: existsSync(tp) ? readFileSync(tp) : null }
    } catch {
      return null
    }
  }

  put(key: string, entry: SeeCacheEntry, template?: Buffer): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(entry))
    if (template) writeFileSync(join(this.dir, `${key}.png`), template)
  }

  invalidate(key: string): void {
    for (const ext of ['json', 'png']) rmSync(join(this.dir, `${key}.${ext}`), { force: true })
  }

  /**
   * 本机那张打断表。**每一条都要过 recipe 装载器同一份校验**（`validateInterrupt`）——这份
   * 文件是磁盘上的 JSON，没经过任何一道装载闸，而 runner 拿到 `{dismiss:{kind:'invoke'}}`
   * （既没 see 也没 query）会去 `find({})`，拿到窗口里的第一个元素然后 invoke 它。
   *
   * 坏条目**只丢它自己**（带一行 warn 指名文件与下标），不抛、也不把整张表连坐：这张表是
   * 复盘工具攒出来的，一条写坏了不该让今天所有的弹窗都关不掉；而静默丢弃又会让人反复问
   * "我写进去的那条怎么不生效"。
   */
  interrupts(): DesktopInterrupt[] {
    const p = join(this.dir, 'interrupts.json')
    if (!existsSync(p)) return []
    let v: unknown
    try {
      v = JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return []
    }
    if (!Array.isArray(v)) return []
    const out: DesktopInterrupt[] = []
    v.forEach((entry, i) => {
      try {
        out.push(validateInterrupt(entry, `${p}[${i}]`))
      } catch (e) {
        console.warn(`[desktop] 本机打断表里第 ${i} 条不合法，已丢弃：${(e as Error).message}`)
      }
    })
    return out
  }
}
