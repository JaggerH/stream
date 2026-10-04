import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openNetdiskDb } from '../db.ts'
import { RunLedger, EXPLAIN_RETAIN_RUNS, type RunRecord } from './ledger.ts'
import type { RowExplain } from '../match-engine/explain.ts'

const explainOf = (path: string): RowExplain => ({
  file: { path, sizeBytes: 1, durationS: 60, kbps: 1 },
  edges: [],
  verdict: { rule: 'R2', disposition: 'claimed', thresholds: {} },
})

const runOf = (show: string, i: number): RunRecord => ({
  runId: `r${show}${i}`,
  at: new Date(0).toISOString(),
  show,
  mode: 'preview',
  counts: { input: 1, claimed: 1, offline: 0, copy: 0, hold: 0, dup: 0, exempt: 0 },
  conservation: true,
  authority: { entries: 1, paid: 0, withDuration: 1, needsSupply: 0 },
  rows: [{ path: `/f/${i}.mp3`, size: 1, verdict: 'claimed', basis: 'authority:x', action: 'none', explain: explainOf(`/f/${i}.mp3`) }],
  secondaryReview: { checked: 1, rows: [{ path: `/s/${i}.mp3`, size: 1, verdict: 'copy', basis: 'shelf-copy-of:/x', action: 'none', explain: explainOf(`/s/${i}.mp3`) }] },
  errors: [],
})

describe('判决书按 show 只保最近 N 轮：窗外剥 explain、其余字段原样', () => {
  it('超窗后老轮次的 explain（含下架复核小节）被剥掉，结论字段一字不动；别的 show 不受牵连', () => {
    const db = openNetdiskDb(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'n.db'))
    const ledger = new RunLedger(db)
    const total = EXPLAIN_RETAIN_RUNS + 5
    for (let i = 0; i < total; i++) {
      ledger.append(runOf('yile', i))
      ledger.append(runOf('other', i)) // 交错写入：窗口必须按 show 各自数，不许混着数
    }
    for (const show of ['yile', 'other']) {
      const runs = ledger.list({ show, limit: total }) // 新→旧
      expect(runs).toHaveLength(total)
      runs.forEach((r, idx) => {
        const inWindow = idx < EXPLAIN_RETAIN_RUNS
        expect(r.rows[0].explain !== undefined, `${show} 第${idx}新的轮`).toBe(inWindow)
        expect(r.secondaryReview!.rows[0].explain !== undefined).toBe(inWindow)
        // 剥的只是 explain：结论字段原样
        expect(r.rows[0].verdict).toBe('claimed')
        expect(r.rows[0].basis).toBe('authority:x')
        expect(r.secondaryReview!.checked).toBe(1)
      })
    }
  })

  it('窗内轮次一直带着 explain（不足 N 轮时一条都不剥）', () => {
    const db = openNetdiskDb(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'n.db'))
    const ledger = new RunLedger(db)
    for (let i = 0; i < 5; i++) ledger.append(runOf('yile', i))
    for (const r of ledger.list({ show: 'yile', limit: 10 })) expect(r.rows[0].explain).toBeDefined()
  })
})
