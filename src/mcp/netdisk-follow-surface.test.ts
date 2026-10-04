// src/mcp/netdisk-follow-surface.test.ts
//
// 投影层的守卫。每条都对着同一个失败形状：**大字段悄悄漏进回执**（上下文被顶爆）或
// **截断没自陈**（模型把半份当全份，静默答错）。所以除了"形状对不对"，还各钉一条
// "这个大字段的名字在序列化后的 JSON 文本里搜不到"——把投影改回 `{...原对象}` 它当场红。
import { describe, it, expect, vi } from 'vitest'
import {
  resolveShareTarget,
  startFollowRun,
  projectShareInspect,
  projectFollowView,
  projectFollowRunResult,
  projectSync,
  seasonsSeenIn,
  seasonOfLeftKey,
  SHARE_FILES_MAX,
  FOLLOW_RUNS_MAX,
  SYNC_MISSING_PER_SEASON,
} from './netdisk-follow-surface.ts'

const file = (i: number) => ({ path: `第三季/EP${i}.mp4`, size: 1000 + i, fid: `f${i}`, token: `t${i}`, name: `EP${i}.mp4` })

describe('projectShareInspect', () => {
  it('原样带出验活结论与文件清单', () => {
    const out = projectShareInspect({
      netdisk: 'quark', pwdId: 'abc', validity: 'alive', files: [file(1), file(2)],
    })
    expect(out).toMatchObject({ netdisk: 'quark', pwdId: 'abc', validity: 'alive', total: 2, truncated: false })
    expect(out.files).toEqual([{ path: '第三季/EP1.mp4', size: 1001 }, { path: '第三季/EP2.mp4', size: 1002 }])
  })

  it('封顶 200 个文件，并**显式**说出截断了——半份清单被当成全份就会答出「这条分享里没有那一集」', () => {
    const files = Array.from({ length: 250 }, (_, i) => file(i))
    const out = projectShareInspect({ netdisk: 'quark', pwdId: 'x', validity: 'alive', files })
    expect(out.files.length).toBe(SHARE_FILES_MAX)
    expect(out.total).toBe(250)
    expect(out.truncated).toBe(true)
  })

  it('fid / token 这类转存内部字段绝不出现在回执里', () => {
    const json = JSON.stringify(projectShareInspect({ netdisk: 'quark', pwdId: 'x', validity: 'alive', files: [file(1)] }))
    expect(json).not.toContain('fid')
    expect(json).not.toContain('token')
  })

  it('季字样原样报，不归一——「第二季」和「S03」被合成一个数，那条矛盾就没了', () => {
    expect(seasonsSeenIn([{ path: '第 三 季/EP1.mp4' }, { path: 'Show.S03E01.mkv' }])).toEqual(['S03', '第三季'])
    const out = projectShareInspect({ netdisk: 'quark', pwdId: 'x', validity: 'alive', files: [{ path: 'a.mp4', size: 1 }] })
    expect(out.seasonsSeen).toBeUndefined()
  })

  it('unknown（没验到）原样带 reason —— 它和 not-usable（验过了、不行）是两件事', () => {
    const out = projectShareInspect({ netdisk: 'quark', pwdId: 'x', validity: 'unknown', reason: 'timeout', files: [] })
    expect(out).toMatchObject({ validity: 'unknown', reason: 'timeout', total: 0, truncated: false })
  })
})

// 这三档以前都是抛异常。在工具面上，"抛" 和 "这条分享死了 / 服务炸了" 长得一模一样：模型会
// 重试、换参数、或者干脆报告「链接失效」——而正确的下一句是「这个盘我们验不了，你自己转存」
// 或「先 video_resolve 拿到真链接」。
describe('resolveShareTarget —— 验不了的三档，各自说清楚是哪一档', () => {
  const deps = {
    supports: (n: string) => n === 'quark',
    parseLink: (l: string) => (l.includes('pan.quark.cn/s/') ? { netdisk: 'quark', pwd_id: l.split('/s/')[1] } : null),
  }

  it('夸克分享链接 → 解析出网盘与分享 id', () => {
    expect(resolveShareTarget({ link: 'https://pan.quark.cn/s/abc123' }, deps)).toEqual({ ok: true, netdisk: 'quark', pwdId: 'abc123' })
  })

  it('不是网盘分享链接（needsResolve 的中转页）→ unsupported，并指路 video_resolve', () => {
    const r = resolveShareTarget({ link: 'https://example.com/detail/8823' }, deps)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.result.validity).toBe('unsupported')
    expect(r.result.reason).toContain('video_resolve')
  })

  it('别的网盘 → unsupported，且报里带着盘名——绝不报成 not-usable（那会让用户删掉一条好分享）', () => {
    const r = resolveShareTarget({ netdisk: 'baidu', pwdId: 'x1' }, deps)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.result).toMatchObject({ netdisk: 'baidu', pwdId: 'x1', validity: 'unsupported' })
    expect(r.result.reason).toContain('baidu')
    expect(r.result.reason).not.toContain('失效')
  })

  it('什么都没给 → 抛（这一档是调用方的编程错误，不是"验不了"）', () => {
    expect(() => resolveShareTarget({}, deps)).toThrow(/二选一必填/)
  })

  it('链接解析不出、但显式给了 netdisk+pwdId → 用显式那份', () => {
    expect(resolveShareTarget({ link: 'https://example.com/x', netdisk: 'quark', pwdId: 'zz' }, deps)).toEqual({ ok: true, netdisk: 'quark', pwdId: 'zz' })
  })
})

