/** `ensureApp` 回执 → debug bus 的一条 entry（channel `host-agent`——**频道名没跟着二进制改名
 *  走**：二进制现在叫 `stream-desktop`，而 DebugBox 里已经按 `host-agent` 这个名字在筛，别改）。
 *
 *  唤起浏览器是采集的第一步，也是唯一一步「成败只在别的进程里可见」的动作：回执里的
 *  `running`/`started`/`pid`/`window` 全在 bootstrap 里就地消费掉，活体没有任何读法。所以每次
 *  ensure 都原样打一条——**失败（回执 undefined）比成功更要留痕**，它是"这一轮为什么没采"的
 *  唯一字面证据。
 */
import type { DebugEntry } from '../debug.ts'
import type { EnsureAppOutcome } from './desktop-driver.ts'

/** 哪一次 ensure：首发（默认语义，进程在就不动）还是 force 补发（托盘 Chrome 那条分支）。 */
export type EnsureAppPhase = 'first' | 'force'

const PHASE_LABEL: Record<EnsureAppPhase, string> = {
  first: '首次唤起',
  force: 'force 补发',
}

/**
 * 回执为 `undefined` = 调用抛了被 catch 掉（agent 不答话 / op 出错），记成 `ok:false`。
 * 有回执时 `ok` 只看 `running`：`running:false` 就是"启动过了但进程始终没出现"，是真失败。
 */
export function ensureAppDebugEntry(
  phase: EnsureAppPhase,
  outcome: EnsureAppOutcome | undefined,
  at: number,
): DebugEntry {
  const label = PHASE_LABEL[phase]
  const base = { id: `desktop:ensureApp:${phase}@${at}`, at, channel: 'desktop', key: 'ensureApp', title: `唤起浏览器（${label}）` }
  if (!outcome) {
    return {
      ...base,
      summary: `${label}：调用失败，没有回执`,
      ok: false,
      fields: [{ label: 'outcome', value: '（无回执，调用抛错被吞）', tone: 'bad' }],
    }
  }
  const { running, started, pid, process, window } = outcome
  const fields: DebugEntry['fields'] = [
    { label: 'running', value: String(running), tone: running ? 'ok' : 'bad' },
    { label: 'started', value: String(started), tone: started ? 'ok' : 'muted' },
    { label: 'process', value: process },
    { label: 'pid', value: pid != null ? String(pid) : '（无）', tone: pid != null ? 'muted' : 'warn' },
    // 窗口拿不准时 host-agent 就不给这个字段（指错一个比不给更坏）；打成 warn 而不是 bad ——
    // 没窗口不等于唤起失败，但它正是「唤起了却等不到中继」那条分支要看的东西。
    window
      ? { label: 'window', value: `${window.process} / ${window.title}${window.foreground ? '（前台）' : ''} #${window.id}`, tone: 'ok' }
      : { label: 'window', value: '（没拿准，无窗口回执）', tone: 'warn' },
  ]
  return {
    ...base,
    summary:
      `${label}：${running ? '在跑' : '没起来'}` +
      `${started ? ' · 本次启动' : ' · 本来就在'}` +
      `${pid != null ? ` · pid ${pid}` : ''}` +
      `${window ? ` · 窗口「${window.title}」` : ' · 无窗口回执'}`,
    ok: running,
    fields,
  }
}
