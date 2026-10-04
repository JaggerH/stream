// 归档器仅有的两份状态（spec §4.10）：人的判断（豁免/墓碑）+ 溯源（审计与撤销）。
// 处理进度不落盘——对账式幂等靠文件系统本身（spec §4.9）。
// 底座是 netdisk.db 的 decisions / run_actions 两张表（spec 2026-07-31 §4）。
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

interface DecisionFile {
  exemptions: Record<string, { note: string; at: number }>
  tombstones: Record<string, { at: number }>
  /** 「这份文件不是那一集」——key 是 `notEpisodeKey()` 拼的组合键，不是集身份键。 */
  notEpisodes: Record<string, { at: number }>
  /** 「这份文件**就是**那一集」——同样是组合键。它是问句的另一半答案，见 `setIsEpisode`。 */
  isEpisodes: Record<string, { at: number }>
  /** 「这两份里留前面那份」——组合键 `[留下的, 落选的]`，见 `setPreferred`。 */
  prefers: Record<string, { at: number }>
}

/**
 * 「不是这一集」的组合键：**一个文件 + 一集**，不是一条身份键。
 *
 * 用户对一条 `duration-collision`（时长撞上某一集、名字过不了地板）点「不是这一集」时落的就是它。
 * 为什么必须带上两侧：这条判断只对**这一次撞车**成立——同一份文件将来撞上别的集要重新问，
 * 同一集碰上别的文件也要重新问。做成按集身份的全局豁免会把整条身份键静音，连真正的那一集
 * 一起哑掉（豁免是「这一集别再提了」，这里说的是「这**份**不是它」，两回事）。
 *
 * JSON 数组当分隔符：`leftKey` 和路径都可能含任意字符，拼串用任何单字符分隔符都有歧义
 * （`a|b` + `c` 与 `a` + `b|c` 会撞成同一条）。这个键**只拼不解**，可读性够排查用。
 */
const notEpisodeKey = (leftKey: string, path: string): string => `not-episode:${JSON.stringify([leftKey, path])}`
/** 「就是这一集」的组合键，与上面同构（同样只拼不解）。 */
const isEpisodeKey = (leftKey: string, path: string): string => `is-episode:${JSON.stringify([leftKey, path])}`
/**
 * 「这两份里留前面那份」的组合键：**两个文件路径**，`[留下的, 落选的]`。
 *
 * 第二货架上同集两份比不出高下时人裁的那条。**必须带两侧**：这条判断只对这一对成立。
 * 做成单边的"这份是落选的"，一旦留下那份将来被删/挪走，落选那条决定还在，下一轮就会把
 * 仅存的一份也判掉——一个保护性的决定退化成删除依据。带两侧则天然失效：另一半不在了，
 * 这条就不再套用，退回问句。
 */
const preferKey = (kept: string, loser: string): string => `prefer:${JSON.stringify([kept, loser])}`

/** 组合键里的"文件"格：**货架 id + 路径**。两个货架上同一个相对路径不是同一份文件；路径归一化
 *  规则一变也只影响一个货架。拼法只住这里，测试钉着——改它 = 存量决定整批掉钉。 */
export function fileKeyOf(shelfId: string, path: string): string { return `${shelfId}:${path}` }
/** 反向：不是本货架的格 → null（调用方据此跳过整行，别把别人的决定读成自己的）。 */
const stripShelf = (shelfId: string, fileKey: string): string | null =>
  fileKey.startsWith(`${shelfId}:`) ? fileKey.slice(shelfId.length + 1) : null

export class DecisionStore {
  private readonly upsert: Database.Statement
  private readonly del: Database.Statement
  private readonly byKey: Database.Statement
  private readonly fullByKey: Database.Statement
  private readonly all: Database.Statement
  private readonly byKind: Database.Statement

  constructor(db: Database.Database, private readonly shelfId: string) {
    this.upsert = db.prepare('INSERT OR REPLACE INTO decisions (key, kind, note, at) VALUES (?, ?, ?, ?)')
    this.del = db.prepare('DELETE FROM decisions WHERE key = ?')
    this.byKey = db.prepare('SELECT kind FROM decisions WHERE key = ?')
    this.fullByKey = db.prepare('SELECT kind, note, at FROM decisions WHERE key = ?')
    this.all = db.prepare('SELECT key, kind, note, at FROM decisions')
    this.byKind = db.prepare('SELECT key FROM decisions WHERE kind = ?')
    this.migrateLegacyKeys()
  }

  /** 裸路径 → 键里的文件格。对外 API 一律收/还裸路径，前缀只在这一层进出。 */
  private fk(path: string): string { return fileKeyOf(this.shelfId, path) }

