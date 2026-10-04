import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openRepo, type DiagnosticsRepo } from './repository.ts'
import { SAMPLE_CAP, EVENT_CAP } from './ring.ts'
import type { DiagEvent, DiagnosticSession, Sample } from './types.ts'

const session = (id: string, startedAt = 1000): DiagnosticSession => ({
  id, startedAt, lastWriteAt: startedAt, appVersion: 'test', ua: 'test', status: 'running',
})

const sample = (sessionId: string, at: number): Sample => ({
  sessionId, at, memory: null,
  dom: { nodes: 100, img: 1, video: 0, audio: 1 },
  route: '/podcast', visibility: 'visible', online: true, audio: null,
  resourceEntries: 5, longTasks: null,
})

const event = (sessionId: string, at: number): DiagEvent => ({ sessionId, at, kind: 'playing', media: null })

let repo: DiagnosticsRepo

// 每个测试一个全新的 IDBFactory —— 测试之间零共享状态
beforeEach(async () => {
  repo = await openRepo(new IDBFactory())
})

describe('会话恢复', () => {
  it('遗留的 running 会话在下次启动被改写为 suspected-abnormal', async () => {
    // 模拟「renderer 被杀 → 没人写 ended → 下次启动」：同一个 DB 重开
    const factory = new IDBFactory()
    const first = await openRepo(factory)
    await first.startSession(session('crashed'))
    first.close()
    const second = await openRepo(factory)

    const recovered = await second.recoverAbnormal()
    expect(recovered.map((s) => s.id)).toEqual(['crashed'])
    const stored = await second.listSessions()
    expect(stored.find((s) => s.id === 'crashed')!.status).toBe('suspected-abnormal')
  })

  it('恢复时保留原始时间线', async () => {
    const factory = new IDBFactory()
    const first = await openRepo(factory)
    await first.startSession(session('crashed'))
    await first.addSample(sample('crashed', 1))
    await first.addSample(sample('crashed', 2))
    await first.addEvent(event('crashed', 3))
    first.close()

    const second = await openRepo(factory)
    await second.recoverAbnormal()
    const bundle = await second.exportSession('crashed')
    expect(bundle!.samples).toHaveLength(2)
    expect(bundle!.events).toHaveLength(1)
    expect(bundle!.session.status).toBe('suspected-abnormal')
  })

  it('正常收尾的会话不被误报为异常', async () => {
    const factory = new IDBFactory()
    const first = await openRepo(factory)
    await first.startSession(session('clean'))
    await first.markEnded('clean')
    first.close()

    const second = await openRepo(factory)
    expect(await second.recoverAbnormal()).toEqual([])
    const stored = await second.listSessions()
    expect(stored.find((s) => s.id === 'clean')!.status).toBe('ended')
  })
})

describe('容量裁剪', () => {
  it('样本超上限时保留最新的', async () => {
    await repo.startSession(session('s'))
    for (let i = 0; i < SAMPLE_CAP + 10; i++) await repo.addSample(sample('s', i))
    const bundle = await repo.exportSession('s')
    expect(bundle!.samples).toHaveLength(SAMPLE_CAP)
    expect(bundle!.samples[0].at).toBe(10) // 最旧的 10 条被丢
    expect(bundle!.samples.at(-1)!.at).toBe(SAMPLE_CAP + 9)
  })

  it('事件超上限时保留最新的', async () => {
    await repo.startSession(session('s'))
    for (let i = 0; i < EVENT_CAP + 5; i++) await repo.addEvent(event('s', i))
    const bundle = await repo.exportSession('s')
    expect(bundle!.events).toHaveLength(EVENT_CAP)
    expect(bundle!.events.at(-1)!.at).toBe(EVENT_CAP + 4)
  })

  it('裁剪按会话隔离 —— 新会话写满不会挤掉崩溃会话的证据', async () => {
    await repo.startSession({ ...session('crashed', 1), status: 'suspected-abnormal' })
    await repo.addSample(sample('crashed', 42))

    await repo.startSession(session('current', 2))
    for (let i = 0; i < SAMPLE_CAP + 50; i++) await repo.addSample(sample('current', i))

    const crashed = await repo.exportSession('crashed')
    expect(crashed!.samples).toHaveLength(1)
    expect(crashed!.samples[0].at).toBe(42)
  })

  it('会话数超上限时丢最旧的历史会话及其样本', async () => {
    for (let i = 1; i <= 4; i++) {
      await repo.startSession({ ...session(`s${i}`, i), status: 'ended' })
      await repo.addSample(sample(`s${i}`, i))
    }
    const ids = (await repo.listSessions()).map((s) => s.id).sort()
    expect(ids).toEqual(['s2', 's3', 's4'])
    expect(await repo.exportSession('s1')).toBeNull()
  })
})

describe('导出与清除', () => {
  it('导出不存在的会话 → null', async () => {
    expect(await repo.exportSession('nope')).toBeNull()
  })

  it('导出带上 memory 指标边界的提示', async () => {
    await repo.startSession(session('s'))
    const bundle = await repo.exportSession('s')
    expect(bundle!.notes.join(' ')).toContain('performance.memory')
  })

  it('clear 清空全部诊断数据', async () => {
    await repo.startSession(session('s'))
    await repo.addSample(sample('s', 1))
    await repo.clear()
    expect(await repo.listSessions()).toEqual([])
    expect(await repo.exportSession('s')).toBeNull()
  })
})
