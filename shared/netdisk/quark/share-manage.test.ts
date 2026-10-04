import { describe, it, expect } from 'vitest'
import { quarkShareDelete, quarkShareMyPage, type QuarkCall } from './share-api.ts'

/**
 * 端点与字段按活体（2026-09-07，pan.quark.cn 页内 fetch 实测，账号里 20 条分享）：
 *  GET  /1/clouddrive/share/mypage/detail?_page&_size&_order_field=created_at&_order_type=desc&_fetch_total=1
 *       → data.list[] + metadata{_page,_size,_total}
 *  POST /1/clouddrive/share/delete {share_ids:[...]} → code 0（删的是链接，文件仍在盘上）
 * expired_type：1 永久（expired_at = 4102416000000 = 2100-01-01），2/3/4 = 1/7/30 天。
 */
const ROW = {
  share_id: 'sid_1', pwd_id: 'abc123', share_url: 'https://pan.quark.cn/s/abc123', title: 'CN-F',
  path_info: '/闲鱼数据包', passcode: 'x3n9', expired_type: 3, expired_at: 1789401599000, expired_left: 618924172,
  created_at: 1788777684070, status: 1, audit_status: 4, all_file_num: 37, file_num: 1, size: 923283282,
}

function fakeQuark(pages: Record<number, Record<string, unknown>[]>, total: number) {
  const calls: Array<{ url: string; body?: unknown }> = []
  const call: QuarkCall = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const page = Number(/_page=(\d+)/.exec(url)?.[1] ?? 1)
    return { status: 200, body: { code: 0, message: 'ok', data: { list: pages[page] ?? [] }, metadata: { _page: page, _total: total } } }
  }
  return { call, calls }
}

describe('quarkShareMyPage', () => {
  it('一行翻成管理用得上的那几格：shareId / pwdId / 有效期 / 状态', async () => {
    const q = fakeQuark({ 1: [ROW] }, 20)
    const r = await quarkShareMyPage(q.call, { page: 1, size: 8 })
    expect(r.ok).toBe(true)
    expect(r.total).toBe(20)
    expect(r.rows[0]).toEqual({
      shareId: 'sid_1', pwdId: 'abc123', url: 'https://pan.quark.cn/s/abc123', title: 'CN-F', state: 'active',
      pathInfo: '/闲鱼数据包', passcode: 'x3n9', expireDays: 7,
      createdAt: new Date(1788777684070).toISOString(), expiredAt: new Date(1789401599000).toISOString(),
      fileNum: 37, size: 923283282, auditStatus: 4,
    })
    expect(q.calls[0]!.url).toContain('/share/mypage/detail')
    expect(q.calls[0]!.url).toContain('_page=1&_size=8')
    expect(q.calls[0]!.url).toContain('_fetch_total=1')
  })

  it('分页是真的：_total 一并回，翻到尾巴那页只回剩下的几条，再翻一页是空', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...ROW, share_id: `sid_${i}`, pwd_id: `pwd_${i}` }))
    const q = fakeQuark({ 1: many(8), 2: many(8), 3: many(4) }, 20)
    expect((await quarkShareMyPage(q.call, { page: 1, size: 8 })).rows).toHaveLength(8)
    expect((await quarkShareMyPage(q.call, { page: 3, size: 8 })).rows).toHaveLength(4)
    const last = await quarkShareMyPage(q.call, { page: 4, size: 8 })
    expect(last.rows).toEqual([])
    expect(last.total).toBe(20) // 空页也要说得出总数，不然调用方分不清"翻完了"和"查砸了"
  })

  it('永久分享不报 expiredAt——夸克给的 2100-01-01 是个占位，原样回等于把"永久"说成一个日期', async () => {
    const q = fakeQuark({ 1: [{ ...ROW, expired_type: 1, expired_at: 4102416000000, expired_left: 2313633325159 }] }, 1)
    const row = (await quarkShareMyPage(q.call)).rows[0]!
    expect(row.expireDays).toBe(0)
    expect(row.expiredAt).toBeUndefined()
    expect(row.state).toBe('active')
  })

  it('期限到了 → expired；夸克把它下掉了（status !== 1）→ invalid，两种"死"不混为一谈', async () => {
    const q = fakeQuark({ 1: [
      { ...ROW, expired_left: -1454675975 },
      { ...ROW, status: 2 },
    ] }, 2)
    const rows = (await quarkShareMyPage(q.call)).rows
    expect(rows.map((r) => r.state)).toEqual(['expired', 'invalid'])
  })

  it('不认识的 expired_type → expireDays 留空，不猜一个天数出来', async () => {
    const q = fakeQuark({ 1: [{ ...ROW, expired_type: 9 }] }, 1)
    expect((await quarkShareMyPage(q.call)).rows[0]!.expireDays).toBeUndefined()
  })

  it('夸克拒了 → ok:false 带它的原话，不回一个空列表冒充"你没有分享"', async () => {
    const call: QuarkCall = async () => ({ status: 401, body: { code: 31001, message: '需要登录' } })
    expect(await quarkShareMyPage(call)).toEqual({ ok: false, message: '需要登录', rows: [], total: 0 })
  })
})

describe('quarkShareDelete', () => {
  it('POST share/delete {share_ids:[一条]}——端点吃数组，但我们一次只放一条', async () => {
    const q = fakeQuark({}, 0)
    const call: QuarkCall = async (url, init) => {
      q.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return { status: 200, body: { code: 0, message: 'ok' } }
    }
    expect(await quarkShareDelete(call, 'sid_1')).toEqual({ ok: true, message: 'ok' })
    expect(q.calls[0]!.url).toContain('/1/clouddrive/share/delete')
    expect(q.calls[0]!.body).toEqual({ share_ids: ['sid_1'] })
  })

  it('夸克拒了 → ok:false 带原话（活体：不存在的 id 会让整个请求回 500/15000）', async () => {
    const call: QuarkCall = async () => ({ status: 500, body: { code: 15000, message: 'inner error' } })
    expect(await quarkShareDelete(call, 'nope')).toEqual({ ok: false, message: 'inner error' })
  })
})
