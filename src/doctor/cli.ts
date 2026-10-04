import { loadConfig, bootstrap } from '../bootstrap.ts'
import { quiesceKernel } from '../kernel/context.ts'
import { buildDoctorReport } from './report.ts'
import { classifyError } from '../failure.ts'

/**
 * `pnpm doctor` — read-only projection of the source health ledger. Prints, per source,
 * its active state, the reason for any degradation, and a prescription for any missing
 * cookie credential. `--reprobe <source>` fetches one source now and updates its state.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const ri = args.indexOf('--reprobe')
  const reprobeId = ri >= 0 ? args[ri + 1] : undefined
  const showTrace = args.includes('--trace')

  const boot = await bootstrap(loadConfig(), console.error)
  const { sourceHealth } = boot.kernel.stores

  if (reprobeId) {
    process.stderr.write(`re-probing ${reprobeId} …\n`)
    try {
      const items = await boot.kernel.scheduling.scheduler.readSource(reprobeId)
      sourceHealth.record(reprobeId, items.length ? { kind: 'ok', itemCount: items.length } : { kind: 'empty' })
      if (items.length) sourceHealth.markHealthy(reprobeId)
    } catch (e) {
      sourceHealth.record(reprobeId, { kind: 'error', ...classifyError(e) })
    }
  }

  const health = await boot.kernel.credentials.cookieHealth()
  // 快照空的时候 domains 也是空的——**不是"这些站都没登录态"**。不说这一句，下面每一行都会把
  // "还没从浏览器取过一轮"报成"缺凭证"，把人支去重新登录一遍完全正常的账号。
  if (health.updatedAt == null) {
    process.stdout.write('⚠️  还没从浏览器取回过登录态 —— 下面的"缺凭证"判定这一轮不可信。\n')
  }
  const rows = buildDoctorReport({
    snapshot: sourceHealth.snapshot(),
    authOf: (id) => boot.kernel.sources.registry.get(id)?.auth as { type: string; domain?: string } | undefined,
    availableDomains: health.domains,
  })

  if (rows.length === 0) {
    process.stdout.write('No source health recorded yet — run some failover harvests first.\n')
  } else {
    const icon = (s: string) => (s === 'healthy' ? '✅' : s === 'degraded' ? '⚠️' : '🔧')
    const w = Math.max(...rows.map((r) => r.sourceId.length))
    for (const r of rows) {
      const line = `${icon(r.state)} ${r.sourceId.padEnd(w)}  ${r.state}${r.reason ? `  — ${r.reason}` : ''}`
      process.stdout.write(line + '\n')
      if (r.missingCredential) process.stdout.write(`   ↳ ${r.missingCredential}\n`)
      if (showTrace && r.trace) process.stdout.write(`   ↳ trace:\n${r.trace.replace(/^/gm, '     ')}\n`)
    }
  }

  // 一次销毁全撤（库句柄 / adapter 子进程 / 定时器）——doctor 从前只关 adapter，落盘句柄
  // 全靠 process.exit 兜。
  await quiesceKernel(boot.kernel).catch(() => {})
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
