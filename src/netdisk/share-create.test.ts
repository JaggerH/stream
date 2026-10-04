import { describe, it, expect, vi } from 'vitest'
import { makeShareCreate } from './share-create.ts'

/**
 * 编排层：OpenList 路径 → 挂载点的 driver（只认夸克）→ 夸克 fid → 建分享。
 * 夸克 API 本身在 shared/netdisk/quark/ 里各自有测试，这里只 mock 那两条腿。
 */
function make(opts: { driver?: string; fid?: string | null; cookie?: string } = {}) {
  const resolveFid = vi.fn(async (segments: string[]) => (opts.fid === undefined ? `fid:${segments.join('/')}` : opts.fid))
  const create = vi.fn(async () => ({ ok: true as const, stage: 'done', message: '分享', shareId: 's', url: 'https://pan.quark.cn/s/x', passcode: '1234', pwdId: 'x' }))
  const alist = { listStorages: vi.fn(async () => [{ mount_path: '/quark', driver: opts.driver ?? 'Quark' }]) }
  const cookieFor = vi.fn(async () => opts.cookie === undefined ? 'kps=1' : opts.cookie)
  const shareCreate = makeShareCreate({ alist: alist as never, cookieFor, resolveFid, create })
  return { shareCreate, resolveFid, create, cookieFor }
}

describe('makeShareCreate', () => {
  it('剥掉挂载点、逐段解析成 fid、带 passcode/expireDays 建分享', async () => {
    const { shareCreate, resolveFid, create } = make()
    const r = await shareCreate({ path: '/quark/闲鱼数据包/pack-1', passcode: '1234', expireDays: 0 })
    expect(r).toEqual({ url: 'https://pan.quark.cn/s/x', passcode: '1234', pwdId: 'x' })
    expect(resolveFid).toHaveBeenCalledWith(['闲鱼数据包', 'pack-1'], expect.objectContaining({ cookieFor: expect.any(Function) }))
    expect(create).toHaveBeenCalledWith(expect.any(Function), { fids: ['fid:闲鱼数据包/pack-1'], title: 'pack-1', passcode: '1234', expireDays: 0 }, expect.anything())
  })

  it('挂载点不是夸克 → unsupported，不碰夸克 API', async () => {
    const { shareCreate, resolveFid } = make({ driver: 'BaiduNetdisk' })
    await expect(shareCreate({ path: '/quark/a' })).rejects.toMatchObject({ code: 'unsupported' })
    expect(resolveFid).not.toHaveBeenCalled()
  })

  it('目录在盘上找不到 → not_found；没有夸克登录态 → unavailable', async () => {
    await expect(make({ fid: null }).shareCreate({ path: '/quark/没有/这个' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(make({ cookie: '' }).shareCreate({ path: '/quark/a' })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('路径是挂载点本身（没有段可解析）→ validation_error', async () => {
    await expect(make().shareCreate({ path: '/quark' })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('夸克那边没成 → upstream_error，message 带它的 stage 与原话', async () => {
    const { shareCreate, create } = make()
    create.mockResolvedValueOnce({ ok: false, stage: 'task', message: '分享任务失败' } as never)
    await expect(shareCreate({ path: '/quark/a' })).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('分享任务失败') })
  })
})
