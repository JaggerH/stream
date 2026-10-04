import { describe, expect, it, vi } from 'vitest'
import {
  classifyPluginTargetMiss,
  pluginTargetMissEntry,
  makePluginTargetMissReporter,
  MissThrottle,
  pluginTargetNotifiableDefect,
  pluginTargetMissNotification,
  pluginTargetMissDetail,
  type PluginTargetMissFacts,
} from './target-miss.ts'
import type { DebugEntry } from '../debug.ts'
import type { EventInput } from '../events/store.ts'
import type { StandbyDiagnosis } from './standby/manager.ts'

const diag = (over: Partial<StandbyDiagnosis> = {}): StandbyDiagnosis => ({
  service: 'douyin-tiktok-download-api',
  managed: true,
  state: 'awake',
  cachedOrigin: 'http://127.0.0.1:44824',
  container: 'running',
  containerId: 'abc123',
  hostPort: 44824,
  ...over,
})

describe('classifyPluginTargetMiss', () => {
  it('钩子没接 → resolver-unbound（先于任何档位判断）', () => {
    const f = classifyPluginTargetMiss({ service: 'x', mode: 'host', resolverBound: false, backendDeclared: true, standby: diag() })
    expect(f.reason).toBe('resolver-unbound')
  })

  it('mode=none（桌面无门）→ net-mode-none', () => {
    const f = classifyPluginTargetMiss({ service: 'x', mode: 'none', resolverBound: true, backendDeclared: false, standby: null })
    expect(f.reason).toBe('net-mode-none')
  })

  it('compose 档、名册里没有它 → no-backend-declared', () => {
    const f = classifyPluginTargetMiss({ service: 'x', mode: 'compose', resolverBound: true, backendDeclared: false, standby: null })
    expect(f.reason).toBe('no-backend-declared')
  })

  it('compose 档、名册里有它却仍答空 → compose-target-unresolved（兜底）', () => {
    const f = classifyPluginTargetMiss({ service: 'x', mode: 'compose', resolverBound: true, backendDeclared: true, standby: null })
    expect(f.reason).toBe('compose-target-unresolved')
  })

  it('host 档、standby 没接线 → standby-unbound', () => {
    const f = classifyPluginTargetMiss({ service: 'x', mode: 'host', resolverBound: true, backendDeclared: true, standby: null })
    expect(f.reason).toBe('standby-unbound')
  })

  it('host 档、名册里没有这个 service → not-managed', () => {
    const f = classifyPluginTargetMiss({
      service: 'x', mode: 'host', resolverBound: true, backendDeclared: true,
      standby: diag({ managed: false, state: null, cachedOrigin: null }),
    })
    expect(f.reason).toBe('not-managed')
  })

  it('host 档、cell 睡着 → not-awake', () => {
    const f = classifyPluginTargetMiss({
      service: 'x', mode: 'host', resolverBound: true, backendDeclared: true,
      standby: diag({ state: 'asleep', cachedOrigin: null }),
    })
    expect(f.reason).toBe('not-awake')
  })

  it('host 档、报 awake 却没有 origin → awake-without-origin（哑状态）', () => {
    const f = classifyPluginTargetMiss({
      service: 'x', mode: 'host', resolverBound: true, backendDeclared: true,
      standby: diag({ state: 'awake', cachedOrigin: null }),
    })
    expect(f.reason).toBe('awake-without-origin')
  })

  it('facts 原样带着 standby 现场（缓存的口 + Docker 现场的口）', () => {
    const f = classifyPluginTargetMiss({
      service: 'douyin-tiktok-download-api', mode: 'host', resolverBound: true, backendDeclared: true,
      standby: diag({ state: 'asleep', cachedOrigin: null, hostPort: 46192 }),
    })
    expect(f.standby?.hostPort).toBe(46192)
    expect(f.standby?.cachedOrigin).toBeNull()
    expect(f.standby?.container).toBe('running')
  })
})