  exempt(key: string, note: string): void { this.upsert.run(key, 'exempt', note, Date.now()) }
  tombstone(key: string): void { this.upsert.run(key, 'tombstone', null, Date.now()) }
  revoke(key: string): void { this.del.run(key) }
  /** **只认这两种**：别的 kind（`not-episode` 那类组合键）落到这里会让整份文件被当成豁免跳过。 */
  verdictFor(key: string): 'exempt' | 'tombstone' | null {
    const row = this.byKey.get(key) as { kind: string } | undefined
    return row?.kind === 'exempt' || row?.kind === 'tombstone' ? row.kind : null
  }

  /** 人裁：这份文件不是那一集（`on: false` = 撤回，下一轮重新问）。`note` 给裁决器用
   *  （落 `llm:<runId>`，`revokeByNotePrefix` 据此整批撤回）——人裁不传，落 null。 */
  setNotEpisode(leftKey: string, path: string, on = true, note?: string): void {
    if (on) this.upsert.run(notEpisodeKey(leftKey, this.fk(path)), 'not-episode', note ?? null, Date.now())
    else this.del.run(notEpisodeKey(leftKey, this.fk(path)))
  }
  isNotEpisode(leftKey: string, path: string): boolean {
    return (this.byKey.get(notEpisodeKey(leftKey, this.fk(path))) as { kind: string } | undefined)?.kind === 'not-episode'
  }

  /**
   * 人裁：这份文件**就是**那一集（`on: false` = 撤回）。这是问句的另一半答案——「不是这一集」
   * 只能把文件推走，推不出"那它是哪一集"；没有这一半，匹配器判不出的那些永远只能一轮轮问下去。
   *
   * 落下去之后它变成匹配层的 **pin**（`SpecLeft.pinnedRight`），在任何 stage 跑之前就把这一对
   * 钉死——**两个消费者（绑定同步、归档器）自动都尊重它**，而不是在归档器里另开一条"人说了算"
   * 的判定分支（那就又是第二个脑）。
   *
   * 两条互斥性，都在这里保证，不许留给调用方：
   *  · 与同一对的「不是这一集」互斥——答了"是"就把那条"否"撤掉，否则两条决定互相打架；
   *  · **一集只能钉一份**：给同一集换一份文件时先清掉它旧的那条，不然 pin 有两条、谁生效
   *    取决于遍历顺序（抓阄）。
   */
  /** `note` 同 `setNotEpisode`——裁决器用它落 `llm:<runId>`，人裁不传。 */
  setIsEpisode(leftKey: string, path: string, on = true, note?: string): void {
    if (!on) { this.del.run(isEpisodeKey(leftKey, this.fk(path))); return } // 撤回只撤这一对，不碰别的
    this.del.run(notEpisodeKey(leftKey, this.fk(path)))
    // 「一集只钉一份」的唯一性**按货架算**：`pinnedFor` 只答本货架，别的货架上那条钉子跟这一份
    // 不是同一个问题的两个答案——顺手删掉就是在替别人拍板。
    for (const row of this.byKind.all('is-episode') as { key: string }[]) {
      const pair = parseComboKey(row.key)
      if (pair?.[0] === leftKey && stripShelf(this.shelfId, pair[1]) !== null) this.del.run(row.key)
    }
    this.upsert.run(isEpisodeKey(leftKey, this.fk(path)), 'is-episode', note ?? null, Date.now())
  }
  /** 这一集被人钉给了哪份文件（没钉过 → null）。**只答本货架**，返回裸路径。 */
  pinnedFor(leftKey: string): string | null {
    for (const row of this.byKind.all('is-episode') as { key: string }[]) {
      const pair = parseComboKey(row.key)
      if (pair?.[0] !== leftKey) continue
      const bare = stripShelf(this.shelfId, pair[1])
      if (bare !== null) return bare
    }
    return null
  }

  /**
   * 人裁：这两份里留 `kept`、`loser` 落选（`on: false` = 撤回，下一轮重新问）。
   *
   * 反向那条**必须一起清掉**：同一对留着两条方向相反的决定，谁生效就取决于查询顺序（抓阄）。
   * 与 `setIsEpisode` 的「一集只能钉一份」是同一类互斥，理由也同一个。
   */
  setPreferred(kept: string, loser: string, on = true): void {
    this.del.run(preferKey(this.fk(loser), this.fk(kept)))
    if (on) this.upsert.run(preferKey(this.fk(kept), this.fk(loser)), 'prefer', null, Date.now())
    else this.del.run(preferKey(this.fk(kept), this.fk(loser)))
  }

