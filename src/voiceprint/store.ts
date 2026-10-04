import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cosineSimilarity } from './cosine.ts'

export interface Person {
  id: string
  name: string
  aliases: string[]
  createdAt: string
  updatedAt: string
}
export interface Voiceprint {
  id: string
  personId: string
  embedding: number[]
  modelVersion: string
  source: string
  enrolledAt: string
}
/** 一条声纹的**元数据**（列表用）：故意不带 `embedding` 本体——列表只回答「这个人名下有哪几条、
 *  各自打哪来」，向量是几百上千个 float，列出来除了撑爆响应没有任何读者。 */
export type VoiceprintInfo = Omit<Voiceprint, 'embedding'>
export interface MatchResult {
  personId: string
  name: string
  score: number
}
/** 一条「演职员表查无此人」的待确认记录：抽名链路校不上演职员表的名字，不静默丢弃，落成这条
 *  挂到认人 UI，让用户点一次「认/不认」（见 spec 2026-07-24-uncast-name-pending-confirm）。 */
export interface PendingName {
  itemId: string
  /** 该被命名的主导簇（确认时 enroll 打在它的向量上；仍存于 item_clusters） */
  cluster: string
  /** LLM 抽到、校不上演职员表的名字（原样，未纠错） */
  name: string
  /** 开场白原文（给用户看的证据句「抽到 X 认吗」） */
  evidence: string
  /** 介绍句时刻（试听定位用） */
  atSeconds: number
  createdAt: string
}

/** diarization 时间线上的一段：谁（匿名簇号或已认的人名）在 [start,end] 说话。
 *  **不带 embedding**——向量按簇存一份代表（item_clusters），段级向量是算代表的中间产物，
 *  没人事后读，落库只会把库撑大几个数量级。 */
export interface DiarizedSpan {
  start: number
  end: number
  speaker: string
}

/** 一条「谁出现在哪个内容」的账：identify 归名那一刻按 person_id 落账（存 id 而非名字，防改名漂移），
 *  `name_at_time` 只是写账那刻 segment 里的 speaker 标签快照，不参与匹配 / join。
 *  见 spec 2026-07-24-person-appearances-ledger-design。 */
export interface Appearance {
  itemId: string
  personId: string
  nameAtTime: string
  seconds: number
  segments: number
  firstAt: number
  updatedAt: string
}

/**
 * Persistent speaker identity registry (sqlite, mirroring ConversionStore). Three tables:
 * persons (identities), voiceprints (each person's accumulated embeddings, tagged with the
 * model_version that produced them), and item_clusters (per-item scratch: each diarization
 * cluster's representative embedding, so the UI can enroll "this cluster is X" later).
 * Owns no audio — only vectors and identities.
 */
