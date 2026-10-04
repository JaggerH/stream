// src/jobs/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityJobStore } from './store.ts'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capability-job-store-'))
  dbPath = join(dir, 'capability-jobs.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('CapabilityJobStore', () => {
  it('enqueue 幂等:同 kind+input 复用既有 jobId,不新建行', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a' })
    const id2 = s.enqueue('stt', { itemId: 'a' })
    expect(id2).toBe(id1)
    const job = s.get(id1)!
    expect(job.status).toBe('queued')
  })

  it('enqueue 幂等判等对键序不敏感(input JSON 键序不同也算同一份)', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a', lang: 'zh' })
    const id2 = s.enqueue('stt', { lang: 'zh', itemId: 'a' })
    expect(id2).toBe(id1)
  })

  it('input 里含不同 Date 值判等键不同(不因内建对象退化成 {} 而误合并)', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a', at: new Date('2026-01-01T00:00:00.000Z') })
    const id2 = s.enqueue('stt', { itemId: 'a', at: new Date('2026-06-01T00:00:00.000Z') })
    expect(id2).not.toBe(id1)
  })

  it('input 里显式 undefined 字段与省略该字段判等键相同', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a', extra: undefined })
    const id2 = s.enqueue('stt', { itemId: 'a' })
    expect(id2).toBe(id1)
  })

  it('不同 kind 或不同 input 各自新建行', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a' })
    const id2 = s.enqueue('identify', { itemId: 'a' })
    const id3 = s.enqueue('stt', { itemId: 'b' })
    expect(new Set([id1, id2, id3]).size).toBe(3)
  })

  it('error 行重新排队时复用既有 jobId 并更新回 queued', () => {
    const s = new CapabilityJobStore(dbPath)
    const id1 = s.enqueue('stt', { itemId: 'a' })
    s.fail(id1, 'boom')
    expect(s.get(id1)!.status).toBe('error')
    const id2 = s.enqueue('stt', { itemId: 'a' })
    expect(id2).toBe(id1)
    const job = s.get(id1)!
    expect(job.status).toBe('queued')
    expect(job.error).toBeUndefined()
  })

  it('markRunning 转 running 状态', () => {
    const s = new CapabilityJobStore(dbPath)
    const id = s.enqueue('stt', { itemId: 'a' })
    s.markRunning(id)
    expect(s.get(id)!.status).toBe('running')
  })

  it('appendChunk 推进 chunksDone 并更新 updatedAt', async () => {
    const s = new CapabilityJobStore(dbPath)
    const id = s.enqueue('stt', { itemId: 'a' })
    const before = s.get(id)!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    s.appendChunk(id, 'data/jobs/x/window-0.json')
    s.appendChunk(id, 'data/jobs/x/window-1.json')
    const job = s.get(id)!
    expect(job.chunksDone).toEqual(['data/jobs/x/window-0.json', 'data/jobs/x/window-1.json'])
    expect(job.updatedAt >= before).toBe(true)
  })

  it('complete 删行 + 删 data/jobs/<jobId>/ 目录', () => {
    const s = new CapabilityJobStore(dbPath)
    const id = s.enqueue('stt', { itemId: 'a' })
    const jobDir = join(dir, 'jobs', id)
    mkdirSync(jobDir, { recursive: true })
    writeFileSync(join(jobDir, 'window-0.json'), '{}')
    expect(existsSync(jobDir)).toBe(true)
    s.complete(id)
    expect(s.get(id)).toBeNull()
    expect(existsSync(jobDir)).toBe(false)
  })

  it('complete 在目录不存在时也不抛(force 删除幂等)', () => {
    const s = new CapabilityJobStore(dbPath)
    const id = s.enqueue('stt', { itemId: 'a' })
    expect(() => s.complete(id)).not.toThrow()
    expect(s.get(id)).toBeNull()
  })

  it('get 查不到返回 null', () => {
    const s = new CapabilityJobStore(dbPath)
    expect(s.get('nope')).toBeNull()
  })

  it('complete 对含路径穿越的 jobId 拒绝执行,不删任何东西(jobDir 校验 UUID 形态)', () => {
    const s = new CapabilityJobStore(dbPath)
    const id = s.enqueue('stt', { itemId: 'a' })
    // 仓库根目录外一个真实存在的哨兵文件:如果校验缺位,'../../etc' 拼出的路径会
    // 递归强删到仓库外,这里断言它压根没被碰到。
    const sentinelDir = mkdtempSync(join(tmpdir(), 'capability-job-store-sentinel-'))
    const sentinelFile = join(sentinelDir, 'do-not-delete.txt')
    writeFileSync(sentinelFile, 'still here')
    try {
      expect(() => s.complete('../../etc')).toThrow(/invalid jobId/)
      // 拒绝发生在 DB 删除之前:合法行不受牵连
      expect(s.get(id)).not.toBeNull()
      expect(existsSync(sentinelFile)).toBe(true)
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true })
    }
  })

  describe('recover', () => {
    it('新鲜 queued 行被返回', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      const rows = s.recover(() => Date.now())
      expect(rows.map((r) => r.jobId)).toContain(id)
    })

    it('新鲜 running 行被返回', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.markRunning(id)
      const rows = s.recover(() => Date.now())
      expect(rows.map((r) => r.jobId)).toContain(id)
      expect(rows.find((r) => r.jobId === id)!.status).toBe('running')
    })

    it('超 24h 的 queued/running 残留标 error 且不返回', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.markRunning(id)
      const base = Date.now()
      const rows = s.recover(() => base + 25 * HOUR)
      expect(rows.map((r) => r.jobId)).not.toContain(id)
      const job = s.get(id)!
      expect(job.status).toBe('error')
      expect(job.error).toBe('stale, superseded on restart')
    })

    it('恰好 24h 边界内(< 24h)仍然返回,不误杀', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      const base = Date.now()
      const rows = s.recover(() => base + 23 * HOUR)
      expect(rows.map((r) => r.jobId)).toContain(id)
      expect(s.get(id)!.status).toBe('queued')
    })

    it('error 行不参与 recover(不是 queued/running)', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.fail(id, 'boom')
      const rows = s.recover(() => Date.now())
      expect(rows.map((r) => r.jobId)).not.toContain(id)
    })
  })

  describe('sweep', () => {
    it('error 行超 7 天删除(连目录)', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.fail(id, 'boom')
      const jobDir = join(dir, 'jobs', id)
      mkdirSync(jobDir, { recursive: true })
      const base = Date.now()
      const result = s.sweep(() => base + 8 * DAY)
      expect(result.removed).toBe(1)
      expect(s.get(id)).toBeNull()
      expect(existsSync(jobDir)).toBe(false)
    })

    it('error 行未满 7 天不动', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.fail(id, 'boom')
      const base = Date.now()
      const result = s.sweep(() => base + 6 * DAY)
      expect(result.removed).toBe(0)
      expect(s.get(id)).not.toBeNull()
    })

    it('不足 1000 行时不因容量而动 queued/running 行', () => {
      const s = new CapabilityJobStore(dbPath)
      const id = s.enqueue('stt', { itemId: 'a' })
      s.markRunning(id)
      const result = s.sweep(() => Date.now())
      expect(result.removed).toBe(0)
      expect(s.get(id)).not.toBeNull()
    })

    it('总行数超 1000 时先删最老的 error 行(容量顶不动 queued/running)', () => {
      const s = new CapabilityJobStore(dbPath)
      // 造 3 个 error 行(created 顺序即 updated_at 顺序,最先 fail 的最老)+ 1 个 running 行,
      // 用一个小 MAX 场景不现实(硬顶是 1000),这里用真实规模验证"最老先走 + 活跃行不动"这两条语义:
      // 直接灌 1001 个 error 行 + 1 个 running 行,断言总数收敛到 1000 且 running 幸存、
      // 幸存的 error 行都比最先造的那批新。
      const errorIds: string[] = []
      for (let i = 0; i < 1001; i++) {
        const id = s.enqueue('stt', { itemId: `err-${i}` })
        s.fail(id, 'boom')
        errorIds.push(id)
      }
      const runningId = s.enqueue('stt', { itemId: 'keep-me' })
      s.markRunning(runningId)

      const result = s.sweep(() => Date.now())
      expect(result.removed).toBe(2) // 1002 行 → 1000,删 2 个最老的 error 行
      expect(s.get(runningId)).not.toBeNull()
      expect(s.get(runningId)!.status).toBe('running')
      // 最先造的两个 error 行(最老)必须已被删掉
      expect(s.get(errorIds[0])).toBeNull()
      expect(s.get(errorIds[1])).toBeNull()
      // 后面造的 error 行还在
      expect(s.get(errorIds[errorIds.length - 1])).not.toBeNull()
    })
  })
})