  /** 这一对人裁过留哪份（没裁过 → null）。两个方向问都一样，答的是同一件事。 */
  preferredOf(a: string, b: string): string | null {
    if ((this.byKey.get(preferKey(this.fk(a), this.fk(b))) as { kind: string } | undefined)?.kind === 'prefer') return a
    if ((this.byKey.get(preferKey(this.fk(b), this.fk(a))) as { kind: string } | undefined)?.kind === 'prefer') return b
    return null
  }

  /**
   * 文件搬家了 → 组合键里的路径跟着走。**executePlan 每搬成一份就调一次**（undo 时反向再调）。
   *
   * 为什么必须有：三类组合键（not-episode / is-episode / prefer）都把文件路径拼在键里，
   * 而 execute 的本职就是改路径。没有这一步，用户采纳一张待决卡 → 决定生效 → 文件搬进货架 →
   * 键里还是旧路径 → 钉子跟丢 → **同一份文件在新路径上重新出卡**（2026-08-24 发发大王活体：
   * 采纳 5 张后 346/49/271 全部复发，每张要答两遍）。答卡的动作本身触发搬运，搬运又作废了
   * 这个决定——采纳的次数越多，掉钉越准。
   *
   * prefer 键的**两侧都要查**（kept 和 loser 任何一侧都可能是被搬的那份）；同一行两侧同时
   * 命中不可能（一次只搬一份文件），逐行改一侧即可。kind/note/at 原样保留——迁移不是新决定。
   *
   * 比对用**带货架前缀**的格：搬的是本货架上那一份，别的货架同名路径纹丝不动。
   */
  migratePath(oldPath: string, newPath: string): void {
    const oldKey = this.fk(oldPath)
    for (const kind of ['not-episode', 'is-episode', 'prefer'] as const) {
      for (const row of this.byKind.all(kind) as { key: string }[]) {
        const pair = parseComboKey(row.key)
        if (!pair) continue
        const idx = pair[0] === oldKey ? 0 : pair[1] === oldKey ? 1 : -1
        // not-episode / is-episode 的路径只住第二格（第一格是 leftKey）——第一格命中说明是
        // prefer 键的 kept 侧，或极端情况下 leftKey 恰好长得像路径；按 kind 区分，别误迁。
        if (idx === -1 || (kind !== 'prefer' && idx === 0)) continue
        const detail = this.fullByKey.get(row.key) as { kind: string; note: string | null; at: number } | undefined
        if (!detail) continue
        pair[idx] = this.fk(newPath)
        const prefix = row.key.slice(0, row.key.indexOf(':'))
        this.del.run(row.key)
        this.upsert.run(`${prefix}:${JSON.stringify(pair)}`, detail.kind, detail.note, detail.at)
      }
    }
  }

  /**
   * 存量行的路径格没有 `<shelfId>:` 前缀（键格式引入货架 id 之前落的）→ 加上。只认"看起来像
   * 绝对路径"（以 `/` 开头）的格；已带前缀的不动。幂等：跑多少次都一样（第二遍那些格已经是
   * `openlist:/...`，不以 `/` 开头，直接跳过）。
   *
   * 为什么在构造时做而不是留给读路径兼容：兼容分支要在**每一处**读键的地方各写一遍，漏一处就是
   * 一条静默失效的决定；一次性改写只有这一个地方能错。
   */
  private migrateLegacyKeys(): void {
    for (const kind of ['not-episode', 'is-episode', 'prefer'] as const) {
      for (const row of this.byKind.all(kind) as { key: string }[]) {
        const pair = parseComboKey(row.key)
        if (!pair) continue
        // not-episode / is-episode 的路径只住第二格（第一格是 leftKey）；prefer 两格都是路径。
        const idx = kind === 'prefer' ? [0, 1] : [1]
        let touched = false
        for (const i of idx) if (pair[i]!.startsWith('/')) { pair[i] = this.fk(pair[i]!); touched = true }
        if (!touched) continue
        const detail = this.fullByKey.get(row.key) as { kind: string; note: string | null; at: number } | undefined
        if (!detail) continue
        const prefix = row.key.slice(0, row.key.indexOf(':'))
        this.del.run(row.key)
        this.upsert.run(`${prefix}:${JSON.stringify(pair)}`, detail.kind, detail.note, detail.at)
      }
    }
  }

  /**
   * 按 `note` 前缀整批撤回——裁决器一轮落的全部决定共用 `llm:<runId>` 这一个前缀，「模型裁的」
   * 因此能一把抹掉，不牵动人工那些（人工决定的 `note` 恒为 null，永远不会命中任何前缀）。
   * 三类组合键（is-episode/not-episode/exempt）都可能带 note，这里不按 kind 分支、逐行扫全表——
   * 前缀是裁决器自己起的命名空间，不会与人写的豁免理由（`exempt` 的自由文本）自然撞上。
   * 返回撤了几条，供账本/回执报数。
   */
  revokeByNotePrefix(prefix: string): number {
    let n = 0
    for (const row of this.all.all() as { key: string; note: string | null }[]) {
      if (row.note && row.note.startsWith(prefix)) { this.del.run(row.key); n++ }
    }
    return n
  }

