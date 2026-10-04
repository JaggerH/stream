import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SYSTEM_CHANNEL_RECORDS, DEFAULT_SPACE_ID, DEFAULT_VIDEO_CHANNEL_ID, VIDEO_RANKING_STREAMS, type ProviderRecord, type ProviderBinding, type SpaceRecord, type StreamRecord, type ChannelRecord } from './types.ts'
import { isParked } from '../providers/parked.ts'
import { presentDescriptor } from '../providers/presents.ts'
import { identityOf } from '../providers/identities.ts'
import { identityServes } from '../providers/system/types.ts'
import { readSlots } from './slots.ts'
import type { VideoDetail } from '../video/types.ts'

/**
 * 一列 JSON 读坏了、这一行被降级读出来的现场。
 *
 * **故意不是 `EventInput`**：store 是纯存储层，不认识通知中心（把 events 灌进构造函数会把它
 * 变成什么都依赖的东西，且所有建 store 的测试都要跟着改）。它只如实报「哪张表哪一行的哪一列
 * 坏了、降级成了什么」，翻译成用户看得懂的通知是装配层（`kernel/plugins/storage.ts` +
 * `bootstrap.ts`）的事。
 */
export interface RowDegradation {
  /** stream.db 里带 JSON 列的每一张表——`rowToXxx` 全在这张单子上，加一个就补一格。 */
  table: 'channels' | 'streams' | 'providers' | 'provider_bindings' | 'video_details'
  rowId: string
  column: string
  /** 降级后用的值，写进通知正文（`[]` / `{}` / `undefined`）。 */
  fallback: string
  /** 坏掉的原始字符串（已截断），只进日志与 detail，不进白话正文。 */
  raw: string
}

/** data/stream.db — 用户拥有的配置存储（ARCHITECTURE.md 两文件模型的珍贵侧）。
 *  WAL + prepared statements，照 item-store.ts 的既有范式。 */