describe('pluginTargetMissEntry', () => {
  const facts = (over: Partial<PluginTargetMissFacts> = {}): PluginTargetMissFacts => ({
    service: 'douyin-tiktok-download-api',
    reason: 'not-awake',
    mode: 'host',
    resolverBound: true,
    backendDeclared: true,
    standby: diag({ state: 'asleep', cachedOrigin: null, hostPort: 46192 }),
    suppressed: 0,
    ...over,
  })

  it('channel/key/id 稳定,ok=false', () => {
    const e = pluginTargetMissEntry(facts(), 1700)
    expect(e.channel).toBe('plugin-target')
    expect(e.key).toBe('douyin-tiktok-download-api')
    expect(e.id).toBe('plugin-target:douyin-tiktok-download-api@1700')
    expect(e.at).toBe(1700)
    expect(e.ok).toBe(false)
  })

  it('净是「按设计如此」的两条 → ok=true(不是故障)', () => {
    expect(pluginTargetMissEntry(facts({ reason: 'net-mode-none', standby: null }), 1).ok).toBe(true)
    expect(pluginTargetMissEntry(facts({ reason: 'resolver-unbound', standby: null }), 1).ok).toBe(true)
  })

  it('三个必答的问题各占一行:容器在不在 / standby 认为什么状态 / inspect 出来的口', () => {
    const e = pluginTargetMissEntry(facts(), 1700)
    const byLabel = Object.fromEntries(e.fields.map((f) => [f.label, f.value]))
    expect(byLabel['容器']).toBe('running (abc123)')
    expect(byLabel['standby 状态']).toBe('asleep')
    expect(byLabel['inspect 宿主口']).toBe('46192')
    expect(byLabel['缓存 origin']).toBe('(无)')
    expect(byLabel['reason']).toBe('not-awake')
    expect(byLabel['net 档']).toBe('host')
  })

  it('standby 没接线时不摆 standby 那几行,但仍说明为什么没有', () => {
    const e = pluginTargetMissEntry(facts({ reason: 'standby-unbound', standby: null }), 1)
    const labels = e.fields.map((f) => f.label)
    expect(labels).not.toContain('容器')
    expect(labels).toContain('standby')
  })

  it('note 与 suppressed 有值才出现', () => {
    const none = pluginTargetMissEntry(facts(), 1).fields.map((f) => f.label)
    expect(none).not.toContain('note')
    expect(none).not.toContain('本窗口另有')
    const some = pluginTargetMissEntry(
      facts({ suppressed: 5, standby: diag({ note: 'docker: Error: boom' }) }),
      1,
    ).fields.map((f) => f.label)
    expect(some).toContain('note')
    expect(some).toContain('本窗口另有')
  })
})

describe('MissThrottle', () => {
  it('冷却窗口内只放第一条,压掉的次数攒进下一条', () => {
    const t = new MissThrottle(60_000)
    expect(t.admit('douyin', 0)).toEqual({ ok: true, suppressed: 0 })
    expect(t.admit('douyin', 1_000)).toEqual({ ok: false, suppressed: 0 })
    expect(t.admit('douyin', 2_000)).toEqual({ ok: false, suppressed: 0 })
    // 窗口过了:放行,并把中间压掉的 2 次带出来
    expect(t.admit('douyin', 61_000)).toEqual({ ok: true, suppressed: 2 })
    // 带出来之后清零
    expect(t.admit('douyin', 200_000)).toEqual({ ok: true, suppressed: 0 })
  })

  it('按 service 各自计时,互不影响', () => {
    const t = new MissThrottle(60_000)
    expect(t.admit('a', 0).ok).toBe(true)
    expect(t.admit('b', 0).ok).toBe(true)
    expect(t.admit('a', 10).ok).toBe(false)
    expect(t.admit('b', 10).ok).toBe(false)
  })
})

