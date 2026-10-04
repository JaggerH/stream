import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioCache } from './audio-cache.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'audio-cache-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const audio = (s: string, mime = 'audio/x-matroska') => ({ bytes: Buffer.from(s) as Uint8Array as never, mime })

describe('AudioCache', () => {
  it('写进去读出来，字节一致、mime 原样带回', async () => {
    const cache = new AudioCache(dir)
    await cache.write('/quark/show/e1.mkv', audio('track-bytes'))
    const hit = await cache.read('/quark/show/e1.mkv')
    expect(Buffer.from(hit!.bytes).toString()).toBe('track-bytes')
    expect(hit!.mime).toBe('audio/x-matroska')
  })

  it('mime 编码在扩展名里往返——mp4/m4a 各回各家', async () => {
    const cache = new AudioCache(dir)
    await cache.write('douyin:v1', audio('whole-video', 'video/mp4'))
    await cache.write('bili:BV1x', audio('audio-only', 'audio/mp4'))
    expect((await cache.read('douyin:v1'))!.mime).toBe('video/mp4')
    expect((await cache.read('bili:BV1x'))!.mime).toBe('audio/mp4')
  })

  it('映射外的 mime 不缓存——write 是 no-op，read 未命中', async () => {
    const cache = new AudioCache(dir)
    await cache.write('weird', audio('data', 'application/x-mystery'))
    expect(await cache.read('weird')).toBeNull()
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  it('同键换 mime——旧扩展名的尸体被清掉，读回的是新 mime', async () => {
    const cache = new AudioCache(dir)
    await cache.write('k', audio('old', 'audio/x-matroska'))
    await cache.write('k', audio('new', 'audio/mp4'))
    const hit = await cache.read('k')
    expect(Buffer.from(hit!.bytes).toString()).toBe('new')
    expect(hit!.mime).toBe('audio/mp4')
    expect((await readdir(dir)).length).toBe(1)
  })

  it('不同键互不串味', async () => {
    const cache = new AudioCache(dir)
    await cache.write('/quark/a.mkv', audio('AAA'))
    expect(await cache.read('/quark/b.mkv')).toBeNull()
  })

  it('过期视为未命中（mtime 判 TTL，同 subtitle-cache）', async () => {
    const cache = new AudioCache(dir, { ttlMs: 1000 })
    await cache.write('/quark/a.mkv', audio('AAA'))
    const [f] = await readdir(dir)
    const old = new Date(Date.now() - 10_000)
    await utimes(join(dir, f), old, old)
    expect(await cache.read('/quark/a.mkv')).toBeNull()
  })

  it('超容量按 mtime 淘汰最久未用的，热条目留下', async () => {
    const cache = new AudioCache(dir, { maxBytes: 8 }) // 每条 4 字节，只容得下 2 条
    await cache.write('/quark/a.mkv', audio('aaaa'))
    await cache.write('/quark/b.mkv', audio('bbbb'))
    const { createHash } = await import('node:crypto')
    const aFile = join(dir, `${createHash('sha256').update('/quark/a.mkv').digest('hex')}.mka`)
    const old = new Date(Date.now() - 60_000)
    await utimes(aFile, old, old)

    await cache.write('/quark/c.mkv', audio('cccc')) // 12 字节 > 8 → 淘汰 mtime 最旧的 a
    expect(await cache.read('/quark/a.mkv')).toBeNull()
    expect(await cache.read('/quark/b.mkv')).not.toBeNull()
    expect(await cache.read('/quark/c.mkv')).not.toBeNull()
  })

  it('读命中 touch mtime——LRU 语义，被读过的不先死', async () => {
    const cache = new AudioCache(dir, { maxBytes: 8 })
    await cache.write('/quark/a.mkv', audio('aaaa'))
    await cache.write('/quark/b.mkv', audio('bbbb'))
    const { createHash } = await import('node:crypto')
    const aFile = join(dir, `${createHash('sha256').update('/quark/a.mkv').digest('hex')}.mka`)
    const bFile = join(dir, `${createHash('sha256').update('/quark/b.mkv').digest('hex')}.mka`)
    const old = new Date(Date.now() - 60_000)
    await utimes(aFile, old, old)
    await utimes(bFile, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000))

    await cache.read('/quark/a.mkv') // touch：a 从最旧变最新
    await cache.write('/quark/c.mkv', audio('cccc')) // 淘汰现在最旧的 b
    expect(await cache.read('/quark/a.mkv')).not.toBeNull()
    expect(await cache.read('/quark/b.mkv')).toBeNull()
  })

  it('写入时顺手把过期条目连文件清掉——中间品不等容量压力', async () => {
    const cache = new AudioCache(dir, { ttlMs: 1000 })
    await cache.write('/quark/a.mkv', audio('aaaa'))
    const { createHash } = await import('node:crypto')
    const { stat } = await import('node:fs/promises')
    const aFile = join(dir, `${createHash('sha256').update('/quark/a.mkv').digest('hex')}.mka`)
    const old = new Date(Date.now() - 10_000)
    await utimes(aFile, old, old)

    await cache.write('/quark/b.mkv', audio('bbbb')) // 容量远没满，但 a 已过期

    await expect(stat(aFile)).rejects.toThrow() // 文件本体没了，不只是读不出来
    expect(await cache.read('/quark/b.mkv')).not.toBeNull()
  })

  it('sweep() 收掉过期残留——兜进程重启丢定时器的场景（触发点 3）', async () => {
    const cache = new AudioCache(dir, { ttlMs: 1000 })
    await cache.write('/quark/a.mkv', audio('aaaa'))
    const { createHash } = await import('node:crypto')
    const { stat } = await import('node:fs/promises')
    const aFile = join(dir, `${createHash('sha256').update('/quark/a.mkv').digest('hex')}.mka`)
    const old = new Date(Date.now() - 10_000)
    await utimes(aFile, old, old)

    await cache.sweep()

    await expect(stat(aFile)).rejects.toThrow()
  })

  it('sweep() 对不存在的目录安静返回', async () => {
    await expect(new AudioCache(join(dir, 'nope')).sweep()).resolves.toBeUndefined()
  })

  it('写入会预约一次 TTL 后的回收——最后一批写入不等下一次写入来收尸（触发点 2）', async () => {
    const { createHash } = await import('node:crypto')
    const { stat } = await import('node:fs/promises')
    vi.useFakeTimers()
    try {
      const cache = new AudioCache(dir, { ttlMs: 1000 })
      await cache.write('/quark/a.mkv', audio('aaaa'))
      // 写入后把文件做旧（真实时钟口径已过期）。写入紧随的那次 evict 早已跑完（文件当时还新鲜），
      // 之后**没有任何后续写入**——按触发点 1 的机制它就是永久残留，只有预约的定时器能收它。
      const aFile = join(dir, `${createHash('sha256').update('/quark/a.mkv').digest('hex')}.mka`)
      const old = new Date(Date.now() - 60_000)
      await utimes(aFile, old, old)
      await vi.advanceTimersByTimeAsync(1000 + 5000 + 1) // 预约的定时器打响 → evict 起跑
      vi.useRealTimers()
      await vi.waitFor(async () => { await expect(stat(aFile)).rejects.toThrow() })
    } finally {
      vi.useRealTimers()
    }
  })

  it('缓存目录还不存在时 read 安静返回 null', async () => {
    const cache = new AudioCache(join(dir, 'not-yet'))
    expect(await cache.read('/quark/a.mkv')).toBeNull()
  })
})

/** 一个卡在半路的取字节动作：`start()` 之后它一直不结束，直到测试自己放行。
 *  两个消费方「同时开工」就是这么模拟的——第一个还没取完，第二个就来了。 */
function pending<T>() {
  let release!: (v: T) => void
  let fail!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { release = res; fail = rej })
  return { promise, release, fail }
}

