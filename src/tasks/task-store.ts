/**
 * 用户定义的定时任务：住 data/stream.db（用户拥有的那一侧，照 user-store.ts 的范式）。
 *
 * **为什么业务任务入库而运维任务留代码**：运维任务（cookie 刷新、standby 回收）是 stream
 * 自己的内脏，改排期就该改代码走 review；业务任务（A 股申购、数据下载）是用户的活儿，
 * 排期本来就该在 UI 里改，不该为了改个时间点重启后端。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface UserTaskRow {
  id: string
  label: string
  /** node-cron 6 段 */
  schedule: string
  timezone?: string
  /**
   * 执行体之一：一条外部命令。与 `action` **二选一**——两个都空是一条跑不起来的任务，
   * 两个都给就没人说得清跑的是哪个。路由层拦住这两种情况。
   */
  command?: string
  args: string[]
  /**
   * 执行体之二：一个**包提供的动作**，全局名 `<包 id>:<动作名>`（见 `package-actions.ts`）。
   *
   * 它的参数**不在这里**，在 `configRef` 指的那格配置 row——那是同一条理由：值不进 argv、
   * 不进 env（`GET /api/tasks` 会把整行回显，交易密码走那条就是明文进任务列表）。
   */
  action?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** 这一条任务自己不叠着跑（存活即拒）。**不决定队列**，也不让它跟别的任务互斥。 */
  serial: boolean
  /**
   * 这条任务独占的**资源**的名字（`exclusive_on`）。同名的任务共用一个 concurrency=1 的
   * 队列，同时只跑一条；缺席 = 不跟任何人互斥。判定与命名规则见 `stream-cron` skill 第 1 步。
   */
  exclusiveOn?: string
  /**
   * 轮不上的时候：`'queue'`（默认，排着）还是 `'skip'`（这一班不跑并留痕）。
   * 判据是"迟到之后还算不算同一件事"，不是这条任务重不重要。
   */
  whenBusy?: 'queue' | 'skip'
  maxAttempts: number
  /**
   * 这条任务用的账号/密钥存在哪一格 —— 配置 row 引擎的 ref（`/api/config/source:<ref>`）。
   *
   * **它只回答"去哪儿填"，不参与执行**：值不会被塞进 argv 也不会进 env（那等于把交易密码
   * 摊在 `ps` 和任务列表里）。真正读它的是 recipe 那条路——宿主按 `secret_params` 注入。
   * 所以这一格是**导航**：编辑这条任务时就地把那份表单画出来，别让人去别的页面找。
   *
   * 和刚摘掉的 `effect` 的区别：那个字段没有任何消费方，写错不报错也没人在意；这个有一个
   * 明确的消费方（编辑器渲染 `source:<ref>` 那一行），写错的表现是当场画不出表单——看得见。
   */
  configRef?: string
  /**
   * 归属分组，**只影响任务页怎么摆**：同一组的任务在列表里收在一个小标题下。
   *
   * **不参与调度、依赖、并发或路由**——别给它执行语义。它存在的理由是任务被拆细了：
   * 一个数据源一条任务（各自的更新时间不同，共用一个 cron 就没有新鲜度可言），拆完列表
   * 变长，而"这几条其实是同一个市场的"这件事在界面上看不出来。分组把它说出来。
   *
   * 列名是 `group_name` 不是 `group`：`group` 是 SQL 关键字。
   */
  group?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type UserTaskInput = Omit<UserTaskRow, 'createdAt' | 'updatedAt'>

interface RawRow {
  id: string; label: string; schedule: string; timezone: string | null
  command: string; action: string | null; args: string; cwd: string | null; env: string | null
  timeout_ms: number | null; serial: number; max_attempts: number
  exclusive_on: string | null; when_busy: string | null
  config_ref: string | null; group_name: string | null
  enabled: number; created_at: number; updated_at: number
}