export class UserStore {
  private db: Database.Database
  /** 「库存变了」的订阅者（见 `onChange`）。 */
  private readonly changeListeners = new Set<() => void>()
  constructor(
    dbPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    /** 某一列 JSON 读坏、这一行被降级读出来时喊一声。不传 = 只写日志（测试 / 单跑那一档）。 */
    private readonly onRowDegraded?: (info: RowDegradation) => void,
  ) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    // 旧 providers 表（capability/overrides 两列）无消费者——检测到即弃，换整行定义 schema
    const legacyProviders = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('providers') WHERE name = 'capability'`)
      .get()
    if (legacyProviders) this.db.exec('DROP TABLE providers')

    // 2026-07-04 Target->Channel rename: adopt an existing user's targets table in place
    const hasLegacyTargets = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='targets'").get()
    const hasChannels = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channels'").get()
    if (hasLegacyTargets && !hasChannels) this.db.exec('ALTER TABLE targets RENAME TO channels')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research','tasks','embed')),
        stream_ids TEXT NOT NULL DEFAULT '[]',
        system INTEGER NOT NULL DEFAULT 0,
        options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('fanout','exclusive')),
        cadence_seconds INTEGER NOT NULL CHECK (cadence_seconds > 0),
        members TEXT NOT NULL,
        contract TEXT,
        options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform','transcribe','llm','metadata','images','data')),
        serves TEXT NOT NULL DEFAULT '[]',
        strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent','expand')),
        members TEXT NOT NULL DEFAULT '[]',
        contract TEXT,
        options TEXT NOT NULL DEFAULT '{}',
        expand TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS video_details (
        cache_key TEXT PRIMARY KEY,
        detail_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_bindings (
        callsite_id TEXT PRIMARY KEY,
        provider_ids TEXT NOT NULL,
        params TEXT,
        offered_defaults TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harvest_state (
        stream_id TEXT PRIMARY KEY,
        last_harvest_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_guard (
        stream_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        armed_at TEXT NOT NULL,
        PRIMARY KEY (stream_id, source_id)
      );
    `)
    // The providers.variant CHECK grew over time ('transcribe' 2026-07, then 'llm', then video
    // metadata/image aggregation). SQLite can't
    // ALTER a CHECK, so rebuild the table (preserving rows) whenever an existing DB's constraint is
    // missing a variant. Idempotent: rebuilds only when the token is absent from the live sql.
    const rebuildProvidersCheck = (missing: string) => {
      const sql = (
        this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'`).get() as
          | { sql?: string }
          | undefined
      )?.sql
      if (!sql || sql.includes(`'${missing}'`)) return
      // The live table may have grown columns since the base schema (e.g. the later-ADDed
      // `system`). Rebuild with those extras appended, or `INSERT … SELECT *` column-counts
      // mismatch on real user DBs (fresh test DBs never hit this).
      const hasSystem = !!this.db
        .prepare(`SELECT 1 FROM pragma_table_info('providers') WHERE name = 'system'`)
        .get()
      const hasExpand = !!this.db
        .prepare(`SELECT 1 FROM pragma_table_info('providers') WHERE name = 'expand'`)
        .get()
      const extra = `${hasExpand ? ', expand' : ''}${hasSystem ? ', system' : ''}`
      this.db.exec(`
        DROP TABLE IF EXISTS providers_old;
        ALTER TABLE providers RENAME TO providers_old;
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform','transcribe','llm','metadata','images','data')),
          serves TEXT NOT NULL DEFAULT '[]',
          strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent','expand')),
          members TEXT NOT NULL DEFAULT '[]',
          contract TEXT,
          options TEXT NOT NULL DEFAULT '{}',
          expand TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL${hasSystem ? ',\n          system INTEGER NOT NULL DEFAULT 0' : ''}
        );
        INSERT INTO providers (id, label, description, variant, serves, strategy, members, contract, options, created_at, updated_at${extra})
          SELECT id, label, description, variant, serves, strategy, members, contract, options, created_at, updated_at${extra} FROM providers_old;
        DROP TABLE providers_old;
      `)
    }
    rebuildProvidersCheck('transcribe')
    rebuildProvidersCheck('llm')
    rebuildProvidersCheck('metadata')
    rebuildProvidersCheck('images')
    rebuildProvidersCheck('expand') // strategy CHECK 加 'expand'(顺带 rebuild 时补 expand 列)—— composition
    rebuildProvidersCheck('data') // board-data-query:查询槽 category(存量库 CHECK 幂等重建)
    const hasChannelSystem = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('channels') WHERE name = 'system'`)
      .get()
    if (!hasChannelSystem) this.db.exec(`ALTER TABLE channels ADD COLUMN system INTEGER NOT NULL DEFAULT 0`)
    // channels.variant → present 改名迁移(2026-07-24,'mixed' 收敛为 'timeline')。CHECK 又长过一轮
    // (2026-08 加 'research')。本块把老库无条件搬到最新 CHECK,新库直接按最新建表,两条路收敛到
    // 同一个 schema——因为 CASE/SELECT 只依赖值不依赖 CHECK 版本,老库无论停在哪个旧版本本块都能搬。
    // 探测:live sql 里没有 "present" 列(老 variant 库),或虽有 "present" 列但 CHECK 里没有
    // 'research'(present 库但 CHECK 落后)→ 重建搬数据。幂等:重建后两个探测都不再命中。
    const channelsSql = (this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'`).get() as { sql?: string } | undefined)?.sql ?? ''
    const hasPresentColumn = channelsSql.includes('present')
    if (channelsSql && (!hasPresentColumn || !channelsSql.includes("'research'"))) {
      // 整条重建走**事务**:中途失败(磁盘满、脏行撞新 CHECK、进程被杀)绝不能留下半张
      // channels_new——那会让下次开库炸在 CREATE TABLE 上,**库开不了 = 应用起不来**。
      // 探测条件放宽之后每个存量安装升级时都会跑这块,曝光面是全体用户,不是几个老库。
      // 前面的 DROP IF EXISTS 兜事务也救不回来的那一档(断电/文件层面的残骸),
      // 写法照 rebuildProvidersCheck 的既有范式。
      this.db.transaction(() => this.db.exec(`
        DROP TABLE IF EXISTS channels_new;
        CREATE TABLE channels_new (
          id TEXT PRIMARY KEY, label TEXT NOT NULL,
          present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research')),
          stream_ids TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
          options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO channels_new (id, label, present, stream_ids, system, options, created_at, updated_at)
          SELECT id, label, ${hasPresentColumn ? 'present' : "CASE WHEN variant='mixed' THEN 'timeline' ELSE variant END"},
                 stream_ids, system, options, created_at, updated_at FROM channels;
        DROP TABLE channels; ALTER TABLE channels_new RENAME TO channels;`))()
    }
    const hasProviderSystem = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('providers') WHERE name = 'system'`)
      .get()
    if (!hasProviderSystem) this.db.exec(`ALTER TABLE providers ADD COLUMN system INTEGER NOT NULL DEFAULT 0`)
    // Task 8（llm-provider-unification）：调用点绑定加 params 列（per-任务 model 覆盖的落点）。
    const hasBindingParams = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('provider_bindings') WHERE name = 'params'`)
      .get()
    if (!hasBindingParams) this.db.exec(`ALTER TABLE provider_bindings ADD COLUMN params TEXT`)
    // 「这条绑定被提过哪些默认行」（见 ProviderBinding.offeredDefaults）。存量行读出来是
    // undefined = 一条都没提过，于是升级后的第一次开机仍会把当下的默认行提一遍——之后才记账。
    const hasOfferedDefaults = this.db
      .prepare(`SELECT 1 FROM pragma_table_info('provider_bindings') WHERE name = 'offered_defaults'`)
      .get()
    if (!hasOfferedDefaults) this.db.exec(`ALTER TABLE provider_bindings ADD COLUMN offered_defaults TEXT`)
    // 空间列（频道之上那一层的归属）。放在上面所有 channels 迁移**之后**：CHECK 重建那一段
    // 用的是写死的列清单，先加列会在下一次重建时被悄悄丢掉。
    // `NOT NULL DEFAULT` 让存量行一次就位——不需要另写一条 UPDATE 回填。
    const hasSpaceId = this.db.prepare(`SELECT 1 FROM pragma_table_info('channels') WHERE name = 'space_id'`).get()
    if (!hasSpaceId) {
      this.db.exec(`ALTER TABLE channels ADD COLUMN space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}'`)
    }
    // present CHECK 又长过两轮（'tasks'、'embed'）。判据看最新那个值：缺它的表不管停在哪一代
    // 都要重建。这次重建必须放在 space_id 列已确保存在之后跑——上面 research 那次重建发生在
    // space_id 加列之前，写死的列清单里没有它；这里反过来，写死的列清单必须带上 space_id，
    // 否则重建会把这一列的值全体丢光。
    const channelsSqlForTasks = (this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'`).get() as { sql?: string } | undefined)?.sql ?? ''
    if (channelsSqlForTasks && !channelsSqlForTasks.includes("'embed'")) {
      this.db.transaction(() => this.db.exec(`
        DROP TABLE IF EXISTS channels_new;
        CREATE TABLE channels_new (
          id TEXT PRIMARY KEY, label TEXT NOT NULL,
          present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research','tasks','embed')),
          stream_ids TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
          options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          space_id TEXT NOT NULL DEFAULT '${DEFAULT_SPACE_ID}');
        INSERT INTO channels_new (id, label, present, stream_ids, system, options, created_at, updated_at, space_id)
          SELECT id, label, present, stream_ids, system, options, created_at, updated_at, space_id FROM channels;
        DROP TABLE channels; ALTER TABLE channels_new RENAME TO channels;`))()
    }
    this.ensureDefaultSpace()
    this.ensureSystemChannels()
    this.ensureVideoStreams()
  }

  /** 默认空间必须始终存在：它是所有频道的兜底落点，删空间时成员往这儿挪。
   *  label 只在**第一次建**时写——用户把它改名叫别的，不该每次开库被改回去。 */
  /**
   * 订阅「频道 / Stream / 空间的库存变了」。
   *
   * **为什么在 store 这一层而不是在写它的那些路由上**：改这份库存的入口不止一个——HTTP 路由、
   * MCP 工具（对话里让 AI 去订阅/改配置走的就是它）、订阅共享 op、清理脚本。挂在路由上就等于
   * 「网页里改了会通知，AI 改了不会」，而那正是这条通知存在的理由。这里是所有写的必经之路。
   *
   * 语义只有一句「有东西变了，自己去重读」——**不带 diff**。带 diff 就得让每个写入口都说清
   * 自己改了什么，而漏说的那次不会报错，只会让界面停在旧数据上；重读一次的代价是一个
   * `/api/channels`，换的是"不可能漏"。
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /** 通知订阅者。单个订阅者抛错不能拖垮这次写入——写已经落盘了，通知失败不该表现成写失败。 */
  private notifyChanged(): void {
    for (const l of this.changeListeners) {
      try { l() } catch { /* 订阅者自己的问题，不回传给写方 */ }
    }
  }

  ensureDefaultSpace(): void {
    if (this.getSpace(DEFAULT_SPACE_ID)) return
    this.putSpace({ id: DEFAULT_SPACE_ID, label: 'Default', position: 0, system: true })
  }

  /** Seed the 影视 channel with its ranking streams on first boot only (empty stream_ids).
   *  Each is a single-source fanout Stream bound to a curated rsshub movie source; the source's
   *  `normalizer: movie` + `mode: collection` do the rest. Once seeded we never re-add, so a user
   *  who removes a ranking keeps it removed. */
  private ensureVideoStreams(): void {
    const channel = this.getChannel(DEFAULT_VIDEO_CHANNEL_ID)
    if (!channel || channel.stream_ids.length > 0) return
    const ids: string[] = []
    for (const seed of VIDEO_RANKING_STREAMS) {
      if (!this.getStream(seed.id)) {
        this.putStream({
          id: seed.id,
          label: seed.label,
          strategy: 'fanout',
          cadence_seconds: 21600,
          members: [{ plugin: 'rsshub', source: seed.source, params: {} }],
          options: { vault_subdir: 'video' },
        })
      }
      ids.push(seed.id)
    }
    this.patchChannel(channel.id, { stream_ids: ids })
  }

  ensureSystemChannels(): void {
    for (const def of SYSTEM_CHANNEL_RECORDS) {
      const current = this.getChannel(def.id)
      this.putChannel({
        id: def.id,
        label: def.label,
        present: def.present,
        stream_ids: current?.stream_ids ?? [],
        system: true,
        options: current?.options ?? {},
      })
    }
  }

  /**
   * 读一列 JSON，坏了就降级成 `fallback` 并出声——**不跳过这一行**。
   *
   * 为什么是降级不是跳过：跳过 = 用户的频道/流凭空消失，没有任何入口找回来，把一个可修的
   * 问题变成不可见的问题；降级 = 那一行还在、还能点进去，只是空的，而 `stream_ids: []` /
   * `members: []` 在语义上本来就是"还没绑东西"，是系统里合法、UI 本来就会渲染的状态，
   * 不需要为它新造显示。**这个文件本来就是这个立场**：`rowToChannel` 里 `space_id` 指向
   * 已删空间时降级成默认空间，理由写着「别让频道从侧栏里消失」——同一个函数里一个字段
   * 降级、另两个整表炸掉，后者不是决定、是没想到。
   *
   * 炸掉的代价也不是"少一个频道"：`listChannels()` 在**开机路径**上（采集调度装载、研究频道
   * watcher 注册），一行坏数据 ⇒ 后端根本起不来。
   *
   * 出声分两路，两者都要：`onRowDegraded` 是给用户的（通知中心，能看见、能去修），
   * `console.warn` 是给排查的（带 rowId + 列名 + 原始串前缀）。
   */
  private parseColumn<T>(
    table: RowDegradation['table'], rowId: string, column: string, raw: unknown, fallback: T, fallbackLabel: string,
  ): T {
    if (typeof raw !== 'string') return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      const excerpt = raw.slice(0, 120)
      console.warn(`[user-store] ${table}.${column} 不是合法 JSON，已降级为 ${fallbackLabel}` +
        ` (row=${rowId}, raw=${JSON.stringify(excerpt)})`)
      this.onRowDegraded?.({ table, rowId, column, fallback: fallbackLabel, raw: excerpt })
      return fallback
    }
  }

  // ── streams ──
  private rowToStream(r: any): StreamRecord {
    return {
      id: r.id, label: r.label, strategy: r.strategy, cadence_seconds: r.cadence_seconds,
      members: this.parseColumn('streams', r.id, 'members', r.members, [] as any, '[]'),
      contract: r.contract ? this.parseColumn('streams', r.id, 'contract', r.contract, undefined, 'undefined') : undefined,
      options: this.parseColumn('streams', r.id, 'options', r.options, {} as any, '{}'),
    }
  }
  listStreams(): StreamRecord[] {
    return (this.db.prepare('SELECT * FROM streams ORDER BY id').all() as any[]).map((r) => this.rowToStream(r))
  }
  getStream(id: string): StreamRecord | null {
    const r = this.db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as any
    return r ? this.rowToStream(r) : null
  }
  putStream(s: StreamRecord): StreamRecord {
    const now = this.now()
    this.db.prepare(
      `INSERT INTO streams (id, label, strategy, cadence_seconds, members, contract, options, created_at, updated_at)
       VALUES (@id,@label,@strategy,@cadence_seconds,@members,@contract,@options,@now,@now)
       ON CONFLICT(id) DO UPDATE SET label=@label, strategy=@strategy, cadence_seconds=@cadence_seconds,
         members=@members, contract=@contract, options=@options, updated_at=@now`,
    ).run({
      id: s.id, label: s.label, strategy: s.strategy, cadence_seconds: s.cadence_seconds,
      members: JSON.stringify(s.members), contract: s.contract ? JSON.stringify(s.contract) : null,
      options: JSON.stringify(s.options ?? {}), now,
    })
    this.notifyChanged()
    return this.getStream(s.id)!
  }
  removeStream(id: string): boolean {
    const gone = this.db.prepare('DELETE FROM streams WHERE id = ?').run(id).changes > 0
    if (gone) {
      this.db.prepare('DELETE FROM harvest_state WHERE stream_id = ?').run(id)
      this.db.prepare('DELETE FROM collection_guard WHERE stream_id = ?').run(id)
      // 引用同步：从所有 channel.stream_ids 摘除
      for (const c of this.listChannels()) {
        if (c.stream_ids.includes(id)) this.patchChannel(c.id, { stream_ids: c.stream_ids.filter((x) => x !== id) })
      }
      this.notifyChanged()
    }
    return gone
  }
  getLastHarvestAt(streamId: string): string | null {
    const r = this.db.prepare('SELECT last_harvest_at FROM harvest_state WHERE stream_id = ?').get(streamId) as any
    return r ? (r.last_harvest_at as string) : null
  }
  setLastHarvestAt(streamId: string, isoAt: string): void {
    this.db.prepare(
      `INSERT INTO harvest_state (stream_id, last_harvest_at) VALUES (?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET last_harvest_at = excluded.last_harvest_at`,
    ).run(streamId, isoAt)
  }

  // ── collection 分片的"近乎全空"防线：armed = 上一轮这个 (stream, source) 已经报过一次近乎
  //    全空。落盘而不是放内存，是因为一次后端重启就会把它抹掉——那样一个真被清空的分片每次都
  //    得重新攒两轮，重启循环里更是永远攒不满。见 src/collection-replace-guard.ts。
  isNearEmptyArmed(streamId: string, sourceId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM collection_guard WHERE stream_id = ? AND source_id = ?')
      .get(streamId, sourceId)
  }
  armNearEmpty(streamId: string, sourceId: string): void {
    this.db.prepare(
      `INSERT INTO collection_guard (stream_id, source_id, armed_at) VALUES (?, ?, ?)
       ON CONFLICT(stream_id, source_id) DO UPDATE SET armed_at = excluded.armed_at`,
    ).run(streamId, sourceId, this.now())
  }
  clearNearEmpty(streamId: string, sourceId: string): void {
    this.db.prepare('DELETE FROM collection_guard WHERE stream_id = ? AND source_id = ?').run(streamId, sourceId)
  }

  // ── spaces（频道之上那一层）──
  private rowToSpace(r: any): SpaceRecord {
    return { id: r.id, label: r.label, position: r.position, system: !!r.system }
  }
  /** 侧栏顺序：position 升序，同值按 id 兜底——少了兜底那一段，同 position 的两个空间
   *  在不同查询里可能换位置，看起来像列表自己在抖。 */
  listSpaces(): SpaceRecord[] {
    return (this.db.prepare('SELECT * FROM spaces ORDER BY position, id').all() as any[]).map((r) => this.rowToSpace(r))
  }
  getSpace(id: string): SpaceRecord | null {
    const r = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as any
    return r ? this.rowToSpace(r) : null
  }
  putSpace(s: SpaceRecord): SpaceRecord {
    const now = this.now()
    const current = this.getSpace(s.id)
    const system = s.system ?? current?.system ?? false
    this.db.prepare(
      `INSERT INTO spaces (id, label, position, system, created_at, updated_at)
       VALUES (@id,@label,@position,@system,@now,@now)
       ON CONFLICT(id) DO UPDATE SET label=@label, position=@position, system=@system, updated_at=@now`,
    ).run({ id: s.id, label: s.label, position: s.position, system: system ? 1 : 0, now })
    this.notifyChanged()
    return this.getSpace(s.id)!
  }
  patchSpace(id: string, patch: Partial<Omit<SpaceRecord, 'id'>>): SpaceRecord | null {
    const cur = this.getSpace(id)
    if (!cur) return null
    return this.putSpace({ ...cur, ...patch, id })
  }
  /** 删空间 = 先把成员频道挪回默认空间，再删这一行。**两步一个事务**：中途失败会留下一批
   *  指向不存在空间的频道，那批频道在侧栏里哪个空间下都不出现——一个不报错的消失。
   *  默认空间和不存在的 id 都返回 false（调用方翻译成 400 / 404）。 */
  removeSpace(id: string): boolean {
    const space = this.getSpace(id)
    if (!space || space.system) return false
    this.db.transaction(() => {
      this.db.prepare('UPDATE channels SET space_id = ?, updated_at = ? WHERE space_id = ?').run(DEFAULT_SPACE_ID, this.now(), id)
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    })()
    this.notifyChanged()
    return true
  }
  /** 下一个空间排在最后。position 直接取"当前最大 +1"，不重排既有行。 */
  nextSpacePosition(): number {
    const r = this.db.prepare('SELECT MAX(position) AS m FROM spaces').get() as { m: number | null }
    return (r.m ?? -1) + 1
  }

  // ── channels ──
  private rowToChannel(r: any): ChannelRecord {
    // `space_id` 兜一层默认：存量库刚加完列时它一定有值，但指向的空间可能已经被删（删空间
    // 的事务会挪走成员，所以正常不会发生）——真出现就当默认空间，别让频道从侧栏里消失。
    const spaceId = typeof r.space_id === 'string' && r.space_id.length > 0 ? r.space_id : DEFAULT_SPACE_ID
    return {
      id: r.id, label: r.label, present: r.present,
      stream_ids: this.parseColumn('channels', r.id, 'stream_ids', r.stream_ids, [] as string[], '[]'),
      system: !!r.system,
      options: this.parseColumn('channels', r.id, 'options', r.options, {} as any, '{}'),
      space_id: this.getSpace(spaceId) ? spaceId : DEFAULT_SPACE_ID,
    }
  }
  listChannels(): ChannelRecord[] {
    return (this.db.prepare('SELECT * FROM channels ORDER BY id').all() as any[]).map((r) => this.rowToChannel(r))
  }
  getChannel(id: string): ChannelRecord | null {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as any
    return r ? this.rowToChannel(r) : null
  }
  /** `space_id` 在这里是**可选**的（记录上它是必填）：不给 = 沿用已有归属，新建 = 默认空间。
   *  调用点多数不关心归属（建频道、系统频道兜底），逼它们每处写一遍只会写错。 */
  putChannel(c: Omit<ChannelRecord, 'space_id'> & { space_id?: string }): ChannelRecord {
    const now = this.now()
    const current = this.getChannel(c.id)
    const system = c.system ?? current?.system ?? false
    // 归属沿用当前值：`ensureSystemChannels` 每次开库都拿一份**不带 space_id** 的定义来
    // put，不回填就是每次重启把用户挪过的系统频道拽回默认空间。
    const spaceId = c.space_id ?? current?.space_id ?? DEFAULT_SPACE_ID
    this.db.prepare(
      `INSERT INTO channels (id, label, present, stream_ids, system, options, space_id, created_at, updated_at)
       VALUES (@id,@label,@present,@stream_ids,@system,@options,@space_id,@now,@now)
       ON CONFLICT(id) DO UPDATE SET label=@label, present=@present, stream_ids=@stream_ids, system=@system, options=@options, space_id=@space_id, updated_at=@now`,
    ).run({ id: c.id, label: c.label, present: c.present, stream_ids: JSON.stringify(c.stream_ids), system: system ? 1 : 0, options: JSON.stringify(c.options ?? {}), space_id: spaceId, now })
    this.notifyChanged()
    return this.getChannel(c.id)!
  }
  patchChannel(id: string, patch: Partial<Omit<ChannelRecord, 'id'>>): ChannelRecord | null {
    const cur = this.getChannel(id)
    if (!cur) return null
    return this.putChannel({ ...cur, ...patch, id })
  }
  removeChannel(id: string): boolean {
    const gone = this.db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0
    if (gone) this.notifyChanged()
    return gone
  }
  streamsOf(channelId: string): StreamRecord[] {
    const c = this.getChannel(channelId)
    if (!c) return []
    return c.stream_ids.map((id) => this.getStream(id)).filter((s): s is StreamRecord => !!s)
  }
  /** 任一 Channel 引用着的全部 stream id（scheduler 装载用） */
  referencedStreamIds(): Set<string> {
    const ids = new Set<string>()
    for (const c of this.listChannels()) for (const id of c.stream_ids) ids.add(id)
    return ids
  }
  /** 调度器该采集的 stream id——**按 Present 的 `data` 轴筛**，不是「被任一频道引用」。
   *
   *  `data === 'live'` 的 present（research / search）语义就是「请求到来时现读、不落库」，
   *  所以它引用的流不该进采集：那条链上的去重 / 广告过滤 / 故事归堆 / 入库全是有状态副作用，
   *  live 面自己不写库，旁边这条路一直在写就等于「不入库」压根没成立。
   *
   *  只排除**仅**被 live 频道引用的流：同一条流若还被某个 collected 频道引用着，
   *  它对那个频道仍然要留档，照采不误。 */
  collectedStreamIds(): Set<string> {
    const ids = new Set<string>()
    for (const c of this.listChannels()) {
      if (presentDescriptor(c.present)?.data === 'live') continue
      for (const id of c.stream_ids) ids.add(id)
    }
    return ids
  }
  /** 单条流版的 `collectedStreamIds()`——运行期的写入路径（POST /api/streams、
   *  PATCH /api/channels）问的是「这一条该不该在调度里」，判据必须与开机装载同源，
   *  所以这里直接查那份清单，不另写一份 present 判断。
   *
   *  还没归属任何频道的流算采集：它不在任何 live 频道里，且 POST /api/streams 建完即排班
   *  是既有行为（订阅一条流就该立刻抓一次），不因这条判据改变。
   *
   *  与 `collectedStreamIds()` 之间因此有一处**刻意的不对称**：开机装载那份清单不含未引用的流。
   *  于是一条始终没绑频道的流，本次会话在调度里、重启后就没了。要绑频道的流别让它先无主地
   *  存在一会儿——`POST /api/streams` 收 `channel_id` 就是为此：先记归属，再问这条判据。 */
  isCollected(streamId: string): boolean {
    return this.collectedStreamIds().has(streamId) || !this.referencedStreamIds().has(streamId)
  }

  /** 归属某个 audio-present Channel 的全部 stream id。消费模式（音频 vs 时间线）的权威
   *  来源是 Channel.present（ARCHITECTURE.md：one per Channel）；Stream 不再自带 kind。
   *  封面富集、时间线排除等派生逻辑都据此判定一条流是否属于音乐面。 */
  audioStreamIds(): Set<string> {
    const ids = new Set<string>()
    for (const c of this.listChannels()) if (c.present === 'audio') for (const id of c.stream_ids) ids.add(id)
    return ids
  }
  /** 归属某个 video-present Channel 的全部 stream id。视频播放的 AList 映射只应作用于
   *  这些流，避免同一绑定覆盖普通时间线内容的 normalizer media。 */
  videoStreamIds(): Set<string> {
    const ids = new Set<string>()
    for (const c of this.listChannels()) if (c.present === 'video') for (const id of c.stream_ids) ids.add(id)
    return ids
  }

  // ── providers（整行定义：与 streams 同构的用户配置行）──
  private rowToProvider(r: any): ProviderRecord {
    return {
      id: r.id, label: r.label, description: r.description,
      category: r.category ?? r.variant, strategy: r.strategy,
      serves: this.parseColumn('providers', r.id, 'serves', r.serves, [] as any, '[]'),
      members: this.parseColumn('providers', r.id, 'members', r.members, [] as any, '[]'),
      contract: r.contract ? this.parseColumn<any>('providers', r.id, 'contract', r.contract, null, 'null') : null,
      options: this.parseColumn('providers', r.id, 'options', r.options, {} as any, '{}'),
      // `expand` 坏了就整格缺席（和这一行压根没声明 expand 是同一个状态），不是塞一个空对象
      // 进去——空的 expand 会被 composition 当成"声明了但展不出东西"，那是另一个意思。
      ...(() => {
        if (!r.expand) return {}
        const expand = this.parseColumn<any>('providers', r.id, 'expand', r.expand, undefined, '缺席')
        return expand === undefined ? {} : { expand }
      })(),
      system: !!r.system,
    }
  }
  listProviders(): ProviderRecord[] {
    return (this.db.prepare('SELECT * FROM providers ORDER BY id').all() as any[]).map((r) => this.rowToProvider(r))
  }
  /** dispatch 用：排除 parked（搭车未激活）行。listProviders 仍返回全部（UI 要看到 parked 才能激活）。 */
  listActiveProviders(): ProviderRecord[] {
    return this.listProviders().filter((p) => !isParked(p))
  }
  getProvider(id: string): ProviderRecord | null {
    const r = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as any
    return r ? this.rowToProvider(r) : null
  }

  /** composition 删除保护:哪些 Provider 通过 {provider} 成员引用了 `providerId`(删除阻断依据)。 */
  providersReferencing(providerId: string): string[] {
    return this.listProviders()
      .filter((p) => p.members.some((m) => 'provider' in m && m.provider === providerId))
      .map((p) => p.id)
  }
  /**
   * 系统行的**身份字段一律取代码**（category/serves/strategy/contract/expand），调用方传什么都
   * 不作数；members/options/label/description 照常落调用方给的值。
   *
   * 为什么写侧也要收窄：读侧（`ProviderDirectory.merged`）已经是代码赢，写侧若还能落进别的值，
   * 库里那一行就和运行时的它长得不一样——一个永远不报错、只在有人直读 DB 或导出包时才现形的
   * 分叉。写侧跟着代码写，两者永不分家。判据用身份表本身（不引 `ProviderDirectory`：directory
   * 依赖 store，反过来引会成环）。判据走 `identityOf()` **函数现取**——store 比包装配早，构造期
   * 抓一份表就抓到了只有宿主行的那张。
   */
  private withSystemIdentity(p: ProviderRecord): ProviderRecord {
    const identity = identityOf(p.id)
    if (!identity) return p
    const { expand: _dropped, ...rest } = p
    return {
      ...rest,
      category: identity.category,
      serves: identityServes(identity),
      strategy: identity.strategy,
      contract: identity.contract ?? null,
      ...(identity.expand ? { expand: identity.expand } : {}),
    }
  }
  putProvider(record: ProviderRecord): ProviderRecord {
    const p = this.withSystemIdentity(record)
    const now = this.now()
    const current = this.getProvider(p.id)
    const system = p.system ?? current?.system ?? false
    this.db.prepare(
      `INSERT INTO providers (id, label, description, variant, serves, strategy, members, contract, options, expand, system, created_at, updated_at)
       VALUES (@id,@label,@description,@variant,@serves,@strategy,@members,@contract,@options,@expand,@system,@now,@now)
       ON CONFLICT(id) DO UPDATE SET label=@label, description=@description, variant=@variant,
         serves=@serves, strategy=@strategy, members=@members, contract=@contract, options=@options, expand=@expand, system=@system, updated_at=@now`,
    ).run({
      id: p.id, label: p.label, description: p.description, variant: p.category,
      serves: JSON.stringify(p.serves), strategy: p.strategy, members: JSON.stringify(p.members),
      contract: p.contract ? JSON.stringify(p.contract) : null,
      options: JSON.stringify(p.options ?? {}), expand: p.expand ? JSON.stringify(p.expand) : null,
      system: system ? 1 : 0, now,
    })
    return this.getProvider(p.id)!
  }
  patchProvider(id: string, patch: Partial<Omit<ProviderRecord, 'id'>>): ProviderRecord | null {
    const cur = this.getProvider(id)
    if (!cur) return null
    return this.putProvider({ ...cur, ...patch, id })
  }
  removeProvider(id: string): boolean {
    return this.db.prepare('DELETE FROM providers WHERE id = ?').run(id).changes > 0
  }

  // ── provider callsite bindings ──
  private rowToProviderBinding(r: any): ProviderBinding {
    // `params` 本来就容错（坏 JSON 当未设置），只是**一声不吭**——走 parseColumn 之后行为不变，
    // 但坏了这件事终于有人喊。`provider_ids` 原先是裸 parse，和别处同一个形状。
    const params = r.params
      ? this.parseColumn('provider_bindings', r.callsite_id, 'params', r.params, undefined, '未设置')
      : undefined
    const offeredDefaults = r.offered_defaults
      ? this.parseColumn('provider_bindings', r.callsite_id, 'offered_defaults', r.offered_defaults, [] as string[], '[]')
      : undefined
    return {
      callsiteId: r.callsite_id,
      providerIds: this.parseColumn('provider_bindings', r.callsite_id, 'provider_ids', r.provider_ids, [] as string[], '[]'),
      ...(params !== undefined ? { params } : {}),
      ...(offeredDefaults !== undefined ? { offeredDefaults } : {}),
      updatedAt: r.updated_at,
    }
  }
  listProviderBindings(): ProviderBinding[] {
    return (this.db.prepare('SELECT * FROM provider_bindings ORDER BY callsite_id').all() as any[]).map((r) => this.rowToProviderBinding(r))
  }
  getProviderBinding(callsiteId: string): ProviderBinding | null {
    const row = this.db.prepare('SELECT * FROM provider_bindings WHERE callsite_id = ?').get(callsiteId) as any
    return row ? this.rowToProviderBinding(row) : null
  }
  putProviderBinding(binding: ProviderBinding): ProviderBinding {
    const now = this.now()
    // 整体替换：不带 params（undefined）落 NULL，清掉旧值——不做合并（restore-default 依赖这条清空）。
    //
    // **`offered_defaults` 是这条规则的唯一例外：不带它就保留旧值（COALESCE）。** 它不是用户
    // 数据，是我们自己的记账——记的是"这条绑定我们提过哪些默认行"。所有写入点里只有开机那一趟
    // 会带上它；用户从页面改一次绑定（PUT 只发 providerIds + params）若把它清空，那条他刚
    // 删掉的默认行下次开机就又长回来了，而没有任何一处会喊。
    this.db.prepare(`INSERT INTO provider_bindings (callsite_id, provider_ids, params, offered_defaults, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(callsite_id) DO UPDATE SET provider_ids=excluded.provider_ids, params=excluded.params,
        offered_defaults=COALESCE(excluded.offered_defaults, provider_bindings.offered_defaults), updated_at=excluded.updated_at`)
      .run(
        binding.callsiteId,
        JSON.stringify(binding.providerIds),
        binding.params !== undefined ? JSON.stringify(binding.params) : null,
        binding.offeredDefaults !== undefined ? JSON.stringify(binding.offeredDefaults) : null,
        now,
      )
    return this.getProviderBinding(binding.callsiteId)!
  }
  removeProviderBinding(callsiteId: string): boolean {
    return this.db.prepare('DELETE FROM provider_bindings WHERE callsite_id = ?').run(callsiteId).changes > 0
  }
  providerCallsitesReferencing(providerId: string): string[] {
    return this.listProviderBindings().filter((binding) => binding.providerIds.includes(providerId)).map((binding) => binding.callsiteId)
  }
  /** 反查:哪些频道的哪个槽位引用了该 Provider(删除保护 + 管理页反查共用)。 */
  channelSlotsReferencing(providerId: string): Array<{ channelId: string; callsiteId: string }> {
    const refs: Array<{ channelId: string; callsiteId: string }> = []
    for (const ch of this.listChannels()) {
      for (const [callsiteId, ids] of Object.entries(readSlots(ch.options))) {
        if (ids.includes(providerId)) refs.push({ channelId: ch.id, callsiteId })
      }
    }
    return refs
  }
  /** 系统行退役时调用:把该 Provider 从所有频道槽位里摘掉(留空数组,不删整个槽键——保留
   *  "这个槽位曾被显式配置过"的痕迹)。系统行退役是我们的代码事件、不是用户错误,不该转化成
   *  用户下次访问时踩中的 SlotBrokenError;返回清了哪些,供开机日志出声。
   *
   *  有意**不**用 `readSlots`:它只认「非空全字符串数组」,而这里要清的恰恰包括那些被它判成
   *  "未配置"的形状(混型数组里夹着这个 id、清空后剩下的空数组)——漏清就等于把悬空 id 留在库里。 */
  clearProviderFromSlots(providerId: string): Array<{ channelId: string; callsiteId: string }> {
    const cleared: Array<{ channelId: string; callsiteId: string }> = []
    for (const ch of this.listChannels()) {
      const slots = ch.options?.slots as Record<string, unknown> | undefined
      if (!slots) continue
      let touched = false
      const nextSlots: Record<string, unknown> = { ...slots }
      for (const [callsiteId, ids] of Object.entries(slots)) {
        if (Array.isArray(ids) && ids.includes(providerId)) {
          nextSlots[callsiteId] = ids.filter((id) => id !== providerId)
          cleared.push({ channelId: ch.id, callsiteId })
          touched = true
        }
      }
      if (touched) this.putChannel({ ...ch, options: { ...ch.options, slots: nextSlots } })
    }
    return cleared
  }

  // ── video detail cache (provider-enriched, never the Stream's availability facts) ──
  getVideoDetail(cacheKey: string): VideoDetail | null {
    const row = this.db.prepare('SELECT detail_json FROM video_details WHERE cache_key = ?').get(cacheKey) as { detail_json: string } | undefined
    // 这一格坏了降级成 `null` = **缓存未命中**，调用方本来就在处理这个返回值，下一次取数会把
    // 坏行覆盖掉（自愈）。所以它比别处轻，但仍然出声：我们自己只用 `JSON.stringify` 写它，
    // 它坏了说明有别的东西在改这个库——那件事值得用户知道，而不是被一次静默的缓存未命中吃掉。
    return row ? this.parseColumn('video_details', cacheKey, 'detail_json', row.detail_json, null, 'null') as VideoDetail | null : null
  }
  putVideoDetail(detail: VideoDetail): VideoDetail {
    const now = this.now()
    this.db.prepare(
      `INSERT INTO video_details (cache_key, detail_json, fetched_at, expires_at, created_at, updated_at)
       VALUES (@cacheKey,@detail,@fetchedAt,@expiresAt,@now,@now)
       ON CONFLICT(cache_key) DO UPDATE SET detail_json=@detail, fetched_at=@fetchedAt, expires_at=@expiresAt, updated_at=@now`,
    ).run({ cacheKey: detail.cacheKey, detail: JSON.stringify(detail), fetchedAt: detail.fetchedAt, expiresAt: detail.expiresAt, now })
    return this.getVideoDetail(detail.cacheKey)!
  }
  removeVideoDetail(cacheKey: string): boolean {
    return this.db.prepare('DELETE FROM video_details WHERE cache_key = ?').run(cacheKey).changes > 0
  }

  close(): void {
    this.db.close()
  }
}