// 一轮的下限就有 6×10 秒的重同步，实测量级是分钟，而工作台一次工具调用 200 秒就超时——
// 等下去的结局是模型手里一条「失败了」，磁盘上一次真的转存 + 真的删副本。
describe('startFollowRun —— 开一轮就返回，别把 200 秒的超时耗在这儿', () => {
  it('runOnce 还挂着的时候就已经返回，且回执讲的是「开了」不是「结果」', async () => {
    let resolveRound = (): void => {}
    const runner = {
      isRunning: () => false,
      runOnce: () => new Promise<void>((r) => { resolveRound = () => r() }),
    }
    const out = startFollowRun(runner, 's1', () => {})
    expect(out).toMatchObject({ started: true, setId: 's1' })
    expect(out).not.toHaveProperty('errors')          // 不是一轮的结果
    expect(out.note).toContain('view')
    resolveRound()
  })

  it('已经有一轮在跑 → 不再开第二轮（两轮并发对着同一个目录转存 + 归档要打架）', () => {
    const runOnce = vi.fn(async () => {})
    const out = startFollowRun({ isRunning: () => true, runOnce }, 's1', () => {})
    expect(out).toMatchObject({ started: false, alreadyRunning: true, setId: 's1' })
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('后台那一轮炸了 → 走 onError，绝不留成没人接的 rejection', async () => {
    const seen: unknown[] = []
    startFollowRun({ isRunning: () => false, runOnce: async () => { throw new Error('unknown binding: s9') } }, 's9', (e) => seen.push(e))
    await new Promise((r) => setTimeout(r, 0))
    expect((seen[0] as Error).message).toContain('unknown binding')
  })
})

const run = (i: number) => ({
  id: `r${i}`,
  at: `2026-09-0${i}T00:00:00Z`,
  trigger: 'scheduled',
  missingAired: ['tmdb:1:S01E01', 'tmdb:1:S01E02'],
  saved: [{ pwdId: 'p1', files: ['a.mp4', 'b.mp4'] }],
  synced: { matchedBefore: 3, matchedAfter: 5 },
  errors: ['boom'],
})

describe('projectFollowView', () => {
  const view = {
    follow: { enabled: true, dryRuns: 2, lastCheckAt: 'x', nextCheckAt: 'y' },
    missingAired: ['tmdb:1:S01E07'],
    upcoming: 3,
    shares: [{ pwdId: 'p1', netdisk: 'quark', origin: 'search', validity: 'alive', lastCheck: 'z' }],
    runs: Array.from({ length: 9 }, (_, i) => run(i)),
  }

  it('历轮只给最近 5 轮，每轮压成一行计数；最近那一轮多带逐条错误', () => {
    const out = projectFollowView(view)
    expect(out.lastRuns.length).toBe(FOLLOW_RUNS_MAX)
    // `run` 是 fire-and-return，模型两分钟后回来读的就是这一行——只给一个 errors: 1，
    // 它说不出哪儿卡住了。
    expect(out.lastRuns[0]).toEqual({
      id: 'r0', at: '2026-09-00T00:00:00Z', trigger: 'scheduled',
      missingAired: 2, saved: 2, synced: { matchedBefore: 3, matchedAfter: 5 }, errors: 1, errorList: ['boom'],
    })
    expect(out.lastRuns[1]).toEqual({
      id: 'r1', at: '2026-09-01T00:00:00Z', trigger: 'scheduled',
      missingAired: 2, saved: 2, synced: { matchedBefore: 3, matchedAfter: 5 }, errors: 1,
    })
    expect(out).toMatchObject({ upcoming: 3, missingAired: ['tmdb:1:S01E07'] })
  })

  // 投影这一层不该依赖上游筛没筛：`view()` 今天恰好只给五个字段，spread 因此看起来是对的——
  // 而上游哪天多带一格（`seenFiles` 一条剧集分享几百个文件，每个带 fid+token），几十 KB
  // 就静默灌进回执。
  it('分享行逐格点名：账本上的 seenFiles / savedFids 一个字都不进回执', () => {
    const out = projectFollowView({
      ...view,
      shares: [
        {
          pwdId: 'p1', netdisk: 'quark', origin: 'search', validity: 'alive', lastCheck: 'z',
          seenFiles: [{ fid: 'f1', token: 't1', path: 'S03/EP1.mp4', size: 1 }],
          savedFids: ['f1'],
          passcode: '1234',
        } as never,
      ],
    })
    expect(out.shares).toEqual([{ pwdId: 'p1', netdisk: 'quark', origin: 'search', validity: 'alive', lastCheck: 'z' }])
    const json = JSON.stringify(out)
    expect(json).not.toContain('seenFiles')
    expect(json).not.toContain('savedFids')
    expect(json).not.toContain('passcode')
  })

  it('逐条明细（回访了哪些分享、搜了哪些词、转存了哪些文件名）不进回执', () => {
    const json = JSON.stringify(projectFollowView({ ...view, runs: [{ ...run(1), revisited: [{ pwdId: 'p', validity: 'alive', newFiles: 9, picked: 1 }], searched: { queries: ['q'], hits: 1, alive: 1, picked: 1, failed: 0 } } as never] }))
    expect(json).not.toContain('revisited')
    expect(json).not.toContain('searched')
    expect(json).not.toContain('a.mp4')
  })
})

describe('projectFollowRunResult', () => {
  it('手动跑一轮：还是那一行，但错误逐条给全——它是唯一说得清「哪儿卡住了」的东西', () => {
    const out = projectFollowRunResult({ ...run(1), errors: ['save p1 [auth]: 登录态过期', 'search: 资源搜索未装配'] })
    expect(out.errors).toBe(2)
    expect(out.errorList).toEqual(['save p1 [auth]: 登录态过期', 'search: 资源搜索未装配'])
  })

  it('归位那一格原样带出（runId 是 reconcile_undo_run 的入口，gated 是「被闸了」）', () => {
    const out = projectFollowRunResult({ ...run(1), archived: { runId: 'run-9', moved: 2, deleted: 1, renamed: 3, gated: '清单不健康' } })
    expect(out.archived).toEqual({ runId: 'run-9', moved: 2, deleted: 1, renamed: 3, gated: '清单不健康' })
  })
})

describe('projectSync', () => {
  const entry = (season: number, ep: number, matched: boolean) => ({
    leftKey: `tmdb:1399:S0${season}E${String(ep).padStart(2, '0')}`,
    leftTitle: `第 ${ep} 集`,
    rightFile: matched ? `S0${season}E${ep}.mkv` : null,
    status: matched ? 'auto' : 'unmatched',
    airDate: '2026-01-01',
    fingerprint: { size: 999_999, duration: 2700 },
  })

  it('按季汇总；逐条 entry 一个都不进回执', () => {
    const set = {
      id: 'b1',
      left: { title: '某剧' },
      entries: [entry(1, 1, true), entry(1, 2, false), entry(2, 1, true)],
      coverage: { right: { orphan: 4 }, orphanFiles: ['x.mkv', 'y.mkv'] },
    }
    const out = projectSync(set, '2026-09-03')
    expect(out).toMatchObject({ setId: 'b1', title: '某剧', orphanFiles: 4, orphanSample: ['x.mkv', 'y.mkv'] })
    expect(out.bySeason).toEqual([
      { season: 1, matched: 1, total: 2, unaired: 0, missing: [{ leftKey: 'tmdb:1399:S01E02', title: '第 2 集', airDate: '2026-01-01' }], missingTruncated: false },
      { season: 2, matched: 1, total: 1, unaired: 0, missing: [], missingTruncated: false },
    ])
    expect(JSON.stringify(out)).not.toContain('fingerprint')
  })

  it('还没播的集不进分母也不算缺——只报一个 unaired 数，别让「97/101」把 4 集占位读成 4 集缺货', () => {
    const set = {
      id: 'b1', left: { title: 'x' },
      entries: [
        entry(1, 1, true), entry(1, 2, false),
        { ...entry(1, 3, false), airDate: '2026-09-10' },
        { ...entry(1, 4, false), airDate: undefined },
      ],
    }
    const [s1] = projectSync(set, '2026-09-03').bySeason
    expect(s1).toMatchObject({ matched: 1, total: 2, unaired: 2, missingTruncated: false })
    expect(s1.missing.map((m) => m.leftKey)).toEqual(['tmdb:1399:S01E02'])
  })

  it('每季缺集封顶并自陈截断——20 条被当成「就缺这些」是静默答错', () => {
    const set = {
      id: 'b1', left: { title: 'x' },
      entries: Array.from({ length: 30 }, (_, i) => entry(1, i + 1, false)),
    }
    const [s1] = projectSync(set, '2026-09-03').bySeason
    expect(s1.missing.length).toBe(SYNC_MISSING_PER_SEASON)
    expect(s1.missingTruncated).toBe(true)
    expect(s1.total).toBe(30)
  })

  it('pending / rejected 不算配上——只有 auto 与 confirmed 才是「这一集有了」', () => {
    const set = {
      id: 'b1', left: { title: 'x' },
      entries: [
        { leftKey: 'tmdb:1:S01E01', leftTitle: 'a', rightFile: 'a.mkv', status: 'pending' },
        { leftKey: 'tmdb:1:S01E02', leftTitle: 'b', rightFile: 'b.mkv', status: 'confirmed' },
      ],
    }
    expect(projectSync(set, '2026-09-03').bySeason[0]).toMatchObject({ matched: 1, total: 2 })
  })

  it('没有季号的左键（订阅流 item:<id>）归第 0 季，不炸', () => {
    expect(seasonOfLeftKey('item:abc')).toBe(0)
    expect(seasonOfLeftKey('tmdb:1399:S12E03')).toBe(12)
  })
})