// 报告器本身（packages.ts 绑给 setPluginTargetMissReporter 的那个）。抽出来是为了让「接线」这一端
// 也有测试 —— 内联在 cordis 插件里的闭包谁也够不到，而它恰恰是唯一会在生产里跑的那份。
describe('makePluginTargetMissReporter', () => {
  /** fire-and-forget 的异步尾巴跑完 —— 用来断言「到这一刻，该 emit 的已经 emit 了」。 */
  const drain = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve() }

  function harness(over: Partial<Parameters<typeof makePluginTargetMissReporter>[0]> = {}) {
    const emitted: DebugEntry[] = []
    let t = 0
    const report = makePluginTargetMissReporter({
      mode: 'host',
      resolverBound: () => true,
      backendDeclared: () => true,
      standbyDiagnose: async () => diag({ state: 'asleep', cachedOrigin: null, hostPort: 46192 }),
      emit: (e) => { emitted.push(e) },
      now: () => (t += 1000),
      ...over,
    })
    return { report, emitted }
  }

  it('答空 → emit 一条带完整现场的 entry', async () => {
    const { report, emitted } = harness()
    report('douyin-tiktok-download-api')
    await drain()
    expect(emitted).toHaveLength(1)
    expect(emitted[0].channel).toBe('plugin-target')
    expect(emitted[0].key).toBe('douyin-tiktok-download-api')
    const byLabel = Object.fromEntries(emitted[0].fields.map((f) => [f.label, f.value]))
    expect(byLabel['reason']).toBe('not-awake')
    expect(byLabel['inspect 宿主口']).toBe('46192')
  })

  it('非 host 档不去问 Docker（compose/none 下 standby 那几个数没有意义）', async () => {
    let asked = 0
    const { report, emitted } = harness({
      mode: 'compose',
      backendDeclared: () => false,
      standbyDiagnose: async () => { asked += 1; return null },
    })
    report('pansou')
    await drain()
    expect(asked).toBe(0)
    expect(emitted[0].fields.find((f) => f.label === 'reason')?.value).toBe('no-backend-declared')
  })

  it('冷却窗口内只 emit 第一条,压掉的次数出现在下一条里', async () => {
    let t = 0
    const { report, emitted } = harness({ now: () => t })
    report('x'); await drain()
    t = 1_000; report('x'); await drain()
    t = 2_000; report('x'); await drain()
    expect(emitted).toHaveLength(1)
    t = 61_000; report('x'); await drain()
    expect(emitted).toHaveLength(2)
    expect(emitted[1].fields.find((f) => f.label === '本窗口另有')?.value).toBe('2 次答空被压掉')
  })

  it('standbyDiagnose 抛 → 不 emit、也不把异常漏出去（观测不能反过来打死主链路）', async () => {
    const { report, emitted } = harness({ standbyDiagnose: async () => { throw new Error('docker gone') } })
    expect(() => report('x')).not.toThrow()
    await drain()
    expect(emitted).toEqual([])
  })

  it('emit 自己抛也吞掉', async () => {
    const { report } = harness({ emit: () => { throw new Error('bus exploded') } })
    expect(() => report('x')).not.toThrow()
    await expect(drain()).resolves.toBeUndefined()
  })

  it('真缺陷那两档才 notify —— 通知与 debug 记录是两条闸门', async () => {
    const notified: any[] = []
    const { report, emitted } = harness({ notify: (e) => notified.push(e) })
    report('douyin-tiktok-download-api')
    await drain()
    expect(emitted).toHaveLength(1) // debug bus 照记
    expect(notified).toHaveLength(1)
    expect(notified[0].dedupeKey).toBe('plugin-target:douyin-tiktok-download-api:container-never-woke')
  })

  it('「容器本来就睡着」不 notify，但 debug bus 照记 —— 生产里它在稳定产生', async () => {
    const notified: any[] = []
    const { report, emitted } = harness({
      standbyDiagnose: async () => diag({ state: 'asleep', cachedOrigin: null, container: 'stopped', hostPort: null }),
      notify: (e) => notified.push(e),
    })
    report('voiceprint')
    await drain()
    expect(emitted).toHaveLength(1)
    expect(notified).toEqual([])
  })

  it('notify 自己抛也吞掉', async () => {
    const { report } = harness({ notify: () => { throw new Error('events exploded') } })
    expect(() => report('x')).not.toThrow()
    await drain()
  })
})

