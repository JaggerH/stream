/**
 * widget 挂载存储（openspec `widget-manifest`）：data/widgets.json，id → {dir, device}。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '../bootstrap.ts'
import type { AppConfig } from '../types.ts'

export interface WidgetRow {
  dir: string
  device: string
}

export function resolveWidgetsStore(config: Pick<AppConfig, 'item_db'>): string {
  const dataDir = resolveDataDir(config)
  return join(dataDir, 'widgets.json')
}

export class WidgetsStore {
  private readonly path: string
  constructor(path: string) { this.path = path }

  list(): Record<string, WidgetRow> {
    if (!existsSync(this.path)) return {}
    try {
      const raw = readFileSync(this.path, 'utf8')
      return JSON.parse(raw) as Record<string, WidgetRow>
    } catch {
      // 损坏文件：静默返回空表（v1 容错策略）
      return {}
    }
  }

  get(id: string): WidgetRow | undefined {
    const m = this.list()
    return m[id]
  }

  set(id: string, row: WidgetRow): void {
    const m = this.list()
    m[id] = row
    writeFileSync(this.path, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
  }

  delete(id: string): boolean {
    const m = this.list()
    if (!(id in m)) return false
    delete m[id]
    writeFileSync(this.path, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    return true
  }
}

export function createWidgetsStore(config: Pick<AppConfig, 'item_db'>): WidgetsStore {
  return new WidgetsStore(resolveWidgetsStore(config))
}
