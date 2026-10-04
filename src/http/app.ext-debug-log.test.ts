// POST /api/ext/debug-log —— 扩展 SW 的关键低频生命周期事件进 debug bus 的 `ext-cdp` channel。
//
// 存在的理由：onStartup 触发 / 账本作废 / 认领旧组这三件事全发生在没人看着 SW 控制台的那一刻，
// 也全发生在中继 connect 之前（所以只能走 HTTP，不能走 WS）。没有这条口，它们就只能靠读代码反推。

import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'
import type { DebugEntry } from './debug-log.ts'

const stubs = {
  service: { streamsResource: () => [] },
  itemStore: { get: () => undefined },
  health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
} as never

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

function appWithRecorder() {
  const seen: DebugEntry[] = []
  const app = createHttpApp({ ...(stubs as object), debug: { record: (e: DebugEntry) => seen.push(e) } } as never)
  // origin 用 `null` 表示「不带 Origin 头」——不能用 undefined，那会触发默认值。
  const post = (body: unknown, origin: string | null = EXT_ORIGIN) =>
    app.request('/api/ext/debug-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    })
  return { seen, post }
}

describe('POST /api/ext/debug-log', () => {
  it('事件落进 ext-cdp channel，字段原样带过来', async () => {
    const { seen, post } = appWithRecorder()
    const res = await post({
      event: 'ledger-cleared',
      summary: '上一次浏览器会话的账本已作废',
      fields: [{ label: 'members', value: 3 }],
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].channel).toBe('ext-cdp')
    expect(seen[0].key).toBe('ledger-cleared')
    expect(seen[0].summary).toBe('上一次浏览器会话的账本已作废')
    expect(seen[0].fields).toEqual([{ label: 'members', value: '3' }])
  })

  it('只有 event 也收（summary/fields 可省）', async () => {
    const { seen, post } = appWithRecorder()
    expect((await post({ event: 'onStartup' })).status).toBe(200)
    expect(seen[0].summary).toBe('onStartup')
    expect(seen[0].fields).toEqual([])
  })

  /**
   * 慢命令那两条要能进"只看失败"那一档。
   *
   * 为什么不能一律 ok:true：DebugBox 有个 failedOnly 过滤。后端侧的 `relay-timeout` 是 ok:false，
   * 扩展侧配对的 `slow-command` 若恒为 true，勾上过滤的人就会看到"有 relay-timeout、没有
   * slow-command"——而这恰好是"命令根本没送到 SW"的判据。**一个 UI 过滤器凭空造出一个错误结论**。
   * 所以 ok 由发送方申报，生命周期事件（onStartup 等）不带 → 仍然是 true。
   */
  it('ok 由扩展申报：慢命令报 false，不带的照旧 true', async () => {
    const { seen, post } = appWithRecorder()
    await post({ event: 'slow-command', ok: false })
    await post({ event: 'onStartup' })
    expect(seen[0].ok).toBe(false)
    expect(seen[1].ok).toBe(true)
  })

  /** 门控和 /api/ext/verify 同款：网页伪造不了 chrome-extension:// Origin，
   *  否则任何页面都能往诊断环里灌东西，把真正要看的那几条冲掉。 */
  it('非扩展 Origin → 403，且什么都不记', async () => {
    const { seen, post } = appWithRecorder()
    expect((await post({ event: 'x' }, 'https://evil.example')).status).toBe(403)
    expect((await post({ event: 'x' }, null)).status).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('缺 event → 400', async () => {
    const { seen, post } = appWithRecorder()
    expect((await post({ summary: '没头没脑' })).status).toBe(400)
    expect(seen).toHaveLength(0)
  })
})
