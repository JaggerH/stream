import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFailureSink, FAILURE_FILE } from './debug-sink.ts'
import type { DebugEntry } from '../debug.ts'

function entry(over: Partial<DebugEntry> = {}): DebugEntry {
  return {
    id: 'ext-cdp:relay-slow@1',
    at: 1,
    channel: 'ext-cdp',
    key: 'relay-slow',
    title: '中继：relay-slow',
    summary: 'Page.navigate 挂了 29927ms',
    ok: false,
    fields: [{ label: 'command', value: 'Page.navigate' }],
    ...over,
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'debug-sink-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = () =>
  readFileSync(join(dir, FAILURE_FILE), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

describe('createFailureSink', () => {
  it('appends failures as one JSON line each, newest last', () => {
    const sink = createFailureSink(dir)
    sink(entry({ id: 'a', summary: '第一条' }))
    sink(entry({ id: 'b', summary: '第二条' }))
    expect(lines().map((e) => e.summary)).toEqual(['第一条', '第二条'])
  })

  it('drops ok entries — the ring already shows the happy path, the file is for evidence', () => {
    const sink = createFailureSink(dir)
    sink(entry({ ok: true }))
    expect(existsSync(join(dir, FAILURE_FILE))).toBe(false)
  })

  it('survives a fresh sink over an existing file (process restart keeps history)', () => {
    createFailureSink(dir)(entry({ id: 'before-restart' }))
    createFailureSink(dir)(entry({ id: 'after-restart' }))
    expect(lines().map((e) => e.id)).toEqual(['before-restart', 'after-restart'])
  })

  // 轮转用的是**互不相同**的条目——真实文件就是这么涨的，而一字不差的重复会先被折叠掉
  // （见下面那组），拿它们撑体积等于测不到轮转。
  it('rotates to .1 once the file passes maxBytes, so it cannot grow unbounded', () => {
    const sink = createFailureSink(dir, { maxBytes: 100 })
    sink(entry({ id: 'old', summary: '第一次现场' }))
    sink(entry({ id: 'new', summary: '第二次现场' })) // 第一条已越界 → 轮转后自己开新文件
    expect(lines().map((e) => e.id)).toEqual(['new'])
    const rotated = readFileSync(join(dir, FAILURE_FILE + '.1'), 'utf8')
    expect(rotated).toContain('"old"')
  })

  it('rotation keeps exactly one generation — .1 is overwritten, never .2', () => {
    const sink = createFailureSink(dir, { maxBytes: 100 })
    sink(entry({ id: 'gen1', summary: '现场一' }))
    sink(entry({ id: 'gen2', summary: '现场二' }))
    sink(entry({ id: 'gen3', summary: '现场三' }))
    expect(existsSync(join(dir, FAILURE_FILE + '.2'))).toBe(false)
    expect(readFileSync(join(dir, FAILURE_FILE + '.1'), 'utf8')).toContain('"gen2"')
  })

  // 折叠：常态噪音（voiceprint「容器睡着所以没地址」每分钟一条、内容一字不差，实测 21 小时
  // 1184 条）会把真正要等的偶发现场挤出轮转窗口。
  describe('折叠一字不差的重复条目', () => {
    it('窗口内的重复只落第一条', () => {
      let t = 0
      const sink = createFailureSink(dir, { dedupeWindowMs: 1000, now: () => t })
      sink(entry({ id: 'a' }))
      t = 500
      sink(entry({ id: 'b' })) // id 不同但内容一字不差 → 折叠
      expect(lines()).toHaveLength(1)
    })

    it('窗口过后再落一条，并带出这段时间被折叠掉的条数', () => {
      let t = 0
      const sink = createFailureSink(dir, { dedupeWindowMs: 1000, now: () => t })
      sink(entry())
      t = 200; sink(entry())
      t = 400; sink(entry())
      t = 1200; sink(entry()) // 出窗 → 落盘，带 _repeated:2
      const out = lines()
      expect(out).toHaveLength(2)
      expect(out[0]._repeated).toBeUndefined() // 第一条没被折叠过，就不该有这个字段
      expect(out[1]._repeated).toBe(2)
    })

    // 这条是折叠判据的**边界**：真实现场的 summary 里带着耗时/状态码，判据一旦放宽成
    // channel+key，同一 key 的第二次真现场就会被前一条挡掉——那正是这个文件存在的理由。
    it('summary 只要有一个字不同就各自落盘（同 channel 同 key 也不折叠）', () => {
      let t = 0
      const sink = createFailureSink(dir, { dedupeWindowMs: 100_000, now: () => t })
      sink(entry({ summary: 'Page.navigate 挂了 29927ms' }))
      t = 1
      sink(entry({ summary: 'Page.navigate 挂了 29220ms' }))
      expect(lines()).toHaveLength(2)
    })

    it('fields 不同也各自落盘（summary 相同但细节不同的两次现场）', () => {
      let t = 0
      const sink = createFailureSink(dir, { dedupeWindowMs: 100_000, now: () => t })
      sink(entry({ fields: [{ label: 'host', value: 'a.example' }] }))
      t = 1
      sink(entry({ fields: [{ label: 'host', value: 'b.example' }] }))
      expect(lines()).toHaveLength(2)
    })

    it('不同 key 互不影响（一条噪音刷屏不该挡住别的 key）', () => {
      let t = 0
      const sink = createFailureSink(dir, { dedupeWindowMs: 100_000, now: () => t })
      sink(entry({ key: 'voiceprint' }))
      t = 1; sink(entry({ key: 'voiceprint' })) // 折叠
      t = 2; sink(entry({ key: 'pansou' })) // 另一个 key，照落
      expect(lines().map((e) => e.key)).toEqual(['voiceprint', 'pansou'])
    })
  })

  it('never throws at the caller — an unwritable dir must not break the debug bus', () => {
    const missing = join(dir, 'no', 'such', 'dir')
    const sink = createFailureSink(missing)
    expect(() => sink(entry())).not.toThrow()
  })
})
