import type { InvokeResult } from './executor.ts'
import { resolveRungs } from './ladder-trace.ts'
import type { DebugEntry, DebugField } from '../debug.ts'

/** Build a resolve DebugEntry straight from the executor ladder (via / rungs / total ms) — this is
 *  how video playback + transcription ride the same debug plumbing as audio: the box shows which
 *  source won (`via`) or why each declined/failed. `opts.verb` names the action in the summary
 *  ('在线解析' for playback, '转写' for STT); `opts.extra` fields sit before the per-rung list. */
export function buildResolveEntry(
  channel: string,
  platform: string,
  key: string,
  res: InvokeResult | null,
  opts?: { verb?: string; extra?: DebugField[] },
): DebugEntry {
  const at = Date.now()
  const verb = opts?.verb ?? '在线解析'
  const rungs = resolveRungs(res)
  const via = res && res.strategy === 'sequential' ? res.via : null
  const totalMs = rungs.reduce((s, r) => s + r.ms, 0)
  const ok = !!via
  const summary = ok ? `${verb}：${via} ${totalMs}ms 命中` : `${verb}失败：试了 ${rungs.length} 个源都没结果`
  const fields: DebugField[] = [{ label: '平台', value: platform }, { label: '耗时', value: `${totalMs}ms` }]
  if (via) fields.push({ label: '来源', value: via, tone: 'ok' })
  // 「没人专门接这个键，是兜底行接的」——一条正常跑完的调用和一条被兜底行接走的调用，结果
  // 长得一模一样，差别只在选行那一刻。不摆到脸上，排查时没人会想到去问。
  if (res?.viaFallback) fields.push({ label: '路由', value: `兜底行 ${res.provider}（无专属行接 ${key}）`, tone: 'warn' })
  if (opts?.extra) fields.push(...opts.extra)
  for (const r of rungs) {
    fields.push({
      label: r.member,
      value: `${r.ms}ms · ${r.outcome}${r.reason ? ' · ' + r.reason : ''}`,
      tone: r.outcome === 'win' ? 'ok' : r.outcome === 'error' ? 'bad' : r.outcome === 'rejected' ? 'muted' : 'warn',
    })
  }
  if (res && res.misses) {
    for (const m of res.misses) {
      if (m.stack) {
        fields.push({
          label: `${m.member} 调用栈`,
          value: m.stack,
          tone: 'muted',
        })
      }
    }
  }
  return { id: `${channel}:${platform}:${key}@${at}`, at, channel, key: `${platform}:${key}`, title: `${platform}:${key}`, summary, ok, fields }
}
