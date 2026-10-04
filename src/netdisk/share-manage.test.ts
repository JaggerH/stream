import { describe, it, expect, vi } from 'vitest'
import { makeShareDelete, makeShareList, SHARE_DELETE_MAX, SHARE_LIST_MAX_SIZE } from './share-create.ts'
import type { QuarkShareRow } from '../../shared/netdisk/quark/share-api.ts'

/**
 * 编排层：宿主派发的夸克 cookie → 列 / 删自己建出去的分享。
 * 夸克 API 本身在 shared/netdisk/quark/share-manage.test.ts 里验，这里只 mock 那两条腿。
 */
const row = (id: string): QuarkShareRow => ({
  shareId: id, pwdId: `pwd_${id}`, url: `https://pan.quark.cn/s/pwd_${id}`, title: id,
  state: 'active', createdAt: '2026-09-07T00:00:00.000Z', fileNum: 1, size: 1, auditStatus: 4,
})

function makeList(opts: { cookie?: string; total?: number } = {}) {
  const myPage = vi.fn(async (_call: unknown, o: { page?: number; size?: number } = {}) => ({
    ok: true, message: 'ok', rows: [row('a'), row('b')], total: opts.total ?? 20, page: o.page,
  }))
  const cookieFor = vi.fn(async () => (opts.cookie === undefined ? 'kps=1' : opts.cookie))
  return { shareList: makeShareList({ cookieFor, myPage: myPage as never }), myPage, cookieFor }
}

describe('makeShareList', () => {
  it('缺省第 1 页 50 条；total 一并回，调用方靠它知道还有没有下一页', async () => {
    const { shareList, myPage } = makeList()
    const r = await shareList()
    expect(r).toEqual({ items: [row('a'), row('b')], page: 1, size: 50, total: 20 })
    expect(myPage).toHaveBeenCalledWith(expect.any(Function), { page: 1, size: 50 })
  })

  it('page / size 透传给夸克那一页', async () => {
    const { shareList, myPage } = makeList()
    await shareList({ page: 3, size: 8 })
    expect(myPage).toHaveBeenCalledWith(expect.any(Function), { page: 3, size: 8 })
  })

  it('page/size 不是正整数、size 超上界 → validation_error，不发请求', async () => {
    const { shareList, myPage } = makeList()
    for (const bad of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { size: 0 }, { size: SHARE_LIST_MAX_SIZE + 1 }, { size: 1.5 }]) {
      await expect(shareList(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(myPage).not.toHaveBeenCalled()
  })

  it('没有夸克登录态 → unavailable（与建分享同一口凭证、同一个判据）', async () => {
    const { shareList, myPage } = makeList({ cookie: '' })
    await expect(shareList()).rejects.toMatchObject({ code: 'unavailable' })
    expect(myPage).not.toHaveBeenCalled()
  })

  it('夸克拒了 → upstream_error 带它的原话，不回空列表冒充"你没有分享"', async () => {
    const cookieFor = async () => 'kps=1'
    const shareList = makeShareList({ cookieFor, myPage: (async () => ({ ok: false, message: '需要登录', rows: [], total: 0 })) as never })
    await expect(shareList()).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('需要登录') })
  })
})

function makeDelete(remove: (call: unknown, id: string) => Promise<{ ok: boolean; message: string }>, cookie?: string) {
  const spy = vi.fn(remove)
  const cookieFor = vi.fn(async () => (cookie === undefined ? 'kps=1' : cookie))
  return { shareDelete: makeShareDelete({ cookieFor, remove: spy as never }), remove: spy }
}

describe('makeShareDelete', () => {
  it('逐条发、逐条回判', async () => {
    const { shareDelete, remove } = makeDelete(async () => ({ ok: true, message: 'ok' }))
    const r = await shareDelete({ shareIds: ['s1', 's2'] })
    expect(r).toEqual({ results: [{ shareId: 's1', ok: true }, { shareId: 's2', ok: true }], deleted: 2, failed: 0 })
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('一条被拒 → 其余照删，失败那条带夸克的原话（不整批静默失败）', async () => {
    const { shareDelete, remove } = makeDelete(async (_c, id) =>
      id === 's2' ? { ok: false, message: 'inner error' } : { ok: true, message: 'ok' })
    const r = await shareDelete({ shareIds: ['s1', 's2', 's3'] })
    expect(r.results).toEqual([
      { shareId: 's1', ok: true },
      { shareId: 's2', ok: false, message: 'inner error' },
      { shareId: 's3', ok: true },
    ])
    expect(r).toMatchObject({ deleted: 2, failed: 1 })
    expect(remove).toHaveBeenCalledTimes(3) // 坏的那条没有把后面的带走
  })

  it('一条抛异常（网络抖）→ 记下原话，后面几条照删', async () => {
    const { shareDelete } = makeDelete(async (_c, id) => {
      if (id === 's1') throw new Error('socket hang up')
      return { ok: true, message: 'ok' }
    })
    const r = await shareDelete({ shareIds: ['s1', 's2'] })
    expect(r.results[0]).toEqual({ shareId: 's1', ok: false, message: 'socket hang up' })
    expect(r).toMatchObject({ deleted: 1, failed: 1 })
  })

  it('空数组 / 空串 / 超过上界 → validation_error，一条都不删', async () => {
    const { shareDelete, remove } = makeDelete(async () => ({ ok: true, message: 'ok' }))
    await expect(shareDelete({ shareIds: [] })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(shareDelete({ shareIds: ['s1', ' '] })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(shareDelete({ shareIds: Array.from({ length: SHARE_DELETE_MAX + 1 }, (_, i) => `s${i}`) }))
      .rejects.toMatchObject({ code: 'validation_error' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('没有夸克登录态 → unavailable，一条都不删', async () => {
    const { shareDelete, remove } = makeDelete(async () => ({ ok: true, message: 'ok' }), '')
    await expect(shareDelete({ shareIds: ['s1'] })).rejects.toMatchObject({ code: 'unavailable' })
    expect(remove).not.toHaveBeenCalled()
  })
})