  /** 读模型保持旧 JSON 文件的形状（API 响应/前端消费不变），组合键那两类各单列一格。 */
  list(): DecisionFile {
    const out: DecisionFile = { exemptions: {}, tombstones: {}, notEpisodes: {}, isEpisodes: {}, prefers: {} }
    for (const row of this.all.all() as { key: string; kind: string; note: string | null; at: number }[]) {
      // **显式列全每一种 kind**：这里原先是 `else → tombstones`，任何新 kind 都会被静默吞进
      // 墓碑格——加一种决定时没有任何东西会喊。`tombstone` 现在也走显式分支，未知的一律丢掉。
      if (row.kind === 'exempt') out.exemptions[row.key] = { note: row.note ?? '', at: row.at }
      else if (row.kind === 'not-episode') out.notEpisodes[row.key] = { at: row.at }
      else if (row.kind === 'is-episode') out.isEpisodes[row.key] = { at: row.at }
      else if (row.kind === 'prefer') out.prefers[row.key] = { at: row.at }
      else if (row.kind === 'tombstone') out.tombstones[row.key] = { at: row.at }
    }
    return out
  }
}

/** 组合键**只拼不解**是对外的约定（键里两侧都可能含任意字符）；库内自己要按 leftKey 找回
 *  那一对时才走这里，坏行当没有，绝不抛。 */
function parseComboKey(key: string): [string, string] | null {
  const json = key.slice(key.indexOf(':') + 1)
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : null
  } catch { return null }
}

export interface ProvenanceEntry {
  id: string; at: number
  /** `rename`：`src` 旧完整路径、`dst` 新完整路径（同目录）。`rmdir`：`src` 被删的空目录，无 `dst`。 */
  action: 'move' | 'delete' | 'rename' | 'rmdir'
  src: string; dst?: string; size: number
  /** 匹配依据（人读的）：如 'num-match:092' / 'size-dup-of:/lib/x.mp3' */
  basis: string
  undone?: true
  /** 哪一轮做的（`reconcile_runs.run_id`）。老行没有；整轮撤销只认带它的行。 */
  runId?: string
}

export class ProvenanceLog {
  private readonly ins: Database.Statement
  private readonly byId: Database.Statement
  private readonly tail: Database.Statement
  private readonly byRun: Database.Statement
  private readonly setUndone: Database.Statement

  constructor(db: Database.Database) {
    this.ins = db.prepare('INSERT INTO run_actions (id, at, action, src, dst, size, basis, undone, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    this.byId = db.prepare('SELECT id, at, action, src, dst, size, basis, undone, run_id FROM run_actions WHERE id = ?')
    this.tail = db.prepare('SELECT id, at, action, src, dst, size, basis, undone, run_id FROM run_actions ORDER BY rowid DESC LIMIT ?')
    this.byRun = db.prepare('SELECT id, at, action, src, dst, size, basis, undone, run_id FROM run_actions WHERE run_id = ? ORDER BY rowid ASC')
    this.setUndone = db.prepare('UPDATE run_actions SET undone = 1 WHERE id = ?')
  }

  record(e: Omit<ProvenanceEntry, 'id' | 'at'>): string {
    const id = randomUUID()
    this.ins.run(id, Date.now(), e.action, e.src, e.dst ?? null, e.size, e.basis, e.runId ?? null)
    return id
  }
  get(id: string): ProvenanceEntry | undefined {
    const row = this.byId.get(id) as ActionRow | undefined
    return row ? fromRow(row) : undefined
  }
  list(limit = 200): ProvenanceEntry[] {
    return (this.tail.all(limit) as ActionRow[]).reverse().map(fromRow)
  }
  /** 一整轮做过的所有动作，按写入顺序（rowid 升序）——`undoRun` 倒序撤销时反过来读。 */
  listByRun(runId: string): ProvenanceEntry[] {
    return (this.byRun.all(runId) as ActionRow[]).map(fromRow)
  }
  markUndone(id: string): void {
    this.setUndone.run(id)
  }
}

interface ActionRow { id: string; at: number; action: string; src: string; dst: string | null; size: number; basis: string; undone: number; run_id: string | null }

function fromRow(row: ActionRow): ProvenanceEntry {
  return {
    id: row.id,
    at: row.at,
    action: row.action as ProvenanceEntry['action'],
    src: row.src,
    ...(row.dst !== null ? { dst: row.dst } : {}),
    size: row.size,
    basis: row.basis,
    ...(row.undone ? { undone: true as const } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
  }
}