describe('AudioCache.share —— 在途表（同一份字节同一时刻只取一次）', () => {
  it('第一个还在取，第二个不另起一趟，等他的结果', async () => {
    const cache = new AudioCache(dir)
    const gate = pending<string>()
    let started = 0
    const fn = () => { started += 1; return gate.promise }

    const a = cache.share('bilibili:BV1x', fn)
    const b = cache.share('bilibili:BV1x', fn)
    expect(started).toBe(1) // ← 整条规则就是这个数字

    gate.release('bytes')
    expect(await a).toBe('bytes')
    expect(await b).toBe('bytes')
  })

  it('不同的键各取各的，互不牵连', async () => {
    const cache = new AudioCache(dir)
    let started = 0
    const gate = pending<string>()
    const fn = () => { started += 1; return gate.promise }
    void cache.share('bilibili:BV1x', fn)
    void cache.share('douyin:v1', fn)
    expect(started).toBe(2)
    gate.release('bytes')
  })

  it('取完之后表就空了——下一次是真的重新取，不会永远拿着第一次的结果', async () => {
    const cache = new AudioCache(dir)
    let started = 0
    const fn = () => { started += 1; return Promise.resolve('bytes') }
    await cache.share('k', fn)
    await cache.share('k', fn)
    expect(started).toBe(2)
  })

  it('第一个取失败：等着的人拿到同一个异常，不各自再去打一遍', async () => {
    const cache = new AudioCache(dir)
    const gate = pending<string>()
    let started = 0
    const fn = () => { started += 1; return gate.promise }

    const a = cache.share('k', fn)
    const b = cache.share('k', fn)
    gate.fail(new Error('403'))
    await expect(a).rejects.toThrow('403')
    await expect(b).rejects.toThrow('403')
    expect(started).toBe(1)
    // 失败之后表要空掉，否则这把键永久卡在一个失败的结果上
    await expect(cache.share('k', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('取字节的函数同步抛也照样登记：异常走 reject，不会绕过在途机制', async () => {
    const cache = new AudioCache(dir)
    const boom = () => { throw new Error('同步炸') }
    await expect(cache.share('k', boom as () => Promise<string>)).rejects.toThrow('同步炸')
    await expect(cache.share('k', () => Promise.resolve('ok'))).resolves.toBe('ok')
  })
})

describe('AudioCache.readOrCompute —— 本地有就给、有人在取就等、都没有才取', () => {
  it('本地已有：不调取字节的函数', async () => {
    const cache = new AudioCache(dir)
    await cache.write('k', audio('已经在本地'))
    let called = 0
    const out = await cache.readOrCompute('k', async () => { called += 1; return audio('新取的') })
    expect(Buffer.from(out.bytes).toString()).toBe('已经在本地')
    expect(called).toBe(0)
  })

  it('本地没有：取一次、存下来，下一次直接命中', async () => {
    const cache = new AudioCache(dir)
    let called = 0
    const compute = async () => { called += 1; return audio('新取的') }
    await cache.readOrCompute('k', compute)
    const again = await cache.readOrCompute('k', compute)
    expect(called).toBe(1)
    expect(Buffer.from(again.bytes).toString()).toBe('新取的')
  })

  it('两个消费方同时开工：只取一次，两边拿到同一份', async () => {
    const cache = new AudioCache(dir)
    const gate = pending<{ bytes: Uint8Array; mime: string }>()
    let started = 0
    const compute = () => { started += 1; return gate.promise }

    const a = cache.readOrCompute('k', compute)
    const b = cache.readOrCompute('k', compute)
    gate.release(audio('只取了一遍'))
    expect(Buffer.from((await a).bytes).toString()).toBe('只取了一遍')
    expect(Buffer.from((await b).bytes).toString()).toBe('只取了一遍')
    expect(started).toBe(1)
  })

  it('存不下不拖累本次结果：字节已经在手上了', async () => {
    const cache = new AudioCache(dir)
    // 映射外的 mime → write 是 no-op（存不下），但这次取到的字节必须原样交出去
    const out = await cache.readOrCompute('k', async () => audio('取到了', 'audio/weird'))
    expect(Buffer.from(out.bytes).toString()).toBe('取到了')
    expect(await cache.read('k')).toBeNull()
  })
})
