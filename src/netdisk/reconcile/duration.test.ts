import { describe, it, expect, vi } from 'vitest'
import { DurationCache, durationOf, durationsFor, probeDurationAt } from './duration.ts'
import { openNetdiskDb } from '../db.ts'

const cache = () => new DurationCache(openNetdiskDb(':memory:'))

describe('probeDurationAt', () => {
  it('解析 ffprobe 的秒数并取整', async () => {
    const run = vi.fn(async () => ({ stdout: '2605.283000\n', stderr: '' }))
    expect(await probeDurationAt('http://x/a.mp3', run as never, () => 'ffprobe')).toBe(2605)
  })

  it('ffprobe 失败/超时 → null（不抛，一条探不到不掀翻整轮）', async () => {
    const run = vi.fn(async () => { throw new Error('412') })
    expect(await probeDurationAt('http://x/a.mp3', run as never, () => 'ffprobe')).toBeNull()
  })

  it('输出不是数字 → null，绝不退化成 0', async () => {
    const run = vi.fn(async () => ({ stdout: 'N/A\n', stderr: '' }))
    expect(await probeDurationAt('http://x/a.mp3', run as never, () => 'ffprobe')).toBeNull()
  })
})

describe('durationOf', () => {
  const file = { path: '/d/455.mp3', size: 111 }

  it('探一次落缓存，第二次不再探', async () => {
    const probe = vi.fn(async () => 2605)
    const deps = { rawUrl: vi.fn(async () => 'http://raw/1'), cache: cache(), probe }
    expect(await durationOf(file, deps)).toBe(2605)
    expect(await durationOf(file, deps)).toBe(2605)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('失败也缓存（负缓存）——别每轮都对同一个坏文件重探', async () => {
    const probe = vi.fn(async () => null)
    const deps = { rawUrl: vi.fn(async () => 'http://raw/1'), cache: cache(), probe }
    expect(await durationOf(file, deps)).toBeNull()
    expect(await durationOf(file, deps)).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('字节数变了 → 视为换了文件，重探', async () => {
    const probe = vi.fn(async () => 2605)
    const deps = { rawUrl: vi.fn(async () => 'http://raw/1'), cache: cache(), probe }
    await durationOf(file, deps)
    await durationOf({ ...file, size: 222 }, deps)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('取直链就失败（412/对象不存在）→ null，不抛', async () => {
    const deps = {
      rawUrl: vi.fn(async () => { throw new Error('[alist] code 412') }),
      cache: cache(),
      probe: vi.fn(async () => 2605),
    }
    expect(await durationOf(file, deps)).toBeNull()
  })

  it('缓存跨实例可读（同一个库）', async () => {
    const db = openNetdiskDb(':memory:')
    const deps = { rawUrl: vi.fn(async () => 'http://raw/1'), cache: new DurationCache(db), probe: vi.fn(async () => 2605) }
    await durationOf(file, deps)
    expect(new DurationCache(db).get(file.path, file.size)).toBe(2605)
  })
})

// 绑定匹配（sync）的时长档要的是一批文件的时长，而 sync 是同步 HTTP 请求路径：
// 一个 600 集的播客首轮全探会把请求拖到十分钟级。预算限的是**新**探测，缓存命中不受限，
// 缓存只增不减，几轮之后收敛到稳态零探测。超预算的文件本轮就是"没时长"→ 走文件名链。
describe('durationsFor（批量 + 探测预算）', () => {
  const files = [
    { path: '/d/a.mp3', size: 1 },
    { path: '/d/b.mp3', size: 2 },
    { path: '/d/c.mp3', size: 3 },
  ]

  it('预算内逐个探到，路径 → 秒', async () => {
    const probe = vi.fn(async () => 60)
    const out = await durationsFor(files, { rawUrl: async () => 'http://raw', cache: cache(), probe, budget: 10 })
    expect(out).toEqual(new Map([['/d/a.mp3', 60], ['/d/b.mp3', 60], ['/d/c.mp3', 60]]))
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('超预算的文件本轮不带时长，也不发探测', async () => {
    const probe = vi.fn(async () => 60)
    const out = await durationsFor(files, { rawUrl: async () => 'http://raw', cache: cache(), probe, budget: 2 })
    expect([...out.keys()]).toEqual(['/d/a.mp3', '/d/b.mp3'])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('缓存命中不吃预算——稳态下预算再小也全都拿得到', async () => {
    const shared = cache()
    const probe = vi.fn(async () => 60)
    await durationsFor(files, { rawUrl: async () => 'http://raw', cache: shared, probe, budget: 10 })
    probe.mockClear()
    const out = await durationsFor(files, { rawUrl: async () => 'http://raw', cache: shared, probe, budget: 0 })
    expect(out.size).toBe(3)
    expect(probe).not.toHaveBeenCalled()
  })

  it('探不到的文件不进结果（未知 ≠ 0）', async () => {
    const probe = vi.fn(async (url: string) => (url.endsWith('b.mp3') ? null : 60))
    const out = await durationsFor(files, { rawUrl: async (p) => `http://raw${p}`, cache: cache(), probe, budget: 10 })
    expect([...out.keys()]).toEqual(['/d/a.mp3', '/d/c.mp3'])
  })
})
