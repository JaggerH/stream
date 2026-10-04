import { describe, it, expect } from 'vitest'
import { runRecipeRunCommand, type RecipeRunIo } from './recipe-run.ts'

type Call = { url: string; init?: RequestInit }

/** 一个假后端：按 URL 回预设的 JSON；记录每一次调用好断言"到底发了什么"。 */
function fakeBackend(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    const key = Object.keys(routes).find((k) => url.endsWith(k))
    if (!key) return new Response('{"error":{"code":"not_found"}}', { status: 404 })
    const r = routes[key]
    const body = typeof r === 'function' ? (r as (i?: RequestInit) => unknown)(init) : r
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

function io(): RecipeRunIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s), sleep: async () => {} }
}

const cmd = (over: Partial<{ params: Record<string, string>; yes: boolean; json: boolean }> = {}) =>
  ({ kind: 'recipe-run' as const, sourceId: 'qq-send', params: { contact: '张三', text: 'hi' }, yes: false, json: false, ...over })

describe('stream recipe run', () => {
  it('不带 --yes：只问后端"会做什么"（confirmed 缺席），打印回执，退出码 2，什么都不执行', async () => {
    const be = fakeBackend({
      '/api/recipes/action': { status: 'needs-confirmation', sourceId: 'qq-send', description: '发一条 QQ 消息', targetApp: 'QQ.exe', screenTakeover: '会抢前台', params: { contact: '张三', text: 'hi' } },
    })
    const o = io()
    const code = await runRecipeRunCommand(cmd(), { fetch: be.fetch, backendUrl: 'http://127.0.0.1:8900', io: o })
    expect(code).toBe(2)
    expect(be.calls).toHaveLength(1)
    const sent = JSON.parse(String(be.calls[0].init?.body))
    expect(sent).toEqual({ sourceId: 'qq-send', params: { contact: '张三', text: 'hi' } })
    expect(sent.confirmed).toBeUndefined()
    const text = o.out.join('\n')
    expect(text).toContain('发一条 QQ 消息')
    expect(text).toContain('QQ.exe')
    expect(text).toContain('--yes')
  })

  it('--yes：带 confirmed:true 真跑；done → 退出码 0', async () => {
    const be = fakeBackend({ '/api/recipes/action': { status: 'done', sourceId: 'qq-send', items: [{ text: 'hi' }] } })
    const o = io()
    const code = await runRecipeRunCommand(cmd({ yes: true }), { fetch: be.fetch, backendUrl: 'http://127.0.0.1:8900', io: o })
    expect(code).toBe(0)
    expect(JSON.parse(String(be.calls[0].init?.body)).confirmed).toBe(true)
  })

  it('running → 轮询 /api/recipes/action/:runId 直到 done，再按 result.status 定退出码', async () => {
    let polls = 0
    const be = fakeBackend({
      '/api/recipes/action': { status: 'running', sourceId: 'qq-send', runId: 'r1' },
      '/api/recipes/action/r1': () => (++polls < 3
        ? { runId: 'r1', status: 'running', sourceId: 'qq-send' }
        : { runId: 'r1', status: 'done', sourceId: 'qq-send', result: { status: 'blocked', sourceId: 'qq-send', reason: '没读到回执' } }),
    })
    const o = io()
    const code = await runRecipeRunCommand(cmd({ yes: true }), { fetch: be.fetch, backendUrl: 'http://127.0.0.1:8900', io: o })
    expect(polls).toBe(3)
    expect(code).toBe(1)
    expect(o.err.join('\n')).toContain('没读到回执')
  })

  /** run 本身崩了（后端重启）和动作失败不是一回事：动作**可能已经做了一部分**，退出码要能区分。 */
  it('run 以 error 收尾 → 退出码 3，并把"可能已做了一部分"说出来', async () => {
    const be = fakeBackend({
      '/api/recipes/action': { status: 'running', sourceId: 'qq-send', runId: 'r2' },
      '/api/recipes/action/r2': { runId: 'r2', status: 'error', sourceId: 'qq-send', error: '后端重启', note: '动作可能已经做了一部分' },
    })
    const o = io()
    const code = await runRecipeRunCommand(cmd({ yes: true }), { fetch: be.fetch, backendUrl: 'http://127.0.0.1:8900', io: o })
    expect(code).toBe(3)
    expect(o.err.join('\n')).toMatch(/可能已经做了一部分/)
  })

  it('失败态各有各的退出码：not-found / invalid-params 是用法错（2），no-desktop / no-browser / needs-login 是环境（4）', async () => {
    for (const [status, want] of [['not-found', 2], ['not-action', 2], ['invalid-params', 2], ['no-desktop', 4], ['no-browser', 4], ['needs-login', 4]] as const) {
      const be = fakeBackend({ '/api/recipes/action': { status, sourceId: 'qq-send', reason: `because ${status}` } })
      const o = io()
      expect(await runRecipeRunCommand(cmd({ yes: true }), { fetch: be.fetch, backendUrl: 'http://x', io: o }), status).toBe(want)
      expect(o.err.join('\n')).toContain(`because ${status}`)
    }
  })

  it('--json：stdout 只有一份 JSON（脚本口），人话全走 stderr', async () => {
    const be = fakeBackend({ '/api/recipes/action': { status: 'done', sourceId: 'qq-send', items: [] } })
    const o = io()
    await runRecipeRunCommand(cmd({ yes: true, json: true }), { fetch: be.fetch, backendUrl: 'http://x', io: o })
    expect(o.out).toHaveLength(1)
    expect(JSON.parse(o.out[0])).toMatchObject({ status: 'done', sourceId: 'qq-send' })
  })

  it('后端不在（连接被拒）→ 退出码 5，指路去起后端；不自己起一份', async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    const o = io()
    const code = await runRecipeRunCommand(cmd({ yes: true }), { fetch, backendUrl: 'http://127.0.0.1:8900', io: o })
    expect(code).toBe(5)
    expect(o.err.join('\n')).toMatch(/127\.0\.0\.1:8900/)
    expect(o.err.join('\n')).toMatch(/stream/)
  })

  it('STREAM_API_TOKEN 在就带 Bearer', async () => {
    const be = fakeBackend({ '/api/recipes/action': { status: 'done', sourceId: 'qq-send' } })
    await runRecipeRunCommand(cmd({ yes: true }), { fetch: be.fetch, backendUrl: 'http://x', io: io(), apiToken: 'tok' })
    expect((be.calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })
})
