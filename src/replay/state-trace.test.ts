import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateTrace } from './state-trace.ts'

const newRoot = () => mkdtempSync(join(tmpdir(), 'state-trace-'))

describe('StateTrace', () => {
  it('每步一个按序号补零的文件，序号从 0 开始', async () => {
    const t = new StateTrace(newRoot(), 'qq/send', 'run1')
    await t.write({ identified: { states: ['a'], matched: [] }, outcome: { expectMet: true } })
    await t.write({ identified: { states: ['b'], matched: [] }, outcome: { expectMet: true } })
    expect(readdirSync(t.dir).sort()).toEqual(['000.json', '001.json'])
  })

  it('落盘的条目带 seq 与 ts，并保留判据', async () => {
    const t = new StateTrace(newRoot(), 'qq/send', 'run1')
    const matched = [{ kind: 'dom', selector: '.feed' } as const]
    await t.write({ identified: { states: ['a'], matched }, outcome: { expectMet: false } })
    const got = JSON.parse(readFileSync(join(t.dir, '000.json'), 'utf8'))
    expect(got.seq).toBe(0)
    expect(typeof got.ts).toBe('number')
    expect(got.identified.matched).toEqual(matched)
  })

  it('sourceId 里的斜杠不会打穿目录层级', async () => {
    const root = newRoot()
    const t = new StateTrace(root, 'qq/send', 'run1')
    await t.write({ identified: { states: [], reason: 'no-match', matched: [] }, outcome: { expectMet: false } })
    expect(t.dir.startsWith(root)).toBe(true)
    expect(readdirSync(root)).toEqual(['qq_send'])
  })
})