export class SpeakerRegistryStore {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voiceprints (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model_version TEXT NOT NULL,
        source TEXT,
        enrolled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_clusters (
        item_id TEXT NOT NULL,
        cluster TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model_version TEXT NOT NULL,
        PRIMARY KEY (item_id, cluster)
      );
      CREATE TABLE IF NOT EXISTS item_diarization (
        item_id  TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        start_s  REAL NOT NULL,
        end_s    REAL NOT NULL,
        speaker  TEXT NOT NULL,
        PRIMARY KEY (item_id, seq)
      );
      CREATE TABLE IF NOT EXISTS pending_intro_names (
        item_id TEXT NOT NULL,
        cluster TEXT NOT NULL,
        name TEXT NOT NULL,
        evidence TEXT,
        at_seconds REAL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, cluster)
      );
      CREATE TABLE IF NOT EXISTS appearances (
        item_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        name_at_time TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        segments INTEGER NOT NULL,
        first_at REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (item_id, person_id)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vp_person ON voiceprints(person_id);
      CREATE INDEX IF NOT EXISTS idx_vp_model ON voiceprints(model_version);
      CREATE INDEX IF NOT EXISTS idx_pending_name ON pending_intro_names(item_id, name);
      CREATE INDEX IF NOT EXISTS idx_appearances_person ON appearances(person_id);
    `)
  }

  createPerson(name: string, aliases: string[] = []): Person {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO persons (id, name, aliases, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, name, JSON.stringify(aliases), now, now)
    return { id, name, aliases, createdAt: now, updatedAt: now }
  }

  listPersons(): Person[] {
    const rows = this.db.prepare('SELECT * FROM persons ORDER BY created_at ASC').all() as Record<string, unknown>[]
    return rows.map((r) => this.rowToPerson(r))
  }

  getPerson(id: string): Person | null {
    const r = this.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? this.rowToPerson(r) : null
  }

  deletePerson(id: string): void {
    this.db.prepare('DELETE FROM voiceprints WHERE person_id = ?').run(id)
    this.db.prepare('DELETE FROM persons WHERE id = ?').run(id)
  }

  addVoiceprint(personId: string, embedding: number[], modelVersion: string, source: string): Voiceprint {
    const id = randomUUID()
    const enrolledAt = new Date().toISOString()
    this.db
      .prepare('INSERT INTO voiceprints (id, person_id, embedding, model_version, source, enrolled_at) VALUES (?,?,?,?,?,?)')
      .run(id, personId, JSON.stringify(embedding), modelVersion, source, enrolledAt)
    return { id, personId, embedding, modelVersion, source, enrolledAt }
  }

  /** 某人名下的声纹清单（元数据，无向量），按登记时间升序。 */
  listVoiceprints(personId: string): VoiceprintInfo[] {
    const rows = this.db
      .prepare('SELECT id, person_id, model_version, source, enrolled_at FROM voiceprints WHERE person_id = ? ORDER BY enrolled_at ASC')
      .all(personId) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      personId: r.person_id as string,
      modelVersion: r.model_version as string,
      source: (r.source as string) ?? '',
      enrolledAt: r.enrolled_at as string,
    }))
  }

  /**
   * 单删一条声纹（一次 enroll 进了污染样本时的手术刀——此前只能整人删再全部重登）。
   *
   * **按 (person_id, id) 双键删**，不是按 id：调用方拿的是「这个人的第 N 条」，用 person 限定
   * 死了归属，别人的 print 撞上同一个 id 也删不着（也让 HTTP 层的 404 语义只需看返回值）。
   * 返回是否真删掉一条（不存在 / 不属于该 person → false）。
   *
   * **删空不级联删 person**：没有声纹的人只是自动认名匹配不到他（`match` 遍历的是 voiceprints，
   * 一条没有就自然不出现在结果里，不会炸），person 本身——名字、别名、出现账——仍然合法。
   */
  deleteVoiceprint(personId: string, voiceprintId: string): boolean {
    const r = this.db.prepare('DELETE FROM voiceprints WHERE id = ? AND person_id = ?').run(voiceprintId, personId)
    return r.changes > 0
  }

  /** Cosine every same-version voiceprint against the probe; each person scores by its BEST
   *  print. Different model_version rows are excluded (vectors from another model aren't
   *  comparable — the hard invariant). Descending by score. */
  match(embedding: number[], modelVersion: string): MatchResult[] {
    const rows = this.db
      .prepare('SELECT person_id, embedding FROM voiceprints WHERE model_version = ?')
      .all(modelVersion) as { person_id: string; embedding: string }[]
    const best = new Map<string, number>()
    for (const r of rows) {
      const v = JSON.parse(r.embedding) as number[]
      const score = cosineSimilarity(embedding, v)
      const cur = best.get(r.person_id)
      if (cur === undefined || score > cur) best.set(r.person_id, score)
    }
    const out: MatchResult[] = []
    for (const [personId, score] of best) {
      const name = (this.getPerson(personId)?.name) ?? '?'
      out.push({ personId, name, score })
    }
    return out.sort((a, b) => b.score - a.score)
  }

  putItemCluster(itemId: string, cluster: string, embedding: number[], modelVersion: string): void {
    this.db
      .prepare(
        `INSERT INTO item_clusters (item_id, cluster, embedding, model_version) VALUES (?,?,?,?)
         ON CONFLICT(item_id, cluster) DO UPDATE SET embedding = excluded.embedding, model_version = excluded.model_version`
      )
      .run(itemId, cluster, JSON.stringify(embedding), modelVersion)
  }

  getItemCluster(itemId: string, cluster: string): { embedding: number[]; modelVersion: string } | null {
    const r = this.db
      .prepare('SELECT embedding, model_version FROM item_clusters WHERE item_id = ? AND cluster = ?')
      .get(itemId, cluster) as { embedding: string; model_version: string } | undefined
    return r ? { embedding: JSON.parse(r.embedding) as number[], modelVersion: r.model_version } : null
  }

  /** 该 item 现存的簇号（不取向量）。用于「这个簇号还在不在」的校验，以及挑一个不撞车的新匿名标签。 */
  listItemClusterNames(itemId: string): string[] {
    const rows = this.db
      .prepare('SELECT cluster FROM item_clusters WHERE item_id = ? ORDER BY cluster ASC')
      .all(itemId) as { cluster: string }[]
    return rows.map((r) => r.cluster)
  }

  /** Drop all diarization cluster vectors for one item — called when its transcript is removed,
   *  so the per-item scratch vectors don't grow unbounded with the DB (re-transcribe re-upserts). */
  deleteItemClusters(itemId: string): void {
    this.db.prepare('DELETE FROM item_clusters WHERE item_id = ?').run(itemId)
  }

  // —— diarization 时间线 ——
  // 「谁在什么时候说话」是**声纹域自己的数据**，转写只是它的一个投影面（把标签贴到文字段上）。
  // 在这张表出现之前它只活在 transcript segments 里，于是没有转写就等于没有说话人——识别被焊死
  // 在 whisper 上。这里把它落成一等数据后，识别只需要音频。

  /** 整条替换某 item 的时间线（identify 每次重跑都是「换一条」，不是追加——簇号每次按首次出现
   *  时间重排，混着存就是两次运行的产物拼在一起）。 */
  putItemTimeline(itemId: string, spans: DiarizedSpan[]): void {
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM item_diarization WHERE item_id = ?').run(itemId)
      const ins = this.db.prepare(
        'INSERT INTO item_diarization (item_id, seq, start_s, end_s, speaker) VALUES (?,?,?,?,?)'
      )
      const ordered = [...spans].sort((a, b) => a.start - b.start)
      ordered.forEach((s, i) => ins.run(itemId, i, s.start, s.end, s.speaker))
    })
    write()
  }

  /** 该 item 的时间线，按时间升序；没有就是空数组（调用方据此回退去读转写 segments）。 */
  getItemTimeline(itemId: string): DiarizedSpan[] {
    const rows = this.db
      .prepare('SELECT start_s, end_s, speaker FROM item_diarization WHERE item_id = ? ORDER BY seq ASC')
      .all(itemId) as { start_s: number; end_s: number; speaker: string }[]
    return rows.map((r) => ({ start: r.start_s, end: r.end_s, speaker: r.speaker }))
  }

  /** 把一个簇标签就地改成人名（enroll 认人）。返回改了几段。 */
  renameInTimeline(itemId: string, from: string, to: string): number {
    const r = this.db
      .prepare('UPDATE item_diarization SET speaker = ? WHERE item_id = ? AND speaker = ?')
      .run(to, itemId, from)
    return r.changes
  }

  deleteItemTimeline(itemId: string): void {
    this.db.prepare('DELETE FROM item_diarization WHERE item_id = ?').run(itemId)
  }

  enrollFromCluster(itemId: string, cluster: string, personId: string, source?: string): Voiceprint | null {
    const c = this.getItemCluster(itemId, cluster)
    if (!c) return null
    return this.addVoiceprint(personId, c.embedding, c.modelVersion, source ?? `${itemId}:${cluster}`)
  }

  /** 待确认队列：抽名校不上演职员表 → 落一条问用户，而不是静默丢弃。写入前查三档去重
   *  （见 spec §3），命中任一即不入队返回 'skipped'：
   *    1. 已有同名 Person（全局确认过 / 就在演职员表里）——确认过靠声纹自动，不再问；
   *    2. 本作品有同名的 rejected 行——「同名同作品再抽到不再入队」（哪怕来自另一被拆出的簇）；
   *    3. 本作品有同名的 pending 行——一个名字每作品只挂一条（diarization 会把一个人拆成多簇）。 */
  enqueuePendingName(rec: { itemId: string; cluster: string; name: string; evidence: string; atSeconds: number }): 'pending' | 'skipped' {
    if (this.db.prepare('SELECT 1 FROM persons WHERE name = ? LIMIT 1').get(rec.name)) return 'skipped'
    const dup = this.db
      .prepare(`SELECT 1 FROM pending_intro_names WHERE item_id = ? AND name = ? AND status IN ('pending','rejected') LIMIT 1`)
      .get(rec.itemId, rec.name)
    if (dup) return 'skipped'
    this.db
      .prepare(
        `INSERT INTO pending_intro_names (item_id, cluster, name, evidence, at_seconds, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)
         ON CONFLICT(item_id, cluster) DO UPDATE SET name = excluded.name, evidence = excluded.evidence,
           at_seconds = excluded.at_seconds, status = 'pending', created_at = excluded.created_at`
      )
      .run(rec.itemId, rec.cluster, rec.name, rec.evidence, rec.atSeconds, new Date().toISOString())
    return 'pending'
  }

  listPendingNames(itemId: string): PendingName[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_intro_names WHERE item_id = ? AND status = 'pending' ORDER BY created_at ASC`)
      .all(itemId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToPending(r))
  }

  getPendingName(itemId: string, cluster: string): PendingName | null {
    const r = this.db
      .prepare(`SELECT * FROM pending_intro_names WHERE item_id = ? AND cluster = ? AND status = 'pending'`)
      .get(itemId, cluster) as Record<string, unknown> | undefined
    return r ? this.rowToPending(r) : null
  }

  /** 否决：翻成 rejected（保留 name 供第 2 档去重），从待确认列表消失，同名同作品再抽到不再入队。 */
  rejectPendingName(itemId: string, cluster: string): void {
    this.db
      .prepare(`UPDATE pending_intro_names SET status = 'rejected' WHERE item_id = ? AND cluster = ?`)
      .run(itemId, cluster)
  }

  /** 确认后清行（enroll 成功即调）：此后同名走「已有 Person」档 skip，永不再生成新待确认。 */
  deletePendingName(itemId: string, cluster: string): void {
    this.db.prepare('DELETE FROM pending_intro_names WHERE item_id = ? AND cluster = ?').run(itemId, cluster)
  }

  /**
   * 重跑聚类前清掉这个 item 的待确认行（**只清 pending**）。
   *
   * 为什么必须清：待确认按 `(item_id, cluster)` 存，而**簇号每次重跑都会变**（编号按首次出现
   * 时间重排）。旧行留着就指向了一批完全不同的内容——真实故障（喜剧之王 E02）：「徐不弃」
   * 第一次挂在 `SPEAKER_17`；重跑后他真正的发言成了 `SPEAKER_70`（346s），而 `SPEAKER_17`
   * 只剩一句「是吗」（0s）。更坑的是 `enqueuePendingName` 的第 3 档去重按**名字**挡重复，
   * 于是新簇那条压根入不了队——名字被永久钉死在一个 0 秒的垃圾簇上，面板里显示成一行空白。
   *
   * **不碰 rejected**：那是「用户说过不认，别再问」，跨重跑必须留着（第 2 档去重按名字查它）。
   */
  clearPendingNames(itemId: string): void {
    this.db.prepare(`DELETE FROM pending_intro_names WHERE item_id = ? AND status = 'pending'`).run(itemId)
  }

  private rowToPending(r: Record<string, unknown>): PendingName {
    return {
      itemId: r.item_id as string,
      cluster: r.cluster as string,
      name: r.name as string,
      evidence: (r.evidence as string) ?? '',
      atSeconds: (r.at_seconds as number) ?? 0,
      createdAt: r.created_at as string,
    }
  }

  /** 名字 → Person：精确（name 或 alias，大小写不敏感）优先；无精确命中再退子串。用于两处不同需求：
   *  归名时把 speaker 标签解析回 person（标签本就是 person.name → 走精确档），以及查询工具的模糊输入。 */
  findPersonsByName(query: string): Person[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const all = this.listPersons()
    const exact = all.filter((p) => p.name.toLowerCase() === q || p.aliases.some((a) => a.toLowerCase() === q))
    if (exact.length) return exact
    return all.filter((p) => p.name.toLowerCase().includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q)))
  }

  /** 整批替换某 item 的出现账（生命周期同 item_clusters：先删后写，re-identify/enroll 重跑不累加）。
   *  以**已（将）持久化的转写 segments** 为唯一真相：每个 speaker 标签按 persons(name+aliases) 精确解析
   *  成 person_id（匿名簇 / 未确认抽名解析不到 → 跳过），按 person 聚合 seconds/segments/firstAt。 */
  recomputeItemAppearances(itemId: string, segments: { start: number; end: number; speaker?: string }[]): void {
    // 名字/alias（小写）→ person，一次建索引供本次全部段解析
    const byName = new Map<string, Person>()
    for (const p of this.listPersons()) {
      if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), p)
      for (const a of p.aliases) if (!byName.has(a.toLowerCase())) byName.set(a.toLowerCase(), p)
    }
    const agg = new Map<string, { personId: string; nameAtTime: string; seconds: number; segments: number; firstAt: number }>()
    for (const s of segments) {
      if (!s.speaker) continue
      const person = byName.get(s.speaker.toLowerCase())
      if (!person) continue
      const dur = Math.max(0, s.end - s.start)
      const cur = agg.get(person.id)
      if (cur) {
        cur.seconds += dur
        cur.segments += 1
        cur.firstAt = Math.min(cur.firstAt, s.start)
      } else {
        agg.set(person.id, { personId: person.id, nameAtTime: s.speaker, seconds: dur, segments: 1, firstAt: s.start })
      }
    }
    const now = new Date().toISOString()
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM appearances WHERE item_id = ?').run(itemId)
      const ins = this.db.prepare(
        `INSERT INTO appearances (item_id, person_id, name_at_time, seconds, segments, first_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      for (const v of agg.values()) {
        ins.run(itemId, v.personId, v.nameAtTime, Math.round(v.seconds), v.segments, v.firstAt, now)
      }
    })
    write()
  }

  /** 清掉某人的全部出现账。删人时的兜底：正常路径靠 `recomputeItemAppearances` 按改回匿名后的
   *  标签重算（那样同 item 里别人的账仍准），但既没转写也没时间线的 item 重算不了，账会悬空。 */
  deleteAppearancesForPerson(personId: string): void {
    this.db.prepare('DELETE FROM appearances WHERE person_id = ?').run(personId)
  }

  /** 按 person 查出现账：seconds >= minSeconds（默认 30，滤插话），按 seconds 降序。personIds 传空 → 空。 */
  listAppearancesForPersons(personIds: string[], minSeconds = 30): Appearance[] {
    if (!personIds.length) return []
    const placeholders = personIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM appearances WHERE person_id IN (${placeholders}) AND seconds >= ? ORDER BY seconds DESC`
      )
      .all(...personIds, minSeconds) as Record<string, unknown>[]
    return rows.map((r) => ({
      itemId: r.item_id as string,
      personId: r.person_id as string,
      nameAtTime: r.name_at_time as string,
      seconds: r.seconds as number,
      segments: r.segments as number,
      firstAt: r.first_at as number,
      updatedAt: r.updated_at as string,
    }))
  }

  // —— meta：库级键值（一次性迁移标记这类「这个库经历过什么」的事实）——
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  private rowToPerson(r: Record<string, unknown>): Person {
    return {
      id: r.id as string,
      name: r.name as string,
      aliases: r.aliases ? (JSON.parse(r.aliases as string) as string[]) : [],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }
  }

  close(): void {
    this.db.close()
  }
}
