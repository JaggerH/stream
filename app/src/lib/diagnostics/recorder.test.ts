import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openRepo, type DiagnosticsRepo } from './repository.ts'
import {
  createRecorder,
  intervalFor,
  newSessionId,
  trimUa,
  HIDDEN_INTERVAL_MS,
  VISIBLE_INTERVAL_MS,
  type RecorderDeps,
} from './recorder.ts'

let repo: DiagnosticsRepo

const mkRecorder = (over: Partial<RecorderDeps> = {}) =>
  createRecorder({
    repo,
    now: () => Date.now(),
    appVersion: 'test',
    ua: 'test-ua',
    rand: () => 0.5,
    sample: (sessionId, at) => ({
      sessionId, at, memory: null,
      dom: { nodes: 1, img: 0, video: 0, audio: 0 },
      route: '/', visibility: 'visible', online: true, audio: null,
      resourceEntries: 0, longTasks: null,
    }),
    visibility: () => 'visible',
    ...over,
  })

beforeEach(async () => {
  // 只假掉 recorder 自己用的 setTimeout/clearTimeout。默认的 useFakeTimers() 连
  // setImmediate 一起假掉,而 fake-indexeddb 正是靠它推进事务队列 —— 全假会让
  // openRepo 永不 resolve,把整个 hook 挂死。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  repo = await openRepo(new IDBFactory())
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 推进一个采样周期并等它真正落库。
 *
 * recorder 是「写完再排下一拍」:tick 先 await 掉 IDB 写入才 schedule()。这是有意的 ——
 * 内存压力下 IDB 变慢时它自动降频,而不是堆积写请求(而内存压力恰恰是本记录器要观测的
 * 场景)。代价是光推假时间不够:那串真异步(add→txDone→trim→touch,好几个来回)不落地,
 * 下一个定时器就没挂上。
 *
 * 与其猜要 flush 几次,不如等条件:放行真事件循环,直到 recorder 把下一拍挂回去。
 * 上限 50 次是防死循环的兜底,不是节拍的一部分。
 */
const tickOnce = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

describe('调度间隔', () => {
  it('可见 10 秒、隐藏 60 秒', () => {
    expect(intervalFor('visible')).toBe(VISIBLE_INTERVAL_MS)
    expect(intervalFor('hidden')).toBe(HIDDEN_INTERVAL_MS)
    expect(VISIBLE_INTERVAL_MS).toBe(10_000)
    expect(HIDDEN_INTERVAL_MS).toBe(60_000)
  })
})

describe('会话生命周期', () => {
  it('start 立刻把会话标为 running —— 崩溃前证据的锚点', async () => {
    const rec = mkRecorder()
    await rec.start()
    const sessions = await repo.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].status).toBe('running')
  })

  it('正常 stop 写 ended', async () => {
    const rec = mkRecorder()
    await rec.start()
    await rec.stop('unload')
    expect((await repo.listSessions())[0].status).toBe('ended')
  })

  it('stop 后不再采样', async () => {
    const rec = mkRecorder()
    await rec.start()
    await rec.stop('disabled')
    const before = (await repo.exportSession(rec.sessionId()))?.samples.length ?? 0
    await vi.advanceTimersByTimeAsync(VISIBLE_INTERVAL_MS * 3)
    const after = (await repo.exportSession(rec.sessionId()))?.samples.length ?? 0
    expect(after).toBe(before)
  })
})

describe('周期采样', () => {
  it('每 10 秒写一条样本', async () => {
    const rec = mkRecorder()
    await rec.start()
    for (let i = 0; i < 3; i++) await tickOnce(VISIBLE_INTERVAL_MS)
    const bundle = await repo.exportSession(rec.sessionId())
    expect(bundle!.samples.length).toBe(3)
  })

  it('页面隐藏时降到 60 秒', async () => {
    const rec = mkRecorder({ visibility: () => 'hidden' })
    await rec.start()
    await tickOnce(VISIBLE_INTERVAL_MS * 3) // 30s < 60s，还不该采
    expect((await repo.exportSession(rec.sessionId()))!.samples.length).toBe(0)
    await tickOnce(HIDDEN_INTERVAL_MS)
    expect((await repo.exportSession(rec.sessionId()))!.samples.length).toBe(1)
  })

  it('采样抛错不会掀翻记录器（诊断绝不能搞崩页面）', async () => {
    const rec = mkRecorder({
      sample: () => { throw new Error('boom') },
    })
    await rec.start()
    await expect(tickOnce(VISIBLE_INTERVAL_MS * 2)).resolves.not.toThrow()
  })

  it('一拍失败后下一拍照常（失败不终止调度）', async () => {
    let calls = 0
    const rec = mkRecorder({
      sample: (sessionId, at) => {
        calls++
        if (calls === 1) throw new Error('boom')
        return {
          sessionId, at, memory: null,
          dom: { nodes: 1, img: 0, video: 0, audio: 0 },
          route: '/', visibility: 'visible', online: true, audio: null,
          resourceEntries: 0, longTasks: null,
        }
      },
    })
    await rec.start()
    for (let i = 0; i < 3; i++) await tickOnce(VISIBLE_INTERVAL_MS)
    expect(calls).toBe(3)
    // 第一拍抛了,后两拍照常落库
    expect((await repo.exportSession(rec.sessionId()))!.samples.length).toBe(2)
  })
})

describe('即时事件', () => {
  it('mark 追加事件', async () => {
    const rec = mkRecorder()
    await rec.start()
    await rec.mark('stalled', 'test-detail')
    const bundle = await repo.exportSession(rec.sessionId())
    expect(bundle!.events).toHaveLength(1)
    expect(bundle!.events[0].kind).toBe('stalled')
    expect(bundle!.events[0].detail).toBe('test-detail')
  })

  it('start 前 mark 不抛（无会话可写）', async () => {
    const rec = mkRecorder()
    await expect(rec.mark('user-mark')).resolves.not.toThrow()
  })
})

describe('trimUa', () => {
  it('只留浏览器与平台，丢掉完整 UA 串', () => {
    const ua = trimUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    expect(ua).toContain('Chrome/131')
    expect(ua).not.toContain('AppleWebKit')
    expect(ua.length).toBeLessThan(60)
  })

  it('认不出来时不整个吐原文', () => {
    expect(trimUa('some-weird-ua-string-that-is-very-long').length).toBeLessThanOrEqual(40)
  })
})

describe('newSessionId', () => {
  it('稳定成型且不同调用不同', () => {
    expect(newSessionId(1000, () => 0.5)).not.toBe(newSessionId(1000, () => 0.9))
  })
})
