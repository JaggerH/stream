import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RecipeDecision } from './recipe-conflict.ts'

/** 一次导入留下的「待拍板事项」。kind 决定 subject/mine/theirs 里装什么（见 spec §4）。 */
/** `source-ambiguous`：旧 bundle 里写的是裸名，而本机有 ≥2 个同名候选、又分不出内置那条
 *  （见 `Registry.get` 的第 4 级）。**不静默挑一个，也不让整份导入失败**——落一条 open item，
 *  `choices` 就是候选全名，等用户拍板。与 `parked-provider` 同一个模式，不新造机制。 */
export type ImportItemKind = 'parked-provider' | 'slot-conflict' | 'notice' | 'source-ambiguous'
export type ImportItemStatus = 'open' | 'decided' | 'dismissed'

export interface ImportItem {
  id: string
  kind: ImportItemKind
  status: ImportItemStatus
  decidedAt?: string
  /** 已拍板时：选了哪个（choices 之一）。 */
  choice?: string
  subject: Record<string, unknown>
  /** 本机现状（冲突类才有）。 */
  mine?: Record<string, unknown>
  /** 包内传入（id 已 remap）。 */
  theirs?: Record<string, unknown>
  choices: string[]
  /** 人可读一句话（UI/AI 共用）；decision 执行失败时把原因写回这里。 */
  detail: string
}

/** 一次导入 = 一个可寻址资源。bundle meta 只存这一份（不再抄进每个条目）。 */
export interface ImportRun {
  id: string
  at: string
  meta: { title: string; author?: string; revision: string }
  remaps: Record<string, string>
  recipeDecisions: Record<string, RecipeDecision>
  /** 网盘 binding 待转存清单——rebind 走既有端点，不进 items。 */
  netdiskBindings: { id: string; title: string; shareUrl?: string }[]
  items: ImportItem[]
}

/** 本机私有导入台账：JSON、原子 tmp+rename、坏文件冷启动空表（照 import-problems-store 的模式）。
 *  离线、绝不外发。decision 是唯一状态迁移入口（patchItem）。 */
export class ImportRunStore {
  private runs_: ImportRun[]
  constructor(private readonly path: string) {
    this.runs_ = this.load()
  }
  private load(): ImportRun[] {
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return Array.isArray(parsed) ? (parsed as ImportRun[]) : []
    } catch {
      return []
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.import-runs.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.runs_, null, 2))
    renameSync(tmp, this.path)
  }
  create(run: ImportRun): void {
    this.runs_.push(run)
    this.persist()
  }
  get(id: string): ImportRun | undefined {
    return this.runs_.find((r) => r.id === id)
  }
  /** at 倒序（新的在前）。 */
  list(): ImportRun[] {
    return [...this.runs_].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }
  patchItem(runId: string, itemId: string, patch: Partial<Pick<ImportItem, 'status' | 'choice' | 'decidedAt' | 'detail'>>): ImportItem | undefined {
    const run = this.get(runId)
    const item = run?.items.find((i) => i.id === itemId)
    if (!run || !item) return undefined
    Object.assign(item, patch)
    this.persist()
    return item
  }
}
