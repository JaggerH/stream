import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { UserStore } from './user-store.ts'
import { setPackageIdentities } from '../providers/identities.ts'

describe('UserStore', () => {
  let dir: string
  let store: UserStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'user-store-'))
    store = new UserStore(join(dir, 'stream.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a strategy:expand provider with its expand config', () => {
    store.putProvider({
      id: 'exp', label: 'x', description: '', category: 'search', serves: ['x'], strategy: 'expand',
      members: [{ source: 'a' }, { source: 'b' }], contract: null, options: {},
      expand: { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } },
    })
    const r = store.getProvider('exp')!
    expect(r.strategy).toBe('expand')
    expect(r.expand).toEqual({ map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } })
  })

  it('round-trips a stream with members JSON', () => {
    store.putStream({
      id: 'hn', label: 'Hacker News', strategy: 'fanout', cadence_seconds: 900,
      members: [{ plugin: 'rsshub', source: 'hackernews', params: {} }], options: {},
    })
    const s = store.getStream('hn')!
    expect(s.members[0].plugin).toBe('rsshub')
    const ids = store.listStreams().map((x) => x.id)
    expect(ids).toContain('hn')
  })

  it('seeds system channels as stored channel rows', () => {
    expect(store.getChannel('default-timeline')).toMatchObject({
      id: 'default-timeline',
      label: '时间线',
      present: 'timeline',
      system: true,
    })
    expect(store.getChannel('default-audio')).toMatchObject({
      id: 'default-audio',
      label: '音乐/播客',
      present: 'audio',
      system: true,
    })
    expect(store.getChannel('default-tasks')).toMatchObject({
      id: 'default-tasks',
      label: '定时任务',
      present: 'tasks',
      system: true,
    })
    expect(store.listChannels().map((c) => c.id)).toContain('default-tasks')
  })

  it('新库能存 research present 的频道', () => {
    store.putChannel({ id: 'r1', label: '研究', present: 'research', stream_ids: [], options: {} })
    expect(store.getChannel('r1')!.present).toBe('research')
  })

  it('channels reference streams by id; streamsOf resolves them', () => {
    store.putStream({ id: 'hn', label: 'HN', strategy: 'fanout', cadence_seconds: 900, members: [], options: {} })
    store.putChannel({ id: 'inbox', label: '默认信箱', present: 'timeline', stream_ids: ['hn'], options: {} })
    expect(store.streamsOf('inbox').map((s) => s.id)).toEqual(['hn'])
  })

  it('derives video stream ids from video channels only', () => {
    store.putChannel({ id: 'films', label: '影视', present: 'video', stream_ids: ['movie-1', 'shared'], options: {} })
    store.putChannel({ id: 'home', label: '首页', present: 'timeline', stream_ids: ['shared', 'timeline-1'], options: {} })

    const ids = store.videoStreamIds()
    expect([...ids]).toEqual(expect.arrayContaining(['movie-1', 'shared']))
    expect(ids.has('timeline-1')).toBe(false)
  })

  it('patchChannel merges fields and bumps updated_at', () => {
    store.putChannel({ id: 't', label: 'a', present: 'timeline', stream_ids: [], options: {} })
    const c = store.patchChannel('t', { label: 'b', stream_ids: ['x'] })!
    expect(c.label).toBe('b')
    expect(c.stream_ids).toEqual(['x'])
  })

  it('rejects invalid strategy/variant/cadence at the DB layer', () => {
    expect(() =>
      store.putStream({ id: 'bad', label: '', strategy: 'merge' as never, cadence_seconds: 900, members: [], options: {} }),
    ).toThrow()
    expect(() =>
      store.putStream({ id: 'bad2', label: '', strategy: 'fanout', cadence_seconds: 0, members: [], options: {} }),
    ).toThrow()
  })

  it('removeStream detaches the id from every referencing channel', () => {
    store.putStream({ id: 's1', label: 'a', strategy: 'fanout', cadence_seconds: 60, members: [], options: {} })
    store.putStream({ id: 's2', label: 'b', strategy: 'fanout', cadence_seconds: 60, members: [], options: {} })
    store.putChannel({ id: 't1', label: 't1', present: 'timeline', stream_ids: ['s1', 's2'], options: {} })
    store.putChannel({ id: 't2', label: 't2', present: 'audio', stream_ids: ['s1'], options: {} })
    expect(store.removeStream('s1')).toBe(true)
    expect(store.getChannel('t1')!.stream_ids).toEqual(['s2'])
    expect(store.getChannel('t2')!.stream_ids).toEqual([])
    expect(store.removeStream('s1')).toBe(false)
  })

  it('provider records round-trip with mixed member forms (fn / source / auto)', () => {
    store.putProvider({
      id: 'track-play', label: '播放解析', description: '音频播放地址解析梯子',
      category: 'resolve', serves: ['netease'], strategy: 'sequential',
      members: [{ source: 'netease-download-znnu' }, { source: 'netease-download-toubiec' }, { mode: 'auto', provides: 'netease-track' }],
      contract: null, options: {},
    })
    const p = store.getProvider('track-play')!
    expect(p.category).toBe('resolve')
    expect(p.serves).toEqual(['netease'])
    expect(p.members).toHaveLength(3)
    expect(p.members[2]).toEqual({ mode: 'auto', provides: 'netease-track' })
    expect(store.listProviders().map((x) => x.id)).toEqual(['track-play'])
  })

  it('rebuilds the providers CHECK on a live DB that already grew the system column', () => {
    // Regression: a real user DB has (a) a providers CHECK missing newer variants AND
    // (b) the later-ADDed `system` column. The CHECK rebuild recreated the table from the
    // 11-column base schema, so `INSERT INTO providers SELECT *` got 12 values → SQLITE_ERROR.
    const legacyDir = mkdtempSync(join(tmpdir(), 'user-store-legacy-'))
    const dbPath = join(legacyDir, 'stream.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform','transcribe')),
        serves TEXT NOT NULL DEFAULT '[]',
        strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent')),
        members TEXT NOT NULL DEFAULT '[]',
        contract TEXT,
        options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        system INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO providers VALUES ('old-row','l','','resolve','[]','sequential','[]',NULL,'{}','t','t',1);
    `)
    raw.close()
    const migrated = new UserStore(dbPath) // must not throw
    const row = migrated.getProvider('old-row')!
    expect(row.system).toBe(true) // system value survives the rebuild
    // the rebuilt CHECK accepts the new variant
    migrated.putProvider({
      id: 'llm', label: 'llm', description: '', category: 'llm', serves: [],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('llm')!.category).toBe('llm')
    migrated.putProvider({
      id: 'metadata', label: 'metadata', description: '', category: 'metadata', serves: [],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    migrated.putProvider({
      id: 'images', label: 'images', description: '', category: 'images', serves: [],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('metadata')!.category).toBe('metadata')
    expect(migrated.getProvider('images')!.category).toBe('images')
    migrated.close()
    rmSync(legacyDir, { recursive: true, force: true })
  })

  it('persists the provider system flag; putProvider preserves it when the patch omits it', () => {
    store.putProvider({
      id: 'sys', label: 's', description: '', category: 'resolve', serves: ['k'],
      strategy: 'sequential', members: [], contract: null, options: {}, system: true,
    })
    expect(store.getProvider('sys')!.system).toBe(true)
    // a user edit that omits `system` must not silently clear it (mirrors putChannel)
    store.patchProvider('sys', { members: [{ source: 'edited' }] })
    const after = store.getProvider('sys')!
    expect(after.system).toBe(true)
    expect(after.members).toEqual([{ source: 'edited' }])
    // a non-system row defaults to false
    store.putProvider({
      id: 'plain', label: 'p', description: '', category: 'resolve', serves: [],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(store.getProvider('plain')!.system).toBe(false)
  })

  it('patchProvider merges partial fields; removeProvider deletes', () => {
    // 用户自建 id：身份就在它自己的行上，写什么存什么（系统行另有一套，见下一条）。
    store.putProvider({
      id: 'my-catchall', label: '兜底抓取', description: '', category: 'transform',
      serves: ['*'], strategy: 'sequential', members: [{ source: 'fetch-url' }], contract: null, options: {},
    })
    const patched = store.patchProvider('my-catchall', { serves: ['*', 'example.com'], options: { exclude: ['x'] } })!
    expect(patched.serves).toEqual(['*', 'example.com'])
    expect(patched.options).toEqual({ exclude: ['x'] })
    expect(patched.members).toEqual([{ source: 'fetch-url' }]) // untouched fields survive
    expect(store.removeProvider('my-catchall')).toBe(true)
    expect(store.getProvider('my-catchall')).toBeNull()
    expect(store.removeProvider('my-catchall')).toBe(false)
  })

  // 写侧收窄：系统行的身份字段一律取代码身份，调用方传什么都不作数。没有这道闸门，库里那一行
  // 就能和运行时读到的它长得不一样（读侧 `ProviderDirectory` 已经是代码赢）——一个永不报错、
  // 只在有人直读 DB 或导出包时才现形的分叉。
  it('putProvider forces the code identity onto system rows; orchestration still lands', () => {
    store.putProvider({
      id: 'fetch-url', label: '我的标签', description: '我的说明', category: 'search',
      serves: ['乱写的'], strategy: 'concurrent', members: [{ source: '我选的' }],
      contract: { members: '瞎编的' }, options: { mine: 1 },
    })
    const row = store.getProvider('fetch-url')!
    // 身份取代码（`src/providers/system/fetch-url.ts`：transform + 兜底 + sequential + 无合同）
    expect(row.category).toBe('transform')
    expect(row.serves).toEqual(['*'])
    expect(row.strategy).toBe('sequential')
    expect(row.contract).toBeNull()
    // 编排与文案照常落用户给的值
    expect(row.members).toEqual([{ source: '我选的' }])
    expect(row.options).toEqual({ mine: 1 })
    expect(row.label).toBe('我的标签')
    expect(row.description).toBe('我的说明')

    // expand 同理：身份没声明就写不进去；声明了的（今天只有包出的组合体行）也不许被改
    store.patchProvider('fetch-url', { expand: { map: { x: '$item.x' }, assemble: { url: '$item.u', type: 'pathClassify', desc: '$item.d' } } })
    expect(store.getProvider('fetch-url')!.expand).toBeUndefined()
    const expand = { map: { detailUrl: '$item.detailUrl' }, assemble: { url: '$item.link', type: 'pathClassify', desc: '$item.title' } }
    setPackageIdentities([{ facility: 'pkg', packageName: '@t/pkg', declaration: {
      id: 'pkg-combo', category: 'search', serveKeys: ['pkg-combo'], strategy: 'expand', expand,
      label: 'x', description: 'x', members: [{ source: 'a' }, { source: 'b' }],
    } }])
    try {
      store.putProvider({
        id: 'pkg-combo', label: '', description: '', category: 'search', serves: [], strategy: 'sequential',
        members: [], contract: null, options: {},
      })
      expect(store.getProvider('pkg-combo')!.expand).toEqual(expand)
      expect(store.getProvider('pkg-combo')!.strategy).toBe('expand')
    } finally { setPackageIdentities([]) }
  })

  it('persists video detail cache entries independently from Stream configuration', () => {
    const detail = {
      cacheKey: 'tmdb:1', identity: { title: 'Example', externalIds: { tmdb: '1' } },
      images: {}, imageCandidates: [], failures: [], fetchedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2026-07-15T00:00:00.000Z',
    }
    store.putVideoDetail(detail)
    expect(store.getVideoDetail('tmdb:1')).toEqual(detail)
    store.removeVideoDetail('tmdb:1')
    expect(store.getVideoDetail('tmdb:1')).toBeNull()
  })

  it('rejects invalid provider variant/strategy at the DB layer', () => {
    const base = { id: 'bad', label: '', description: '', serves: [], members: [], contract: null, options: {} }
    expect(() => store.putProvider({ ...base, category: 'timeline' as never, strategy: 'sequential' })).toThrow()
    expect(() => store.putProvider({ ...base, category: 'search', strategy: 'failover' as never })).toThrow()
  })

  it('rebuilds a legacy two-column providers table (capability/overrides) on open', () => {
    store.close()
    const raw = new Database(join(dir, 'legacy.db'))
    raw.exec(`CREATE TABLE providers (capability TEXT PRIMARY KEY, overrides TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO providers VALUES ('search', '{}', 't')`).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'legacy.db'))
    expect(migrated.listProviders()).toEqual([]) // legacy overrides had no consumer — dropped
    migrated.putProvider({
      id: 'p', label: '', description: '', category: 'search', serves: ['content'],
      strategy: 'concurrent', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('p')!.strategy).toBe('concurrent')
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('adopts a legacy targets table in place (2026-07-04 Target→Channel rename)', () => {
    store.close()
    const raw = new Database(join(dir, 'renamed.db'))
    raw.exec(`CREATE TABLE targets (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      variant TEXT NOT NULL CHECK (variant IN ('timeline','search','audio','mixed')),
      stream_ids TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0, options TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO targets VALUES ('my-feed', '我的频道', 'timeline', '["s1"]', 0, '{}', 't', 't')`).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'renamed.db'))
    const chan = migrated.getChannel('my-feed')! // user rows survive the table rename verbatim
    expect(chan.label).toBe('我的频道')
    expect(chan.stream_ids).toEqual(['s1'])
    expect(migrated.listChannels().map((c) => c.id)).toContain('default-timeline') // system seed still runs
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('migrates a channels CHECK missing tasks by rebuilding, preserving the existing row incl. space_id', () => {
    store.close()
    const dbPath = join(dir, 'oldcheck-tasks.db')
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research')),
      stream_ids TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      space_id TEXT NOT NULL DEFAULT 'default-space')`)
    raw.prepare(
      `INSERT INTO channels (id, label, present, stream_ids, system, options, created_at, updated_at, space_id)
       VALUES ('r1', '研究', 'research', '["s1"]', 0, '{"x":1}', 't1', 't2', 'my-space')`,
    ).run()
    raw.close()

    const migrated = new UserStore(dbPath) // must not throw on the CHECK-missing-tasks table

    // 老行原样在——直接读原始列，不经 rowToChannel 的 space 校验，逼真验证重建没丢东西。
    // 一个「直接 DROP 老表重建」的错实现同样能让下面 (b) 的插入通过，但这里会先炸：
    // r1 这一行、以及它的 space_id，会随老表一起消失。
    const rawAfter = new Database(dbPath)
    const row = rawAfter.prepare('SELECT * FROM channels WHERE id = ?').get('r1') as any
    rawAfter.close()
    expect(row.label).toBe('研究')
    expect(row.present).toBe('research')
    expect(row.stream_ids).toBe('["s1"]')
    expect(row.options).toBe('{"x":1}')
    expect(row.space_id).toBe('my-space') // 后加的这一列没被重建丢掉

    // 重建后的 CHECK 现在接受 tasks
    migrated.putChannel({ id: 't1', label: '定时任务', present: 'tasks', stream_ids: [], options: {} })
    expect(migrated.getChannel('t1')!.present).toBe('tasks')
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('migrates a channels CHECK that has tasks but not embed — rebuild once more, rows intact', () => {
    store.close()
    const dbPath = join(dir, 'oldcheck-embed.db')
    const raw = new Database(dbPath)
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research','tasks')),
      stream_ids TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      space_id TEXT NOT NULL DEFAULT 'default-space')`)
    raw.prepare(
      `INSERT INTO channels (id, label, present, stream_ids, system, options, created_at, updated_at, space_id)
       VALUES ('t1', '定时任务', 'tasks', '[]', 1, '{"y":2}', 't1', 't2', 'my-space')`,
    ).run()
    raw.close()

    const migrated = new UserStore(dbPath)
    const rawAfter = new Database(dbPath)
    const row = rawAfter.prepare('SELECT * FROM channels WHERE id = ?').get('t1') as any
    rawAfter.close()
    expect(row.present).toBe('tasks')
    expect(row.options).toBe('{"y":2}')
    expect(row.space_id).toBe('my-space')

    migrated.putChannel({ id: 'e1', label: '监控', present: 'embed', stream_ids: [], options: { url: 'http://x/' } })
    expect(migrated.getChannel('e1')!.present).toBe('embed')
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('accepts the transcribe variant', () => {
    store.putProvider({
      id: 'transcribe', label: '语音转文字', description: '', category: 'transcribe', serves: ['*'],
      strategy: 'sequential', members: [{ source: 'cf-whisper', params: { tokenName: 'cloudflare' } }],
      contract: null, options: {},
    })
    expect(store.getProvider('transcribe')!.category).toBe('transcribe')
  })

  it('migrates an old providers.category CHECK (without transcribe) by rebuilding, preserving rows', () => {
    store.close()
    const raw = new Database(join(dir, 'oldcheck.db'))
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform')),
        serves TEXT NOT NULL DEFAULT '[]',
        strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent')),
        members TEXT NOT NULL DEFAULT '[]', contract TEXT, options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
    raw.prepare(
      `INSERT INTO providers (id,label,description,variant,serves,strategy,members,contract,options,created_at,updated_at)
       VALUES ('keep','K','','search','["content"]','concurrent','[]',NULL,'{}','t','t')`
    ).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'oldcheck.db'))
    expect(migrated.getProvider('keep')!.category).toBe('search') // existing row preserved
    // the new variant is now accepted (was rejected by the old CHECK)
    migrated.putProvider({
      id: 'transcribe', label: '', description: '', category: 'transcribe', serves: ['*'],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('transcribe')!.category).toBe('transcribe')
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('accepts the llm variant', () => {
    store.putProvider({
      id: 'llm', label: 'LLM', description: '', category: 'llm', serves: ['*'],
      strategy: 'sequential',
      members: [{ source: 'llm-openai', name: 'zhipu', params: { baseUrl: 'https://x/v1', model: 'm', tokenName: 'llm:zhipu' } }],
      contract: null, options: {},
    })
    expect(store.getProvider('llm')!.category).toBe('llm')
  })

  it('migrates a post-transcribe CHECK (without llm) by rebuilding, preserving rows', () => {
    store.close()
    const raw = new Database(join(dir, 'llmcheck.db'))
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform','transcribe')),
        serves TEXT NOT NULL DEFAULT '[]',
        strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent')),
        members TEXT NOT NULL DEFAULT '[]', contract TEXT, options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
    raw.prepare(
      `INSERT INTO providers (id,label,description,variant,serves,strategy,members,contract,options,created_at,updated_at)
       VALUES ('keep','K','','transcribe','["*"]','sequential','[]',NULL,'{}','t','t')`
    ).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'llmcheck.db'))
    expect(migrated.getProvider('keep')!.category).toBe('transcribe') // existing row preserved
    migrated.putProvider({
      id: 'llm', label: '', description: '', category: 'llm', serves: ['*'],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('llm')!.category).toBe('llm') // new variant now accepted
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

  it('drops leftover providers_old table if it exists before rebuild and preserves existing rows', () => {
    store.close()
    const raw = new Database(join(dir, 'leftover_check.db'))
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        variant TEXT NOT NULL CHECK (variant IN ('search','resolve','download','transform','transcribe')),
        serves TEXT NOT NULL DEFAULT '[]',
        strategy TEXT NOT NULL CHECK (strategy IN ('sequential','concurrent')),
        members TEXT NOT NULL DEFAULT '[]', contract TEXT, options TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE providers_old (
        id TEXT PRIMARY KEY
      );
    `)
    raw.prepare(
      `INSERT INTO providers (id,label,description,variant,serves,strategy,members,contract,options,created_at,updated_at)
       VALUES ('keep','K','','transcribe','["*"]','sequential','[]',NULL,'{}','t','t')`
    ).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'leftover_check.db'))
    expect(migrated.getProvider('keep')!.category).toBe('transcribe')
    migrated.putProvider({
      id: 'llm', label: '', description: '', category: 'llm', serves: ['*'],
      strategy: 'sequential', members: [], contract: null, options: {},
    })
    expect(migrated.getProvider('llm')!.category).toBe('llm')
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })


  it('persists and reads back lastHarvestAt per stream', () => {
    const store = new UserStore(join(dir, 'lha.db'))
    expect(store.getLastHarvestAt('s1')).toBeNull()
    store.setLastHarvestAt('s1', '2026-07-20T10:00:00.000Z')
    expect(store.getLastHarvestAt('s1')).toBe('2026-07-20T10:00:00.000Z')
    store.setLastHarvestAt('s1', '2026-07-20T11:00:00.000Z') // upsert
    expect(store.getLastHarvestAt('s1')).toBe('2026-07-20T11:00:00.000Z')
  })

  it('drops lastHarvestAt when the stream is removed', () => {
    const store = new UserStore(join(dir, 'lha2.db'))
    store.putStream({ id: 's1', label: 's1', strategy: 'fanout', cadence_seconds: 60, members: [], options: {} } as any)
    store.setLastHarvestAt('s1', '2026-07-20T10:00:00.000Z')
    store.removeStream('s1')
    expect(store.getLastHarvestAt('s1')).toBeNull()
  })

  it('近乎全空的 armed 位按 (stream, source) 持久化，并随删流一起走', () => {
    const path = join(dir, 'guard.db')
    const store = new UserStore(path)
    store.putStream({ id: 's1', label: 's1', strategy: 'fanout', cadence_seconds: 60, members: [], options: {} } as any)
    expect(store.isNearEmptyArmed('s1', 'src-a')).toBe(false)
    store.armNearEmpty('s1', 'src-a')
    store.armNearEmpty('s1', 'src-a') // 幂等
    expect(store.isNearEmptyArmed('s1', 'src-a')).toBe(true)
    expect(store.isNearEmptyArmed('s1', 'src-b')).toBe(false)

    // 跨实例可读——重启后一个真被清空的 collection 流不用重新攒两轮
    const reopened = new UserStore(path)
    expect(reopened.isNearEmptyArmed('s1', 'src-a')).toBe(true)
    reopened.clearNearEmpty('s1', 'src-a')
    expect(reopened.isNearEmptyArmed('s1', 'src-a')).toBe(false)

    reopened.armNearEmpty('s1', 'src-a')
    reopened.removeStream('s1')
    expect(reopened.isNearEmptyArmed('s1', 'src-a')).toBe(false)
  })

  it('channelSlotsReferencing finds providers referenced by channel slots', () => {
    store.putChannel({ id: 'c1', label: 'x', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['p-nsfw'] } } })
    store.putChannel({ id: 'c2', label: 'y', present: 'timeline', stream_ids: [], options: {} })
    expect(store.channelSlotsReferencing('p-nsfw')).toEqual([{ channelId: 'c1', callsiteId: 'search.resources' }])
    expect(store.channelSlotsReferencing('other')).toEqual([])
  })

  // Task 8（llm-provider-unification）：调用点绑定带可选 params——per-任务 model 覆盖的落点。
  // 只做存取，不改任何调用方行为；旧行为（不带 params）必须原样保留。
  it('round-trips provider binding params; omitting params keeps the old undefined shape', () => {
    store.putProviderBinding({ callsiteId: 'llm.chat', providerIds: ['llm'], params: { model: 'gpt-4o-mini' } })
    const withParams = store.getProviderBinding('llm.chat')!
    expect(withParams.params).toEqual({ model: 'gpt-4o-mini' })
    expect(store.listProviderBindings().find((b) => b.callsiteId === 'llm.chat')?.params).toEqual({ model: 'gpt-4o-mini' })

    // put 不带 params（如 restore-default）会把已有的 params 清掉——PUT 是整体替换，不是合并
    store.putProviderBinding({ callsiteId: 'llm.chat', providerIds: ['llm'] })
    const cleared = store.getProviderBinding('llm.chat')!
    expect(cleared.params).toBeUndefined()

    // 从未带过 params 的旧行为原样不变
    store.putProviderBinding({ callsiteId: 'netdisk.spec.suggest', providerIds: ['llm'] })
    expect(store.getProviderBinding('netdisk.spec.suggest')!.params).toBeUndefined()
  })

  it('migrates a pre-existing provider_bindings table without a params column, preserving rows', () => {
    store.close()
    const raw = new Database(join(dir, 'nolegacyparams.db'))
    raw.exec(`
      CREATE TABLE provider_bindings (
        callsite_id TEXT PRIMARY KEY,
        provider_ids TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
    raw.prepare(`INSERT INTO provider_bindings (callsite_id, provider_ids, updated_at) VALUES ('search.content', '["content-search"]', 't')`).run()
    raw.close()
    const migrated = new UserStore(join(dir, 'nolegacyparams.db'))
    expect(migrated.getProviderBinding('search.content')).toEqual({ callsiteId: 'search.content', providerIds: ['content-search'], updatedAt: 't' })
    migrated.putProviderBinding({ callsiteId: 'llm.chat', providerIds: ['llm'], params: { model: 'x' } })
    expect(migrated.getProviderBinding('llm.chat')!.params).toEqual({ model: 'x' })
    migrated.close()
    store = new UserStore(join(dir, 'stream.db')) // keep afterEach close() happy
  })

})

describe('channels present migration', () => {
  it('migrates variant column to present, mapping mixed→timeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const file = join(dir, 'stream.db')
    // 用旧 schema 手工造库(模拟存量用户)
    const raw = new Database(file)
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      variant TEXT NOT NULL CHECK (variant IN ('timeline','search','audio','mixed','video')),
      stream_ids TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO channels VALUES ('c1','旧频道','mixed','[]',0,'{}','2026-01-01','2026-01-01')`).run()
    raw.prepare(`INSERT INTO channels VALUES ('c2','视频','video','[]',0,'{}','2026-01-01','2026-01-01')`).run()
    raw.close()
    const store = new UserStore(file)
    expect(store.getChannel('c1')?.present).toBe('timeline')
    expect(store.getChannel('c2')?.present).toBe('video')
    store.close()
    // 幂等:再开一次不炸、数据不变
    const again = new UserStore(file)
    expect(again.getChannel('c1')?.present).toBe('timeline')
    again.close()
  })

  it('停在旧 CHECK 的老库迁移后也能存 research', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const file = join(dir, 'stream.db')
    // 已经过 variant→present 改名、但 CHECK 还停在加 'video' 那一版的存量库
    const raw = new Database(file)
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video')),
      stream_ids TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO channels VALUES ('keep','K','timeline','[]',0,'{}','2026-01-01','2026-01-01')`).run()
    raw.close()
    const migrated = new UserStore(file)
    expect(migrated.getChannel('keep')?.present).toBe('timeline') // 老行保住
    migrated.putChannel({ id: 'r1', label: '研究', present: 'research', stream_ids: [], options: {} })
    expect(migrated.getChannel('r1')?.present).toBe('research')
    migrated.close()
  })
})

// —— 调度装载面：live present 的流不该被采集 ——
//
// `data === 'live'` 的 present（research / search）在 spec 里明说「不入库」：请求到来时现读，
// 不走去重/过滤/入库那条有状态的链。但调度装载一直按 `referencedStreamIds()` 装，
// **只看有没有被频道引用、不看是哪种 present**，于是 live 面自己不写库、旁边那条采集路一直在写。
//
// 只跳过「仅被 live 频道引用」的流：同一条流若还被某个 collected 频道引用着，它仍然该被采集。
describe('collectedStreamIds（调度装载的那份清单）', () => {
  let dir: string
  let store: UserStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'user-store-live-'))
    store = new UserStore(join(dir, 'stream.db'))
    for (const id of ['s-live', 's-both', 's-collected']) {
      store.putStream({ id, label: id, strategy: 'fanout', cadence_seconds: 900, members: [], options: {} })
    }
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('只被 live present 频道引用的流不进清单,但仍在 referencedStreamIds 里', () => {
    store.putChannel({ id: 'rc', label: '研究', present: 'research', stream_ids: ['s-live'], options: {} })
    expect(store.referencedStreamIds().has('s-live')).toBe(true)
    expect(store.collectedStreamIds().has('s-live')).toBe(false)
  })

  it('同一条流还被 collected 频道引用着 → 照样进清单', () => {
    store.putChannel({ id: 'rc', label: '研究', present: 'research', stream_ids: ['s-both'], options: {} })
    store.putChannel({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['s-both', 's-collected'], options: {} })
    expect(store.collectedStreamIds().has('s-both')).toBe(true)
    expect(store.collectedStreamIds().has('s-collected')).toBe(true)
  })

  // 运行期（HTTP 写入路径）问的是单条流，不是整份清单——但判据必须是同一个，
  // 不能在路由里手写第二份 present 判断。
  it('isCollected 与整份清单逐条一致', () => {
    store.putChannel({ id: 'rc', label: '研究', present: 'research', stream_ids: ['s-live', 's-both'], options: {} })
    store.putChannel({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['s-both'], options: {} })
    expect(store.isCollected('s-live')).toBe(false)
    expect(store.isCollected('s-both')).toBe(true)
  })

  it('还没归属任何频道的流 → 算采集(与 POST /api/streams 建完即排班的既有行为一致)', () => {
    expect(store.referencedStreamIds().has('s-collected')).toBe(false)
    expect(store.isCollected('s-collected')).toBe(true)
  })
})

// —— channels 表重建必须是原子的 ——
//
// 重建是 CREATE channels_new → INSERT SELECT → DROP → RENAME 一整条 exec，无事务。中途失败
// （磁盘满、CHECK 撞上脏行、进程被杀）会留下一张 channels_new，**下次开库炸在 CREATE TABLE 上
// —— 库开不了 = 应用起不来**。本分支把探测条件放宽之后，每一个存量安装升级时都会跑这块，
// 曝光面从「variant 期老库」变成全体用户。
//
// 这里直接模拟"上一次重建半途死掉"的现场：库里预先躺着一张 channels_new。
describe('channels 重建的原子性', () => {
  it('库里残留 channels_new 时照样开得起来,老频道不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-halfway-'))
    const file = join(dir, 'stream.db')
    const raw = new Database(file)
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video')),
      stream_ids TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO channels VALUES ('keep','K','timeline','[]',0,'{}','2026-01-01','2026-01-01')`).run()
    // 上一轮重建死在 DROP 之前留下的残骸
    raw.exec(`CREATE TABLE channels_new (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','research')),
      stream_ids TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.close()
    const store = new UserStore(file)
    expect(store.getChannel('keep')?.present).toBe('timeline')
    store.putChannel({ id: 'r1', label: '研究', present: 'research', stream_ids: [], options: {} })
    expect(store.getChannel('r1')?.present).toBe('research')
    store.close()
  })

  it('重建整条走事务:INSERT 撞 CHECK 时整体回滚,老表原封不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-rollback-'))
    const file = join(dir, 'stream.db')
    const raw = new Database(file)
    // 老库的 CHECK 里有 'mixed',新 CHECK 没有,且 present 列已存在 → CASE 分支不会把它翻译掉,
    // INSERT SELECT 必然撞新表的 CHECK。这是"重建中途炸"的一个真实可复现形状。
    raw.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      present TEXT NOT NULL CHECK (present IN ('timeline','search','audio','video','mixed')),
      stream_ids TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0,
      options TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO channels VALUES ('bad','B','mixed','[]',0,'{}','2026-01-01','2026-01-01')`).run()
    raw.close()
    expect(() => new UserStore(file)).toThrow()
    // 炸归炸,现场必须干净:老表还在、行还在、没有半张 channels_new 挡着下次开库。
    const after = new Database(file)
    const tables = after.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'channels%'`).all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(['channels'])
    expect((after.prepare(`SELECT count(*) c FROM channels`).get() as { c: number }).c).toBe(1)
    after.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
