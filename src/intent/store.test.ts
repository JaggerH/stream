// src/intent/store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntentStore } from './store.ts'

describe('IntentStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intent-store-'))
  })

  it('create/list/get 往返，默认值就位', () => {
    const s = new IntentStore(dir)
    const rec = s.create({ goal: '跟踪 AI 硬件最新发展', criteria: '与 AI 芯片/推理硬件/机器人硬件相关' })
    expect(rec.id).toBeTruthy()
    expect(rec.streamIds).toEqual([])
    expect(rec.cadenceHours).toBe(24)
    expect(rec.status).toBe('active')
    expect(s.list()).toHaveLength(1)
    expect(s.get(rec.id)?.goal).toBe('跟踪 AI 硬件最新发展')
    // 持久化：新实例读同一目录
    expect(new IntentStore(dir).get(rec.id)?.criteria).toContain('AI 芯片')
  })

  it('put 打补丁并持久化；未知 id 回 null', () => {
    const s = new IntentStore(dir)
    const rec = s.create({ goal: 'g', criteria: 'c' })
    expect(s.put(rec.id, { status: 'retired', lastDigestAt: 123 })?.status).toBe('retired')
    expect(new IntentStore(dir).get(rec.id)?.lastDigestAt).toBe(123)
    expect(s.put('nope', { status: 'retired' })).toBeNull()
  })

  it('ledger 初始为空，appendLedger 合并且持久化', () => {
    const s = new IntentStore(dir)
    const rec = s.create({ goal: 'g', criteria: 'c' })
    expect(s.ledger(rec.id)).toEqual({})
    s.appendLedger(rec.id, { item1: { relevant: true, summary: '讲了 A', at: 1 } })
    s.appendLedger(rec.id, { item2: { relevant: false, at: 2 } })
    const led = new IntentStore(dir).ledger(rec.id)
    expect(Object.keys(led).sort()).toEqual(['item1', 'item2'])
    expect(led.item1.summary).toBe('讲了 A')
  })

  it('dossier 初始为空串，writeDossier 覆盖写并持久化', () => {
    const s = new IntentStore(dir)
    const rec = s.create({ goal: 'g', criteria: 'c' })
    expect(s.dossier(rec.id)).toBe('')
    s.writeDossier(rec.id, '# 档案\n内容')
    expect(new IntentStore(dir).dossier(rec.id)).toBe('# 档案\n内容')
  })

  it('intents.json 存在但解析失败 → 备份原文件、console.error 一条、以空清单起（F5）', () => {
    const path = join(dir, 'intents.json')
    writeFileSync(path, '{ 坏 json 不闭合')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = new IntentStore(dir)
      expect(s.list()).toEqual([])
      expect(existsSync(path)).toBe(false)
      const corrupt = readdirSync(dir).filter((f) => f.startsWith('intents.json.corrupt-'))
      expect(corrupt).toHaveLength(1)
      expect(readFileSync(join(dir, corrupt[0]), 'utf8')).toBe('{ 坏 json 不闭合')
      expect(errSpy).toHaveBeenCalled()
      // save() 之后 intents.json 可读——不是被静默覆盖掉的坏文件
      s.create({ goal: 'g', criteria: 'c' })
      expect(new IntentStore(dir).list()).toHaveLength(1)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('save() 是原子写：写完 tmp 文件不残留', () => {
    const s = new IntentStore(dir)
    s.create({ goal: 'g', criteria: 'c' })
    expect(existsSync(join(dir, 'intents.json.tmp'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'intents.json'), 'utf8'))).toHaveLength(1)
  })

  it('ledgerCount 走缓存且 appendLedger 增量维护', () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    expect(store.ledgerCount(rec.id)).toBe(0)
    store.appendLedger(rec.id, { a: { relevant: true, at: 1 } })
    expect(store.ledgerCount(rec.id)).toBe(1)
    store.appendLedger(rec.id, { a: { relevant: false, at: 2 }, b: { relevant: true, at: 2 } })
    expect(store.ledgerCount(rec.id)).toBe(2) // a 是覆盖不是新增
  })

  it('writeDossier 覆盖前把旧档案落 dossier.prev.md；首写不落', () => {
    const store = new IntentStore(dir)
    const rec = store.create({ goal: 'g', criteria: 'c' })
    store.writeDossier(rec.id, '第一版')
    expect(existsSync(join(dir, rec.id, 'dossier.prev.md'))).toBe(false)
    store.writeDossier(rec.id, '第二版')
    expect(readFileSync(join(dir, rec.id, 'dossier.prev.md'), 'utf8')).toBe('第一版')
    expect(store.dossier(rec.id)).toBe('第二版')
  })
})
