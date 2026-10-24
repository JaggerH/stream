/**
 * 同进程双实例（openspec `embeddable-engine` 5.1–5.3、3.4 的整体兜底）。
 *
 * 两个 `createStream`、两个临时数据目录、**共用一个 `createRuntime()`**。逐条钉：
 * 订阅/条目/设置/任务/cookie/文章缓存的隔离，共享 runtime 的 worker 单例，
 * 以及数据目录锁（第二个实例拿同一目录必须失败、第一份照常）。
 *
 * 各模块内部的两内核用例散在各自文件（见 3.2–3.3 的勾选记录）；这里测的是整体。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntime } from './runtime.ts'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import type { StreamItem } from '../types.ts'
import { RunLedger } from '../tasks/run-history.ts'

const roots: string[] = []
const open: Stream[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tempRoot(tag: string, scheduler = false): ReturnType<typeof readConfig> {
  const root = mkdtempSync(join(tmpdir(), `stream-two-${tag}-`))
  roots.push(root)
  const packages = join(root, 'packages')
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  // 后台工作默认**关**：隔离类用例不需要真 sidequest 引擎；场景 3 显式开（它测的就是定时）。
  const config = { ...base, packages_dir: packages, rsshub_catalog: '', deployment: { ...base.deployment, scheduler } }
  return config
}

const item = (id: string, streamId: string): StreamItem => ({
  id, stream_id: streamId, title: `t-${id}`,
  url: `https://example.com/${id}`,
  published: '2026-10-24T00:00:00Z', fetched_at: '2026-10-24T00:00:00Z',
} as unknown as StreamItem)

it('A 订阅并采到条目 → B 的订阅列表、条目查询、tools.call(stream_list) 都看不到', async () => {
  const shared = createRuntime()
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-a-')), config: tempRoot('a'), runtime: shared, log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-b-')), config: tempRoot('b'), runtime: shared, log: () => {} })
  open.push(b)

  // A：一条订阅流 + 一条采集到的条目
  a.kernel.stores.channels.putStream({ id: 's_a', label: 'A 的流', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
  a.kernel.stores.channels.putChannel({ id: 'c_a', label: 'A 的频道', present: 'timeline', stream_ids: ['s_a'], options: {} })
  a.kernel.stores.itemStore.add(item('i1', 's_a'), 'post')

  // A 自己看得见
  expect(a.kernel.stores.channels.listChannels().map((c) => c.id)).toContain('c_a')
  expect(a.kernel.stores.itemStore.recent({ stream: 's_a' }).map((x) => x.id)).toContain('i1')
  // B 全都看不到
  expect(b.kernel.stores.channels.listChannels().map((c) => c.id)).not.toContain('c_a')
  expect(b.kernel.stores.itemStore.recent({ stream: 's_a' })).toEqual([])
  const listed = await b.tools.call('stream_list', {})
  const names = JSON.stringify(listed)
  expect(names).not.toContain('A 的流')
})

it('A 改设置（settings.json 的一项）→ B 不变', async () => {
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-sa-')), config: tempRoot('a'), log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-sb-')), config: tempRoot('b'), log: () => {} })
  open.push(b)

  await a.kernel.settings.rows.put('video-sources', { tmdbApiKey: 'a-key', language: 'zh-CN' })
  expect(a.kernel.settings.rows.resolve('video-sources').tmdbApiKey).toBe('a-key')
  expect(b.kernel.settings.rows.resolve('video-sources').tmdbApiKey).toBeUndefined()
})

it('A、B 各加一条定时任务（秒级 cron）→ 关 A → B 的照样触发，A 的账本不再被写', async () => {
  // scheduler=true：任务中心随 createStream 起（design D1 附注）——两个实例都这样起、互不冲突
  // 本身就是这条用例的一部分。任务跑在实例装配的 deps 上，能**成功**跑（不是记 failed）。
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-ta-')), config: tempRoot('a', true), log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-tb-')), config: tempRoot('b', true), log: () => {} })
  open.push(b)
  expect(a.tasks.depsBound()).toBe(true)
  expect(b.tasks.depsBound()).toBe(true)

  const task = (id: string) => ({
    id, label: id, schedule: '* * * * * *', // 6 段含秒：每秒一班
    serial: false, whenBusy: 'skip' as const, maxAttempts: 1, enabled: true,
    run: async () => ({ summary: 'tick' }),
  })
  await a.tasks.addTask(task('two.a'))
  await b.tasks.addTask(task('two.b'))

  const aLedger = new RunLedger(join(a.stateDir, 'sidequest.sqlite'))
  const bLedger = new RunLedger(join(b.stateDir, 'sidequest.sqlite'))
  // 两个账本都开始记，而且任务**跑成**（completed）——deps 是实例装配的那份，不是空。
  await new Promise((r) => setTimeout(r, 2500))
  expect(aLedger.runs('two.a').some((r) => r.state === 'completed')).toBe(true)
  expect(bLedger.runs('two.b').some((r) => r.state === 'completed')).toBe(true)

  await a.close()
  const aFrozen = aLedger.runs('two.a').length
  const bBefore = bLedger.runs('two.b').length
  await new Promise((r) => setTimeout(r, 2500))
  // 关 A 之后 B 的运行次数**增长**（不是只断言「没报错」——bBefore 在关 A 之前就 > 0，
  // 单独断言它等于什么都没验），A 的账本冻结。
  expect(bLedger.runs('two.b').length).toBeGreaterThan(bBefore)
  await new Promise((r) => setTimeout(r, 1200))
  expect(aLedger.runs('two.a').length).toBe(aFrozen)
})

it('A 写一条 cookie 快照 → B 读不到', async () => {
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-ca-')), config: tempRoot('a'), log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-cb-')), config: tempRoot('b'), log: () => {} })
  open.push(b)

  a.kernel.credentials.pushedCookies.replace({ 'site.example': [{ name: 'sid', value: 'a-secret', domain: 'site.example', path: '/', httpOnly: false, secure: true }] })
  const aDomains = await a.kernel.credentials.cookieProvider.availableDomains()
  const bDomains = await b.kernel.credentials.cookieProvider.availableDomains()
  expect(aDomains).toContain('site.example')
  expect(bDomains).not.toContain('site.example')
})

it('A、B 各写一条文章缓存 → 各取到自己的（内存回退层互不可见）', async () => {
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-ra-')), config: tempRoot('a'), log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-rb-')), config: tempRoot('b'), log: () => {} })
  open.push(b)

  // 文章缓存的取数腿是网络；这里不出网，直接断言两实例拿到的是**不同的** ArticleCache 实例，
  // 且各自 wire 到各自 contentCache（不同数据目录的 cache.db）。
  expect(a.kernel.stores.articles).not.toBe(b.kernel.stores.articles)
  expect(a.kernel.stores.favicons).not.toBe(b.kernel.stores.favicons)
  // 条目层同样按实例隔离（5.1 的存储面在场景 1 已逐格钉过）。
  a.kernel.stores.itemStore.add(item('ra-1', 's_ra'), 'post')
  expect(b.kernel.stores.itemStore.recent({ stream: 's_ra' })).toEqual([])
})

it('共用 runtime 时 worker 是同一份对象，关 A 不影响 B', async () => {
  const shared = createRuntime()
  const a = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-wa-')), config: tempRoot('a'), runtime: shared, log: () => {} })
  open.push(a)
  const b = await createStream({ dataDir: mkdtempSync(join(tmpdir(), 'two-wb-')), config: tempRoot('b'), runtime: shared, log: () => {} })
  open.push(b)

  // RSSHub worker 是进程里唯一一份（懒起）：两个实例的 adapter 共用 runtime 持有的同一个对象。
  expect(a.runtime).toBe(b.runtime)
  expect(b.runtime.rsshub).toBe(a.runtime.rsshub)
  await a.close()
  // A 关了，runtime 的 worker 还在（只有创建 runtime 的一方关它）
  expect(shared.rsshub).toBeDefined()
})

it('第二个 createStream 用 A 的数据目录 → 抛错，A 照常', async () => {
  const config = tempRoot('lock')
  const a = await createStream({ dataDir: join(config.packages_dir, '..'), config, log: () => {} })
  open.push(a)
  let secondError: unknown
  try {
    // 同一份 config ⇒ 同一个 stateDir ⇒ 同一把数据目录锁
    await createStream({ dataDir: join(config.packages_dir, '..'), config, log: () => {} })
  } catch (e) { secondError = e }
  // pretty-format 会对 cordis Context 上的惰性服务炸出 inject 错误，所以手工断言消息而不是 .rejects
  expect((secondError as Error)?.message).toContain('已被本进程里的另一个 Stream 实例占用')
  // A 照常：设置读写不炸
  await a.kernel.settings.rows.put('video-sources', { tmdbApiKey: 'still-alive' })
  expect(a.kernel.settings.rows.resolve('video-sources').tmdbApiKey).toBe('still-alive')
})
