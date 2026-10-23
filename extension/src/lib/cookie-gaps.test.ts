import { describe, it, expect, vi, beforeEach } from 'vitest'

// 最近一轮后端来取登录态时，这个 profile 没给的域（browser-identity 冒烟后续）。同步范围与站点权限都按 profile
// 记，新 profile 里两样都可能缺；缺了的表现和「没登录」一模一样。所以记下来，弹窗里一键补上。
let store: Record<string, unknown>
const request = vi.fn(async (_p: { origins: string[] }) => true)

beforeEach(() => {
  store = { config: { baseUrl: 'http://127.0.0.1:8900', domains: ['weibo.com'], autoSync: true } }
  request.mockClear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(store, o) }),
        remove: vi.fn(async (k: string) => { delete store[k] }),
      },
    },
    permissions: { request },
  })
  vi.resetModules()
})

const load = () => import('./cookie-gaps.ts')

describe('cookie gaps', () => {
  it('按绑定记；两样都没缺就删掉那一条', async () => {
    const g = await load()
    await g.noteGaps('local', ['bilibili.com'], [], 10)
    await g.noteGaps('ext:a', [], ['quark.cn'], 11)
    expect(await g.readGaps()).toEqual({
      local: { refused: ['bilibili.com'], noAccess: [], at: 10 },
      'ext:a': { refused: [], noAccess: ['quark.cn'], at: 11 },
    })
    await g.noteGaps('local', [], [], 12)
    expect(Object.keys(await g.readGaps())).toEqual(['ext:a'])
  })

  it('修法：本机绑定拒掉的并进同步域，所有绑定缺的站点权限去要；配对绑定拒掉的不在这里（那是逐个批准）', async () => {
    const g = await load()
    const plan = g.fixPlan({
      local: { refused: ['bilibili.com'], noAccess: ['xiaohongshu.com'], at: 1 },
      'ext:a': { refused: ['mybank.example'], noAccess: ['quark.cn', 'xiaohongshu.com'], at: 1 },
    })
    expect(plan).toEqual({
      addDomains: ['bilibili.com'],
      origins: ['*://*.xiaohongshu.com/*', '*://*.quark.cn/*'],
      domains: ['bilibili.com', 'xiaohongshu.com', 'quark.cn'],
    })
    expect(g.fixPlan({ 'ext:a': { refused: ['mybank.example'], noAccess: [], at: 1 } }).domains).toEqual([])
  })

  it('一键修：先要权限（同一个用户手势里、第一个 await 之前），给了再并同步域、清记录', async () => {
    const g = await load()
    await g.noteGaps('local', ['bilibili.com'], ['xiaohongshu.com'], 1)
    const plan = g.fixPlan(await g.readGaps())
    const p = g.applyFix(plan)
    expect(request).toHaveBeenCalledWith({ origins: ['*://*.xiaohongshu.com/*'] })
    expect(await p).toBe(true)
    expect((store.config as { domains: string[] }).domains).toEqual(['weibo.com', 'bilibili.com'])
    expect(await g.readGaps()).toEqual({})
  })

  it('用户没给权限：什么都不改', async () => {
    request.mockResolvedValueOnce(false)
    const g = await load()
    await g.noteGaps('local', ['bilibili.com'], ['xiaohongshu.com'], 1)
    expect(await g.applyFix(g.fixPlan(await g.readGaps()))).toBe(false)
    expect((store.config as { domains: string[] }).domains).toEqual(['weibo.com'])
    expect(Object.keys(await g.readGaps())).toEqual(['local'])
  })

  it('只缺同步范围时不弹权限框', async () => {
    const g = await load()
    await g.applyFix({ addDomains: ['bilibili.com'], origins: [], domains: ['bilibili.com'] })
    expect(request).not.toHaveBeenCalled()
  })
})