// 排查的人第一眼读的是频道里那一行 summary 和 standby 那一格。有准确原因还继续说两可的话，
// 等于让下一个人重走一遍今天走过的路。
describe('未接线时的诊断现场说清「为什么」', () => {
  const facts = (over: Partial<PluginTargetMissFacts> = {}): PluginTargetMissFacts => ({
    service: 'pansou', mode: 'host', resolverBound: true, backendDeclared: true,
    standby: null, reason: 'standby-unbound', suppressed: 0, ...over,
  })

  it('够不着 Docker → summary 与 standby 那格都直说，且标红', () => {
    const e = pluginTargetMissEntry(facts({ standbyInert: 'docker-unreachable' }), 1)
    expect(e.summary).toContain('够不着 Docker')
    expect(e.summary).not.toContain('或没插件声明')   // 不再是两可的话
    const row = e.fields.find((f) => f.label === 'standby')!
    expect(row.value).toContain('够不着 Docker')
    expect(row.tone).toBe('bad')
  })

  it('按设计如此 → 说得出是哪一种，但不标红（它不是故障）', () => {
    const e = pluginTargetMissEntry(facts({ standbyInert: 'not-gated' }), 1)
    expect(e.summary).toContain('按设计如此')
    expect(e.fields.find((f) => f.label === 'standby')!.tone).toBe('warn')
  })

  it('原因此刻还不知道（取址早于接线）→ 如实说，别写得像 bug', () => {
    // 活体真的会走到：AList 在 bootstrap 接管前打的那次 /ping 早于 wireStandby。
    const e = pluginTargetMissEntry(facts({}), 1)
    const row = e.fields.find((f) => f.label === 'standby')!
    expect(row.value).toContain('此刻还不知道')
    expect(e.summary).toBe(
      'host 档：standby 没接线（没 Docker 或没插件声明 standby），随机口无从查起',
    ) // 没有准确原因时保持原样，不编造
  })
})

// 生产上只有一个构造点会填 standbyInert（字段是可选的），所以"它到底传没传下去"必须钉住：
// 漏了不报错，只是那条通知永远不发——正是这次要修的那种静默。
describe('makePluginTargetMissReporter → standbyInert', () => {
  it('standby 未接线时把 inert 原因带下去，于是 Docker 够不着能发出通知', async () => {
    const notices: EventInput[] = []
    const report = makePluginTargetMissReporter({
      mode: 'host',
      resolverBound: () => true,
      backendDeclared: () => true,
      standbyDiagnose: async () => null,
      standbyInertReason: () => 'docker-unreachable',
      emit: () => {},
      notify: (n) => void notices.push(n),
    })
    report('pansou')
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0].dedupeKey).toBe('plugin-target:docker-unreachable')
  })

  it('接线着的时候不去问 inert 原因（接上了就没有"为什么没接线"这回事）', async () => {
    let asked = 0
    const emitted: DebugEntry[] = []
    const report = makePluginTargetMissReporter({
      mode: 'host',
      resolverBound: () => true,
      backendDeclared: () => true,
      standbyDiagnose: async () => diag({ state: 'asleep', cachedOrigin: null, container: 'stopped', hostPort: null }),
      standbyInertReason: () => { asked++; return 'docker-unreachable' },
      emit: (e) => void emitted.push(e),
    })
    report('voiceprint')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(asked).toBe(0)
  })
})

