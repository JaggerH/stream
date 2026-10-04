import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRunStore, type ImportRun } from './import-run-store.ts'

function sampleRun(id = 'imp-000001'): ImportRun {
  return {
    id,
    at: '2026-07-24T00:00:00.000Z',
    meta: { title: '测试包', author: 'a', revision: '1.0.0' },
    remaps: { s1: 's1-imported' },
    recipeDecisions: {},
    netdiskBindings: [],
    items: [
      { id: 'itm-1', kind: 'notice', status: 'open', subject: { reason: 'missing-plugin', dep: 'xhs' }, choices: ['dismiss'], detail: '代码插件 xhs 未安装' },
      { id: 'itm-2', kind: 'parked-provider', status: 'open', subject: { providerId: 'p1' }, choices: ['use-imported', 'keep-mine', 'append', 'dismiss'], detail: '导入的 Provider p1 待激活' },
    ],
  }
}

describe('ImportRunStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-run-store-'))
    path = join(dir, 'import-runs.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('create + get + list（at 倒序）', () => {
    const store = new ImportRunStore(path)
    store.create(sampleRun('imp-a'))
    store.create({ ...sampleRun('imp-b'), at: '2026-07-25T00:00:00.000Z' })
    expect(store.get('imp-a')?.id).toBe('imp-a')
    expect(store.get('nope')).toBeUndefined()
    expect(store.list().map((r) => r.id)).toEqual(['imp-b', 'imp-a']) // 新的在前
  })

  it('持久化：重开进程（新实例）读回同样内容', () => {
    new ImportRunStore(path).create(sampleRun())
    const reopened = new ImportRunStore(path)
    expect(reopened.get('imp-000001')?.items).toHaveLength(2)
  })

  it('patchItem 更新条目并持久化；未知 run/item 返回 undefined 不写', () => {
    const store = new ImportRunStore(path)
    store.create(sampleRun())
    const patched = store.patchItem('imp-000001', 'itm-2', { status: 'decided', choice: 'use-imported', decidedAt: '2026-07-24T01:00:00.000Z' })
    expect(patched?.status).toBe('decided')
    expect(patched?.choice).toBe('use-imported')
    const reopened = new ImportRunStore(path)
    expect(reopened.get('imp-000001')?.items.find((i) => i.id === 'itm-2')?.status).toBe('decided')
    expect(store.patchItem('nope', 'itm-2', { status: 'dismissed' })).toBeUndefined()
    expect(store.patchItem('imp-000001', 'nope', { status: 'dismissed' })).toBeUndefined()
  })

  it('坏文件冷启动为空表，不 throw', () => {
    writeFileSync(path, '{not json')
    const store = new ImportRunStore(path)
    expect(store.list()).toEqual([])
    writeFileSync(path, '"a string"')
    expect(new ImportRunStore(path).list()).toEqual([])
  })

  it('原子写：落盘无 tmp 残留，内容是合法 JSON', () => {
    const store = new ImportRunStore(path)
    store.create(sampleRun())
    expect(existsSync(path)).toBe(true)
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
    const leftovers = readFileSync(path, 'utf8')
    expect(leftovers).toContain('imp-000001')
  })
})