function hydrate(r: RawRow): UserTaskRow {
  return {
    id: r.id, label: r.label, schedule: r.schedule,
    ...(r.timezone === null ? {} : { timezone: r.timezone }),
    // 空串 = 没有这个执行体（建表时 command 是 NOT NULL，动作型的行写空串占位）。
    ...(r.command === '' ? {} : { command: r.command }),
    ...(r.action === null || r.action === '' ? {} : { action: r.action }),
    args: JSON.parse(r.args) as string[],
    ...(r.cwd === null ? {} : { cwd: r.cwd }),
    ...(r.env === null ? {} : { env: JSON.parse(r.env) as Record<string, string> }),
    ...(r.timeout_ms === null ? {} : { timeoutMs: r.timeout_ms }),
    serial: r.serial === 1,
    // 空串和 NULL 一样按"不互斥"处理（路由层已把空串归一化掉，这里再兜一层）。
    ...(r.exclusive_on === null || r.exclusive_on === '' ? {} : { exclusiveOn: r.exclusive_on }),
    // 只认这两个词。手改过库的行写了别的字（或者 NULL）一律当默认的 `queue`——**不猜**：
    // 猜成 skip 的后果是一条任务安静地不跑，那正是这一格要防的事。
    ...(r.when_busy === 'skip' || r.when_busy === 'queue' ? { whenBusy: r.when_busy } : {}),
    maxAttempts: r.max_attempts,
    ...(r.config_ref === null ? {} : { configRef: r.config_ref }),
    // 空串和 NULL 一样按"没分组"处理：老行是 NULL，而路由层已经把空串归一化掉了——
    // 这里再兜一层，免得手改过库的行在页面上顶出一个名字是空串的分组标题。
    ...(r.group_name === null || r.group_name === '' ? {} : { group: r.group_name }),
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export class TaskStore {
  private db: Database.Database
  constructor(dbPath: string, private readonly now: () => number = () => Date.now()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT,
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        env TEXT,
        timeout_ms INTEGER,
        serial INTEGER NOT NULL DEFAULT 1,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        exclusive_on TEXT,
        when_busy TEXT,
        config_ref TEXT,
        group_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    this.dropEffectColumn()
    this.addConfigRefColumn()
    this.addActionColumn()
    this.addGroupColumn()
    this.addExclusivityColumns()
  }

  /**
   * `exclusive_on` / `when_busy` 是后加的两列。加可空列，同 `config_ref`——但**多一步回填**，
   * 而那一步是这次迁移的重点。
   *
   * `serial` 这一格从前一次做两件事：这条任务自己不叠 + 进一个全局单槽队列。现在它只做第一件，
   * 队列由 `exclusive_on` 定。所以存量的 `serial=1` 行如果这一格空着，它们会从"彼此互斥"
   * 一步掉进 concurrency 4 的公共队列——**一次没有任何人会注意到的行为放宽**（不报错、
   * 界面上没有任何变化，只是本来排队的东西开始并发）。
   *
   * 回填成一个统一的组名把原语义原样留住：它们仍然彼此互斥，只是这件事现在写在明面上、
   * 而且能被逐条改成真正的资源名。名字是 `legacy-serial` 而不是某个真资源——它说的正是
   * "这一组还没有被分过"，看见它的人就知道这条任务的互斥关系还没人认领过。
   */
  private addExclusivityColumns(): void {
    const cols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'exclusive_on')) {
      this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN exclusive_on TEXT')
      // 只在**加列那一刻**回填一次：新建的库这一支根本不会走（列在建表语句里就有），
      // 所以不会有"每次开库都把用户分好的组打回原样"这回事。
      this.db.exec("UPDATE scheduled_tasks SET exclusive_on = 'legacy-serial' WHERE serial = 1")
    }
    if (!cols.some((c) => c.name === 'when_busy')) {
      this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN when_busy TEXT')
    }
  }

  /**
   * 存量库里那一列 `effect` 是 `NOT NULL` 的，而这一版不再写它——不摘掉的话下一次 upsert
   * 直接撞 NOT NULL 约束。**所以这不是"顺手清理"，是必须做的迁移。**
   *
   * 用整表重建而不是 `ALTER TABLE DROP COLUMN`：后者要 SQLite ≥ 3.35，而这条路本来就要走
   * （上一版加档位时也是重建），代价一样、兼容面更宽。`INSERT ... SELECT` 逐列点名，
   * 不写 `SELECT *`——列数已经对不上了。
   */
  /**
   * `config_ref` 是后加的一列。这里用 `ALTER TABLE ADD COLUMN` 而不是像上面那样整表重建：
   * **加一列可空列**是 SQLite 从很早就支持的原地操作，没有约束要改，重建纯属浪费——
   * 上面那次重建是被 `NOT NULL` 逼的，不是范式。
   *
   * 判据读 `PRAGMA table_info`，不读建表 SQL 字符串：这一列刚好叫 `config_ref`，而上面那条
   * 判据用的 `sql.includes('effect')` 是子串匹配——两条判据挨在一起，用列名精确匹配免得
   * 以后加一个名字里含 `config_ref` 的列时互相误伤。
   */
  private addConfigRefColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'config_ref')) return
    this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN config_ref TEXT')
  }

  /** `action` 是后加的一列（执行体之二：包提供的动作）。加可空列，同 `config_ref`。 */
  private addActionColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'action')) return
    this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN action TEXT')
  }

  /** `group_name` 是后加的一列（纯展示用的归属分组）。加可空列，同 `config_ref`。
   *  **列名不叫 `group`**：那是 SQL 关键字，不加引号写不进 SQL 语句。 */
  private addGroupColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'group_name')) return
    this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN group_name TEXT')
  }

  private dropEffectColumn(): void {
    const sql = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
    ).get() as { sql: string } | undefined)?.sql
    if (!sql || !sql.includes('effect')) return
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        CREATE TABLE scheduled_tasks_new (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          schedule TEXT NOT NULL,
          timezone TEXT,
          command TEXT NOT NULL,
          args TEXT NOT NULL DEFAULT '[]',
          cwd TEXT,
          env TEXT,
          timeout_ms INTEGER,
          serial INTEGER NOT NULL DEFAULT 1,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO scheduled_tasks_new
          (id, label, schedule, timezone, command, args, cwd, env, timeout_ms,
           serial, max_attempts, enabled, created_at, updated_at)
        SELECT id, label, schedule, timezone, command, args, cwd, env, timeout_ms,
               serial, max_attempts, enabled, created_at, updated_at FROM scheduled_tasks;
        DROP TABLE scheduled_tasks;
        ALTER TABLE scheduled_tasks_new RENAME TO scheduled_tasks;
      `)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  list(): UserTaskRow[] {
    return (this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all() as RawRow[]).map(hydrate)
  }

  get(id: string): UserTaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as RawRow | undefined
    return r ? hydrate(r) : undefined
  }

  upsert(input: UserTaskInput): UserTaskRow {
    const t = this.now()
    // createdAt 用 excluded 之外的旧值保住——UI 上"这条建于何时"不该被一次改排期抹掉。
    this.db.prepare(`
      INSERT INTO scheduled_tasks
        (id, label, schedule, timezone, command, action, args, cwd, env, timeout_ms, serial, max_attempts, exclusive_on, when_busy, config_ref, group_name, enabled, created_at, updated_at)
      VALUES (@id, @label, @schedule, @timezone, @command, @action, @args, @cwd, @env, @timeout_ms, @serial, @max_attempts, @exclusive_on, @when_busy, @config_ref, @group_name, @enabled, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, schedule=excluded.schedule, timezone=excluded.timezone,
        command=excluded.command, action=excluded.action, args=excluded.args, cwd=excluded.cwd, env=excluded.env,
        timeout_ms=excluded.timeout_ms, serial=excluded.serial, max_attempts=excluded.max_attempts,
        exclusive_on=excluded.exclusive_on, when_busy=excluded.when_busy,
        config_ref=excluded.config_ref, group_name=excluded.group_name,
        enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run({
      id: input.id, label: input.label, schedule: input.schedule,
      timezone: input.timezone ?? null,
      command: input.command ?? '', action: input.action ?? null,
      args: JSON.stringify(input.args),
      cwd: input.cwd ?? null,
      env: input.env ? JSON.stringify(input.env) : null,
      timeout_ms: input.timeoutMs ?? null,
      serial: input.serial ? 1 : 0,
      max_attempts: input.maxAttempts,
      exclusive_on: input.exclusiveOn ?? null,
      when_busy: input.whenBusy ?? null,
      config_ref: input.configRef ?? null,
      group_name: input.group ?? null,
      enabled: input.enabled ? 1 : 0,
      now: t,
    })
    return this.get(input.id)!
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
  }

  close(): void { this.db.close() }
}
