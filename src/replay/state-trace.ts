import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Feature, StateId } from './state-graph.ts'

/**
 * 一步的轨迹。**留的是决策的输入，不是决策本身**——只记「第 3 步点了 (620, 613)」是回溯不了的，
 * 看不出它当时**为什么**觉得那儿对。`identified.matched`（凭哪条特征判的）是这份轨迹的核心字段。
 */
export interface TraceEntry {
  seq: number
  ts: number
  observed?: { shot?: string; elements?: string }
  identified: {
    /** 命中的**全部**状态。跨组同时成立是正常的，只留一个会让排查看不见全貌。 */
    states: StateId[]
    reason?: 'no-match' | 'ambiguous'
    /**
     * 凭哪条特征判的。多命中时是**所有命中状态的特征并集**——配着 `states` 读，
     * 别以为它们都属于 `states[0]`。
     */
    matched: Feature[]
    candidates?: StateId[]
  }
  action?: { label?: string; from: StateId; to: StateId }
  /** **起步那次识别不写**：那一格根本没有判据可言，硬写 `expectMet:false` 会和
   *  「动作做了但没兑现」在文件里长得一模一样。 */
  outcome?: { expectMet: boolean }
}

export class StateTrace {
  readonly dir: string
  private seq = 0

  constructor(root: string, sourceId: string, runId: string) {
    // sourceId 常含 `/`（`qq/send`）。不替换的话它会在 root 底下多长一层目录，
    // 于是「一次运行一个目录」这个前提悄悄失效。
    this.dir = join(root, sourceId.replace(/[/\\]/g, '_'), runId)
    mkdirSync(this.dir, { recursive: true })
  }

  async write(entry: Omit<TraceEntry, 'seq' | 'ts'>): Promise<void> {
    const seq = this.seq++
    const full: TraceEntry = { seq, ts: Date.now(), ...entry }
    writeFileSync(join(this.dir, `${String(seq).padStart(3, '0')}.json`), JSON.stringify(full, null, 2))
  }
}
