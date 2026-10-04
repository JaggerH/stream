// src/board/run-source.ts — 研究 run 采集源(设计 §5)。盯 cockpit_sdk 落盘的 artifacts
// 目录(后端在宿主上直接读文件系统),每个 run 一条 raw item 进 feed:订阅/提醒/频道
// 全部白拿。去重靠 guid 稳定 + 采集管线 dedup-store(stream-pipeline.ts itemId=guid)。
// 解析失败一律抛错带文件路径——宁可这轮采集红,不造空成功。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuiltinFn } from '../adapters/builtin/adapter.ts'
import { runGuid } from '../../shared/research/run-guid.ts'

export interface RunManifest {
  schema: string
  id: string
  name: string
  variant: string | null
  tags: string[]
  params: Record<string, unknown>
  status: string
  metrics: Record<string, unknown>
  artifacts: Array<{ name: string; view: string }>
  created_at: string
  finished_at: string | null
}

export function readRunManifest(dir: string, runId: string): RunManifest {
  const file = join(dir, runId, 'run.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`invalid JSON in ${file}`)
  }
  const m = parsed as Partial<RunManifest> & { schema?: string }
  if (m.schema !== 'run/v1' || typeof m.id !== 'string' || typeof m.name !== 'string') {
    throw new Error(`${file} is not a cockpit_sdk run/v1 manifest (schema=${String(m.schema)})`)
  }
  return {
    schema: m.schema, id: m.id, name: m.name, variant: m.variant ?? null, tags: m.tags ?? [],
    params: (m.params ?? {}) as Record<string, unknown>, status: m.status ?? 'unknown',
    metrics: (m.metrics ?? {}) as Record<string, unknown>, artifacts: m.artifacts ?? [],
    created_at: m.created_at ?? '', finished_at: m.finished_at ?? null,
  }
}

/** run 目录清单:子目录里有 run.json 的,id 降序(run id 时间戳前缀 → 新的在前)。 */
export function listRunIds(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try { readFileSync(join(dir, name, 'run.json'), 'utf8'); return true } catch { return false }
    })
    .sort((a, b) => b.localeCompare(a))
}

/** artifactsDir 的解析顺序：成员 params > 源级 runtimeConfig。
 *  params 优先是为了「一个 research-runs 源，多个 stream 各盯一个目录」——
 *  runtimeConfigFor 是按 manifest 解析的，只有源级那一份，装不下第二个目录。 */
export function artifactsDirOf(
  params?: Record<string, unknown>,
  context?: { runtimeConfig: Record<string, unknown> },
): string {
  const fromParams = params?.artifactsDir
  if (typeof fromParams === 'string' && fromParams) return fromParams
  const dir = context?.runtimeConfig.artifactsDir
  if (typeof dir !== 'string' || !dir) {
    throw new Error('research source: artifactsDir 未配置(在源配置或该 stream 成员的 params 里填 artifacts 目录绝对路径)')
  }
  return dir
}

function metricsSummary(metrics: Record<string, unknown>): string {
  const parts = Object.entries(metrics).slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toPrecision(4)) : String(v)}`)
  return parts.join('  ')
}

export const researchRunsFn: BuiltinFn = async (_input, params, context) => {
  const dir = artifactsDirOf(params, context)
  return listRunIds(dir).map((runId) => {
    const run = readRunManifest(dir, runId)
    const lines = [metricsSummary(run.metrics), run.tags.length ? `#${run.tags.join(' #')}` : '', `status: ${run.status}`]
    return {
      guid: runGuid(run.id),
      title: run.variant ? `${run.name} · ${run.variant}` : run.name,
      description: lines.filter(Boolean).join('\n'),
      pubDate: run.created_at,
      author: 'research',
      category: run.tags,
    }
  })
}
