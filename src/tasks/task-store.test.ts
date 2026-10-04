import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, type UserTaskInput } from './task-store.ts'

function freshStore(): TaskStore {
  return new TaskStore(join(mkdtempSync(join(tmpdir(), 'task-store-')), 'stream.db'))
}

const sample: UserTaskInput = {
  id: 'dfcf-subscribe-jagger',
  label: '工作日 09:45 新股新债申购',
  schedule: '0 45 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  command: '/opt/qlib/bin/python',
  args: ['-m', 'ashare_automation.tasks.dfcf_subscribe', '--alias', 'jagger'],
  cwd: '/workspace/Cockpit',
  env: { PYTHONPATH: '.' },
  timeoutMs: 600_000,
  serial: true,
  maxAttempts: 1,
  enabled: true,
}

describe('TaskStore', () => {
  it('新库是空的', () => {
    expect(freshStore().list()).toEqual([])
  })

  it('upsert 后读得回来，数组/对象字段往返不变形', () => {
    const s = freshStore()
    s.upsert(sample)
    const got = s.get('dfcf-subscribe-jagger')!
    expect(got.args).toEqual(['-m', 'ashare_automation.tasks.dfcf_subscribe', '--alias', 'jagger'])
    expect(got.env).toEqual({ PYTHONPATH: '.' })
    expect(got.serial).toBe(true)
    expect(got.enabled).toBe(true)
    expect(got.createdAt).toBeGreaterThan(0)
  })

  it('同 id 再 upsert 是改不是插，createdAt 保持不变、updatedAt 前进', () => {
    let clock = 1000
    const s = new TaskStore(join(mkdtempSync(join(tmpdir(), 'task-store-')), 'stream.db'), () => clock)
    const a = s.upsert(sample)
    clock = 2000 // advance clock between upserts
    const b = s.upsert({ ...sample, schedule: '0 50 9 * * 1-5' })
    expect(s.list()).toHaveLength(1)
    expect(b.schedule).toBe('0 50 9 * * 1-5')
    expect(b.createdAt).toBe(a.createdAt)
    expect(b.createdAt).toBe(1000)
    expect(b.updatedAt).toBe(2000)
    expect(b.updatedAt).toBeGreaterThan(a.createdAt)
  })

  it('remove 删得掉，删不存在的返回 false', () => {
    const s = freshStore()
    s.upsert(sample)
    expect(s.remove('dfcf-subscribe-jagger')).toBe(true)
    expect(s.remove('dfcf-subscribe-jagger')).toBe(false)
    expect(s.list()).toEqual([])
  })

  it('可选字段缺省时不写成字符串 "undefined"', () => {
    const s = freshStore()
    const { timezone: _tz, cwd: _cwd, env: _env, timeoutMs: _t, ...bare } = sample
    s.upsert({ ...bare, id: 'bare' })
    const got = s.get('bare')!
    expect(got.timezone).toBeUndefined()
    expect(got.cwd).toBeUndefined()
    expect(got.env).toBeUndefined()
    expect(got.timeoutMs).toBeUndefined()
  })

  // 存量库里 `effect` 是 NOT NULL 的，而这一版不再写它——不摘掉这一列，第一次 upsert 就撞
  // NOT NULL 约束。所以这条测的不是"清理干净了"，是**存量库还能不能用**。
  it('旧库（带 effect 列）会整表重建：已有行不丢，之后照常写得进去', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT,
        command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, env TEXT,
        timeout_ms INTEGER, serial INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
        effect TEXT NOT NULL CHECK (effect IN ('read-only','writes-files','writes-db','external')),
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO scheduled_tasks VALUES
        ('old','旧任务','0 0 1 * * *',NULL,'/bin/true','[]',NULL,NULL,NULL,1,1,'external',1,111,111);
    `)
    raw.close()

    const s = new TaskStore(path)
    expect(s.list().map((t) => t.id)).toEqual(['old'])
    expect(s.get('old')!.createdAt).toBe(111)
    expect(s.get('old')!.label).toBe('旧任务')
    expect(s.upsert({ ...sample, id: 'repo' }).id).toBe('repo')
    expect(Object.keys(s.get('repo')!)).not.toContain('effect')
  })

  it('group 往返不变形，且不填时不留下一个空串分组', () => {
    const s = freshStore()
    s.upsert({ ...sample, id: 'grouped', group: '宏观' })
    expect(s.get('grouped')!.group).toBe('宏观')
    s.upsert({ ...sample, id: 'loose' })
    expect(s.get('loose')!.group).toBeUndefined()
    // 改一次也得改得掉——分组是纯展示的一格，改它不该比改别的字段难。
    s.upsert({ ...sample, id: 'grouped', group: '农产品' })
    expect(s.get('grouped')!.group).toBe('农产品')
  })

  // 手改过库、或别的路径写进来的空串：hydrate 得把它当"没分组"，否则任务页上会顶出一个
  // 没有名字的分组小标题——那比没分组更难看懂。
  it('库里存着空串分组的行读出来是"没分组"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const s = new TaskStore(path)
    s.upsert({ ...sample, id: 'blank' })
    s.close()
    const raw = new Database(path)
    raw.exec("UPDATE scheduled_tasks SET group_name = '' WHERE id = 'blank'")
    raw.close()
    expect(new TaskStore(path).get('blank')!.group).toBeUndefined()
  })

  // 存量库没有 group_name 这一列。**不重建表**（加可空列是原地操作，理由见 addGroupColumn），
  // 所以这条测的是：老行还在、读得出来且 group 为空，而且新的写照样进得去。
  it('旧库（没有 group_name 列）平滑升级：老行不丢、group 为空、之后写得进新分组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT,
        command TEXT NOT NULL, action TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, env TEXT,
        timeout_ms INTEGER, serial INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
        config_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO scheduled_tasks
        (id, label, schedule, command, args, serial, max_attempts, enabled, created_at, updated_at)
      VALUES ('old','旧任务','0 0 1 * * *','/bin/true','[]',1,1,1,111,111);
    `)
    const before = raw.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    expect(before.map((c) => c.name)).not.toContain('group_name')
    raw.close()

    const s = new TaskStore(path)
    expect(s.list().map((t) => t.id)).toEqual(['old'])
    // 老行原地保住：不重建表的证据是 createdAt 还是原来那个，而不是被 upsert 重写过。
    expect(s.get('old')!.createdAt).toBe(111)
    expect(s.get('old')!.group).toBeUndefined()
    expect(s.upsert({ ...sample, id: 'new', group: '生猪' }).group).toBe('生猪')
    expect(s.get('old')!.label).toBe('旧任务')
  })

  it('互斥那两格往返不变形，不填时不留下空串组名 / 不猜迟到语义', () => {
    const s = freshStore()
    s.upsert({ ...sample, id: 'x', exclusiveOn: 'jq-bridge', whenBusy: 'skip' })
    expect(s.get('x')!.exclusiveOn).toBe('jq-bridge')
    expect(s.get('x')!.whenBusy).toBe('skip')
    s.upsert({ ...sample, id: 'bare' })
    expect(s.get('bare')!.exclusiveOn).toBeUndefined()
    expect(s.get('bare')!.whenBusy).toBeUndefined()
    // 改得掉：把一条从 skip 改回排队，也要真的改回去
    s.upsert({ ...sample, id: 'x', exclusiveOn: 'jq-bridge', whenBusy: 'queue' })
    expect(s.get('x')!.whenBusy).toBe('queue')
  })

  it('库里 when_busy 存着别的字（手改过库）读出来是"没设"，不猜成 skip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const s = new TaskStore(path)
    s.upsert({ ...sample, id: 'weird' })
    s.close()
    const raw = new Database(path)
    raw.exec("UPDATE scheduled_tasks SET when_busy = 'SKIP', exclusive_on = '' WHERE id = 'weird'")
    raw.close()
    const got = new TaskStore(path).get('weird')!
    expect(got.whenBusy).toBeUndefined()
    expect(got.exclusiveOn).toBeUndefined()
  })

  /**
   * 这条守的是本次改动里唯一一次**静默行为放宽**的可能：`serial` 从前捎带把任务放进一个全局
   * 单槽队列，现在只管"这条不叠着自己跑"。存量的 serial 行如果 `exclusive_on` 空着，它们会
   * 一步从"彼此互斥"掉进 concurrency 4 的公共队列，而且没有任何一处会报。
   */
  it('旧库升级：存量 serial 行的 exclusive_on 被回填，老行其余字段和 createdAt 原样在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT,
        command TEXT NOT NULL, action TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, env TEXT,
        timeout_ms INTEGER, serial INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
        config_ref TEXT, group_name TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO scheduled_tasks
        (id, label, schedule, command, args, cwd, serial, max_attempts, group_name, enabled, created_at, updated_at)
      VALUES
        ('ser','串行的旧任务','0 0 1 * * *','/bin/true','["--x"]','/tmp',1,2,'宏观',1,111,111),
        ('par','不串行的旧任务','0 0 2 * * *','/bin/true','[]',NULL,0,1,NULL,1,222,222);
    `)
    raw.close()

    const s = new TaskStore(path)
    // serial 行被回填成统一的组名——原来的"彼此互斥"原样留住，且它说得出自己还没被分过组
    const ser = s.get('ser')!
    expect(ser.exclusiveOn).toBe('legacy-serial')
    expect(ser.whenBusy).toBeUndefined() // 迟到语义保持默认（排着），和从前一样
    // 老行其余字段一个都没丢，createdAt 原样在 = 没重建表、没被 upsert 重写过
    expect(ser.createdAt).toBe(111)
    expect(ser.label).toBe('串行的旧任务')
    expect(ser.args).toEqual(['--x'])
    expect(ser.cwd).toBe('/tmp')
    expect(ser.group).toBe('宏观')
    expect(ser.maxAttempts).toBe(2)
    // 本来就不串行的行不该被塞进任何互斥组：它从前就是并发的
    expect(s.get('par')!.exclusiveOn).toBeUndefined()
    expect(s.get('par')!.createdAt).toBe(222)
  })

  it('回填只在加列那一刻发生：重开库不会把用户分好的组打回 legacy-serial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT,
        command TEXT NOT NULL, action TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, env TEXT,
        timeout_ms INTEGER, serial INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 1,
        config_ref TEXT, group_name TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO scheduled_tasks
        (id, label, schedule, command, args, serial, max_attempts, enabled, created_at, updated_at)
      VALUES ('ser','串行的旧任务','0 0 1 * * *','/bin/true','[]',1,1,1,111,111);
    `)
    raw.close()

    const a = new TaskStore(path)
    // 用户按真资源重新分组
    a.upsert({ ...a.get('ser')!, exclusiveOn: 'jq-bridge' })
    a.close()
    expect(new TaskStore(path).get('ser')!.exclusiveOn).toBe('jq-bridge')
  })

  it('重开同一个库文件读得到之前写的（建表是 IF NOT EXISTS）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
    const path = join(dir, 'stream.db')
    const a = new TaskStore(path)
    a.upsert(sample)
    a.close()
    expect(new TaskStore(path).list()).toHaveLength(1)
  })
})
