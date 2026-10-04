import { describe, it, expect, vi } from 'vitest'
import { executePlan, undoMove } from './execute.ts'
import { DecisionStore, ProvenanceLog } from './decisions.ts'
import { openNetdiskDb } from '../db.ts'
import type { PlanAction } from './plan.ts'

/**
 * 掉钉修复（spec 2026-08-24-conversational-reconcile §4 前置依赖 #1）：
 * 决定行的组合键里拼着文件路径，execute 的本职是改路径——搬完不迁，用户采纳过的裁决
 * 在新路径上全部跟丢、同一份文件二次出卡（2026-08-24 发发大王活体：采纳 5 张后
 * 346/49/271 全部复发，每张要答两遍）。
 */
const mkDeps = () => {
  const db = openNetdiskDb(':memory:')
  const decisions = new DecisionStore(db, 'openlist')
  return {
    decisions,
    deps: {
      // 这一组用例只搬不删，删前核体量的那次列目录用不上（列空即可）。
      alist: { mkdir: vi.fn(async () => {}), move: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), listDirRecursive: vi.fn(async () => []) },
      provenance: new ProvenanceLog(db),
      decisions,
      log: () => {},
    },
  }
}

const move = (path: string, dstDir: string): PlanAction => ({
  kind: 'move',
  src: { path, name: path.slice(path.lastIndexOf('/') + 1), size: 1 },
  dstDir,
  basis: 'authority:item:x',
})

describe('决定行随搬运迁移（掉钉修复）', () => {
  it('is-episode 钉子跟着文件走：搬完后旧路径查无、新路径命中', async () => {
    const { decisions, deps } = mkDeps()
    decisions.setIsEpisode('item:346', '/share/346期.mp3')
    await executePlan([move('/share/346期.mp3', '/lib/付费')], deps)
    expect(decisions.pinnedFor('item:346')).toBe('/lib/付费/346期.mp3')
  })

  it('not-episode 同样跟着走', async () => {
    const { decisions, deps } = mkDeps()
    decisions.setNotEpisode('item:295', '/share/295期.mp3')
    await executePlan([move('/share/295期.mp3', '/lib/下架')], deps)
    expect(decisions.isNotEpisode('item:295', '/lib/下架/295期.mp3')).toBe(true)
    expect(decisions.isNotEpisode('item:295', '/share/295期.mp3')).toBe(false)
  })

  it('prefer 键两侧各自迁：搬的是 kept 侧也好、loser 侧也好，配对关系都不丢', async () => {
    const { decisions, deps } = mkDeps()
    decisions.setPreferred('/share/a.mp3', '/share/b.mp3')
    await executePlan([move('/share/a.mp3', '/lib')], deps)
    expect(decisions.preferredOf('/lib/a.mp3', '/share/b.mp3')).toBe('/lib/a.mp3')
    await executePlan([move('/share/b.mp3', '/lib2')], deps)
    expect(decisions.preferredOf('/lib/a.mp3', '/lib2/b.mp3')).toBe('/lib/a.mp3')
  })

  it('leftKey 恰好长得像被搬的路径时不误迁（is-episode 第一格是集身份，不是文件）', async () => {
    const { decisions, deps } = mkDeps()
    // 构造一个 leftKey 与文件路径同字符串的极端情况
    decisions.setIsEpisode('/share/x.mp3', '/share/other.mp3')
    await executePlan([move('/share/x.mp3', '/lib')], deps)
    // 集身份键保持原样——只有文件那一格才跟搬运
    expect(decisions.pinnedFor('/share/x.mp3')).toBe('/share/other.mp3')
  })

  it('kind/at 原样保留——迁移不是新决定', async () => {
    const { decisions, deps } = mkDeps()
    decisions.setIsEpisode('item:1', '/share/f.mp3')
    const before = Object.entries(decisions.list().isEpisodes)[0][1].at
    await executePlan([move('/share/f.mp3', '/lib')], deps)
    const [key, val] = Object.entries(decisions.list().isEpisodes)[0]
    expect(key).toContain('/lib/f.mp3')
    expect(val.at).toBe(before)
  })

  it('undo 把文件搬回去，决定行也跟回去', async () => {
    const { decisions, deps } = mkDeps()
    decisions.setIsEpisode('item:1', '/share/f.mp3')
    await executePlan([move('/share/f.mp3', '/lib')], deps)
    const provId = deps.provenance.list()[0].id
    await undoMove(provId, deps)
    expect(decisions.pinnedFor('item:1')).toBe('/share/f.mp3')
  })

  it('不接 decisions 的调用方（影视一键去重）原样跑，不炸', async () => {
    const { deps } = mkDeps()
    const bare = { alist: deps.alist, provenance: deps.provenance, log: deps.log }
    const r = await executePlan([move('/share/f.mp3', '/lib')], bare)
    expect(r.moved).toBe(1)
  })
})
