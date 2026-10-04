// src/intent/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IntentRecord, Ledger } from './types.ts'

/** 意图清单 + 每意图账本/档案。照 EventStore 的模式：小 JSON 文件，整读整写。
 *  目录约定：`<dir>/intents.json`、`<dir>/<id>/ledger.json`、`<dir>/<id>/dossier.md`。 */
export class IntentStore {
  private intents: IntentRecord[] = []
  /** 每意图账本条数缓存——list() 高频调用不再整读账本文件（phase2 spec §4）。 */
  private counts = new Map<string, number>()

  constructor(private readonly dir: string) {
    const path = join(dir, 'intents.json')
    if (!existsSync(path)) return // 首次运行 → 静默空起
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(raw)) this.intents = raw
    } catch (e) {
      // 文件存在但解析失败——不能静默空起再 save() 覆盖用户数据：先把原文件挪走留档，
      // 再空清单开始。
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`)
      } catch { /* rename 失败也别崩构造函数 */ }
      console.error(`[intent] intents.json 解析失败，已备份原文件并以空清单起：${(e as Error).message}`)
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, 'intents.json')
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.intents, null, 2))
    renameSync(tmp, path)
  }

  list(): IntentRecord[] {
    return [...this.intents]
  }

  get(id: string): IntentRecord | null {
    return this.intents.find((i) => i.id === id) ?? null
  }

  create(input: { goal: string; criteria: string; metadata?: string; streamIds?: string[]; cadenceHours?: number }): IntentRecord {
    const rec: IntentRecord = {
      id: randomUUID(),
      goal: input.goal,
      criteria: input.criteria,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      streamIds: input.streamIds ?? [],
      cadenceHours: input.cadenceHours ?? 24,
      status: 'active',
      createdAt: Date.now(),
    }
    this.intents.push(rec)
    this.save()
    return rec
  }

  put(id: string, patch: Partial<IntentRecord>): IntentRecord | null {
    const idx = this.intents.findIndex((i) => i.id === id)
    if (idx < 0) return null
    this.intents[idx] = { ...this.intents[idx], ...patch, id }
    this.save()
    return this.intents[idx]
  }

  private ledgerPath(id: string): string {
    return join(this.dir, id, 'ledger.json')
  }

  ledger(id: string): Ledger {
    try {
      return JSON.parse(readFileSync(this.ledgerPath(id), 'utf8')) as Ledger
    } catch {
      return {}
    }
  }

  appendLedger(id: string, entries: Ledger): void {
    const merged = { ...this.ledger(id), ...entries }
    mkdirSync(join(this.dir, id), { recursive: true })
    writeFileSync(this.ledgerPath(id), JSON.stringify(merged))
    this.counts.set(id, Object.keys(merged).length)
  }

  ledgerCount(id: string): number {
    const cached = this.counts.get(id)
    if (cached !== undefined) return cached
    const n = Object.keys(this.ledger(id)).length
    this.counts.set(id, n)
    return n
  }

  dossier(id: string): string {
    try {
      return readFileSync(join(this.dir, id, 'dossier.md'), 'utf8')
    } catch {
      return ''
    }
  }

  writeDossier(id: string, md: string): void {
    mkdirSync(join(this.dir, id), { recursive: true })
    const prev = this.dossier(id)
    if (prev) writeFileSync(join(this.dir, id, 'dossier.prev.md'), prev)
    writeFileSync(join(this.dir, id, 'dossier.md'), md)
  }
}