// ── 通知那一格：只有真缺陷才配打扰用户 ────────────────────────────────────────
// 判据是具名函数（不是内联 if），因为它要被搜得到、钉得住：放宽一档就会有一条测试变红。
// 设计与「为什么排除其余形状」见 docs/superpowers/specs/2026-08-19-silent-failure-notifications-design.md §2。
describe('pluginTargetNotifiableDefect', () => {
  const facts = (over: Partial<PluginTargetMissFacts> = {}): PluginTargetMissFacts => ({
    service: 'voiceprint', mode: 'host', resolverBound: true, backendDeclared: true,
    standby: diag(), reason: 'not-awake', suppressed: 0, ...over,
  })

  it('容器 running 而 standby 认为睡着 → container-never-woke', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'not-awake', standby: diag({ state: 'asleep', cachedOrigin: null, container: 'running', hostPort: 46192 }),
    }))).toBe('container-never-woke')
  })

  it('容器本来就 stopped 的 not-awake → null（**正常态**，通知它就是纯骚扰）', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'not-awake', standby: diag({ state: 'asleep', cachedOrigin: null, container: 'stopped', hostPort: null }),
    }))).toBeNull()
  })

  it('缓存 origin 的口 ≠ inspect 出的口 → stale-origin', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'awake-without-origin', standby: diag({ cachedOrigin: 'http://127.0.0.1:44824', hostPort: 51999 }),
    }))).toBe('stale-origin')
  })

  it('两个口一致 → 不是缺陷', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'awake-without-origin', standby: diag({ cachedOrigin: 'http://127.0.0.1:44824', hostPort: 44824 }),
    }))).toBeNull()
  })

  it('两个口有一个取不到就不判 —— 拿不到证据不等于有缺陷', () => {
    const awake = { reason: 'awake-without-origin' } as const
    expect(pluginTargetNotifiableDefect(facts({ ...awake, standby: diag({ cachedOrigin: null, hostPort: 44824 }) }))).toBeNull()
    expect(pluginTargetNotifiableDefect(facts({ ...awake, standby: diag({ hostPort: null }) }))).toBeNull()
  })

  it('两档同时成立 → 取 container-never-woke（更靠近根因）', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'not-awake', standby: diag({ state: 'asleep', container: 'running', cachedOrigin: 'http://127.0.0.1:1', hostPort: 2 }),
    }))).toBe('container-never-woke')
  })

  it('其余 reason 一律不通知（含按设计如此的两条、以及配置层那四条）', () => {
    for (const reason of ['resolver-unbound', 'net-mode-none', 'no-backend-declared', 'compose-target-unresolved'] as const) {
      expect(pluginTargetNotifiableDefect(facts({ reason, standby: null }))).toBeNull()
    }
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'not-managed', standby: diag({ managed: false, state: null, cachedOrigin: null, hostPort: null }),
    }))).toBeNull()
  })

  // ── Docker 整个够不着 ──────────────────────────────────────────────────────
  // 影响面最大的那件事,过去在**三条路径上**都被归进了"不通知":boot 期 ping 不通划成
  // 「预期内的没有 Docker」、取址时 standby 未接线撞 `if (!s) return null`、
  // 接线了但 diagnose 问 Docker 失败拿到 container:'unknown' 又不满足另外两档的判据。
  // 后果:所有带容器的插件一起失效,而没有任何一处会喊(2026-09-02 活体,整整一天)。
  it('standby 未接线且原因是 Docker 够不着 → docker-unreachable', () => {
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'standby-unbound', standby: null, standbyInert: 'docker-unreachable',
    }))).toBe('docker-unreachable')
  })

  it('standby 未接线但按设计如此（没插件声明 / 桌面档没门）→ 不通知', () => {
    // 这两条要是也喊,一台没装 Docker 的机器每次取址都被告知"Docker 挂了",
    // 等于训练用户忽略这个通知——比不喊更坏。
    for (const inert of ['not-gated', 'no-resolvable-services'] as const) {
      expect(pluginTargetNotifiableDefect(facts({
        reason: 'standby-unbound', standby: null, standbyInert: inert,
      }))).toBeNull()
    }
    // 原因根本没传下来(旧调用点/单测)→ 保持沉默,别拿"不知道"当"出事了"。
    expect(pluginTargetNotifiableDefect(facts({ reason: 'standby-unbound', standby: null }))).toBeNull()
  })

  it('接线了、但 diagnose 问 Docker 失败（container=unknown）→ 同一个 docker-unreachable', () => {
    // 这一格覆盖的是**后端跑着、Docker 半路挂**——比 boot 期就没有 Docker 更常见。
    // `unknown` 只在 manager.diagnose 的 catch 里产生,判据干净,不用去解析 note 的文本。
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'not-awake',
      standby: diag({ state: 'asleep', cachedOrigin: null, container: 'unknown', containerId: null, hostPort: null, note: 'docker: Error: connect ENOENT /var/run/docker.sock' }),
    }))).toBe('docker-unreachable')
  })

  it('Docker 够不着优先于其余两档 —— 它离根因更近', () => {
    // 容器状态都问不到的时候,"容器 running 却没被唤醒"这类结论根本无从谈起。
    expect(pluginTargetNotifiableDefect(facts({
      reason: 'awake-without-origin',
      standby: diag({ container: 'unknown', cachedOrigin: 'http://127.0.0.1:44824', hostPort: null }),
    }))).toBe('docker-unreachable')
  })
})

