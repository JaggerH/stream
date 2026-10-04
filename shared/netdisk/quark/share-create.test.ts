import { describe, it, expect } from 'vitest'
import { quarkShareCreate, type QuarkCall } from './share-api.ts'

/**
 * 端点与字段按活体（2026-09-07，pan.quark.cn 页内 fetch 实测）：
 *  POST /1/clouddrive/share          {fid_list,title,url_type(1 公开/2 提取码),expired_type,passcode?} → data.task_id
 *  GET  /1/clouddrive/task?task_id&retry_index → data.status(2 完成) + data.share_id
 *  POST /1/clouddrive/share/password {share_id} → data.share_url / data.passcode / data.expired_type / expired_at
 * expired_type：1 永久（expired_at=2100-01-01），2/3/4 = 1/7/30 天。
 */
function fakeQuark(opts: { taskPolls?: number; shareCode?: number; taskStatus?: number } = {}) {
  const calls: Array<{ url: string; body?: unknown }> = []
  let polls = 0
  const call: QuarkCall = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.includes('/share/password')) {
      const b = JSON.parse(String(init?.body)) as { share_id: string }
      return { status: 200, body: { code: 0, data: { share_id: b.share_id, share_url: 'https://pan.quark.cn/s/abc123', passcode: 'ab12', expired_type: 1, url_type: 2 } } }
    }
    if (url.includes('/share?')) return { status: 200, body: { code: opts.shareCode ?? 0, message: opts.shareCode ? 'no' : 'ok', data: { task_id: 'task_1' } } }
    if (url.includes('/task?')) {
      polls++
      const done = polls >= (opts.taskPolls ?? 1)
      return { status: 200, body: { code: 0, data: done ? { status: opts.taskStatus ?? 2, share_id: 'sid_1', task_title: '分享' } : { status: 1 } } }
    }
    return { status: 404, body: { code: -1 } }
  }
  return { call, calls }
}
const noSleep = async () => {}

describe('quarkShareCreate', () => {
  it('三步：share → 轮询 task 拿 share_id → share/password 拿 url/passcode', async () => {
    const q = fakeQuark({ taskPolls: 3 })
    const r = await quarkShareCreate(q.call, { fids: ['f1'], title: '包', passcode: 'ab12', expireDays: 0 }, { sleep: noSleep })
    expect(r).toEqual({ ok: true, stage: 'done', message: '分享', shareId: 'sid_1', url: 'https://pan.quark.cn/s/abc123', passcode: 'ab12', pwdId: 'abc123' })
    expect(q.calls[0]!.url).toContain('/1/clouddrive/share?')
    expect(q.calls[0]!.body).toEqual({ fid_list: ['f1'], title: '包', url_type: 2, expired_type: 1, passcode: 'ab12' })
    expect(q.calls.filter((c) => c.url.includes('/task?'))).toHaveLength(3)
    expect(q.calls.at(-1)!.body).toEqual({ share_id: 'sid_1' })
  })

  it('不给 passcode = 公开分享（url_type 1，body 不带 passcode）；expireDays 1/7/30 → expired_type 2/3/4', async () => {
    for (const [days, et] of [[1, 2], [7, 3], [30, 4]] as const) {
      const q = fakeQuark()
      await quarkShareCreate(q.call, { fids: ['f1'], expireDays: days }, { sleep: noSleep })
      expect(q.calls[0]!.body).toEqual({ fid_list: ['f1'], title: '', url_type: 1, expired_type: et })
    }
  })

  it('夸克只认 0/1/7/30 天——别的天数当场拒，不静默四舍五入成另一种有效期', async () => {
    const q = fakeQuark()
    await expect(quarkShareCreate(q.call, { fids: ['f1'], expireDays: 3 }, { sleep: noSleep })).rejects.toThrow(/expireDays/)
    expect(q.calls).toHaveLength(0)
  })

  it('share 一步就被拒 → ok:false stage:share，带夸克的 message', async () => {
    const q = fakeQuark({ shareCode: 31001 })
    const r = await quarkShareCreate(q.call, { fids: ['f1'] }, { sleep: noSleep })
    expect(r).toMatchObject({ ok: false, stage: 'share', message: 'no' })
  })

  it('task 失败（status 3）→ stage:task；轮询预算耗尽 → stage:task 且说明未观察到结果', async () => {
    const q = fakeQuark({ taskStatus: 3 })
    expect(await quarkShareCreate(q.call, { fids: ['f1'] }, { sleep: noSleep })).toMatchObject({ ok: false, stage: 'task' })
    const slow = fakeQuark({ taskPolls: 99 })
    const r = await quarkShareCreate(slow.call, { fids: ['f1'] }, { sleep: noSleep, maxPolls: 2 })
    expect(r).toMatchObject({ ok: false, stage: 'task' })
    expect(r.message).toMatch(/未/)
  })
})