describe('pluginTargetMissNotification', () => {
  const facts = (over: Partial<PluginTargetMissFacts> = {}): PluginTargetMissFacts => ({
    service: 'voiceprint', mode: 'host', resolverBound: true, backendDeclared: true,
    standby: diag(), reason: 'not-awake', suppressed: 0, ...over,
  })

  it('没缺陷 → null（不发）', () => {
    expect(pluginTargetMissNotification(facts({
      reason: 'not-awake', standby: diag({ state: 'asleep', cachedOrigin: null, container: 'stopped', hostPort: null }),
    }))).toBeNull()
  })

  it('never-woke：正文说人话，不出现 reason 枚举名/字段名', () => {
    const n = pluginTargetMissNotification(facts({
      reason: 'not-awake', standby: diag({ state: 'asleep', cachedOrigin: null, container: 'running', hostPort: 46192 }),
    }))!
    expect(n.type).toBe('plugin.target-miss')
    expect(n.severity).toBe('error')
    expect(n.title).toBe('插件后端没被唤醒：voiceprint')
    expect(n.body).toMatch(/容器明明在运行/)
    expect(n.body).toMatch(/plugin-target 频道/)
    expect(n.dedupeKey).toBe('plugin-target:voiceprint:container-never-woke')
    // 术语不许出现在用户读的那几行
    expect(`${n.title}${n.body}`).not.toMatch(/not-awake|standby|cachedOrigin|hostPort|reason/)
  })

  // Docker 够不着是**全局事实**,不属于任何一个插件:8 个带容器的插件挨个取址一次,
  // 按 service 去重就是 8 条一模一样的"Docker 挂了"。所以这一条的 key 里没有 service。
  it('docker-unreachable：一条全局通知，key 不含 service（否则每个插件刷一条）', () => {
    const a = pluginTargetMissNotification(facts({
      service: 'pansou', reason: 'standby-unbound', standby: null, standbyInert: 'docker-unreachable',
    }))!
    const b = pluginTargetMissNotification(facts({
      service: 'alist', reason: 'standby-unbound', standby: null, standbyInert: 'docker-unreachable',
    }))!
    expect(a.dedupeKey).toBe('plugin-target:docker-unreachable')
    expect(b.dedupeKey).toBe(a.dedupeKey)
    expect(a.severity).toBe('error')
    expect(a.title).not.toContain('pansou')   // 标题说的是这台机器,不是某个插件
    // 正文要答的是「什么坏了 / 现在什么样 / 怎么办」,而不是抛一个枚举名。
    expect(a.body).toMatch(/Docker/)
    expect(`${a.title}${a.body}`).not.toMatch(/standby|inert|docker-unreachable|reason/)
    // 是在访问谁的时候发现的,进 detail(排查要用),不进正文(用户不关心是哪个插件先撞上)。
    expect(a.detail).toContain('service=pansou')
  })

  it('stale-origin：两个端口摆进正文，key 里却没有它们（否则每次重建都是一行新通知）', () => {
    const n = pluginTargetMissNotification(facts({
      reason: 'awake-without-origin', standby: diag({ cachedOrigin: 'http://127.0.0.1:44824', hostPort: 51999 }),
    }))!
    expect(n.title).toBe('插件后端地址过期：voiceprint')
    expect(n.body).toContain('44824')
    expect(n.body).toContain('51999')
    expect(n.dedupeKey).toBe('plugin-target:voiceprint:stale-origin')
  })

  // 正文是写给用户的白话，对排查没用；用户复制这条是为了**贴给 AI**，所以每条通知还得
  // 自带一份诊断现场。它不在 UI 上显示，只参与复制。
  it('detail 带着 debug bus 那条记录里的全部现场（复用同一批值，不重新取）', () => {
    const n = pluginTargetMissNotification(facts({
      reason: 'not-awake', suppressed: 3,
      standby: diag({
        state: 'asleep', cachedOrigin: 'http://127.0.0.1:44824', container: 'running',
        containerId: 'a1b2c3d4e5f6', hostPort: 46192, note: 'hostProbe 没声明',
      }),
    }))!
    const d = n.detail!
    expect(d).toContain('service=voiceprint')
    expect(d).toContain('reason=not-awake')
    expect(d).toContain('net 档=host')
    expect(d).toContain('standby 状态=asleep')
    expect(d).toContain('缓存 origin=http://127.0.0.1:44824')
    expect(d).toContain('容器=running (a1b2c3d4e5f6)')
    expect(d).toContain('inspect 宿主口=46192')
    expect(d).toContain('note=hostProbe 没声明')
    expect(d).toContain('3') // 本窗口被压掉的次数
  })

  it('standby 未接线时 detail 如实写 unbound，不编造那五格', () => {
    // 这条形状今天发不出通知（standby-unbound 不是可通知缺陷），所以直接钉渲染函数：
    // 缺席就是缺席，别拿 null/0 冒充"查过了"。
    const d = pluginTargetMissDetail(facts({ reason: 'standby-unbound', standby: null }))
    expect(d).toContain('standby=未接线')
    expect(d).not.toContain('缓存 origin')
  })
})
